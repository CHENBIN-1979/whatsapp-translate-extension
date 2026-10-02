/* popup.js — 设置页逻辑（v1.1.24：例句独立框 / 注入模式开关 / 折叠区默认收起各自记忆） */

const $ = (id) => document.getElementById(id);
const FIELDS = ['apiBase', 'apiKey', 'model', 'temperature'];

function setStatus(kind, text) {
  const el = $('status');
  el.className = kind;
  el.textContent = text;
}

// v1.1.24 词典/例句分离成两个框。词典行：印尼文 = 中文（分隔符兼容 = / : / ： / 全角＝ / → / ->）
// 例句行：印尼文例句 = 中文例句（同分隔符）。旧版「术语 = 中文 | 例句」行在加载时自动拆分迁移。
const KV_SEP = /(?:[=:：＝→]|->)/;
function splitKV(line) {
  const i = line.search(KV_SEP);
  if (i < 0) return null;
  const sepLen = line.startsWith('->', i) ? 2 : 1;
  const k = line.slice(0, i).trim();
  const v = line.slice(i + sepLen).replace(/^[=:：＝→\s]+/, '').trim();
  if (!k || !v) return null;
  return { k, v };
}
function parseDictText(txt) {
  // 返回 {dict, ex, ignored}——ex 只在旧格式（行内含 | 例句）时非空，供迁移；ignored = 解析失败的行数
  const dict = {}, ex = {};
  let ignored = 0;
  for (const rawLine of (txt || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const bar = line.indexOf('|');
    const head = bar < 0 ? line : line.slice(0, bar);
    const tail = bar < 0 ? '' : line.slice(bar + 1);
    const kv = splitKV(head);
    if (!kv) { ignored++; continue; }
    dict[kv.k] = kv.v;
    if (tail.trim()) {
      const ekv = splitKV(tail);
      if (ekv) ex[kv.k.toLowerCase()] = [ekv.k, ekv.v]; // 旧格式例句 → 迁移进例句框
    }
  }
  return { dict, ex, ignored };
}
function textToDict(txt) { return parseDictText(txt).dict; } // 兼容旧调用
function dictToText(obj) {
  return Object.entries(obj || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
}
// 例句框 <-> customDictEx = {印尼例句(小写键): [印尼例句, 中文例句]}
function parseExText(txt) {
  const ex = {};
  let ignored = 0;
  for (const rawLine of (txt || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const kv = splitKV(line);
    if (!kv) { ignored++; continue; }
    ex[kv.k.toLowerCase()] = [kv.k, kv.v];
  }
  return { ex, ignored };
}
function exToText(obj) {
  const out = [];
  for (const v of Object.values(obj || {})) {
    const arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v, ''] : null);
    if (!arr) continue;
    const idS = String(arr[0] || '').trim(), zhS = String(arr[1] || '').trim();
    if (idS && zhS) out.push(`${idS} = ${zhS}`);
    else if (idS || zhS) out.push(idS || zhS);
  }
  return out.join('\n');
}
function fmtLogTs(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------- v1.1.20 多配置列表 ----------------
// profiles: [{id,name,apiBase,apiKey,model,temperature}]，activeProfile 指当前启用 id。
// 迁移：旧版只有扁平字段（apiBase/apiKey/model/temperature）。首次见到「扁平字段已被用户
// 配置过且无 profiles」时，自动打包成第一条「默认配置」，不丢用户的 Key。
let profiles = [];
let activeId = '';

const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function normalizeProfiles(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && String(p.name || '').trim())
    .map((p) => ({
      id: String(p.id || newId()),
      name: String(p.name).trim().slice(0, 30),
      apiBase: String(p.apiBase || 'https://api.scnet.cn/api/llm/v1').trim(),
      apiKey: String(p.apiKey || '').trim(),
      model: String(p.model || 'Qwen3.8-Flash').trim(),
      temperature: Number(p.temperature ?? 0.2),
    }));
}

function currentProfile() {
  return profiles.find((p) => p.id === activeId) || profiles[0] || null;
}

// 把表单值写回当前 profile（不保存磁盘，仅内存，切条/保存时用）
function commitFormToProfile() {
  const p = currentProfile();
  if (!p) return;
  p.name = $('pName').value.trim() || p.name || '未命名';
  p.apiBase = $('apiBase').value.trim() || 'https://api.scnet.cn/api/llm/v1';
  p.apiKey = $('apiKey').value.trim();
  p.model = $('model').value.trim() || 'Qwen3.8-Flash';
  p.temperature = Math.min(2, Math.max(0, parseFloat($('temperature').value) || 0.2));
  // 名称唯一化：重名自动加序号，避免下拉框两条同名分不清
  const base = p.name;
  let n = 2;
  while (profiles.some((o) => o !== p && o.name === p.name)) p.name = `${base} (${n++})`;
}

// v1.1.21 表单是否有未保存的修改（与当前存储值比较）
function isFormDirty() {
  const p = currentProfile();
  if (!p) return false;
  const t = parseFloat($('temperature').value);
  return p.name !== $('pName').value.trim()
    || p.apiBase !== $('apiBase').value.trim()
    || p.apiKey !== $('apiKey').value.trim()
    || p.model !== $('model').value.trim()
    || p.temperature !== (isNaN(t) ? 0.2 : Math.min(2, Math.max(0, t)));
}

function uniqueName(base0) {
  let nm = base0 || '新配置', n = 2;
  while (profiles.some((o) => o.name === nm)) nm = `${base0 || '新配置'} (${n++})`;
  return nm;
}

function renderForm() {
  const p = currentProfile();
  if (!p) {
    $('pName').value = '默认配置';
    $('apiBase').value = 'https://api.scnet.cn/api/llm/v1';
    $('apiKey').value = '';
    $('model').value = 'Qwen3.8-Flash';
    $('temperature').value = 0.2;
    return;
  }
  $('pName').value = p.name;
  $('apiBase').value = p.apiBase;
  $('apiKey').value = p.apiKey;
  $('model').value = p.model;
  $('temperature').value = p.temperature;
}

function renderProfileSelect() {
  const sel = $('profileSel');
  sel.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = (p.id === activeId ? '● ' : '') + p.name;
    sel.appendChild(opt);
  }
  if (!profiles.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（无配置——点「＋ 新增」）';
    sel.appendChild(opt);
  }
  sel.value = profiles.some((p) => p.id === activeId) ? activeId : '';
}

