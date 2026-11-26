// 第五轮：直接以 file:// 打开「打好的 assets」，模拟 APK 里 WebView 的加载方式。
// 目的：排除「装上去白屏」这类灾难性问题（路径、相对引用、file 协议限制）。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

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
  async goto(u, w = 1200) { await this.send('Page.navigate', { url: u }); await sleep(w); }
}

const FAKE_BRIDGE = `
(function(){
  const KEY='fake_native_fs';
  function readAll(){ try{ return JSON.parse(sessionStorage.getItem(KEY)||'{}'); }catch(e){ return {}; } }
  window.AppBridge = {
    systemDark: function(){ return '0'; },
    setStatusBarColor: function(){}, toast: function(){},
    copyText: function(){},
    storageGet: function(k){ const a=readAll(); return Object.prototype.hasOwnProperty.call(a,k)?a[k]:null; },
    storageSet: function(k,v){ const a=readAll(); a[k]=v; sessionStorage.setItem(KEY, JSON.stringify(a)); return true; }
  };
})();`;

async function main() {
  const target = await fetch(BASE + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' }).then(r => r.json());
  const c = new CDP(target.webSocketDebuggerUrl);
  await c.init();
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE });

  const indexFile = path.resolve('build/assets/index.html');
  const url = pathToFileURL(indexFile).href;
  console.log('打开:', url);

  await c.goto(url, 1500);
  const state = await c.js(`(() => ({
    title: document.title,
    cssLoaded: getComputedStyle(document.body).backgroundColor,
    appRendered: document.getElementById('app').children.length > 0,
    hasEmpty: !!document.querySelector('.empty'),
    hasCssFile: [...document.styleSheets].some(s => (s.href||'').endsWith('style.css')),
    appJsLoaded: typeof window.__back === 'function',
    proto: location.protocol
  }))()`);
  console.log('\n--- file:// 加载结果 ---'); console.log(JSON.stringify(state, null, 1));
  check('file:// 下页面能打开', state.title === '分类账', state.title);
  check('style.css 被加载', state.hasCssFile === true, state.hasCssFile);
  check('app.js 执行成功（__back 存在）', state.appJsLoaded === true);
  check('视图已渲染', state.appRendered === true);
  check('CSS 生效（背景色非默认）', state.cssLoaded === 'rgb(246, 247, 249)', state.cssLoaded);

  // 完整走一遍：建分类 → 记账 → 查询
  await c.js(`document.querySelector('[data-act="new-cat"]').click()`);
  await sleep(500);
  const editorUp = await c.js(`!!document.querySelector('#fName')`);
  check('file:// 下弹层可用', editorUp === true);

  await c.js(`(() => { const n=document.querySelector('#fName'); n.value='测试'; n.dispatchEvent(new Event('input')); })()`);
  await c.js(`document.querySelector('#fSave').click()`);
  await sleep(700);
  const card = await c.js(`document.querySelectorAll('.cat-card[data-id]').length`);
  check('file:// 下能新建分类', card === 1, card);

  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(450);
  await c.js(`document.querySelector('.fab').click()`);
  await sleep(500);
  for (const k of ['9', '9']) await c.js(`[...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key===${JSON.stringify(k)}).click()`);
  await c.js(`document.querySelector('#saveBtn').click()`);
  await sleep(700);
  const after = await c.js(`(() => ({
    rows: document.querySelectorAll('.row').length,
    stat: (document.querySelector('.stat .big')||{}).textContent,
    stored: JSON.parse(JSON.parse(sessionStorage.getItem('fake_native_fs')||'{}')['catledger.db.v1']||'{}').entries.length
  }))()`);
  console.log('\n--- file:// 记账后 ---'); console.log(JSON.stringify(after));
  check('file:// 下记账成功并写入原生存储', after.rows === 1 && after.stored === 1 && /99\.00/.test(after.stat || ''), after);

  // 笔记功能在 file:// 下也要能用（且写进原生存储）
  await c.js(`document.querySelector('.note-card').click()`);
  await sleep(500);
  const noteSheet = await c.js(`!!document.querySelector('#nText')`);
  check('file:// 下笔记弹层可打开', noteSheet === true);
  await c.js(`(() => { const t = document.querySelector('#nText'); t.value = 'file 协议下的笔记'; t.dispatchEvent(new Event('input')); })()`);
  await c.js(`document.querySelector('#nSave').click()`);
  await sleep(650);
  const noteSaved = await c.js(`(() => ({
    text: (document.querySelector('.note-card .n-text') || {}).textContent,
    stored: (JSON.parse(JSON.parse(sessionStorage.getItem('fake_native_fs') || '{}')['catledger.db.v1'] || '{}').notes || []).length
  }))()`);
  check('file:// 下笔记写入原生存储', /file 协议下的笔记/.test(noteSaved.text || '') && noteSaved.stored === 1, noteSaved);

  const errs = c.errors.filter(e => e && !/favicon/i.test(e));
  check('file:// 下无 JS 异常', errs.length === 0, errs.slice(0, 3));

  const bad = results.filter(r => !r.ok);
  console.log('\n==== ' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
  if (bad.length) bad.forEach(f => console.log(' - ' + f.n + ' ' + JSON.stringify(f.d)));
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error('崩溃', e.message); process.exit(2); });