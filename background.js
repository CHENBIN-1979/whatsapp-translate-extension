/**
 * background.js — WhatsApp 实时翻译 service worker
 * 职责：接收 content script 的翻译请求 → 批量合并 → 调用 OpenAI 兼容 LLM API → 返回结果。
 * 带缓存去重，失败自动逐条重试。配置存 chrome.storage.local。
 * v1.1.3：逐条降级改为并行（并发3，单条超时12s）；批量调用超时 45s→30s；
 *          每批最多 12 条（过多模型容易漏条/截断）。16 条全挂场景从 ~12 分钟降到 <30s。
 * v1.1.5：极速模式 —— 默认给请求附加 enable_thinking:false 关闭推理模型的思维链
 *          （scnet Qwen3.8-Flash 实测单条翻译 7.3s→3.6s）；网关若不认识该参数
 *          （400/422）自动剥字段重试并记住不再发送。弹窗可开关。
 * v1.1.8：用户专属词典（术语表注入提示词 + 输出整词硬替换），词典变更自动清缓存。
 */
const DEFAULTS = {
  apiBase: 'https://api.scnet.cn/api/llm/v1',
  apiKey: '',
  model: 'Qwen3.8-Flash',
  enabled: true,
  temperature: 0.2,
  fast: true,   // v1.1.5 极速模式：关思考型模型(qwen等)的思维链，实测翻译 7.3s→3.6s
  customDict: {}, // v1.1.8 用户专属词典 {印尼术语: 指定译文}（键存小写）
  profiles: null,      // v1.1.20 多模型配置列表 [{id,name,apiBase,apiKey,model,temperature}]；null=未设置，走旧单配置
  activeProfile: '',   // v1.1.20 当前启用的配置 id；翻译实时用这一条
};

// ---------------- 缓存 ----------------
const CACHE_KEY = 'wtrans_' + 'cache_v2'; // v1.1.10：v2 作废旧算法/旧提示词产生的错误译文
const CACHE_MAX = 2000;
let cache = null; // Map<string,string>，key = lang|text

async function loadCache() {
  if (cache) return cache;
  const obj = await chrome.storage.local.get(CACHE_KEY);
  cache = new Map(Object.entries(obj[CACHE_KEY] || {}));
  return cache;
}

let saveTimer = null;
function scheduleSaveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!cache) return;
    // 超限裁剪（Map 保持插入序，删最旧）
    while (cache.size > CACHE_MAX) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) });
  }, 1500);
}

// ---------------- 语言判定 ----------------
// 含中文字符 → 目标印尼语；否则 → 目标简体中文
function detectTarget(text) {
  return /[\u4e00-\u9fff]/.test(text) ? 'id' : 'zh-CN';
}

