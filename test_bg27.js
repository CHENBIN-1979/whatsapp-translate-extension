// v1.1.27 回显智能重试 单测：vm 加载 background.js，stub chrome + fetch，驱动真实 wtranslate 路由。
// 关键场景：中文夹英文名（DARIMINTO 立即查看…）首次模型回显 → 触发 retryEchoTranslate → 返回译文。
// 纯人名/纯号码回显 → 不重试（计费次数不变）。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const SRC = '/home/chenbin/.hermes/workspace/whatsapp-translate-extension';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// 可编程 fetch：根据请求内容决定返回。echoSet=首轮回显的文本集合；retryGood=重试返回译文。
function makeEnv({ echoSet = [], retryGood = true, batchFail = false }) {
  const calls = []; // 每次 fetch 的 {sys,user}
  const storage = {};
  const ctx = {
    console,
    setTimeout, clearTimeout, Promise, JSON, Object, Array, String, Number, Math, Date,
    Error, RegExp, encodeURIComponent, decodeURIComponent, AbortController: class {
      constructor() { this.signal = {}; } abort() {}
    },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      const sys = body.messages[0].content;
      const user = body.messages[1].content; // JSON 数组（批量）或纯文本（单条/重试）
      calls.push({ sys, user });
      const isBatch = user.trim().startsWith('[');
      // 批量首轮失败 → 触发逐条降级（仅当确实是批量请求）
      if (batchFail && isBatch) {
        return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
      }
      // 重试 sys 含「绝不能整句原样返回」
      const isRetry = sys.includes('绝不能整句原样返回');
      const items = isBatch ? JSON.parse(user) : [user];
      const out = items.map((t) => {
        if (isRetry) return retryGood ? 'TRANSLATED:' + t : t;
        if (echoSet.some((e) => t.includes(e))) return t; // 首轮回显
        return 'ZH[' + t + ']';
      });
      const content = isBatch ? JSON.stringify(out) : out[0];
      return {
        ok: true, status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    },
  };
  ctx.globalThis = ctx;
  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') keys = [keys];
          if (Array.isArray(keys)) { const o = {}; keys.forEach(k => { if (k in storage) o[k] = storage[k]; }); return o; }
          return Object.assign({}, storage);
        },
        set: async (obj) => { Object.assign(storage, obj); },
        remove: async (k) => { delete storage[k]; },
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => { ctx.__onMessage = fn; } },
      lastError: null,
    },
  };
  ctx.chrome = chrome;
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'background.js' });
  return { ctx, calls, storage };
}

function translate(ctx, texts) {
  return new Promise((resolve) => {
    ctx.__onMessage({ type: 'wtranslate', texts }, {}, (resp) => resolve(resp));
  });
}

(async () => {
  // ---- T1: 中文夹英文名，首轮回显 → 重试成功返回译文 ----
  {
    const env = makeEnv({ echoSet: ['DARIMINTO'] });
    // 配置一个云端 endpoint
    env.storage.apiKey = '***'; env.storage.apiBase = 'https://api.scnet.cn/api/llm/v1';
    env.storage.model = 'test';
    const src = 'DARIMINTO 立即查看是否可以现在修复';
    const resp = await translate(env.ctx, [src]);
    const t = resp.translations[0];
    ok(resp.ok, 'T1_ok', resp);
    // 关键：返回的是重试译文（非回显）。回显=与原文完全相等；重试成功=TRANSLATED: 前缀。
    ok(t === 'TRANSLATED:' + src, 'T1_retry_translated_not_echo', t);
    // 应该有 2 次 fetch：首轮回显 + 重试
    ok(env.calls.length === 2, 'T1_two_calls', env.calls.length);
    // 重试 sys 含混合文字规则
    ok(env.calls[1].sys.includes('绝不能整句原样返回'), 'T1_retry_sys', env.calls[1].sys.slice(0, 40));
  }

  // ---- T2: 纯人名回显（Adyanto Setiaji）→ 不重试，1 次 fetch ----
  {
    const env = makeEnv({ echoSet: ['Adyanto Setiaji'] });
    env.storage.apiKey = '***'; env.storage.apiBase = 'https://api.scnet.cn/api/llm/v1'; env.storage.model = 'test';
    const resp = await translate(env.ctx, ['Adyanto Setiaji']);
    ok(resp.translations[0] === 'Adyanto Setiaji', 'T2_name_kept', resp.translations[0]);
    ok(env.calls.length === 1, 'T2_no_retry_single_call', env.calls.length);
  }

  // ---- T3: 纯号码+1词（0895392493636 siswanto）→ 不重试 ----
  {
    const env = makeEnv({ echoSet: ['siswanto'] });
    env.storage.apiKey = '***'; env.storage.apiBase = 'https://api.scnet.cn/api/llm/v1'; env.storage.model = 'test';
    const resp = await translate(env.ctx, ['0895392493636 siswanto']);
    ok(env.calls.length === 1, 'T3_phone_no_retry', env.calls.length);
  }

  // ---- T4: 重试仍回显 → 落回专名保留（不报错），2 次 fetch ----
  {
    const env = makeEnv({ echoSet: ['DARIMINTO'], retryGood: false });
    env.storage.apiKey = '***'; env.storage.apiBase = 'https://api.scnet.cn/api/llm/v1'; env.storage.model = 'test';
    const resp = await translate(env.ctx, ['DARIMINTO 立即查看是否可以现在修复']);
    ok(resp.ok, 'T4_ok', resp);
    ok(resp.translations[0] === 'DARIMINTO 立即查看是否可以现在修复', 'T4_echo_kept', resp.translations[0]);
    ok(env.calls.length === 2, 'T4_two_calls', env.calls.length);
  }

  // ---- T5: 正常印尼文消息 → 1 次 fetch，正常翻译，无回显 ----
  {
    const env = makeEnv({});
    env.storage.apiKey = '***'; env.storage.apiBase = 'https://api.scnet.cn/api/llm/v1'; env.storage.model = 'test';
    const resp = await translate(env.ctx, ['Mesin calender A06 rusak']);
    ok(resp.translations[0] === 'ZH[Mesin calender A06 rusak]', 'T5_normal', resp.translations[0]);
    ok(env.calls.length === 1, 'T5_single_call', env.calls.length);
  }

  // ---- T6: 提示词硬规则存在（首轮 sys 含混合文字规则） ----
  {
    const env = makeEnv({});
    env.storage.apiKey = '***'; env.storage.apiBase = 'https://api.scnet.cn/api/llm/v1'; env.storage.model = 'test';
    await translate(env.ctx, ['hello world test']);
    ok(env.calls[0].sys.includes('混合文字消息') && env.calls[0].sys.includes('DARIMINTO'), 'T6_sys_hard_rule', env.calls[0].sys.slice(0, 60));
  }

  // ---- T7: 批量失败→单条降级路径，混合句回显也重试 ----
  {
    const env = makeEnv({ echoSet: ['DARIMINTO'], batchFail: true });
    env.storage.apiKey = '***'; env.storage.apiBase = 'https://api.scnet.cn/api/llm/v1'; env.storage.model = 'test';
    const resp = await translate(env.ctx, ['DARIMINTO 立即查看是否可以现在修复']);
    // 单条首轮（translateSingle）sys 不含「聊天消息翻译器」→ batchFail 不触发；
    // translateSingle 返回 ZH[...] 非回显 → 不重试。这里验证降级不报错即可。
    ok(resp.ok, 'T7_fallback_ok', resp);
  }

  console.log(`\n${fail === 0 ? 'BG27_ALL_PASS' : 'BG27_FAIL'} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