async function persistProfiles() {
  await chrome.storage.local.set({ profiles, activeProfile: activeId });
}

async function load() {
  const cfg = await chrome.storage.local.get([
    ...FIELDS, 'enabled', 'fast', 'customDict', 'customDictEx', 'dictMode', 'transFontSize',
    'profiles', 'activeProfile', 'dictOpen', 'exOpen',
  ]);
  $('enabled').checked = cfg.enabled !== false;
  $('fast').checked = cfg.fast !== false;
  // v1.1.24 词典/例句分框 + 旧格式（术语 = 中文 | 例句）自动迁移
  let storedEx = cfg.customDictEx || {};
  const legacy = parseDictText(dictToText(cfg.customDict || {})); // 纯词条文本，无 | 时 ex 为空
  if (Object.keys(legacy.ex).length) storedEx = { ...storedEx, ...legacy.ex }; // 词条框里残留旧格式 → 例句提取走
  $('customDict').value = dictToText(cfg.customDict);
  $('customEx').value = exToText(storedEx);
  const needMigrate = Object.keys(legacy.ex).length > 0;
  // v1.1.23 词典模式（v1.1.24 改开关：开=全词典）/ 字号 / 折叠区展开记忆（默认收起）
  $('dictAllSw').checked = cfg.dictMode === 'all';
  $('dictModeAuto').textContent = cfg.dictMode === 'all' ? '全词典注入' : '自动匹配';
  const fs = Math.min(22, Math.max(12, Number(cfg.transFontSize) || 15));
  $('fontSize').value = String(fs);
  $('fontSizeVal').textContent = fs + 'px';
  $('dictBox').open = cfg.dictOpen === true;
  $('exBox').open = cfg.exOpen === true;
  if (needMigrate) {
    await chrome.storage.local.set({ customDict: legacy.dict, customDictEx: storedEx });
    $('customDict').value = dictToText(legacy.dict);
    setStatus('ok', '✔ 旧格式词典里的 "\| 例句" 已自动拆分到下方例句框');
  }

  profiles = normalizeProfiles(cfg.profiles);
  if (!profiles.length && (cfg.apiKey || cfg.model || (cfg.apiBase && cfg.apiBase !== 'https://api.scnet.cn/api/llm/v1'))) {
    // 旧版单配置迁移成第一条
    profiles = normalizeProfiles([{
      id: newId(), name: '默认配置',
      apiBase: cfg.apiBase, apiKey: cfg.apiKey, model: cfg.model, temperature: cfg.temperature,
    }]);
    activeId = profiles[0].id;
    await persistProfiles();
  } else if (profiles.length) {
    activeId = profiles.find((p) => p.id === cfg.activeProfile) ? cfg.activeProfile : profiles[0].id;
  }
  renderProfileSelect();
  renderForm();

  chrome.runtime.sendMessage({ type: 'wtranslate-stats' }, async (res) => {
    if (res && typeof res.cacheSize === 'number') {
      let noteN = 0;
      try { const r = await chrome.storage.local.get('wtrans_' + 'note_v1'); noteN = Array.isArray(r.wtrans_note_v1) ? r.wtrans_note_v1.length : 0; } catch {}
      $('stats').textContent = `缓存：${res.cacheSize} 条（重复消息不会重复计费）` + (noteN ? `　专有名词保留原文：${noteN} 条（正常，不算失败）` : '');
    }
  });
}