// ---------------- 用户专属词典（v1.1.8） ----------------
// 词条 = {印尼语术语: 指定译文}（双向自动生效：印尼文消息→按表译成中文，
// 中文消息里出现"指定译文"→按表译回印尼术语）。三层保障：
// ①术语表注入系统提示词（两个方向都列出，模型必须按表翻译）；
// ②模型输出后整词硬替换兜底（模型偶尔不听话/保留原文时强制纠正）；
// ③缓存 key 含词典指纹——改词典后旧译文自动失效，无需手动清缓存。
// v1.1.9：硬替换改两轮占位符法，相近词条（mixing/mixer）双向互不顶替。
// v1.1.10：提示词加整词精确匹配约束 + enforceDictOut 源文核对纠正（模型把 mixing 错译成 mixer 译文时强制改回）+ 缓存键升 v2 作废旧错误译文。
// v1.1.11：同形一词之差纠正（压花轮→压花辊）+ 译文行版本水印。
// v1.1.12：多行消息按行对齐逐术语核对（混进他行的混淆也能抓）；同值拼写变体（bambury/banbury）互认不臆改。
// v1.1.14 输入框换 Lexical 编辑器：写入前后以 DOM 校验，content.js 侧全选→等选区同步→再插入，杜绝译文追加
// v1.1.15 已删除系统占位消息/引用头人名行不送翻（content 侧结构过滤，bg 无改动）
// v1.1.16 媒体消息昵称横幅（~utamakan sholat）不再被当正文送翻，图注（Suhu D005/Scaner a08）正常翻译（content 侧修复，bg 无改动）
// v1.1.17 群昵称横幅改结构性剔除（~前缀行含 LRM 变体/独立横幅块），真实 WhatsApp 形态复现修复（content 侧，bg 无改动）
// v1.1.19 原文回显防护：模型原样吐回输入时不再当真译文（不缓存+显示⚠可⟳刷新）；
//   缓存命中同样校验（旧脏数据自愈）；新增 wtranslate-forget 路由支撑 ⟳ 强制重译。
// v1.1.18 昵称横幅根因修复：~在真实DOM是独立span（抽出文本无~）→ 改用电话号结构规则：
//   候选不在[data-pre-plain-text]正文容器内 且 同气泡存在电话行（含U+2011不间断横杠）→ 横幅整泡作废；同行\"名字+电话尾\"≤40字符判横幅。
function normDict(raw) {
  const out = new Map();
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const key = String(k).trim();
      const val = String(v).trim();
      if (key && val) out.set(key.toLowerCase(), val);
    }
  }
  return out;
}
function dictVer(dict) {
  // 词典指纹（FNV-1a）：任何增删改 → 缓存 key 变化 → 旧译文自动失效
  const str = [...dict.entries()].sort().map(([k, v]) => k + '=' + v).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return dict.size.toString(36) + '-' + h.toString(36);
}
function dictLines(dict) {
  if (!dict || !dict.size) return '';
  return [...dict.entries()].sort((a, b) => b[0].length - a[0].length)
    .map(([k, v]) => `${k}=${v}`).join('；');
}
function dictLinesRev(dict) {
  if (!dict || !dict.size) return '';
  return [...dict.entries()].sort((a, b) => b[1].length - a[1].length)
    .map(([k, v]) => `${v}=${k}`).join('；');
}
function escapeRe(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function applyDictOut(text, dict, srcZh) {
  // srcZh=true：原文是中文、译文是印尼语 → 反向表（指定译文 替换回 印尼术语）。
  // v1.1.9：两轮替换。第一轮把所有命中词换成不可再命中的占位符，第二轮统一换回目标。
  // 隔离相近词双向串扰：词典 mixing=轧轮机 + mixer=混合桶 时，正向把 mixing 替换成
  // 轧轮机 后，反向词条 mixer=混合桶 绝不能再把刚写入的 轧轮机 改成 mixer（反之亦然）。
  if (!text || !dict || !dict.size) return text;
  let t = text;
  const pairs = srcZh ? [...dict.entries()].map(([k, v]) => [v, k]) : [...dict.entries()];
  pairs.sort((a, b) => b[0].length - a[0].length); // 长词优先
  const tokens = [];
  for (const [from] of pairs) {
    try {
      const ascii = /[A-Za-z0-9]/.test(from);
      const re = ascii
        ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(from)}(?![A-Za-z0-9])`, 'gi')
        : new RegExp(escapeRe(from), 'g');
      t = t.replace(re, () => { tokens.push(from); return '\u2063' + (tokens.length - 1) + '\u2063'; });
    } catch {}
  }
  if (!tokens.length) return t;
  return t.replace(/\u2063(\d+)\u2063/g, (_, i) => {
    const hit = pairs.find(([from]) => from === tokens[+i]);
    return hit ? hit[1] : tokens[+i];
  });
}
function hasTerm(term, text) {
  try {
    const ascii = /[A-Za-z0-9]/.test(term);
    const re = ascii
      ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`, 'i')
      : new RegExp(escapeRe(term));
    return re.test(text);
  } catch { return false; }
}
function fuzzyTermVal(out, val) {
  // 等长滑窗、恰好 1 个位置不同、且该窗口在全文唯一 → 返回窗口，否则 null
  if (val.length < 2) return null;
  let hit = null, count = 0;
  for (let i = 0; i + val.length <= out.length; i++) {
    const win = out.slice(i, i + val.length);
    if (win === val) continue;
    let diff = 0;
    for (let j = 0; j < val.length; j++) if (win[j] !== val[j]) diff++;
    if (diff === 1) { hit = win; count++; }
  }
  return count === 1 ? hit : null;
}
function enforceDictOut(out, dict, sourceText, srcZh) {
  // 正向（印尼文→中文）：源文出现的术语，其指定译文必须出现在输出里。
  // 若模型把 mixing 错译成了别的词条的译文（如输出"混合桶"但源文没有 mixer），
  // 且该外来译文只可能来自混淆，则强制纠正为正确译文。
  // 反向（中文→印尼文）不做此纠正：印尼词可被模型保留原文，无法用同样条件判断。
  // v1.1.12：多行消息按行对齐逐行核对。整段核对在多行消息里 mixing 与 mixer
  // 同时出现时会把"混合桶"当成合法译文而弃权——模型恰恰会把 A 行的术语译到 B 行。
  if (srcZh || !out || !dict || !dict.size || !sourceText) return out;
  const enforceOne = (t, source) => {
    const entries = [...dict.entries()]; // [term, val]
    const srcTerms = entries.filter(([term]) => hasTerm(term, source));
    const outTerms = new Set(srcTerms.map(([, val]) => val).filter((v) => t.includes(v)));
    for (const [term, val] of srcTerms) {
      if (outTerms.has(val)) continue; // 该术语译文已在，正常
      // 找出"源文不含其术语、却出现在译文里"的其他词条译文 → 视为混淆，纠正。
      // v1.1.12：译文已属源文某合法术语（如 bambury/banbury 同值"万马力"拼写变体）→ 不算入侵者
      const intruders = entries.filter(([t2, v2]) => t2 !== term && !hasTerm(t2, source) && v2 !== val && !outTerms.has(v2) && t.includes(v2));
      if (intruders.length === 1) {
        t = t.split(intruders[0][1]).join(val);
        outTerms.add(val);
      } else if (!intruders.length) {
        // 无混淆词也缺正确译文 → 试“一词之差”同形纠正（压花轮→压花辊）
        const near = fuzzyTermVal(t, val);
        if (near && !entries.some(([, v2]) => v2 === near)) { t = t.split(near).join(val); outTerms.add(val); }
      }
    }
    return t;
  };
  const srcLines = sourceText.split('\n');
  const outLines = out.split('\n');
  if (srcLines.length === outLines.length && srcLines.length > 1) {
    return outLines.map((ln, i) => enforceOne(ln, srcLines[i])).join('\n');
  }
  return enforceOne(out, sourceText);
}
function systemPromptWithDict(dict) {
  const g = dictLines(dict);
  return g
    ? SYSTEM_PROMPT + '\n术语表（印尼语→中文，大小写不限，下列术语【必须】翻译成指定译文，不得意译、不得保留原文）：'
      + g + '\n反向术语表（中文→印尼语，下列中文词【必须】翻译成指定印尼语）：' + dictLinesRev(dict)
      + '\n术语必须整词精确匹配后再套用：表中相近的术语（如 mixing 与 mixer）是不同词，'
      + '不得互相顶替；原文单词与表中词条不完全相同（多字母、少字母、词形变化）时不套表，按正常翻译处理。'
    : SYSTEM_PROMPT;
}

