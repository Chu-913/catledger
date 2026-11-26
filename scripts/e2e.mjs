// 通过 CDP 驱动 headless Chrome，对 Web 版做布局与交互自检。
// 用法: node scripts/e2e.mjs
const BASE = 'http://127.0.0.1:9222';

async function newPage(url) {
  const r = await fetch(BASE + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  if (!r.ok) throw new Error('create target failed: ' + r.status);
  return await r.json();
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = e => rej(new Error('ws error'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.text + ' ' +
          (m.params.exceptionDetails.exception?.description || ''));
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
      }
    };
  }
  async init() {
    await this.ready;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); }
      }, 15000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  async viewport(w, h, dpr = 2) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: dpr, mobile: true
    });
  }
  async goto(url, wait = 900) {
    await this.send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, wait));
  }
  close() { try { this.ws.close(); } catch (e) { } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
}

function layoutProbe() {
  return `(() => {
    const d = document.documentElement;
    const over = [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 1.5 || r.left < -1.5);
    }).slice(0, 6).map(el => el.className || el.tagName);
    return {
      vw: innerWidth, vh: innerHeight,
      scrollW: d.scrollWidth, scrollH: d.scrollHeight,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      theme: d.getAttribute('data-theme'),
      overflowEls: over
    };
  })()`;
}