// 「测试/诊断」用的临时 cfg：以当前表单为准，不写盘
function gatherForm() {
  return {
    apiBase: $('apiBase').value.trim() || 'https://api.scnet.cn/api/llm/v1',
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'Qwen3.8-Flash',
    temperature: Math.min(2, Math.max(0, parseFloat($('temperature').value) || 0.2)),
  };
}

$('save').addEventListener('click', async () => {
  if (!profiles.length) {
    setStatus('err', '✘ 还没有模型配置。点「＋ 新增」把当前表单存为第一条配置。');
    return;
  }
  commitFormToProfile();
  await persistProfiles();
  // v1.1.23 大「保存」键连带保存词典（旧版词典编辑必须另点「保存词典」，常被漏掉 → 词条丢失）
  // v1.1.24 连带例句框一起存
  const parsed = parseDictText($('customDict').value);
  const parsedEx = parseExText($('customEx').value);
  const mergedEx = { ...parsedEx.ex, ...parsed.ex }; // 词条框残留旧格式 "| 例句" → 一并收进例句库
  await chrome.storage.local.set({ customDict: parsed.dict, customDictEx: mergedEx });
  $('customEx').value = exToText(mergedEx);
  renderProfileSelect();
  setStatus('ok', '✔ 已保存「' + currentProfile().name + '」与词典（' + Object.keys(parsed.dict).length + ' 条/例句 ' + Object.keys(mergedEx).length + ' 条），翻译即时生效（无需刷新 WhatsApp）');
});

$('profileSel').addEventListener('change', async () => {
  // v1.1.21 切换 = 纯查看切换：绝不把未保存的表单写回旧配置（旧版静默回写会污染数据）
  const dirty = isFormDirty();
  activeId = $('profileSel').value;
  await persistProfiles();        // 只切 activeProfile；翻译在 background 用「已保存」的配置
  renderProfileSelect();
  renderForm();
  const p = currentProfile();
  let msg = '✔ 已切换到「' + (p?.name || '') + '」，当前模型：' + (p?.model || '') + '（翻译立即使用这条已保存的配置）';
  if (dirty) msg += '\n⚠ 切换前表单里有未保存的修改，已丢弃。要保留修改请先点「保存」。';
  setStatus(dirty ? 'err' : 'ok', msg);
});

$('addProfile').addEventListener('click', async () => {
  // v1.1.21 新增 = 复制当前配置「已保存」的值（不再把表单未保存改动回写到旧配置）
  const src = currentProfile();
  const p = src
    ? { ...src, id: newId(), name: uniqueName(src.name) }
    : { id: newId(), name: '新配置', apiBase: 'https://api.scnet.cn/api/llm/v1', apiKey: '', model: 'Qwen3.8-Flash', temperature: 0.2 };
  profiles.push(p);
  activeId = p.id;
  await persistProfiles();
  renderProfileSelect();
  renderForm();
  $('pName').focus(); $('pName').select();
  let msg = '✔ 已新增「' + p.name + '」（复制自当前配置的已保存值），改参数后点「保存」';
  if (src && isFormDirtyFor(src)) msg += '\n⚠ 注意：上一条有未保存的修改未被带过来（新增只复制已保存值）';
  setStatus('ok', msg);
});

