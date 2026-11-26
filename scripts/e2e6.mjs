// 第六轮：每月每类一篇笔记
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

const URL0 = 'http://127.0.0.1:8899/?seed=demo&theme=light';

async function main() {
  const target = await fetch(BASE + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' }).then(r => r.json());
  const c = new CDP(target.webSocketDebuggerUrl);
  await c.init();
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  await c.goto(URL0);
  await c.js(`localStorage.clear();`);
  await c.goto(URL0, 1300);

  // ---- 首页：有笔记的分类显示 📝 ----
  const home = await c.js(`(() => ({
    cards: document.querySelectorAll('.cat-card[data-id]').length,
    dots: document.querySelectorAll('.cat-card .n-dot').length,
    firstHasDot: !!document.querySelector('.cat-card[data-id] .n-dot')
  }))()`);
  console.log('\n--- 首页 ---'); console.log(JSON.stringify(home));
  check('首页 4 个分类', home.cards === 4, home.cards);
  check('有笔记的分类带 📝 标记', home.dots === 1, home.dots);

  // ---- 进入饮食 ----
  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(500);
  const cat1 = await c.js(`(() => {
    const n = document.querySelector('.note-card');
    return {
      exists: !!n, empty: n ? n.classList.contains('empty') : null,
      ttl: n ? n.querySelector('.n-ttl').textContent : null,
      edit: n ? n.querySelector('.n-edit').textContent : null,
      text: n && n.querySelector('.n-text') ? n.querySelector('.n-text').textContent : null,
      meta: n && n.querySelector('.n-meta') ? n.querySelector('.n-meta').textContent : null
    };
  })()`);
  console.log('\n--- 分类页笔记卡 ---'); console.log(JSON.stringify(cat1));
  check('笔记卡出现', cat1.exists === true);
  check('标题为「11月笔记」', /11月笔记/.test(cat1.ttl || ''), cat1.ttl);
  check('演示笔记内容可见', /苹果/.test(cat1.text || ''), (cat1.text || '').slice(0, 20));
  check('显示更新时间', /更新$/.test(cat1.meta || ''), cat1.meta);

  // ---- 打开笔记弹层 ----
  await c.js(`document.querySelector('.note-card').click()`);
  await sleep(500);
  const sheet = await c.js(`(() => {
    const ta = document.querySelector('#nText');
    return { open: !!ta, value: ta ? ta.value : null, max: ta ? ta.getAttribute('maxlength') : null,
             count: (document.querySelector('#nCount') || {}).textContent,
             hasDel: !!document.querySelector('#nDel') };
  })()`);
  console.log('\n--- 笔记弹层 ---'); console.log(JSON.stringify(sheet));
  check('弹层打开并带出原内容', sheet.open === true && /苹果/.test(sheet.value || ''));
  check('限 500 字并显示计数', sheet.max === '500' && /\/ 500$/.test(sheet.count || ''), sheet.count);
  check('已有笔记时可删除', sheet.hasDel === true);

  // ---- 改内容并保存 ----
  const newText = '这个月多买了一箱苹果，比上个月多花 60。外卖少点了两次，下个月继续。';
  await c.js(`(() => { const t = document.querySelector('#nText'); t.value = ${JSON.stringify(newText)}; t.dispatchEvent(new Event('input')); })()`);
  const counted = await c.js(`document.querySelector('#nCount').textContent`);
  check('输入后计数更新', /^3[0-9] \/ 500$/.test(counted), counted);
  await c.js(`document.querySelector('#nSave').click()`);
  await sleep(600);
  const afterSave = await c.js(`(() => ({
    sheetGone: !document.querySelector('#nText'),
    cardText: (document.querySelector('.note-card .n-text') || {}).textContent,
    toast: (window.__lastToast || '')
  }))()`);
  console.log('\n--- 保存后 ---'); console.log(JSON.stringify(afterSave).slice(0, 200));
  check('保存后弹层关闭', afterSave.sheetGone === true);
  check('卡片内容已更新', /比上个月多花 60/.test(afterSave.cardText || ''), (afterSave.cardText || '').slice(0, 20));

  // ---- 全部模式：笔记列表 ----
  await c.js(`document.querySelector('[data-act="range-all"]').click()`);
  await sleep(450);
  const all1 = await c.js(`(() => {
    const items = [...document.querySelectorAll('.n-item')];
    return { sec: !!document.querySelector('.notes-sec'), count: items.length,
             first: items[0] ? items[0].textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : null,
             head: (document.querySelector('.n-sec-head') || {}).textContent };
  })()`);
  console.log('\n--- 全部模式 ---'); console.log(JSON.stringify(all1));
  check('全部模式有笔记分区', all1.sec === true && all1.count === 1, all1.count);
  check('笔记条目显示月份与首行', /11月/.test(all1.first || ''), all1.first);

  // ---- 上个月：空笔记 → 写一篇 ----
  await c.js(`document.querySelector('[data-act="range-month"]').click()`);
  await sleep(400);
  await c.js(`document.querySelector('[data-act="month-prev"]').click()`);
  await sleep(450);
  const prev = await c.js(`(() => {
    const n = document.querySelector('.note-card');
    return { empty: n.classList.contains('empty'), edit: n.querySelector('.n-edit').textContent,
             ttl: n.querySelector('.n-ttl').textContent, ph: (n.querySelector('.n-ph') || {}).textContent };
  })()`);
  console.log('\n--- 上个月 ---'); console.log(JSON.stringify(prev));
  check('上个月显示空笔记态', prev.empty === true && prev.edit === '写一篇', prev);
  check('空态有引导文案', /苹果/.test(prev.ph || ''), prev.ph);

  await c.js(`document.querySelector('.note-card').click()`);
  await sleep(450);
  const prevSheet = await c.js(`(() => ({ val: (document.querySelector('#nText') || {}).value,
      title: (document.querySelector('.sheet .ttl') || {}).textContent }))()`);
  check('上月笔记弹层为空且标题对应月份', prevSheet.val === '' && /10月/.test(prevSheet.title || ''), prevSheet.title);

  const prevText = '10月：外卖点太多了，水果几乎没买。';
  await c.js(`(() => { const t = document.querySelector('#nText'); t.value = ${JSON.stringify(prevText)}; t.dispatchEvent(new Event('input')); })()`);
  await c.js(`document.querySelector('#nSave').click()`);
  await sleep(600);
  const prevSaved = await c.js(`document.querySelector('.note-card .n-text').textContent`);
  check('上月笔记保存成功', /外卖点太多/.test(prevSaved), prevSaved.slice(0, 16));

  // ---- 全部模式：两条，按月份倒序 ----
  await c.js(`document.querySelector('[data-act="range-all"]').click()`);
  await sleep(450);
  const all2 = await c.js(`(() => {
    const items = [...document.querySelectorAll('.n-item')];
    return { count: items.length, months: items.map(i => i.querySelector('.ym').textContent) };
  })()`);
  console.log('\n--- 两条笔记 ---'); console.log(JSON.stringify(all2));
  check('两条笔记都在', all2.count === 2, all2.count);
  check('按月份倒序（11月在前）', /11月/.test(all2.months[0] || '') && /10月/.test(all2.months[1] || ''), all2.months);

  // ---- 从列表点开旧笔记并删除 ----
  await c.js(`document.querySelectorAll('.n-item')[1].click()`);
  await sleep(450);
  const opened = await c.js(`(() => ({ val: (document.querySelector('#nText') || {}).value,
      title: (document.querySelector('.sheet .ttl') || {}).textContent }))()`);
  check('点列表项打开对应月份', /外卖点太多/.test(opened.val || '') && /10月/.test(opened.title || ''), opened.title);

  await c.js(`document.querySelector('#nDel').click()`);
  await sleep(500);
  const confirmUp = await c.js(`(() => ({ ask: /删除这篇笔记/.test(document.body.textContent),
      sheets: document.querySelectorAll('.sheet').length }))()`);
  check('弹出删除确认', confirmUp.ask === true, confirmUp);
  await c.js(`[...document.querySelectorAll('.sheet [data-opt="1"]')].pop().click()`);
  await sleep(700);
  const afterDel = await c.js(`(() => ({ items: document.querySelectorAll('.n-item').length,
      sheets: document.querySelectorAll('.sheet').length }))()`);
  console.log('\n--- 删除后 ---'); console.log(JSON.stringify(afterDel));
  check('删除后只剩 1 篇', afterDel.items === 1, afterDel.items);
  check('弹层全部关闭', afterDel.sheets === 0, afterDel.sheets);

  // ---- 刷新持久化 ----
  await c.goto(URL0, 1300);
  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(500);
  await c.js(`document.querySelector('[data-act="range-all"]').click()`);
  await sleep(450);
  const persisted = await c.js(`(() => ({ items: document.querySelectorAll('.n-item').length,
      text: (document.querySelector('.n-item .tx') || {}).textContent }))()`);
  check('刷新后笔记仍在', persisted.items === 1 && /比上个月多花 60/.test(persisted.text || ''), persisted);

  // ---- 删掉本月笔记 → 首页标记消失 ----
  await c.js(`document.querySelector('[data-act="range-month"]').click()`);
  await sleep(400);
  await c.js(`document.querySelector('.note-card').click()`);
  await sleep(450);
  await c.js(`document.querySelector('#nDel').click()`);
  await sleep(500);
  await c.js(`[...document.querySelectorAll('.sheet [data-opt="1"]')].pop().click()`);
  await sleep(700);
  const noNote = await c.js(`(() => ({ empty: document.querySelector('.note-card').classList.contains('empty') }))()`);
  check('删除后回到空笔记态', noNote.empty === true);

  await c.js(`window.__back()`);
  await sleep(500);
  const home2 = await c.js(`(() => ({ dots: document.querySelectorAll('.cat-card .n-dot').length }))()`);
  check('首页 📝 标记随之消失', home2.dots === 0, home2.dots);

  // ---- 小屏不溢出 ----
  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(450);
  for (const [w, h] of [[390, 844], [360, 640]]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await sleep(350);
    const ov = await c.js(`(() => ({
      vw: innerWidth, sw: document.documentElement.scrollWidth,
      cardW: document.querySelector('.note-card') ? Math.round(document.querySelector('.note-card').getBoundingClientRect().width) : null
    }))()`);
    check(`${w}x${h} 笔记卡不横向溢出`, ov.sw <= ov.vw, ov);
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // ---- 深色主题下笔记卡可见 ----
  await c.goto(URL0.replace('theme=light', 'theme=dark'), 1200);
  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(500);
  // 此时笔记已被删空，先写一篇再看配色
  await c.js(`document.querySelector('.note-card').click()`);
  await sleep(450);
  await c.js(`(() => { const t = document.querySelector('#nText'); t.value = '深色模式下的笔记'; t.dispatchEvent(new Event('input')); })()`);
  await c.js(`document.querySelector('#nSave').click()`);
  await sleep(650);
  const dark = await c.js(`(() => {
    const n = document.querySelector('.note-card');
    const cs = getComputedStyle(n);
    return { theme: document.documentElement.getAttribute('data-theme'), bg: cs.backgroundColor,
             color: getComputedStyle(n.querySelector('.n-ttl')).color,
             textColor: getComputedStyle(n.querySelector('.n-text')).color };
  })()`);
  check('深色下笔记卡配色正确', dark.theme === 'dark' && dark.bg === 'rgb(25, 28, 32)', dark);

  const errs = c.errors.filter(e => e && !/favicon/i.test(e));
  check('无 JS 异常（第六轮）', errs.length === 0, errs.slice(0, 3));

  const bad = results.filter(r => !r.ok);
  console.log('\n==== ' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
  if (bad.length) bad.forEach(f => console.log(' - ' + f.n + ' ' + JSON.stringify(f.d)));
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error('崩溃', e.message); process.exit(2); });