// ---------------- LLM 调用 ----------------
// v1.1.20 配置规范化：丢弃无名条目，补默认值与 id
function normalizeProfiles(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && String(p.name || '').trim())
    .map((p) => ({
      id: String(p.id || ('p' + Math.random().toString(36).slice(2, 9))),
      name: String(p.name).trim().slice(0, 30),
      apiBase: String(p.apiBase || DEFAULTS.apiBase).trim(),
      apiKey: String(p.apiKey || '').trim(),
      model: String(p.model || DEFAULTS.model).trim(),
      temperature: Number(p.temperature ?? DEFAULTS.temperature),
    }));
}

async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const cfg = { ...DEFAULTS, ...stored };
  const list = normalizeProfiles(cfg.profiles);
  if (list.length) {
    // 有配置列表 → 用当前启用条覆盖连接字段；无列表（旧版/单测桩）→ 扁平字段，向后兼容
    const p = list.find((x) => x.id === cfg.activeProfile) || list[0];
    return { ...cfg, apiBase: p.apiBase, apiKey: p.apiKey, model: p.model, temperature: p.temperature };
  }
  return cfg;
}

async function chatCompletion(cfg, messages, timeoutMs = 30000, maxTokens = 0) {
  const base = (cfg.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = {
    model: cfg.model || DEFAULTS.model,
    temperature: Number(cfg.temperature ?? DEFAULTS.temperature),
    messages,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  // 极速模式：关思考型模型思维链（实测翻译 7.3s→3.6s）；记住网关不认识的字段，之后不再撞 400
  if (cfg.fast !== false && !chatCompletion._unsupported?.has('enable_thinking')) {
    body.enable_thinking = false;
  } else {
    delete body.enable_thinking;
  }
  if (chatCompletion._unsupported?.has('max_tokens')) delete body.max_tokens;
  const doFetch = async (b) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: 'Bear' + 'er ' + cfg.apiKey } : {}),
        },
        body: JSON.stringify(b),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`API ${resp.status}: ${text.slice(0, 300)}`);
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  };
  let data;
  try {
    data = await doFetch(body);
  } catch (e) {
    // 部分网关不接受 max_tokens / enable_thinking（400/422）→ 逐个剥掉可选字段重试，并记住不再发送
    if (/API 400|API 422/.test(e.message)) {
      chatCompletion._unsupported = chatCompletion._unsupported || new Set();
      let recovered = false;
      for (const opt of ['enable_thinking', 'max_tokens']) {
        if (opt in body) { delete body[opt]; chatCompletion._unsupported.add(opt); recovered = true; break; }
      }
      if (recovered) data = await doFetch(body);
      else throw e;
    } else throw e;
  }
  if (maxTokens && data?.choices?.[0]?.finish_reason === 'length') {
    // 输出被 max_tokens 截断 → 不报错，去掉上限再要一次完整结果
    delete body.max_tokens;
    try { data = await doFetch(body); } catch { /* 保留截断结果 */ }
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 返回内容为空');
  return content;
}