function isFormDirtyFor(p) {
  const t = parseFloat($('temperature').value);
  return p.name !== $('pName').value.trim() || p.apiBase !== $('apiBase').value.trim()
    || p.apiKey !== $('apiKey').value.trim() || p.model !== $('model').value.trim()
    || p.temperature !== (isNaN(t) ? 0.2 : Math.min(2, Math.max(0, t)));
}

$('delProfile').addEventListener('click', async () => {
  if (!profiles.length) return;
  const cur = currentProfile();
  if (!cur) return;
  const keepKey = cur.apiKey || '';
  profiles = profiles.filter((p) => p.id !== cur.id);
  activeId = profiles.length ? profiles[0].id : '';
  await persistProfiles();
  if (!profiles.length) {
    await chrome.storage.local.remove(['profiles', 'activeProfile']);
    // 删光时把最后一条的 key 留在扁平字段，方便下次「新增」回填
    await chrome.storage.local.set({ apiKey: keepKey });
  }
  renderProfileSelect();
  renderForm();
  setStatus('ok', '✔ 已删除配置「' + cur.name + '」');
});

$('enabled').addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: $('enabled').checked });
});

$('fast').addEventListener('change', async () => {
  await chrome.storage.local.set({ fast: $('fast').checked });
});

$('saveDict').addEventListener('click', async () => {
  const parsed = parseDictText($('customDict').value);
  const mergedEx = { ...(await chrome.storage.local.get('customDictEx')).customDictEx || {}, ...parsed.ex };
  await chrome.storage.local.set({ customDict: parsed.dict, customDictEx: mergedEx });
  // v1.1.23 规范化回写 + 忽略行明确警告（旧版全角＝等解析失败是静默丢词条的根因之一）
  $('customDict').value = dictToText(parsed.dict);
  const n = Object.keys(parsed.dict).length;
  let msg = n ? `✔ 词典已保存（${n} 条），立即生效；旧译文会自动重新翻译` : '✔ 词典已清空';
  if (parsed.ignored) msg += `\n⚠ ${parsed.ignored} 行没识别（缺 = 或 : 分隔符），已忽略，请检查写法`;
  setStatus(n && !parsed.ignored ? 'ok' : parsed.ignored ? 'err' : 'ok', msg);
});

// v1.1.24 例句独立框：每行「印尼文例句 = 中文例句」
$('saveEx').addEventListener('click', async () => {
  const parsed = parseExText($('customEx').value);
  await chrome.storage.local.set({ customDictEx: parsed.ex });
  $('customEx').value = exToText(parsed.ex);
  const n = Object.keys(parsed.ex).length;
  let msg = n ? `✔ 例句已保存（${n} 条），立即生效；旧译文会自动重新翻译` : '✔ 例句已清空';
  if (parsed.ignored) msg += `\n⚠ ${parsed.ignored} 行没识别（缺 = 或 : 分隔符），已忽略`;
  setStatus(n && !parsed.ignored ? 'ok' : parsed.ignored ? 'err' : 'ok', msg);
});

// v1.1.24 词典注入模式改开关：开=全词典注入，关=自动匹配（省 token、防相近词干扰）
$('dictAllSw').addEventListener('change', async () => {
  const mode = $('dictAllSw').checked ? 'all' : 'auto';
  await chrome.storage.local.set({ dictMode: mode });
  $('dictModeAuto').textContent = mode === 'all' ? '全词典注入' : '自动匹配';
  setStatus('ok', mode === 'all' ? '✔ 已切为「全词典」：每次翻译整本词典注入提示词' : '✔ 已切为「自动匹配」：只有句子里出现的术语/例句才注入提示词（推荐）');
});