async function main() {
  const target = await newPage('about:blank');
  const c = new CDP(target.webSocketDebuggerUrl);
  await c.init();
  await c.viewport(390, 844);

  // ---------- 1. 首页 ----------
  await c.goto('http://127.0.0.1:8899/?seed=demo', 1200);
  const home = await c.js(`(() => {
    const cards = [...document.querySelectorAll('.cat-card[data-id]')];
    const sum = document.querySelector('.summary .sum-value');
    const fab = document.querySelector('.fab');
    return {
      cards: cards.length,
      names: cards.map(x => x.querySelector('.name').textContent),
      lines: cards.map(x => x.querySelector('.line1').textContent.trim()),
      summary: sum && sum.textContent,
      summaryRect: sum && sum.getBoundingClientRect().toJSON(),
      firstCardRect: cards[0] && cards[0].getBoundingClientRect().toJSON(),
      hasFab: !!fab,
      grid: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns,
      newCard: !!document.querySelector('.cat-card.new')
    };
  })()`);
  console.log('\n--- 首页 ---'); console.log(JSON.stringify(home, null, 1));
  check('首页 4 个分类卡片', home.cards === 4, home.names);
  check('本月汇总有金额', /¥[\d,]+\.\d\d/.test(home.summary || ''), home.summary);
  check('汇总数字未溢出', home.summaryRect.width < 390 * 0.6, Math.round(home.summaryRect.width));
  check('网格两列', (home.grid || '').split(' ').length === 2, home.grid);
  const lay1 = await c.js(layoutProbe());
  check('首页无横向溢出', lay1.scrollW <= lay1.vw + 1, lay1);
  const prefersDark = await c.js(`matchMedia('(prefers-color-scheme: dark)').matches`);
  check('自动主题跟随系统', lay1.theme === (prefersDark ? 'dark' : 'light'), { theme: lay1.theme, prefersDark });

  // ---------- 2. 进分类 ----------
  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(400);
  const detail = await c.js(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    const stat = document.querySelector('.stat .big');
    const heads = [...document.querySelectorAll('.day-head')].map(x => x.textContent);
    return {
      title: document.querySelector('.topbar h1').textContent,
      stat: stat && stat.textContent.trim(),
      dividers: document.querySelector('.stat .dividers').textContent.replace(/\\s+/g,' ').trim(),
      rows: rows.length,
      firstRow: rows[0] && rows[0].textContent.replace(/\\s+/g,' ').trim(),
      dayHeads: heads.length,
      budget: !!document.querySelector('.budget'),
      chips: [...document.querySelectorAll('.chip')].map(x => x.textContent)
    };
  })()`);
  console.log('\n--- 分类详情 ---'); console.log(JSON.stringify(detail, null, 1));
  check('详情页标题正确', /饮食/.test(detail.title), detail.title);
  check('详情页有明细行', detail.rows > 0, detail.rows);
  check('按天分组生效', detail.dayHeads >= 2, detail.dayHeads);
  check('统计卡有支出合计', /¥[\d,]+\.\d\d/.test(detail.stat), detail.stat);
  check('预算进度条显示', detail.budget === true, detail.budget);

  // ---------- 3. 记账 ----------
  const before = await c.js(`document.querySelectorAll('.row').length`);
  await c.js(`document.querySelector('.fab').click()`);
  await sleep(450);
  const sheet1 = await c.js(`(() => {
    const s = document.querySelector('.sheet');
    const r = s.getBoundingClientRect();
    return { h: Math.round(r.height), vh: innerHeight, top: Math.round(r.top),
             saveDisabled: document.querySelector('#saveBtn').disabled,
             keypadBtns: document.querySelectorAll('.keypad button').length,
             amt: document.querySelector('#amtView').textContent };
  })()`);
  console.log('\n--- 记账弹层 ---'); console.log(JSON.stringify(sheet1));
  check('弹层高度不超出屏幕', sheet1.h <= sheet1.vh, sheet1);
  check('键盘 12 键', sheet1.keypadBtns === 12, sheet1.keypadBtns);
  check('未输入时保存禁用', sheet1.saveDisabled === true);

  await c.js(`[...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key==='4').click()`);
  await c.js(`[...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key==='5').click()`);
  await c.js(`[...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key==='.').click()`);
  await c.js(`[...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key==='5').click()`);
  await c.js(`[...document.querySelectorAll('[data-key]')].find(b=>b.dataset.key==='0').click()`);
  const typed = await c.js(`document.querySelector('#amtView').textContent`);
  check('金额输入 45.50', typed === '45.50', typed);

  await c.js(`document.querySelector('#noteInput').value='自动测试'; document.querySelector('#noteInput').dispatchEvent(new Event('input'))`);
  await c.js(`document.querySelector('#saveBtn').click()`);
  await sleep(600);
  const after = await c.js(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    return { rows: rows.length, sheet: !!document.querySelector('.sheet'),
             first: rows[0] && rows[0].textContent.replace(/\\s+/g,' ').trim(),
             stat: document.querySelector('.stat .big').textContent.trim(),
             toast: document.querySelector('#toast').textContent };
  })()`);
  console.log('\n--- 保存后 ---'); console.log(JSON.stringify(after, null, 1));
  check('保存后弹层关闭', after.sheet === false);
  check('新记录已插入列表首位', after.rows === before + 1, { before: before, after: after.rows });
  check('新记录内容正确', /自动测试/.test(after.first) && /45\.50/.test(after.first), after.first);

  // ---------- 4. 返回首页 + 深色 ----------
  await c.js(`document.querySelector('[data-act="back"]').click()`);
  await sleep(300);
  await c.js(`document.querySelector('[data-act="settings"]').click()`);
  await sleep(300);
  const settings = await c.js(`(() => ({
     rows: document.querySelectorAll('.srow').length,
     title: document.querySelector('.topbar h1').textContent,
     hasTheme: !!document.querySelector('[data-act="theme"]')
  }))()`);
  console.log('\n--- 设置页 ---'); console.log(JSON.stringify(settings));
  check('设置页渲染', settings.hasTheme && settings.rows >= 6, settings);

  await c.js(`document.querySelector('[data-act="theme"][data-v="dark"]').click()`);
  await sleep(400);
  const dark = await c.js(`(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    card: getComputedStyle(document.querySelector('.group .box')).backgroundColor,
    text: getComputedStyle(document.body).color
  }))()`);
  console.log('\n--- 深色 ---'); console.log(JSON.stringify(dark));
  check('深色主题生效', dark.theme === 'dark', dark.theme);
  check('深色背景变暗', dark.bg !== 'rgb(246, 247, 249)', dark.bg);

  await c.js(`document.querySelector('[data-act="back"]').click()`);
  await sleep(300);
  const lay3 = await c.js(layoutProbe());
  check('深色首页无横向溢出', lay3.scrollW <= lay3.vw + 1, lay3);

  // ---------- 5. 小屏 360x640 ----------
  await c.viewport(360, 640, 2);
  await sleep(400);
  const small = await c.js(layoutProbe());
  check('360x640 无横向溢出', small.scrollW <= small.vw + 1, small);
  await c.js(`document.querySelector('.cat-card[data-id]').click()`);
  await sleep(300);
  await c.js(`document.querySelector('.fab').click()`);
  await sleep(500);
  const sheetSmall = await c.js(`(() => {
    const s = document.querySelector('.sheet').getBoundingClientRect();
    const btn = document.querySelector('#saveBtn').getBoundingClientRect();
    return { sheetTop: Math.round(s.top), sheetH: Math.round(s.height), vh: innerHeight,
             saveBottom: Math.round(btn.bottom), saveVisible: btn.bottom <= innerHeight + 1 };
  })()`);
  console.log('\n--- 小屏记账弹层 ---'); console.log(JSON.stringify(sheetSmall));
  check('小屏弹层不超出屏幕', sheetSmall.sheetTop >= -1, sheetSmall);
  check('小屏保存按钮可见', sheetSmall.saveVisible === true, sheetSmall);

  // ---------- 6. 错误 ----------
  const errs = c.errors.filter(e => e && !/favicon/i.test(e));
  check('无 JS 异常', errs.length === 0, errs.slice(0, 4));

  const failed = results.filter(r => !r.ok);
  console.log('\n================ ' + (results.length - failed.length) + '/' + results.length + ' 通过 ================');
  if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(' - ' + f.name + '  ' + JSON.stringify(f.detail))); }
  c.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('E2E 崩溃:', e.message); process.exit(2); });