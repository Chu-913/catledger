// 第三轮：撤销条点击、备注聚焦收起键盘（用真实鼠标事件）
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  }
  async tapAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async goto(u, w = 900) { await this.send('Page.navigate', { url: u }); await sleep(w); }
}

async function main() {
  const t = await fetch(BASE + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' }).then(r => r.json());
  const c = new CDP(t.webSocketDebuggerUrl);
  await c.init();
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.goto('http://127.0.0.1:8899/?seed=demo&theme=light', 1200);

  // 进入分类，删除一笔，点撤销
  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(400);
  const n0 = await c.js(`document.querySelectorAll('.row').length`);
  await c.js(`document.querySelector('.row').click()`);
  await sleep(450);
  await c.js(`document.querySelector('#delBtn').click()`);
  await sleep(400);
  await c.js(`[...document.querySelectorAll('[data-opt]')].find(b => b.dataset.opt === '1').click()`);
  await sleep(600);
  const n1 = await c.js(`document.querySelectorAll('.row').length`);

  const undoInfo = await c.js(`(() => {
    const bars = [...document.querySelectorAll('div')].filter(d =>
      getComputedStyle(d).position === 'fixed' && /撤销/.test(d.textContent) && d.style.zIndex === '70');
    if (!bars.length) return { found: false };
    const b = bars[0].querySelector('b');
    const r = b.getBoundingClientRect();
    return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent };
  })()`);
  check('撤销条存在且可点', undoInfo.found === true && undoInfo.text === '撤销', undoInfo);

  await c.tapAt(undoInfo.x, undoInfo.y);
  await sleep(700);
  const n2 = await c.js(`document.querySelectorAll('.row').length`);
  const toast = await c.js(`document.querySelector('#toast').textContent`);
  check('点撤销后记录恢复', n2 === n0, { n0, n1, n2, toast });

  // 备注聚焦 → 键盘收起（真实点击）
  await c.js(`document.querySelector('.fab').click()`);
  await sleep(500);
  const box = await c.js(`(() => { const r = document.querySelector('#noteInput').getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
  await c.tapAt(box.x, box.y);
  await sleep(500);
  const hidden = await c.js(`document.querySelector('#keypad').classList.contains('hidden')`);
  const focused = await c.js(`document.activeElement && document.activeElement.id`);
  check('点备注后键盘收起', hidden === true, { hidden, focused });

  const saveVisible = await c.js(`(() => { const r = document.querySelector('#saveBtn').getBoundingClientRect();
    return r.bottom <= innerHeight + 1 && r.top >= 0; })()`);
  check('键盘收起后保存按钮仍可见', saveVisible === true);

  // 失焦后键盘恢复
  await c.js(`document.querySelector('#noteInput').blur()`);
  await sleep(300);
  const shown = await c.js(`!document.querySelector('#keypad').classList.contains('hidden')`);
  check('失焦后键盘恢复', shown === true);

  // 收入切换 + 小数位限制
  await c.js(`[...document.querySelectorAll('#seg button')].find(b=>b.dataset.dir==='in').click()`);
  const segOn = await c.js(`document.querySelector('#seg button.on').dataset.dir`);
  check('可切换收入', segOn === 'in', segOn);

  const digits = ['1', '2', '.', '3', '4', '5'];
  for (const d of digits) await c.js(`[...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key===${JSON.stringify(d)}).click()`);
  const amt = await c.js(`document.querySelector('#amtView').textContent`);
  check('小数最多两位', amt === '12.34', amt);

  const delKey = await c.js(`(() => {
    [...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key==='del').click();
    return document.querySelector('#amtView').textContent; })()`);
  check('退格可用', delKey === '12.3', delKey);

  // 0 元不允许保存
  await c.js(`(() => { const b=document.querySelector('#saveBtn'); })()`);
  const zeroCase = await c.js(`(() => {
    const st = document.querySelector('#amtView');
    for (let i=0;i<12;i++) [...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key==='del').click();
    return { amt: st.textContent, disabled: document.querySelector('#saveBtn').disabled }; })()`);
  check('清空金额后禁用保存', zeroCase.disabled === true, zeroCase);

  const errs = c.errors.filter(e => e && !/favicon/i.test(e));
  check('无 JS 异常（第三轮）', errs.length === 0, errs.slice(0, 3));

  const bad = results.filter(r => !r.ok);
  console.log('\n==== ' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
  if (bad.length) bad.forEach(f => console.log(' - ' + f.n + ' ' + JSON.stringify(f.d)));
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error('崩溃', e.message); process.exit(2); });