// v1.1.23 折叠区展开状态记忆（v1.1.24 词典/例句两框各记各的，默认收起）
$('dictBox').addEventListener('toggle', () => {
  chrome.storage.local.set({ dictOpen: $('dictBox').open });
});
$('exBox').addEventListener('toggle', () => {
  chrome.storage.local.set({ exOpen: $('exBox').open });
});

// v1.1.23 译文字号：拖动即时应用（存盘 → content.js 的 storage.onChanged 实时生效，免刷新、免额外权限）
$('fontSize').addEventListener('input', () => {
  const px = Math.min(22, Math.max(12, Number($('fontSize').value) || 15));
  $('fontSizeVal').textContent = px + 'px';
  clearTimeout($('fontSize')._t);
  $('fontSize')._t = setTimeout(() => {
    chrome.storage.local.set({ transFontSize: px });
  }, 200);
});

$('test').addEventListener('click', async () => {
  setStatus('busy', '测试中，请稍候…');
  chrome.runtime.sendMessage({ type: 'wtranslate-test', config: gatherForm() }, (res) => {
    if (chrome.runtime.lastError) {
      setStatus('err', '✘ 后台不可用：' + chrome.runtime.lastError.message);
      return;
    }
    if (res?.ok) {
      setStatus('ok', '✔ 连接成功。样例输出：\n「你好，这批货明天发货」→ ' + res.sample);
    } else {
      setStatus('err', '✘ 失败：' + (res?.error || '未知错误'));
    }
  });
});

$('diagnose').addEventListener('click', async () => {
  const { wtrans_diag: d } = await chrome.storage.local.get('wtrans_diag');
  if (!d) {
    setStatus('err', '✘ 还没有诊断数据。\n请先打开 web.whatsapp.com 并进入一个聊天窗口，等 5 秒再点诊断。');
    return;
  }
  const a = d.anchors || {};
  const lines = [
    `扩展版本 ${d.version}　页面脚本 ${d.mainFound ? '已就绪' : '运行中(新版布局)'}`,
    `扫描根=${d.root}　策略=${d.strategy}　本轮命中=${d.candidates}　已注入=${d.injected}　失败=${d.failed}　sample=${d.sample ? d.sample.slice(0, 80).replace(/\s+/g, ' ') : '（无）'}`,
    `输入框按钮=${d.composer ? '✔ 已出现' : '✘ 未找到'}`,
    `DOM锚点统计: data-id×${a.dataId ?? '?'}　copyable×${a.copyable ?? '?'}　selectable×${a.selectable ?? '?'}　dirAuto×${a.dirAuto ?? '?'}　message类×${a.messageCls ?? '?'}　侧栏=${a.paneSide ? '有' : '无'}　${d.lastErr ? '　错误: ' + d.lastErr : ''}`,
  ];
  setStatus('busy', lines.join('\n'));
});

$('clearCache').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'wtranslate-clear-cache' }, () => {
    $('stats').textContent = '缓存：0 条';
    setStatus('ok', '缓存已清空');
  });
});

// ---------------- v1.1.23 运行日志 ----------------
async function fetchLog() {
  const { wtrans_log_v1: arr } = await chrome.storage.local.get('wtrans_' + 'log_v1');
  return Array.isArray(arr) ? arr : [];
}
$('exportLog').addEventListener('click', async () => {
  const lines = await fetchLog();
  if (!lines.length) { setStatus('err', '✘ 日志为空。\n在 WhatsApp 页点几条消息翻译后再来导出。'); return; }
  const text = lines.map((l) => `[${fmtLogTs(l.t)}] ${l.lv}: ${l.m}${l.d ? ' | ' + l.d : ''}`).join('\n');
  const head = `WhatsApp翻译插件日志 v1.1.24　${lines.length} 条　导出时间 ${fmtLogTs(Date.now())}\n${'='.repeat(46)}\n`;
  try {
    await navigator.clipboard.writeText(head + text);
    setStatus('ok', '✔ 日志（' + lines.length + ' 条）已复制到剪贴板，直接粘贴发给开发者即可');
  } catch {
    setStatus('busy', '⚠ 复制失败，日志全文如下，请手动选中复制：\n' + head + text);
  }
});
$('clearLog').addEventListener('click', async () => {
  await chrome.storage.local.remove('wtrans_' + 'log_v1');
  setStatus('ok', '✔ 日志已清空');
});

load();
