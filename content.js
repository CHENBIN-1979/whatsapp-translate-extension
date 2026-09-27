/**
 * content.js v1.1.7 — WhatsApp Web 扫描与注入
 * v1.1.2：扫描根多级回退 + data-id 锚点 + 诊断通道（解决「一条都不翻」）。
 * v1.1.3：解决「一直翻译中」——
 *   ① 批量请求按 12 条/组切分并发，早组早回话；
 *   ② requestTranslations 加 90s 兜底超时，回调丢失时显示可重试错误而非永久转圈；
 *   ③ 扫描扑空静默跳过（不再留误导性的 lastErr）；成功一轮即清 lastErr。
 * v1.1.4：解决「长文只翻一行/丢换行」——多行消息取整个文本容器（含 <br>），
 *   不再只取最长叶子 span；兜底超时对齐后端预算 90s→300s。
 */

(() => {
  if (window.__wTranslateLoaded) return;
  window.__wTranslateLoaded = true;

  const VERSION = '1.1.21';
  let enabled = true;
  const rowsByEl = new WeakMap();     // 文本元素 → 注入的译文行
  const inFlight = new Set();
  const failedEls = new WeakSet();     // v1.1.19 失败过的元素：自动重试仅一次，防持续失败时译文行无限累积

  // ---------- 诊断 ----------
  const diag = {
    version: VERSION, mainFound: false, root: 'none', strategy: 'none',
    candidates: 0, injected: 0, failed: 0, composer: false, lastErr: '',
    anchors: {}, sample: '',
  };
  let injectedN = 0, failedN = 0;
  let lastDiagSave = 0;
  function saveDiag(force) {
    const now = Date.now();
    if (!force && now - lastDiagSave < 3000) return;
    lastDiagSave = now;
    diag.injected = injectedN;
    diag.failed = failedN;
    try { chrome.storage.local.set({ wtrans_diag: diag }); } catch {}
  }
  function countAnchors() {
    try {
      const d = document;
      diag.anchors = {
        idMain: !!d.getElementById('main'),
        roleApp: d.querySelectorAll('[role="application"]').length,
        dataId: d.querySelectorAll('[data-id]').length,
        copyable: d.querySelectorAll('.copyable-text').length,
        selectable: d.querySelectorAll('.selectable-text').length,
        dirAuto: d.querySelectorAll('span[dir="auto"]').length,
        messageCls: d.querySelectorAll('div[class*="message"]').length,
        roleListitem: d.querySelectorAll('[role="listitem"]').length,
        paneSide: !!d.getElementById('pane-side'),
      };
    } catch {}
  }

  // ---------- 配置 ----------
  async function loadEnabled() {
    const { enabled: e } = await chrome.storage.local.get('enabled');
    enabled = e !== false;
    saveDiag(true);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (!enabled) removeComposeButton();
      else ensureComposeButton();
      saveDiag(true);
    }
  });

  // ---------- 文本资格 ----------
  const FILE_EXT_RE = /\.(?:pdf|docx?|xlsx?|pptx?|jpe?g|png|webp|heic|gif|bmp|svg|mp4|mov|avi|mkv|opus|ogg|mp3|m4a|wav|txt|zip|rar|7z|apk)$/i;
  const TIME_RE = /^(?:凌晨|早上|上午|中午|下午|晚上|午夜|晚)?\s*\d{1,2}[:：.]\d{2}/;  // v1.1.6 覆盖「晚上6:44」等全部中文时段前缀
  // v1.1.13：图标 SVG 的 <title>/<text>（wds-ic-read、ic-error、document-PDF-icon 等
  // 是 WhatsApp 文件/状态图标的无障碍标签，不是消息正文）从取词结果里剥离。
  function stripIconTitles(el, t) {
    if (!t || !el || !el.querySelector) return t;
    let svgs = null;
    try { svgs = el.querySelector('svg'); } catch {}
    if (!svgs) return t;
    let out = t;
    try {
      for (const ti of el.querySelectorAll('svg title, svg text')) {
        const s = (ti.textContent || '').trim();
        if (s && s.length <= 40) out = out.split(s).join('');
      }
    } catch {}
    return out.trim();
  }
  // 图标类名兜底：全小写(段)带连字符、无任何空格句子的短串 = DOM 类名而非人话
  const ICONTITLE_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i;
  function metaNoise(text) {
    const t = text.replace(/\s+/g, '');
    if (TIME_RE.test(text) && t.length < 12) return true;      // 下午3:26
    if (/^\d{1,2}:\d{2}$/.test(t)) return true;                 // 15:26
    if (/[\d.]+\s*(kB|MB|GB)/i.test(text) && text.length < 40) return true;
    if (/^\d+\s*(页|张|条|分钟)/.test(text)) return true;
    if (/·\s*(PDF|DOCX?|XLSX?|PPTX?|MP4|HEIC|视频|图片)/i.test(text)) return true;
    if (/^\d+\s*(页|分钟)\s*·/.test(text)) return true;
    if (/^\+?[\d\s().\-\u2010\u2011\u00A0]{7,}$/.test(text)) return true;   // v1.1.6 纯电话号（联系人名片）
    const one = text.trim();
    if (one.length <= 32 && !/\s/.test(one) && ICONTITLE_RE.test(one)) return true; // v1.1.13 图标类名
    if (SYSTEM_TEXT_RE.test(one)) return true; // v1.1.14 系统占位消息（这条消息已删除…）
    return false;
  }
  // v1.1.14：系统占位气泡（消息已删除/加密提示/未读回执提示…）不是用户正文，
  // 中文界面下它本身就是中文 → 送译会给对方发「已删除」的印尼文回译，纯属噪声。
  const SYSTEM_TEXT_RE = /^(?:🚫\s*)?(?:这条消息已删除|此消息已删除|You deleted this message|This message was deleted|消息已删除|端到端加密.*(?:提示|说明).*$|点击.*查看通知.*)$/;
  function eligible(text) {
    if (!text || text.length < 2) return false;
    if (!/[\u4e00-\u9fffA-Za-z\u3040-\u30ff\u0400-\u04ff\u0600-\u06ff\u0900-\u097f]/.test(text)) return false;
    if (FILE_EXT_RE.test(text.trim())) return false;
    if (metaNoise(text)) return false;
    return true;
  }
  // innerText 优先（真实 Chrome 中 <br> / 块级行 span → \n）；
  // 若 innerText 没给出换行但元素含 <br>（如 jsdom 或渲染差异），克隆节点把 <br> 显式转 \n。
  function domText(el) {
    let t = '';
    try { t = (el.innerText || '').trim(); } catch {}
    try {
      if (t && !t.includes('\n') && el.querySelector('br')) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
        return (clone.textContent || '').trim();
      }
    } catch {}
    if (t) {
      const stripped = stripIconTitles(el, t);
      if (stripped) return stripped;
    }
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      clone.querySelectorAll('svg').forEach((s) => s.remove()); // 图标整体不参与取词
      return stripIconTitles(el, (clone.textContent || '').trim());
    } catch { return stripIconTitles(el, (el.textContent || '').trim()); }
  }
  const txt = (el) => (el && domText(el)) || '';

  // ---------- 群发送者名识别（v1.1.6） ----------
  // 图片/贴纸/名片消息没有正文，气泡里唯一的文本是群发送者名（如「Erwin
  // Suryantoro」），v1.1.5 把人名当消息送译。稳定锚点：WhatsApp 给正文容器
  // copyable-text 挂 data-pre-plain-text="[时间, 日期] 名字: "，用它拿到本条
  // 消息的发送者名，候选文本与之一致就跳过（不依赖混淆 class）。
  function normName(str) {
    // v1.1.16：群昵称横幅固定带 `~` 前缀（~utamakan sholat），归一时剥掉才能与
    // data-pre-plain-text 里的裸名（utamakan sholat）匹配上
    return (str || '').replace(/^[~\u200b-\u200f\s]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  // ---------- 群昵称横幅结构判定（v1.1.17，用户截图2根因） ----------
  // 群消息顶部的发送者昵称横幅（「~ bae (Fauzan & farlin) +62 877…」）没有可靠的
  // data-pre-plain-text 参照（横幅自成一块 / pre 属性名里带电话），逐字匹配会漏。
  // 改结构性规则：WhatsApp 在横幅前固定渲染一个 `~` 字符（可带空格）；
  // 「~」前缀短行 / 名字行以电话号结尾 = 横幅，永不送译。
  // 误伤防护：「~2 jam…」（≈2小时）等 ~后接数字 的正文不算横幅。
  const BANNER_TILDE_RE = /^~\s*\D/;
  function isBannerLine(t) {
    // WhatsApp 昵称常裹 LRM/RLM 方向标记（\u200e 等），先剥掉再判 ~ 前缀
    const c = (t || '').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').trim();
    if (!c || c.length > 70) return false;
    return BANNER_TILDE_RE.test(c);
  }
  function senderNamesOf(bubble) {
    const names = new Set();
    try {
      const holders = [];
      if (bubble.hasAttribute && bubble.hasAttribute('data-pre-plain-text')) holders.push(bubble);
      bubble.querySelectorAll('[data-pre-plain-text]').forEach((e) => holders.push(e));
      for (const h of holders) {
        const m = (h.getAttribute('data-pre-plain-text') || '').match(/^\[[^\]]*\]\s*([^\n:]{2,80}):/);
        if (m) {
          const nm = m[1].replace(/\s*\+[\d\s).\-－—–]{6,}$/, '').trim(); // v1.1.17：pre 里名字常带电话后缀
          if (nm) names.add(normName(nm));
        }
      }
      // 名字 span 通常带 title（正文/引用一般没有）；排除带时间戳的 title
      bubble.querySelectorAll('span[title], div[title]').forEach((e) => {
        const tt = (e.getAttribute('title') || '').trim();
        if (tt && tt.length <= 60 && !/\d{2}:\d{2}/.test(tt)) names.add(normName(tt));
      });
      bubble.querySelectorAll('[data-testid*="name"], [data-testid*="participant"]').forEach((e) => {
        const tt = txt(e);
        if (tt && tt.length <= 60) names.add(normName(tt));
      });
    } catch {}
    return names;
  }

  // ---------- 名片/人名清洗（v1.1.7） ----------
  // 用户实测：联系人名片气泡（名字行 + 电话行）很多版本没有
  // data-pre-plain-text，v1.1.6 的 senderNamesOf 拿不到参照名 → 名字照翻。
  // 补两条结构规则：①含电话行的多行候选 = 名片形态，名字行连同电话行剥离；
  // ②单行候选"像人名"+ 所在气泡含图片/画布媒体 + 元素不在
  // data-pre-plain-text 容器内（= 不是正文/图注，而是名片名或媒体上方群标签）→ 跳过。
  const NAME_LINE_RE = /^[A-Z\p{L}][\p{L}'\-\.]{0,29}(?:[ \u00A0]+[A-Z\p{L}][\p{L}'\-\.]{0,29}){0,4}$/u;
  const PHONE_RE = /^[+\(（]?\d[\d\s).\-().－—–\u2010\u2011\u00A0]{5,24}$/;
  const DIGITS_RE = /\d/g;
  function isPhoneLine(t) {
    const c = t.trim();
    if (!PHONE_RE.test(c)) return false;
    return (c.match(DIGITS_RE) || []).length >= 6;
  }
  function looksLikeName(t) { return NAME_LINE_RE.test((t || '').trim()); }
  function hasMedia(bubble) {
    try { return !!bubble.querySelector('canvas, img, video, [data-mime]'); } catch { return false; }
  }
  function bubbleHasPhone(bubble) {
    try {
      for (const sp of bubble.querySelectorAll('span, div')) {
        if (sp.querySelector('span')) continue;
        const t = (sp.textContent || '').trim();
        if (t && t.length <= 30 && isPhoneLine(t)) return true;
      }
    } catch {}
    return false;
  }
  function cleanCandidateText(text, el, bubble) {
    if (!text) return '';
    let lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return '';
    // v1.1.14 ①-1 剥离引用头行（「~ 名字 +电话」「Replied to …」「回复 名字:」），
    // 它们永远不是本条消息的正文；剩下全是占位/空 → 不译。
    let pre = lines.filter((x) => !/^(?:~\s|Replied to\b|回复\s|~[^\p{L}\p{N}]{1,4}$)/u.test(x) && !/^(?:🚫\s*)?(?:这条消息已删除|此消息已删除|消息已删除|You deleted this message|This message was deleted)$/.test(x));
    if (pre.length !== lines.length) {
      lines = pre.map((x) => x.trim()).filter(Boolean);
      if (!lines.length) return '';
    }
    // ① 名片形态：任一电话行 → 该候选是 vCard；名字行（首行像人名 或 jsdom 拼接的单行"名字 +电话"）剥离
    const phoneIdx = lines.map((x, i) => (isPhoneLine(x) ? i : -1)).filter((i) => i >= 0);
    if (phoneIdx.length) {
      const rest = lines.filter((x, i) => !phoneIdx.includes(i));
      if (rest.length && looksLikeName(rest[0])) {
        // v1.1.17：剥完电话只剩一个名字行 = 本候选就是昵称横幅（v1.1.16 的
        // 媒体裸名规则要求单行才触发，「名字\n电话」两行形态漏网 → 「好的（Fauzan…」）
        if (rest.length === 1) return '';
        lines = rest.slice(1);
      } else lines = rest;
      if (!lines.length) return '';
    }
    // jsdom / title 属性场景：电话与名字挤在同一行
    if (lines.length === 1) {
      const m = lines[0].match(/^(.*?)\s*(\+[\d\s).\-－—–\u2010\u2011\u00A0]{6,})$/);
      // v1.1.18：真实昵称可带括注/数字（bae (Fauzan & farlin)、darman nidar23），
      // NAME_LINE_RE 过严会漏 → 改判「剥掉电话尾后剩短文本（≤40字符）」即横幅整行丢弃
      if (m && m[1].trim().length <= 40) return '';
    }
    // ② 媒体气泡里的裸名字标签（无 data-pre-plain-text 祖先 = 非图注正文）
    let inPre = false;
    try { inPre = !!(el && el.closest && el.closest('[data-pre-plain-text]')); } catch {}
    if (lines.length === 1 && looksLikeName(lines[0]) && hasMedia(bubble) && !inPre) {
      return '';
    }
    // v1.1.18 ③ 昵称横幅泡 = 「电话号就在同一个消息泡里」+「本候选行不在正文容器里」。
    // ~ 在真实 DOM 里常是独立 span（抽出的名字文本根本没有~），逐字符匹配必然漏网；
    // 而电话号码是每种横幅形态（换行/同行/括注/数字名）都跑不掉的共同特征。
    // 正文永远包在 [data-pre-plain-text] 容器里，vCard 的号码也在其中 → 均不受影响。
    if (!inPre && bubbleHasPhone(bubble)) {
      const one = lines.join('\n');
      if (one.length <= 70 && one.split(/\s+/).length <= 6 && !/[?？!！,;，；:：]/.test(one)) return '';
    }
    return lines.join('\n');
  }

  // ---------- 区域排除 ----------
  function inExcludedZone(el) {
    if (!el || el.closest('.wtrans-row')) return true;
    if (el.closest('[id="pane-side"], [class*="pane-side"]')) return true;   // 会话列表侧栏
    if (el.closest('header, footer, nav')) return true;
    if (el.closest('.quote, [class*="quoted"], [class*="system"], [contenteditable="true"]')) return true;
    // v1.1.6 会话列表行兜底：#pane-side id 失效时（WA 改版），行内含可拖拽头像
    // img 的 listitem = 左侧会话列表条目（聊天区的照片消息渲染为 canvas，无此特征）
    const li = el.closest('[role="listitem"]');
    if (li && li.querySelector('img[draggable="true"]')) return true;
    return false;
  }

  // ---------- 扫描根回退（关键修复） ----------
  // 用户实测：#main 存在但聊天区不在它内部（copyable×47 全在 #main 外），
  // v1.0/v1.1 在 #main 里扫 0 命中直接 return → 一条都不翻。
  // 改为「哪个容器里真的有消息」才当扫描根，否则回退 body（排除侧栏）。
  function looksLikeChatRoot(el) {
    if (!el) return false;
    try { return el.querySelectorAll('.copyable-text, .selectable-text, [data-id]').length > 0; } catch { return false; }
  }
  function getScanRoot() {
    const cands = [['#main', document.getElementById('main')]];
    try {
      document.querySelectorAll('[role="application"]').forEach((el, i) => cands.push(['role=application#' + i, el]));
    } catch {}
    cands.push(['body', document.body]);
    for (const [name, el] of cands) {
      if (looksLikeChatRoot(el)) { diag.root = name; return el; }
    }
    diag.root = 'none';
    return null;
  }

  // ---------- 气泡文本提取（data-id 锚点） ----------
  // v1.1.4：多行长文修复。WhatsApp 把长消息拆成「容器 span + 每行一个子
  // span（行间用 <br>）」；v1.1.3 只取最长叶子 span → 7 行报告只翻其中 1 行。
  // 优先取整个文本容器（innerText 会保留 <br> 换行），容器不合格才退回叶子。
  // v1.1.16：取词阶段统一清洗 = 剥掉等于本条发送者名的任意行 → 再过名片/引用/占位清洗
  function bubbleCandidateText(el, bubble) {
    let t = txt(el);
    if (!t) return '';
    const names = senderNamesOf(bubble);
    const lines = t.split('\n').filter((x) => x.trim());
    let kept = lines;
    if (names.size) kept = kept.filter((x) => !names.has(normName(x)));
    // v1.1.17：不依赖参照名，结构性剔除昵称横幅行（~前缀/带括注/名字+电话尾）
    const struct = kept.filter((x) => !isBannerLine(x));
    if (struct.length !== lines.length) t = struct.join('\n').trim();
    return cleanCandidateText(t, el, bubble);
  }

  function pickBubbleTextEl(bubble) {
    // ① 含 ≥2 个 <br> 的容器（copyable-text / selectable-text）= 多行整段消息
    let container = null, containerLen = 0;
    for (const sp of bubble.querySelectorAll('span.copyable-text, span.selectable-text.copyable-text, span[dir="auto"]')) {
      if (inExcludedZone(sp)) continue;
      if (sp.querySelectorAll('br').length < 1) continue;
      const t = bubbleCandidateText(sp, bubble);
      if (eligible(t) && t.length > containerLen) { container = sp; containerLen = t.length; }
    }
    if (container) return container;
    // ② copyable/selectable 容器内含 ≥2 个有文本的行 span（<br> 分隔或 pre-wrap \n）
    for (const sp of bubble.querySelectorAll('span.copyable-text, span.selectable-text')) {
      if (inExcludedZone(sp)) continue;
      const leaves = [...sp.querySelectorAll('span')].filter((x) => !x.querySelector('span') && txt(x));
      if (leaves.length >= 2 && eligible(bubbleCandidateText(sp, bubble))) return sp;
    }
    // ③ 原有叶子逻辑（单行消息 / 兜底）
    let best = null, bestLen = 0;
    for (const sp of bubble.querySelectorAll('span.selectable-text, span[dir="auto"], span')) {
      if (inExcludedZone(sp)) continue;
      if (sp.hasAttribute('title') && !sp.classList.contains('selectable-text')) continue; // 群成员昵称带 title
      // v1.1.14：叶子若只是 quote/占位/名片形态（清洗后为空）不得当选，
      // 否则「纯图片+引用头」消息会把引用头人名当正文送译（截图里的 Sutimin 行）
      // v1.1.16：v1.1.6 的剥离式名过滤只在「首行=名字」时起效，媒体消息的昵称横幅
      // 往往比图注长而当选（「优先礼拜」=「~utamakan sholat」被翻、图注没翻的根因），
      // 改为评分前就剥掉所有等于发送者名的行
      const cleaned = bubbleCandidateText(sp, bubble);
      if (!cleaned) continue;
      const t = cleaned;
      if (!eligible(t)) continue;
      if (t.length >= bestLen && !sp.querySelector('span')) { best = sp; bestLen = t.length; }
    }
    return best;
  }
  function isBubbleOut(bubble) {
    const id = bubble.getAttribute('data-id') || '';
    if (id.startsWith('true_')) return true;
    if (id.startsWith('false_')) return false;
    return !!(bubble.closest('.message-out, .message.out, [class*="message-out"]'));
  }

  let sampleTaken = false;
  function takeSample() {
    if (sampleTaken) return;
    const first = document.querySelector('[data-id]') || document.querySelector('[role="listitem"] span[dir="auto"]');
    if (first) {
      const host = first.closest('[data-id]') || first.closest('[role="listitem"]') || first;
      diag.sample = host.outerHTML.slice(0, 2500);
      sampleTaken = true;
      saveDiag(true);
    }
  }

  // ---------- 主扫描 ----------
  function scanMessages() {
    if (!enabled) return;
    try {
      const root = getScanRoot();
      diag.mainFound = !!document.getElementById('main');
      countAnchors();
      takeSample();
      if (!root) { diag.strategy = 'none'; diag.candidates = 0; saveDiag(); return; } // 切换聊天瞬间可能扑空，静默等下轮
      diag.lastErr = ''; // 本轮扫描成功，清除上轮陈旧错误，避免误导

      const usable = [];
      const seen = new Set();

      // 主策略：data-id 气泡 ∪ 旧版 copyable-text（去重，外层优先）
      let bubbles = [...new Set(root.querySelectorAll('[data-id], div.copyable-text'))];
      if (bubbles.length) {
        diag.strategy = 'data-id+legacy';
        for (const bubble of bubbles) {
          if (seen.has(bubble) || inExcludedZone(bubble)) continue;
          if (bubble.parentElement && bubble.parentElement.closest('[data-id]')) continue; // 嵌套取外层
          const el = pickBubbleTextEl(bubble);
          if (!el) continue;
          // v1.1.16：pick 阶段已按同一规则清洗，这里直接复用（避免两处逻辑漂移）
          const text = bubbleCandidateText(el, bubble);
          if (!eligible(text)) continue;
          seen.add(bubble);
          usable.push({ bubble, el, text, out: isBubbleOut(bubble) });
        }
      } else {
        // 兜底策略：无 data-id 时用结构特征
        diag.strategy = 'structural';
        const spans = [...root.querySelectorAll('span[dir="auto"], span.selectable-text')];
        for (const sp of spans) {
          if (inExcludedZone(sp)) continue;
          const host = sp.closest('[role="listitem"], [role="row"], [class*="message"]') || sp;
          if (seen.has(host)) continue;
          const t = bubbleCandidateText(sp, host); // v1.1.16 同主路径
          if (!eligible(t)) continue;
          if (sp.hasAttribute('title') && !sp.classList.contains('selectable-text')) continue; // 群成员昵称带 title（维持原规则）
          seen.add(host);
          usable.push({ bubble: host, el: sp, text: t, out: false });
        }
      }
      diag.candidates = usable.length;

      for (const item of usable) {
        if (inFlight.has(item.el)) continue;
        const prev = rowsByEl.get(item.el);
        if (prev) {
          // 已处理过：若文本未变且行仍在 DOM → 跳过；文本变了（消息编辑）→ 重译
          if (!document.contains(prev)) { rowsByEl.delete(item.el); }
          else if (prev._text === item.text) continue;
          else { prev.remove(); rowsByEl.delete(item.el); failedEls.delete(item.el); } // 文本变了→允许重译
        }
        if (failedEls.has(item.el)) continue; // v1.1.19 该条上一轮已失败（行还在），不再自动重排——用户点 ⟳
        const row = makeRow(item.out);
        row._text = item.text;
        row._el = item.el; // v1.1.19 ⟳ 刷新时找回归属元素（inFlight/rowsByEl 键）
        bindRetry(row, item);
        try {
          // 放置策略：译文作为 message 气泡层（copyable-text 的父级）的最后一个子节点，
          // 视觉上位于原文下方且不被 WhatsApp 选区/复制吞掉；找不到气泡层则退回紧跟原文节点。
          const host = item.el.closest('[class*="message"], [role="listitem"], [role="row"]') || item.bubble;
          const anchor = (host && host.contains(item.el)) ? host : item.el;
          if (anchor === host && anchor !== item.el) {
            anchor.appendChild(row);
          } else {
            item.el.insertAdjacentElement('afterend', row);
          }
          injectedN++;
        } catch { continue; }
        rowsByEl.set(item.el, row);
        queueForTranslation(item.el, row, item.text);
      }
      if (pending.length) scheduleFlush();
      saveDiag(usable.length > 0);
    } catch (e) {
      diag.lastErr = String((e && e.message) || e);
      saveDiag(true);
    }
  }

  // ---------- 翻译请求 ----------
  function requestTranslations(texts) {
    return new Promise((resolve) => {
      // 兜底超时：MV3 service worker 若被回收/响应丢失，回调可能永不触发，
      // 译文行会永远停在「翻译中…」。60s 后强制显示可重试错误。
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const failAll = (msg) => finish({
        translations: texts.map(() => null),
        errors: texts.map(() => msg),
      });
      setTimeout(() => failAll('后台响应超时（点击重试）'), 300000);
      try {
        chrome.runtime.sendMessage({ type: 'wtranslate', texts }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) {
            failAll((chrome.runtime.lastError?.message) || res?.error || '后台不可用（点击重试）');
          } else {
            finish(res);
          }
        });
      } catch (e) {
        failAll(e.message);
      }
    });
  }

  // ---------- 译文行 ----------
  function makeRow(out) {
    const row = document.createElement('div');
    row.className = 'wtrans-row' + (out ? ' wtrans-out' : '');
    row.setAttribute('dir', 'auto');
    const tag = document.createElement('span');
    tag.className = 'wtrans-tag';
    tag.textContent = '译';
    const verMark = document.createElement('span'); // v1.1.11 版本水印：肉眼确认装的是哪个版本
    verMark.className = 'wtrans-ver';
    verMark.textContent = 'v' + VERSION;
    tag.appendChild(verMark);
    const body = document.createElement('span');
    body.className = 'wtrans-body';
    body.textContent = '翻译中…';
    // v1.1.19 ⟳ 刷新按钮：翻译失败/译文显示原文时点击 → 清该条缓存强制重译
    const refresh = document.createElement('span');
    refresh.className = 'wtrans-refresh';
    refresh.textContent = '⟳';
    refresh.title = '重新翻译此条（强制刷新缓存）';
    refresh.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (row._busy) return;
      doRefresh(row);
    });
    row.appendChild(tag);
    row.appendChild(refresh);
    row.appendChild(body);
    row._body = body;
    return row;
  }
  function markFailed(row, msg) {
    row._body.textContent = '⚠ ' + (msg || '翻译失败');
    row.classList.add('wtrans-failed');
    row._failed = true;
    row._busy = false;
    failedN++;
  }
  const normEchoC = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  function isEchoText(src, val) { // 回显=归一化后与原文完全相同（与 background.js 同逻辑）
    const s = String(src || '').trim(), v = String(val || '').trim();
    if (!v) return true;
    if (s.length < 6) return false;
    return normEchoC(s) === normEchoC(v);
  }
  function doRefresh(row) {
    row._busy = true;
    row._body.textContent = '翻译中…';
    row.classList.remove('wtrans-failed');
    const text = row._text;
    const el = row._el; // 刷新期间占用 inFlight → 轮扫描不会给同一气泡插第二条译文行
    if (el) inFlight.add(el);
    try { chrome.runtime.sendMessage({ type: 'wtranslate-forget', text }, () => void chrome.runtime.lastError); } catch {}
    requestOne(text, (t, err) => {
      if (el) inFlight.delete(el);
      row._busy = false;
      if (!document.contains(row)) return;
      if (t && !isEchoText(text, t)) {
        row._body.textContent = t;
        row._failed = false;
        if (el) { rowsByEl.set(el, row); failedEls.delete(el); } // 恢复映射：扫描跳过
      } else {
        markFailed(row, err || '刷新后仍是原文（点 ⟳ 再试）');
      }
    });
  }
  function requestOne(text, cb) {
    requestTranslations([text]).then((res) => {
      cb(res.translations?.[0] || null, res.errors?.[0] || null);
    });
  }

  function bindRetry(row, item) {
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ev.target && ev.target.classList && ev.target.classList.contains('wtrans-refresh')) return; // ⟳ 自处理
      if (!row._failed) return;
      rowsByEl.delete(item.el);
      inFlight.delete(item.el);
      failedEls.delete(item.el); // v1.1.19 点击 ⚠ 行 = 授权重新排队
      row.remove();
      scanMessages();
    });
  }

  async function runBatch(items) {
    const texts = items.map((i) => i.text);
    const res = await requestTranslations(texts);
    items.forEach((item, idx) => {
      const t = res.translations?.[idx];
      const row = item.row;
      if (!document.contains(row)) { inFlight.delete(item.el); return; } // WhatsApp 重渲染掉了气泡
      if (typeof t === 'string' && t.trim() && !isEchoText(item.text, t)) {
        row._body.textContent = t;
        row._failed = false;
      } else if (typeof t === 'string' && t.trim()) {
        // v1.1.19：模型把原文吐回来 = 未翻译，按失败处理（行显示⚠，点 ⟳ 强制重译）
        markFailed(row, '显示的是原文，未翻译成功');
        failedEls.add(item.el); // 不再自动重排队（防持续失败时译文行累积）；⟳ 手动刷新
      } else {
        markFailed(row, (res.errors?.[idx] || '翻译失败') + '（点 ⟳ 或点击此行重试）');
        failedEls.add(item.el);
      }
      inFlight.delete(item.el);
    });
    saveDiag();
  }

  function queueForTranslation(textEl, row, text) {
    inFlight.add(textEl);
    pending.push({ el: textEl, row, text });
  }

  let pending = [];
  let flushTimer = null;
  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      // 切成 ≤12 条/组并发发送：早组早回，译文逐组出现；
      // 单请求塞 16+ 条会让后台一次要等几十秒，用户视角=一直「翻译中…」。
      const groups = [];
      for (let i = 0; i < batch.length; i += 12) groups.push(batch.slice(i, i + 12));
      await Promise.all(groups.map(runBatch));
    }, 300);
  }

  // ---------- 输入框反向翻译 ----------
  let composeBtn = null;
  let composeAnchor = null;
  let originalBeforeTranslate = null;
  let translatedSnapshot = null;

  function getComposer() {
    const candidates = document.querySelectorAll(
      'footer div[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"][data-tab]'
    );
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.top > window.innerHeight * 0.5) return el;
    }
    return null;
  }

  const ZW_RE = /[\u200b-\u200f\ufeff\u202a-\u202e]/g; // 零宽占位符 + Lexical 插入的方向控制符
  const normTxt = (s) => (s || '').replace(ZW_RE, '').trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function selectAllIn(el) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }
  function caretToEnd(el) {
    try {
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {}
  }
  // v1.1.14：WhatsApp 输入框已换成 Lexical 编辑器——插入位置用它「内部选区」决定，
  // 内部选区靠 selectionchange 异步同步 DOM 选区。同一拍里「全选+insertText」时
  // 内部选区还停在旧光标（文字末尾）→ 译文被追加成 原文+译文（用户截图
  // 「早上好Selamat pagiSelamat pagi」正是连点两次各追加一次的累积）。
  // 必须：全选 → 等同步 → 再插入；每步验证，失败则「删除全部→重插」两级兜底。
  async function setComposerText(el, text) {
    el.focus({ preventScroll: true });
    selectAllIn(el);
    await wait(120); // 等 Lexical 的 selectionchange → 内部选区同步完成
    selectAllIn(el); // 编辑器若重渲染打断了选区，再选一次
    try { document.execCommand('insertText', false, text); } catch {}
    await wait(80);
    if (normTxt(txt(el)) === normTxt(text)) return;
    // 仍不对（被追加而非替换）→ 全选删除，等同步后光标置尾再插入
    selectAllIn(el);
    await wait(120);
    try { document.execCommand('delete'); } catch {}
    await wait(80);
    caretToEnd(el);
    await wait(60);
    try { document.execCommand('insertText', false, text); } catch {}
    await wait(80);
    if (normTxt(txt(el)) === normTxt(text)) return;
    // 最后兜底：直接重建 DOM + 事件通知（非受控编辑器/旧版页面）
    try {
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
    } catch {}
    el.replaceChildren(document.createTextNode(text));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  function ensureComposeButton() {
    const composer = getComposer();
    diag.composer = !!composer;
    if (!composer) { saveDiag(); return; }
    const footer = composer.closest('footer') || composer.parentElement;
    if (composeBtn && composeAnchor === footer && footer.contains(composeBtn)) return;
    removeComposeButton();

    if (getComputedStyle(footer).position === 'static') {
      footer.style.position = 'relative';
    }
    composeBtn = document.createElement('div');
    composeBtn.className = 'wtrans-compose-btn';
    composeBtn.title = '中 ⇄ 印尼语：翻译输入框内容（再点一次还原）';
    composeBtn.textContent = '译';
    // v1.1.13：mousedown 阻止默认 —— 否则点按钮瞬间输入框失焦，
    // WhatsApp 的 React 在 blur 后异步把内部状态刷回 DOM，覆盖我们写入的译文
    // （用户实测：不先选中文字就点「译」无效）。保住焦点即一次点击生效。
    composeBtn.addEventListener('mousedown', (e) => e.preventDefault());
    composeBtn.addEventListener('click', onComposeTranslate);
    footer.appendChild(composeBtn);
    composeAnchor = footer;
    saveDiag();
  }

  function removeComposeButton() {
    if (composeBtn) composeBtn.remove();
    composeBtn = null;
    composeAnchor = null;
    originalBeforeTranslate = null;
    translatedSnapshot = null;
  }

  async function onComposeTranslate() {
    const composer = getComposer();
    if (!composer || !composeBtn) return;
    const current = txt(composer);

    if (originalBeforeTranslate !== null && current && normTxt(current) === normTxt(translatedSnapshot)) {
      await setComposerText(composer, originalBeforeTranslate);
      originalBeforeTranslate = null;
      translatedSnapshot = null;
      composeBtn.classList.remove('wtrans-active');
      return;
    }

    if (!normTxt(current)) return;
    composeBtn.classList.add('wtrans-busy');
    composeBtn.textContent = '…';
    const res = await requestTranslations([current]);
    const t = res.translations?.[0];
    composeBtn.classList.remove('wtrans-busy');
    composeBtn.textContent = '译';
    if (typeof t === 'string' && t.trim()) {
      originalBeforeTranslate = current;
      translatedSnapshot = normTxt(t);
      await setComposerText(composer, translatedSnapshot);
      composeBtn.classList.add('wtrans-active');
    } else {
      composeBtn.title = '翻译失败：' + (res.errors?.[0] || '未知错误');
    }
  }

  // ---------- 驱动 ----------
  const appRoot = document.getElementById('app') || document.body;
  const observer = new MutationObserver(() => {
    scheduleScan();
    ensureComposeButtonSoon();
  });
  try { observer.observe(appRoot, { childList: true, subtree: true }); } catch {}

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanMessages(); }, 600);
  }

  let btnTimer = null;
  function ensureComposeButtonSoon() {
    clearTimeout(btnTimer);
    btnTimer = setTimeout(ensureComposeButton, 800);
  }

  setInterval(() => { try { scanMessages(); ensureComposeButton(); } catch (e) { diag.lastErr = String(e); saveDiag(true); } }, 2500);

  loadEnabled().then(() => {
    [0, 800, 2000, 4000, 7000].forEach((ms) => setTimeout(() => { scanMessages(); ensureComposeButton(); }, ms));
  });
})();
