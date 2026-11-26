// 第四轮：模拟 APK 里的 AppBridge，验证「原生存储」这条代码路径
// （这是 WebView 壳最容易出问题的地方：桥方法名/返回值/持久化）
const BASE = 'http://127.0.0.1:9222';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, c, d) => { results.push({ n, ok: !!c, d }); console.log((c ? 'PASS ' : 'FAIL ') + n + (d !== undefined ? '  ' + JSON.stringify(d) : '')); };

class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.errors = [];
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws')); });
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { this.p.get(m.id)(m.result || {}); this.p.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.text);
    };
  }
  async init() { await this.ready; await this.send('Runtime.enable'); await this.send('Page.enable'); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.p.set(id, res); this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
    });
  }
  async js(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  async goto(u, w = 1100) { await this.send('Page.navigate', { url: u }); await sleep(w); }
}

// 伪 AppBridge：用 sessionStorage 模拟原生文件，跨刷新保留
const FAKE_BRIDGE = `
(function(){
  window.__calls = [];
  const KEY = 'fake_native_fs';
  function readAll(){ try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch(e){ return {}; } }
  function writeAll(o){ sessionStorage.setItem(KEY, JSON.stringify(o)); }
  window.AppBridge = {
    systemDark: function(){ window.__calls.push('systemDark'); return '1'; },
    setStatusBarColor: function(d){ window.__calls.push('setStatusBarColor:' + d); },
    toast: function(m){ window.__calls.push('toast:' + m); },
    copyText: function(t){ window.__calls.push('copyText:' + t.length); sessionStorage.setItem('lastCopy', t); },
    storageGet: function(k){ window.__calls.push('get:' + k); const all = readAll(); return Object.prototype.hasOwnProperty.call(all, k) ? all[k] : null; },
    storageSet: function(k, v){ window.__calls.push('set:' + k); const all = readAll(); all[k] = v; writeAll(all); return true; }
  };
})();
`;

async function main() {
  const target = await fetch(BASE + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' }).then(r => r.json());
  const c = new CDP(target.webSocketDebuggerUrl);
  await c.init();
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE });

  // 先清干净上一轮遗留数据，模拟「首次安装」
  await c.goto('http://127.0.0.1:8899/');
  await c.js(`localStorage.clear(); sessionStorage.clear();`);
  await c.goto('http://127.0.0.1:8899/', 1200);
  const first = await c.js(`(() => ({
    empty: !!document.querySelector('.empty'),
    theme: document.documentElement.getAttribute('data-theme'),
    ls: localStorage.length,
    calls: window.__calls.slice(0, 6)
  }))()`);
  console.log('\n--- 首次启动（模拟 APK）---'); console.log(JSON.stringify(first));
  check('空数据进入引导页', first.empty === true, first.empty);
  check('主题读取原生 systemDark → 深色', first.theme === 'dark', first.theme);
  check('未写 localStorage（走原生存储）', first.ls === 0, first.ls);
  check('调用了 storageGet', first.calls.some(x => x.startsWith('get:')), first.calls);

  // 建分类 + 记一笔
  await c.js(`document.querySelector('[data-act="new-cat"]').click()`);
  await sleep(450);
  await c.js(`(() => { const n = document.querySelector('#fName'); n.value = '饮食'; n.dispatchEvent(new Event('input')); })()`);
  await c.js(`document.querySelector('#fSave').click()`);
  await sleep(600);
  const afterCat = await c.js(`(() => ({ cards: document.querySelectorAll('.cat-card[data-id]').length,
      stored: !!sessionStorage.getItem('fake_native_fs') }))()`);
  check('新建分类写入原生存储', afterCat.cards === 1 && afterCat.stored === true, afterCat);

  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(400);
  await c.js(`document.querySelector('.fab').click()`);
  await sleep(450);
  for (const k of ['1', '2', '.', '5']) await c.js(`[...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key===${JSON.stringify(k)}).click()`);
  await c.js(`document.querySelector('#saveBtn').click()`);
  await sleep(700);
  const afterEntry = await c.js(`(() => {
    const raw = sessionStorage.getItem('fake_native_fs') || '{}';
    const db = JSON.parse(JSON.parse(raw)['catledger.db.v1'] || '{}');
    return { entries: (db.entries||[]).length, amount: db.entries && db.entries[0] && db.entries[0].amount,
             cats: (db.categories||[]).length, rows: document.querySelectorAll('.row').length };
  })()`);
  console.log('\n--- 记账后 ---'); console.log(JSON.stringify(afterEntry));
  check('账目写入原生存储且金额正确（分）', afterEntry.entries === 1 && afterEntry.amount === 1250, afterEntry);
  check('列表立即刷新', afterEntry.rows === 1, afterEntry.rows);

  // 刷新后数据仍在（模拟重开 App）
  await c.goto('http://127.0.0.1:8899/', 1200);
  const reopened = await c.js(`(() => ({
    cards: document.querySelectorAll('.cat-card[data-id]').length,
    ls: localStorage.length,
    theme: document.documentElement.getAttribute('data-theme')
  }))()`);
  console.log('\n--- 重开后 ---'); console.log(JSON.stringify(reopened));
  check('重启后分类仍在', reopened.cards === 1, reopened.cards);
  check('仍然不依赖 localStorage', reopened.ls === 0, reopened.ls);

  // 导出走原生剪贴板
  await c.js(`document.querySelector('[data-act="settings"]').click()`);
  await sleep(350);
  await c.js(`document.querySelector('[data-act="export"]').click()`);
  await sleep(450);
  await c.js(`document.querySelector('#expCopy').click()`);
  await sleep(400);
  const copied = await c.js(`(() => {
    const t = sessionStorage.getItem('lastCopy');
    if (!t) return { ok: false };
    try { const o = JSON.parse(t); return { ok: true, cats: o.categories.length, ents: o.entries.length }; } catch (e) { return { ok: false, raw: t.slice(0, 40) }; }
  })()`);
  check('导出走原生 copyText 且 JSON 合法', copied.ok === true && copied.ents === 1, copied);

  // 深浅色切换会通知原生改状态栏
  await c.js(`window.__back()`);
  await sleep(250);
  await c.js(`document.querySelector('[data-act="theme"][data-v="light"]').click()`);
  await sleep(400);
  const barCalls = await c.js(`window.__calls.filter(x => x.startsWith('setStatusBarColor'))`);
  const lightTheme = await c.js(`document.documentElement.getAttribute('data-theme')`);
  check('切换浅色后通知原生改状态栏', lightTheme === 'light' && barCalls.some(x => x.endsWith(':false')), barCalls);

  const errs = c.errors.filter(e => e && !/favicon/i.test(e));
  check('无 JS 异常（第四轮）', errs.length === 0, errs.slice(0, 3));

  const bad = results.filter(r => !r.ok);
  console.log('\n==== ' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
  if (bad.length) bad.forEach(f => console.log(' - ' + f.n + ' ' + JSON.stringify(f.d)));
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error('崩溃', e.message); process.exit(2); });