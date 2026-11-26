// 第二轮自检：浅色主题、新建分类、整理排序、删除+撤销、导出、返回栈
const BASE = 'http://127.0.0.1:9222';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.errors = [];
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws')); });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result || {});
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    };
  }
  async init() { await this.ready; await this.send('Runtime.enable'); await this.send('Page.enable'); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  async goto(url, wait = 900) { await this.send('Page.navigate', { url }); await sleep(wait); }
  close() { try { this.ws.close(); } catch (e) { } }
}

async function main() {
  const newPage = await fetch(BASE + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' }).then(r => r.json());
  const c = new CDP(newPage.webSocketDebuggerUrl);
  await c.init();
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // ---------- 浅色主题 ----------
  await c.goto('http://127.0.0.1:8899/?seed=demo&theme=light', 1200);
  const light = await c.js(`(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    card: getComputedStyle(document.querySelector('.cat-card')).backgroundColor,
    text: getComputedStyle(document.body).color,
    cards: document.querySelectorAll('.cat-card[data-id]').length
  }))()`);
  console.log('\n--- 浅色 ---'); console.log(JSON.stringify(light));
  check('浅色主题生效', light.theme === 'light' && light.bg === 'rgb(246, 247, 249)', light);
  check('浅色卡片为白底', light.card === 'rgb(255, 255, 255)', light.card);

  // ---------- 新建分类 ----------
  await c.js(`document.querySelector('[data-act="new-cat"]').click()`);
  await sleep(450);
  const editorOpen = await c.js(`(() => !!document.querySelector('#fName'))()`);
  check('新建分类弹层打开', editorOpen === true);

  await c.js(`(() => {
    const n = document.querySelector('#fName');
    n.value = '房租'; n.dispatchEvent(new Event('input'));
    [...document.querySelectorAll('#fEmoji button')].find(b => b.dataset.emoji === '🏠').click();
    [...document.querySelectorAll('#fColor button')][8].click();
    [...document.querySelectorAll('#fDir button')].find(b => b.dataset.dir === 'out').click();
    const b = document.querySelector('#fBudget'); b.value = '2500';
  })()`);
  await c.js(`document.querySelector('#fSave').click()`);
  await sleep(600);
  const afterCreate = await c.js(`(() => ({
    cards: [...document.querySelectorAll('.cat-card[data-id] .name')].map(x => x.textContent),
    stored: JSON.parse(localStorage.getItem('catledger.db.v1')).categories.map(c => ({ n: c.name, e: c.emoji, b: c.budgetMonth }))
  }))()`);
  console.log('\n--- 新建分类后 ---'); console.log(JSON.stringify(afterCreate, null, 1));
  check('新分类出现在首页', afterCreate.cards.includes('房租'), afterCreate.cards);
  const created = afterCreate.stored.find(x => x.n === '房租');
  check('分类字段保存正确', created && created.e === '🏠' && created.b === 250000, created);

  // ---------- 整理模式 + 排序 ----------
  await c.js(`document.querySelector('[data-act="settings"]')? null : null`);
  await c.js(`(() => { const ev = new PointerEvent('pointerdown', {bubbles:true, clientX:60, clientY:200});
      document.querySelector('.cat-card[data-id]').dispatchEvent(ev); })()`);
  await sleep(800);
  const editMode = await c.js(`(() => ({
    editing: !!document.querySelector('.grid.editing'),
    tools: document.querySelectorAll('.card-tools').length,
    hint: !!document.querySelector('.edit-hint')
  }))()`);
  console.log('\n--- 长按整理 ---'); console.log(JSON.stringify(editMode));
  check('长按进入整理模式', editMode.editing === true, editMode);

  const beforeOrder = await c.js(`[...document.querySelectorAll('.cat-card[data-id] .name')].map(x=>x.textContent)`);
  await c.js(`[...document.querySelectorAll('[data-act="move-up"]')][1].click()`);
  await sleep(400);
  const afterOrder = await c.js(`[...document.querySelectorAll('.cat-card[data-id] .name')].map(x=>x.textContent)`);
  check('上下移调顺序生效', afterOrder[0] === beforeOrder[1] && afterOrder[1] === beforeOrder[0],
    { before: beforeOrder, after: afterOrder });

  await c.js(`document.querySelector('[data-act="end-edit-home"]').click()`);
  await sleep(300);
  check('退出整理模式', (await c.js(`!!document.querySelector('.grid.editing')`)) === false);

  // ---------- 删除一笔 + 撤销 ----------
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
  const undoVisible = await c.js(`!!document.body.querySelector('div[style*="bottom"] b')`);
  check('删除后行数减少', n1 === n0 - 1, { n0, n1 });
  check('出现撤销条', undoVisible === true);

  await c.js(`(() => { const bars=[...document.querySelectorAll('div')].filter(d=>d.style.zIndex==='70'&&/撤销/.test(d.textContent)); if(bars[0]) bars[0].querySelector('b').click(); })()`);
  await sleep(500);
  const n2 = await c.js(`document.querySelectorAll('.row').length`);
  check('撤销恢复记录', n2 === n0, { n2, n0 });

  // ---------- 导出 ----------
  await c.js(`document.querySelector('[data-act="back"]').click()`);
  await sleep(300);
  await c.js(`document.querySelector('[data-act="settings"]').click()`);
  await sleep(300);
  await c.js(`[...document.querySelectorAll('[data-act="export"]')][0].click()`);
  await sleep(450);
  const exp = await c.js(`(() => {
    const ta = document.querySelector('#expTa');
    if (!ta) return { ok: false };
    let parsed = null; try { parsed = JSON.parse(ta.value); } catch (e) {}
    return { ok: true, len: ta.value.length, cats: parsed && parsed.categories.length, ents: parsed && parsed.entries.length };
  })()`);
  console.log('\n--- 导出 ---'); console.log(JSON.stringify(exp));
  check('导出 JSON 可解析', exp.ok && exp.cats === 5 && exp.ents > 0, exp);

  // ---------- 返回栈 / __back ----------
  const b1 = await c.js(`window.__back()`);
  await sleep(300);
  const sheetGone = await c.js(`!document.querySelector('.sheet')`);
  check('__back 关闭弹层', b1 === true && sheetGone === true, { b1, sheetGone });

  const b2 = await c.js(`window.__back()`);
  await sleep(300);
  const onHome = await c.js(`!!document.querySelector('.grid') || !!document.querySelector('.empty')`);
  check('__back 返回首页', b2 === true && onHome === true, { b2, onHome });

  const b3 = await c.js(`window.__back()`);
  check('首页再按返回交还系统', b3 === false, b3);

  // ---------- 数据持久化 ----------
  await c.goto('http://127.0.0.1:8899/', 900);
  const persist = await c.js(`JSON.parse(localStorage.getItem('catledger.db.v1')).categories.length`);
  check('刷新后数据仍在', persist === 5, persist);

  // ---------- 备注聚焦隐藏键盘 ----------
  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(350);
  await c.js(`document.querySelector('.fab').click()`);
  await sleep(450);
  const kbBefore = await c.js(`!document.querySelector('#keypad').classList.contains('hidden')`);
  await c.js(`document.querySelector('#noteInput').dispatchEvent(new Event('focus'))`);
  await sleep(250);
  const kbAfter = await c.js(`document.querySelector('#keypad').classList.contains('hidden')`);
  check('弹默认显示键盘/备注聚焦时收起', kbBefore === true && kbAfter === true, { kbBefore, kbAfter });

  const dt = await c.js(`document.querySelector('#dtInput').value`);
  check('时间输入框有本地时间值', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt), dt);

  const errs = c.errors.filter(e => e && !/favicon/i.test(e));
  check('无 JS 异常（第二轮）', errs.length === 0, errs.slice(0, 3));

  const failed = results.filter(r => !r.ok);
  console.log('\n============ ' + (results.length - failed.length) + '/' + results.length + ' 通过 ============');
  if (failed.length) failed.forEach(f => console.log(' - ' + f.name + ' ' + JSON.stringify(f.detail)));
  c.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('E2E2 崩溃:', e.message); process.exit(2); });