// 从模型输出里稳健地抠出 JSON 数组（有的服务会包 ``` 或前后有废话）
function parseJsonArray(raw) {
  const cleaned = raw.replace(/```(?:json)?/gi, '');
  const s = cleaned.indexOf('[');
  const e = cleaned.lastIndexOf(']');
  if (s === -1 || e === -1 || e <= s) throw new Error('输出中未找到 JSON 数组');
  const arr = JSON.parse(cleaned.slice(s, e + 1));
  if (!Array.isArray(arr)) throw new Error('输出不是数组');
  return arr.map((x) => (typeof x === 'string' ? x : x?.text ?? ''));
}

const SYSTEM_PROMPT = [
  '你是 WhatsApp 聊天消息翻译器，只翻译，不回答、不解释、不补充。',
  '输入是一个 JSON 字符串数组，代表一组聊天消息。',
  '规则：印尼语消息翻译成简体中文；中文消息翻译成印尼语；英语等其他语言翻译成简体中文。',
  '保持口语化，保留表情符号、数字、@ 提及原样。',
  '必须逐行翻译：原文每一行（含换行符\\n分隔的行）都要翻译并在译文中保留同样的换行，不得合并、省略或重排任何一行。',
  '专有名词（人名、地名、产品型号）可保留原文。',
  '输出：只输出一个 JSON 字符串数组，长度、顺序与输入完全一致。不要输出任何其他文字。',
].join('\n');

async function translateBatch(cfg, texts) {
  const userPayload = JSON.stringify(texts);
  const chars = texts.reduce((s, t) => s + t.length, 0); // v1.1.4：按总字符给预算，长报告不被截断
  const budget = Math.min(8192, 200 + Math.ceil(chars * 2.5));
  const content = await chatCompletion(cfg, [
    { role: 'system', content: systemPromptWithDict(normDict(cfg.customDict)) },
    { role: 'user', content: userPayload },
  ], 50000, budget);
  const arr = parseJsonArray(content);
  if (arr.length !== texts.length) {
    throw new Error(`返回条数不匹配：期望 ${texts.length}，得到 ${arr.length}`);
  }
  return arr;
}

async function translateSingle(cfg, text) {
  // 逐条模式不依赖 JSON，直接要译文。超时短（12s）：降级路径是并行的，
  // 但单条也不能吊太久，否则整批回话慢。
  const target = detectTarget(text);
  const targetName = target === 'id' ? '印尼语' : '简体中文';
  const content = await chatCompletion(cfg, [
    { role: 'system', content: '你是聊天消息翻译器。把用户给你的消息翻译成' + targetName + '，口语化，只输出译文本身，不要任何解释、引号或前缀。保留表情符号和换行。' + (dictLines(normDict(cfg.customDict)) ? '术语表：' + (target === 'id' ? dictLinesRev(normDict(cfg.customDict)) : dictLines(normDict(cfg.customDict))) + '（下列术语必须按指定译文翻译，不得意译或保留原文）' : '') },
    { role: 'user', content: text },
  ], 25000, Math.min(4096, 100 + Math.ceil(text.length * 3)));
  return content.trim();
}

// ---------------- v1.1.19 原文回显防护 ----------------
// 模型偶尔把输入原样吐回来（批量截断/网关抽风），旧版会当真译文显示并缓存，
// 用户看到「译文=原文」。判定为回显 → 按失败处理（不缓存，行显示⚠可刷新）。
// 缓存读取也过一遍此判定：旧的回显脏数据会在下次命中时自动重译（自愈）。
const normEcho = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
function looksLikeEcho(src, val) {
  const s = String(src || '').trim(), v = String(val || '').trim();
  if (!v) return true;
  if (s.length < 6) return false; // 极短消息（OK/谢谢）合法译文可能就等于原文，不误判
  // 只做归一化精确比对：模型原样吐回输入（忽略换行/空格/大小写差异）= 回显。
  // 不用「缺汉字/缺拉丁词」启发式——合法译文也可能不含目标文字（纯型号、URL）。
  return normEcho(s) === normEcho(v);
}
const ECHO_MSG = '模型返回了原文（未翻译），点 ⟳ 刷新';

const MAX_TEXT_LEN = 4000;   // 单条上限
const MAX_BATCH_ITEMS = 12;  // 一批最多条数（过多模型容易漏条/截断）
const MAX_BATCH_CHARS = 4000; // 一批的总字符预算
const BATCH_WINDOW_MS = 350;  // 攒批窗口
const SINGLE_CONCURRENCY = 3; // 逐条降级的并发数

// ---------------- 攒批队列 ----------------
// queue: [{text, resolve, reject}]
let queue = [];
let flushTimer = null;

function enqueue(text) {
  return new Promise((resolve, reject) => {
    queue.push({ text, resolve, reject });
    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WINDOW_MS);
  });
}

async function flush() {
  flushTimer = null;
  const items = queue;
  queue = [];
  if (!items.length) return;

  const cfg = await getConfig();
  if (!cfg.enabled) {
    items.forEach((i) => i.reject(new Error('翻译已停用')));
    return;
  }
  if (!cfg.apiKey && !cfg.apiBase.includes('localhost') && !cfg.apiBase.includes('127.0.0.1')) {
    items.forEach((i) => i.reject(new Error('未配置 API Key，请点击扩展图标设置')));
    return;
  }

  const c = await loadCache();
  const dict = normDict(cfg.customDict);
  const dver = dictVer(dict); // v1.1.8 词典版本进缓存 key：改词典自动失效

  // 先查缓存
  const misses = [];
  for (const item of items) {
    const key = detectTarget(item.text) + '|' + dver + '|' + item.text;
    const hit = c.get(key);
    // v1.1.19：缓存里的回显脏数据不再采信 → 重新翻译并覆盖
    if (hit !== undefined && !looksLikeEcho(item.text, hit)) item.resolve(hit);
    else misses.push({ ...item, key });
  }
  if (!misses.length) return;

  // 按条数+字符预算切分成若干批
  const batches = [];
  let cur = [], curLen = 0;
  for (const m of misses) {
    const t = m.text.slice(0, MAX_TEXT_LEN);
    if (t.length > 600) { batches.push([{ ...m, sent: t }]); continue; } // 长文单独成批
    if (cur.length && (cur.length >= MAX_BATCH_ITEMS || curLen + t.length > MAX_BATCH_CHARS)) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push({ ...m, sent: t });
    curLen += t.length;
  }
  if (cur.length) batches.push(cur);

  for (const batch of batches) {
    try {
      const results = await translateBatch(cfg, batch.map((b) => b.sent));
      batch.forEach((b, idx) => {
        const rawVal = String(results[idx] ?? '').trim();
        const srcZh1 = detectTarget(b.sent) === 'id';
        const val = enforceDictOut(applyDictOut(rawVal, dict, srcZh1), dict, b.sent, srcZh1) || '⚠ 无译文';
        if (looksLikeEcho(b.sent, val)) { b.reject(new Error(ECHO_MSG)); return; } // v1.1.19 回显不缓存
        c.set(b.key, val);
        scheduleSaveCache();
        b.resolve(val);
      });
    } catch (err) {
      // 批量失败 → 逐条降级。必须并行：串行 N 条 × 超时 = 全挂十几分钟，
      // 译文行会一直显示「翻译中…」（用户实测 16 条卡死即此因）。
      console.warn('[wTranslate] 批量失败，逐条并行重试:', err.message);
      let cursor = 0;
      const worker = async () => {
        while (cursor < batch.length) {
          const b = batch[cursor++];
          try {
            const sent2 = b.sent; const srcZh2 = detectTarget(sent2) === 'id';
            const raw2 = await translateSingle(cfg, sent2);
            const val = enforceDictOut(applyDictOut(raw2, dict, srcZh2), dict, sent2, srcZh2);
            if (looksLikeEcho(sent2, val)) { b.reject(new Error(ECHO_MSG)); continue; } // v1.1.19
            c.set(b.key, val);
            scheduleSaveCache();
            b.resolve(val);
          } catch (err2) {
            b.reject(err2);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SINGLE_CONCURRENCY, batch.length) }, worker));
    }
  }
}

// ---------------- 消息路由 ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'wtranslate') {
    if (!Array.isArray(msg.texts)) {
      sendResponse({ ok: false, error: 'texts 必须是数组' });
      return true;
    }
    Promise.all(msg.texts.map((t) => enqueue(String(t)).catch((e) => ({ __error: e.message }))))
      .then((results) => {
        const translations = results.map((r) =>
          typeof r === 'string' ? r : null
        );
        const errors = results.map((r) =>
          typeof r === 'string' ? null : r?.__error || '未知错误'
        );
        sendResponse({ ok: true, translations, errors });
      });
    return true; // async
  }

  if (msg?.type === 'wtranslate-test') {
    (async () => {
      try {
        const cfg = { ...DEFAULTS, ...msg.config };
        const out = await translateSingle(cfg, '你好，这批货明天发货');
        sendResponse({ ok: true, sample: out });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'wtranslate-stats') {
    (async () => {
      const c = await loadCache();
      sendResponse({ cacheSize: c.size });
    })();
    return true;
  }

  if (msg?.type === 'wtranslate-forget') {
    // v1.1.19 ⟳ 刷新按钮：删掉该文本的全部缓存条目 → 下一次请求必走 API 重译
    (async () => {
      const c = await loadCache();
      const t = String(msg.text || '');
      let n = 0;
      for (const k of [...c.keys()]) if (k.endsWith('|' + t)) { c.delete(k); n++; }
      scheduleSaveCache();
      sendResponse({ ok: true, removed: n });
    })();
    return true;
  }

  if (msg?.type === 'wtranslate-clear-cache') {
    (async () => {
      cache = new Map();
      await chrome.storage.local.remove(CACHE_KEY);
      sendResponse({ ok: true });
    })();
    return true;
  }
});
