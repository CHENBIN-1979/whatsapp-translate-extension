// v1.1.27 真浏览器 e2e：加载 MV3 扩展，service worker 真实 fetch 打 mock27(8791)。
// 验证：DARIMINTO 混合句首轮回显→重试→返回印尼文译文（2 次 API）；纯人名 Adyanto 不重试（1 次）。
const pcore = require('puppeteer-core');
const path = require('path');

const EXT = __dirname;
const MOCK = 'http://127.0.0.1:8791/v1';
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, e !== undefined ? JSON.stringify(e) : ''); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getExtId(browser) {
  for (let i = 0; i < 40; i++) {
    const sw = browser.targets().find(t => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
    if (sw) return sw.url().split('/')[2];
    await sleep(250);
  }
  throw new Error('service worker not found');
}

(async () => {
  const browser = await pcore.launch({
    executablePath: '/snap/bin/chromium', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const id = await getExtId(browser);
  console.log('EXT_ID', id);

  // 配置 storage：指向 mock
  const setup = await browser.newPage();
  await setup.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await setup.evaluate(async (mock) => {
    await chrome.storage.local.set({ apiKey: '***', apiBase: mock, model: 'test', enabled: true });
    await chrome.storage.local.remove('wtrans_cache_v2');
  }, MOCK);
  await setup.close();

  // 发起页：在 popup context 里 sendMessage 触发 background 真实翻译
  async function translate(texts) {
    const pg = await browser.newPage();
    await pg.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
    const resp = await pg.evaluate(async (t) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'wtranslate', texts: t }, (r) => resolve(r));
    }), texts);
    await pg.close();
    return resp;
  }
  async function hits() {
    const r = await fetch(MOCK.replace('/v1', '') + '/hits'); return r.json();
  }
  // 重置计数
  await fetch(MOCK.replace('/v1', '') + '/hits?reset=1');

  // T1: DARIMINTO 混合句 → 期望重试成功返回印尼文译文
  {
    const resp = await translate(['DARIMINTO 立即查看是否可以现在修复']);
    const t = resp && resp.translations && resp.translations[0];
    ok(resp && resp.ok, 'E1_resp_ok', resp);
    ok(t === 'DARIMINTO, silakan cek sekarang apakah bisa diperbaiki', 'E1_dariminto_translated', t);
    const h = await hits();
    // DARIMINTO 句被请求 2 次（首轮回显 + 重试）
    ok(h.per['DARIMINTO 立即查看是否可以现在修复'] === 2, 'E1_two_api_calls', h.per);
  }

  // T2: 纯人名 → 不重试，1 次，原样返回（专名保留）
  {
    await fetch(MOCK.replace('/v1', '') + '/hits?reset=1');
    const resp = await translate(['Adyanto Setiaji']);
    const t = resp && resp.translations && resp.translations[0];
    ok(t === 'Adyanto Setiaji', 'E2_name_kept', t);
    const h = await hits();
    ok(h.per['Adyanto Setiaji'] === 1, 'E2_no_retry', h.per);
  }

  // T3: 纯号码+1词 → 不重试
  {
    await fetch(MOCK.replace('/v1', '') + '/hits?reset=1');
    const resp = await translate(['0895392493636 siswanto']);
    const h = await hits();
    ok(h.per['0895392493636 siswanto'] === 1, 'E3_phone_no_retry', h.per);
  }

  // T4: 重复点击 DARIMINTO（已缓存重试译文）→ 0 次新 API
  {
    await fetch(MOCK.replace('/v1', '') + '/hits?reset=1');
    const resp = await translate(['DARIMINTO 立即查看是否可以现在修复']);
    const t = resp && resp.translations && resp.translations[0];
    ok(t === 'DARIMINTO, silakan cek sekarang apakah bisa diperbaiki', 'E4_cached_retry', t);
    const h = await hits();
    ok(h.total === 0, 'E4_zero_api_cached', h);
  }

  await browser.close();
  console.log(`\n${fail === 0 ? 'E2E27_ALL_PASS' : 'E2E27_FAIL'} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('E2E27_ERROR', e); process.exit(2); });
