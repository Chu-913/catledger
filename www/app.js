'use strict';
/* =========================================================
   分类账 CatLedger — 应用逻辑
   数据全部存在本机（localStorage），无网络请求、无账号。
   ========================================================= */

/* ---------------- 1. 基础工具 ---------------- */
const p2 = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PALETTE = ['#F97316', '#F43F5E', '#8B5CF6', '#3B82F6', '#06B6D4', '#10B981',
  '#84CC16', '#EAB308', '#EC4899', '#64748B', '#14B8A6', '#A855F7'];
const EMOJIS = ['🍜', '🍔', '☕', '🍎', '🛒', '🧺', '🚌', '🚕', '🏠', '💡', '📱', '🎬',
  '🎮', '👕', '💊', '🎁', '✈️', '📚', '💼', '💰', '🧧', '🐱', '🎵', '⚽'];

const uid = p => p + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);

function fmtNum(cents) {
  const a = Math.abs(Math.round(cents));
  const int = Math.floor(a / 100).toLocaleString('en-US');
  return int + '.' + p2(a % 100);
}
const yuan = c => '¥' + fmtNum(c);
const signedYuan = c => (c > 0 ? '+' : c < 0 ? '-' : '') + '¥' + fmtNum(Math.abs(c));

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayKeyOf = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const ymOf = d => d.getFullYear() * 100 + (d.getMonth() + 1);
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function fmtDayHead(key) {
  const [y, m, dd] = key.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const head = sameDay(d, now) ? '今天' : sameDay(d, yest) ? '昨天' : (m + '月' + dd + '日');
  return head + ' ' + WEEK[d.getDay()];
}
const fmtTime = d => p2(d.getHours()) + ':' + p2(d.getMinutes());

function toLocalIso(d) {
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) +
    s + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
}
const inputVal = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
  'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());

/* ---------------- 2. 数据层 ---------------- */
const KEY = 'catledger.db.v1';
const BAK = 'catledger.db.v1.bak';
const APP_VERSION = '1.1.0';
const NOTE_MAX = 500;          // 一篇笔记最多 500 字，够写一段比较和感受

/* 存储适配层：APK 里优先用原生文件存储（原子写入，不依赖 WebView 的 localStorage），
   浏览器里退回 localStorage。 */
const store = {
  get(k) {
    try {
      if (native && native.storageGet) {
        const v = native.storageGet(k);
        if (v !== null && v !== undefined && v !== '') return String(v);
      }
    } catch (e) { }
    try { return localStorage.getItem(k); } catch (e) { return null; }
  },
  set(k, v) {
    try {
      if (native && native.storageSet) {
        if (native.storageSet(k, v)) return true;
      }
    } catch (e) { }
    try { localStorage.setItem(k, v); return true; } catch (e) { return false; }
  }
};

function emptyDB() {
  return {
    version: 1, categories: [], entries: [], notes: [],
    settings: { theme: 'auto', compactList: false, showColors: true, homeCollapsed: false, lastDir: {} }
  };
}

function normalize(o) {
  const d = emptyDB();
  d.categories = (Array.isArray(o.categories) ? o.categories : []).map(c => ({
    id: c.id || uid('c_'),
    name: String(c.name || '未命名').slice(0, 12),
    emoji: c.emoji || '📁',
    color: c.color || PALETTE[0],
    defaultDir: c.defaultDir === 'in' ? 'in' : 'out',
    sort: Number.isFinite(+c.sort) ? +c.sort : 0,
    budgetMonth: Number.isFinite(+c.budgetMonth) && +c.budgetMonth > 0 ? Math.round(+c.budgetMonth) : null,
    archived: !!c.archived,
    createdAt: c.createdAt || toLocalIso(new Date())
  }));
  const ids = new Set(d.categories.map(c => c.id));
  d.entries = (Array.isArray(o.entries) ? o.entries : [])
    .filter(e => e && ids.has(e.catId) && Number.isFinite(+e.amount))
    .map(e => ({
      id: e.id || uid('e_'),
      catId: e.catId,
      amount: Math.round(Math.abs(+e.amount)),
      dir: e.dir === 'in' ? 'in' : 'out',
      at: e.at || toLocalIso(new Date()),
      note: String(e.note || '').slice(0, 60),
      createdAt: e.createdAt || e.at || toLocalIso(new Date()),
      updatedAt: e.updatedAt || e.at || toLocalIso(new Date()),
      deletedAt: e.deletedAt || null
    }));
  /* 笔记：一个分类一个月一篇，同一月有多条时只留最后更新的那条 */
  const seenNote = new Set();
  d.notes = (Array.isArray(o.notes) ? o.notes : [])
    .filter(n => n && ids.has(n.catId) && Number.isFinite(+n.ym) && String(n.text || '').trim())
    .map(n => ({
      id: n.id || uid('n_'),
      catId: n.catId,
      ym: Math.round(+n.ym),
      text: String(n.text).slice(0, NOTE_MAX),
      createdAt: n.createdAt || toLocalIso(new Date()),
      updatedAt: n.updatedAt || n.createdAt || toLocalIso(new Date())
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .filter(n => {
      const k = n.catId + ':' + n.ym;
      if (seenNote.has(k)) return false;
      seenNote.add(k);
      return true;
    });
  d.settings = Object.assign(d.settings, o.settings || {});
  if (!d.settings.lastDir || typeof d.settings.lastDir !== 'object') d.settings.lastDir = {};
  return d;
}

let db = null;
let pendingSave = false, lastBakAt = 0;

function load() {
  let raw = null;
  try { raw = store.get(KEY); } catch (e) { raw = null; }
  if (raw) {
    try { return normalize(JSON.parse(raw)); }
    catch (e) {
      try {
        const b = store.get(BAK);
        if (b) { toast('主数据损坏，已从备份恢复'); return normalize(JSON.parse(b)); }
      } catch (e2) { }
      toast('数据读取失败');
      return emptyDB();
    }
  }
  return emptyDB();
}

function save() {
  if (pendingSave) return;
  pendingSave = true;
  setTimeout(() => {
    pendingSave = false;
    try {
      const json = JSON.stringify(db);
      const cur = store.get(KEY);
      if (cur && Date.now() - lastBakAt > 60000) { store.set(BAK, cur); lastBakAt = Date.now(); }
      if (!store.set(KEY, json)) toast('存储空间不足，请先导出备份');
    } catch (e) {
      toast('保存失败，请先导出备份');
    }
  }, 60);
}

const getCat = id => db.categories.find(c => c.id === id);
const liveEntries = () => db.entries.filter(e => !e.deletedAt);
const sortDesc = (a, b) => (new Date(b.at) - new Date(a.at)) || (new Date(b.createdAt) - new Date(a.createdAt));

/* ---------------- 3. 主题 ---------------- */
const native = (() => { try { return window.AppBridge || null; } catch (e) { return null; } })();

function nativeDark() {
  try { return !!(native && native.systemDark && native.systemDark() === '1'); } catch (e) { return false; }
}
function effectiveTheme() {
  const t = db.settings.theme;
  if (t === 'dark' || t === 'light') return t;
  if (native) return nativeDark() ? 'dark' : 'light';
  try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
}
function applyTheme() {
  const th = effectiveTheme();
  document.documentElement.setAttribute('data-theme', th);
  document.documentElement.classList.toggle('nocolor', !db.settings.showColors);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', th === 'dark' ? '#0F1113' : '#F6F7F9');
  try { if (native && native.setStatusBarColor) native.setStatusBarColor(th === 'dark'); } catch (e) { }
}

/* ---------------- 4. 提示 / 剪贴板 ---------------- */
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 1900);
}

async function copyText(t) {
  try { if (native && native.copyText) { native.copyText(t); return true; } } catch (e) { }
  try { await navigator.clipboard.writeText(t); return true; } catch (e) { }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* ---------------- 5. 视图状态 ---------------- */
const stack = [{ view: 'home' }];
const ui = { editHome: false, range: { mode: 'month', ym: ymOf(new Date()) }, flash: null };
let lastViewKey = '';

function render() {
  const v = stack[stack.length - 1];
  const key = v.view + ':' + (v.id || '');
  const sy = key === lastViewKey ? window.scrollY : 0;
  const app = document.getElementById('app');
  app.innerHTML = viewFor(v);
  lastViewKey = key;
  if (sy) window.scrollTo(0, sy);
  ui.flash = null;
}

function viewFor(v) {
  if (v.view === 'cat') return viewCat(v.id);
  if (v.view === 'settings') return viewSettings();
  return viewHome();
}

/* ---------------- 6. 首页 ---------------- */
function monthTotals(ym) {
  let inSum = 0, outSum = 0;
  for (const e of liveEntries()) {
    const d = new Date(e.at);
    if (isNaN(d) || ymOf(d) !== ym) continue;
    if (e.dir === 'in') inSum += e.amount; else outSum += e.amount;
  }
  return { inSum, outSum };
}

function catMonth(catId, ym) {
  let inSum = 0, outSum = 0, count = 0;
  for (const e of liveEntries()) {
    if (e.catId !== catId) continue;
    const d = new Date(e.at);
    if (isNaN(d) || ymOf(d) !== ym) continue;
    count++;
    if (e.dir === 'in') inSum += e.amount; else outSum += e.amount;
  }
  return { inSum, outSum, count };
}

/* ---- 每月一篇笔记 ---- */
const ymLabel = ym => Math.floor(ym / 100) + '年' + (ym % 100) + '月';
const shortYm = ym => (ym % 100) + '月';
const noteOf = (catId, ym) => db.notes.find(n => n.catId === catId && n.ym === ym) || null;
const notesOfCat = catId => db.notes.filter(n => n.catId === catId).sort((a, b) => b.ym - a.ym);
const firstLine = s => String(s).split('\n').find(x => x.trim()) || '';

function fmtNoteStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const day = sameDay(d, now) ? '今天' : sameDay(d, yest) ? '昨天' : (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return day + ' ' + fmtTime(d) + ' 更新';
}

function cardHTML(c, ym) {
  const s = catMonth(c.id, ym);
  const inc = c.defaultDir === 'in';
  const primary = inc
    ? (s.count ? '收入 <b>' + yuan(s.inSum) + '</b>' : '收入 <b>¥0.00</b>')
    : (s.count ? '支出 <b>' + yuan(s.outSum) + '</b>' : '支出 <b>¥0.00</b>');
  const other = inc ? s.outSum : s.inSum;
  const secondary = [s.count + ' 笔', other ? (inc ? '支出 ' : '收入 ') + yuan(other) : '']
    .filter(Boolean).join(' · ');
  const act = ui.editHome ? 'edit-cat' : 'open-cat';
  const hasNote = !!noteOf(c.id, ym);
  return `<div class="cat-card" role="button" tabindex="0" data-act="${act}" data-id="${c.id}">
    <div class="head"><span class="emoji">${esc(c.emoji)}</span><span class="name">${esc(c.name)}</span>${hasNote ? '<span class="n-dot" aria-label="本月有笔记">📝</span>' : ''}</div>
    <div class="body"><div class="line1">${primary}</div><div class="line2">${secondary}</div></div>
    ${ui.editHome ? `<div class="card-tools">
        <button data-act="move-up" data-id="${c.id}" aria-label="上移">↑</button>
        <button data-act="move-down" data-id="${c.id}" aria-label="下移">↓</button>
      </div>` : ''}
  </div>`;
}

function viewHome() {
  const cats = db.categories.filter(c => !c.archived).sort((a, b) => a.sort - b.sort);
  const now = new Date();
  const t = monthTotals(ymOf(now));
  const collapsed = db.settings.homeCollapsed;
  const balance = t.inSum - t.outSum;

  const body = cats.length === 0
    ? `<div class="empty">
         <div class="ic">📒</div>
         <div class="t">还没有分类</div>
         <div class="d">先建一个，比如「饮食」「生活」「兼职」</div>
         <button class="btn" data-act="new-cat">新建第一个分类</button>
       </div>`
    : `<div class="grid ${ui.editHome ? 'editing' : ''}">
         ${cats.map(c => cardHTML(c, ymOf(now))).join('')}
         ${ui.editHome ? '' : `<button class="cat-card new" data-act="new-cat">
            <span class="plus">＋</span><span class="txt">新建分类</span></button>`}
       </div>`;

  return `<div class="screen">
    <header class="topbar">
      <div class="titles">
        <h1>分类账</h1>
        <div class="sub">${now.getFullYear()}年${now.getMonth() + 1}月</div>
      </div>
      <div class="actions">
        ${ui.editHome
      ? `<button class="text-btn" data-act="end-edit-home">完成</button>`
      : `<button class="icon-btn" data-act="new-cat" aria-label="新建分类">＋</button>
           <button class="icon-btn ghost" data-act="settings" aria-label="设置">⋯</button>`}
      </div>
    </header>

    <section class="summary ${collapsed ? 'collapsed' : ''}" data-act="toggle-summary">
      <div class="sum-main">
        <span class="label">本月支出</span>
        <span class="sum-value">${yuan(t.outSum)}</span>
      </div>
      <div class="sum-side">
        <div class="line">收入 <b class="income">${signedYuan(t.inSum)}</b></div>
        <div class="line">结余 <b class="${balance >= 0 ? 'income' : 'expense'}">${signedYuan(balance)}</b></div>
      </div>
    </section>

    ${ui.editHome ? `<div class="edit-hint"><span>点卡片改分类，↑↓ 调顺序</span><span>共 ${cats.length} 个</span></div>` : ''}
    ${body}
  </div>`;
}

/* ---------------- 7. 分类详情 ---------------- */
function inRange(e, r) {
  if (r.mode === 'all') return true;
  const d = new Date(e.at);
  return !isNaN(d) && ymOf(d) === r.ym;
}

function rangeLabel(r) {
  if (r.mode === 'all') return '全部时间';
  return Math.floor(r.ym / 100) + '年' + (r.ym % 100) + '月';
}

function rowHTML(e) {
  const d = new Date(e.at);
  const sign = e.dir === 'in' ? '+' : '-';
  return `<div class="row ${ui.flash === e.id ? 'flash' : ''}" data-act="edit-entry" data-eid="${e.id}">
    <div class="r-time">${fmtTime(d)}</div>
    <div class="r-note ${e.note ? '' : 'empty'}">${e.note ? esc(e.note) : (e.dir === 'in' ? '收入' : '支出')}</div>
    <div class="r-amt ${e.dir === 'in' ? 'income' : 'expense'}">${sign}${yuan(e.amount)}</div>
  </div>`;
}

function viewCat(id) {
  const c = getCat(id);
  if (!c) return `<div class="empty"><div class="t">分类不存在</div></div>`;
  const r = ui.range;
  const list = liveEntries().filter(e => e.catId === id && inRange(e, r)).sort(sortDesc);

  let inSum = 0, outSum = 0;
  for (const e of list) { if (e.dir === 'in') inSum += e.amount; else outSum += e.amount; }
  const balance = inSum - outSum;

  let groups = [];
  for (const e of list) {
    const k = dayKeyOf(new Date(e.at));
    if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, items: [] });
    groups[groups.length - 1].items.push(e);
  }

  const listHTML = list.length === 0
    ? `<div class="empty" style="padding:46px 28px">
         <div class="ic">${esc(c.emoji)}</div>
         <div class="t">这一类还没有记录</div>
         <div class="d">点右下角的 ＋ 记第一笔</div>
       </div>`
    : groups.map(g => {
      let gi = 0, go = 0;
      for (const e of g.items) { if (e.dir === 'in') gi += e.amount; else go += e.amount; }
      const parts = [];
      if (go) parts.push('支出 ' + yuan(go));
      if (gi) parts.push('收入 ' + yuan(gi));
      const compact = db.settings.compactList;
      return `${compact ? '' : `<div class="day-head"><span>${fmtDayHead(g.key)}</span><span class="dsum">${parts.join(' · ')}</span></div>`}
        ${g.items.map(rowHTML).join('')}`;
    }).join('');

  const budgetHTML = (c.budgetMonth && r.mode !== 'all')
    ? (() => {
      const used = Math.min(1, outSum / c.budgetMonth);
      const pct = Math.round(used * 100);
      return `<div class="budget">
          <div class="bar"><i class="${used >= 1 ? 'over' : ''}" style="width:${Math.max(2, pct)}%"></i></div>
          <div class="txt">本月预算 ${yuan(c.budgetMonth)} · 已用 ${pct}%</div>
        </div>`;
    })()
    : '';

  const n = r.mode === 'month' ? noteOf(c.id, r.ym) : null;
  const allNotes = r.mode === 'all' ? notesOfCat(c.id) : [];

  const noteHTML = r.mode !== 'month' ? '' : (n
    ? `<section class="note-card" data-act="note-open" data-id="${c.id}">
         <div class="n-head"><span class="n-ttl">${shortYm(r.ym)}笔记</span><span class="n-edit">编辑</span></div>
         <div class="n-text">${esc(n.text)}</div>
         <div class="n-meta">${fmtNoteStamp(n.updatedAt)}</div>
       </section>`
    : `<section class="note-card empty" data-act="note-open" data-id="${c.id}">
         <div class="n-head"><span class="n-ttl">${shortYm(r.ym)}笔记</span><span class="n-edit">写一篇</span></div>
         <div class="n-ph">这个月想记点什么？比如「多买了一箱苹果」</div>
       </section>`);

  const notesHTML = (r.mode === 'all' && allNotes.length)
    ? `<div class="notes-sec">
         <div class="n-sec-head">笔记 <span>${allNotes.length} 篇</span></div>
         ${allNotes.map(x => `<button class="n-item" data-act="note-edit" data-id="${c.id}" data-ym="${x.ym}">
             <span class="ym">${ymLabel(x.ym)}</span>
             <span class="tx">${esc(firstLine(x.text))}</span>
             <span class="ar">›</span>
           </button>`).join('')}
       </div>`
    : '';

  return `<div class="screen">
    <header class="topbar">
      <button class="icon-btn" data-act="back" aria-label="返回">‹</button>
      <div class="titles">
        <h1>${esc(c.emoji)} ${esc(c.name)}</h1>
        <div class="sub">${rangeLabel(r)}</div>
      </div>
      <div class="actions">
        <button class="icon-btn ghost" data-act="cat-menu" data-id="${c.id}" aria-label="分类操作">⋯</button>
      </div>
    </header>

    <section class="stat">
      <div class="label">${c.defaultDir === 'in' ? '总收入' : '总支出'}</div>
      <div class="big ${(c.defaultDir === 'in' ? inSum : outSum) === 0 ? '' : (c.defaultDir === 'in' ? 'income' : 'expense')}">
        ${yuan(c.defaultDir === 'in' ? inSum : outSum)}
      </div>
      <div class="dividers">
        <span>收入 <b class="income">${signedYuan(inSum)}</b></span>
        <span>支出 <b class="expense">-${yuan(outSum)}</b></span>
        <span>结余 <b class="${balance >= 0 ? 'income' : 'expense'}">${signedYuan(balance)}</b></span>
      </div>
      ${budgetHTML}
    </section>

    <div class="chips">
      <button class="chip ${r.mode === 'month' ? 'on' : ''}" data-act="range-month">本月</button>
      <button class="chip ${r.mode === 'all' ? 'on' : ''}" data-act="range-all">全部</button>
      ${r.mode === 'month' ? `<div class="monthnav">
        <button data-act="month-prev" aria-label="上个月">‹</button>
        <span class="ym">${(r.ym % 100)}月</span>
        <button data-act="month-next" aria-label="下个月">›</button>
      </div>` : ''}
    </div>

    ${noteHTML}${notesHTML}
    <div class="list">${listHTML}</div>
    <button class="fab" data-act="add-entry" data-id="${c.id}" aria-label="记一笔">＋</button>
  </div>`;
}

/* ---------------- 8. 设置页 ---------------- */
function viewSettings() {
  const s = db.settings;
  const themes = [['auto', '自动'], ['light', '浅色'], ['dark', '深色']];
  const row = (label, right, act, extra) =>
    `<button class="srow" ${act ? `data-act="${act}"` : ''}><span class="t">${label}</span>${right || ''}</button>`;

  return `<div class="screen">
    <header class="topbar">
      <button class="icon-btn" data-act="back" aria-label="返回">‹</button>
      <div class="titles"><h1>设置</h1></div>
    </header>

    <div class="group">
      <div class="glabel">外观</div>
      <div class="box">
        <div class="srow">
          <span class="t">主题</span>
          <div class="seg-sm">${themes.map(([v, n]) =>
            `<button data-act="theme" data-v="${v}" class="${s.theme === v ? 'on' : ''}">${n}</button>`).join('')}</div>
        </div>
        ${row('收支显示颜色', `<div class="switch ${s.showColors ? 'on' : ''}" data-act="toggle-colors"></div>`)}
      </div>
    </div>

    <div class="group">
      <div class="glabel">列表</div>
      <div class="box">
        <div class="srow">
          <span class="t">紧凑模式<span class="d"> · 不显示日期分组</span></span>
          <div class="switch ${s.compactList ? 'on' : ''}" data-act="toggle-compact"></div>
        </div>
        <div class="srow">
          <span class="t">首页汇总折叠</span>
          <div class="switch ${s.homeCollapsed ? 'on' : ''}" data-act="toggle-collapsed"></div>
        </div>
        ${row('整理首页分类', '<span class="d">›</span>', 'tidy-home')}
      </div>
    </div>

    <div class="group">
      <div class="glabel">数据（只存在这台手机）</div>
      <div class="box">
        ${row('导出备份', '<span class="d">复制 JSON ›</span>', 'export')}
        ${row('导入备份', '<span class="d">粘贴 JSON ›</span>', 'import')}
        ${row('清空所有数据', '', 'clear', true)}
      </div>
    </div>

    <div class="about">
      分类账 CatLedger v${APP_VERSION}<br>
      共 ${db.categories.length} 个分类 · ${db.entries.length} 笔记录<br>
      无账号 · 无网络 · 数据只在本机
    </div>
  </div>`;
}

/* ---------------- 9. 弹层引擎 ---------------- */
const sheets = [];

function mountSheet(html, opts = {}) {
  const layers = document.getElementById('layers');
  const depth = sheets.length > 0;
  const bd = document.createElement('div');
  bd.className = 'backdrop' + (depth ? ' z2' : '');
  const el = document.createElement('div');
  el.className = 'sheet' + (depth ? ' z2' : '');
  el.innerHTML = html;
  layers.appendChild(bd);
  layers.appendChild(el);
  requestAnimationFrame(() => {
    bd.classList.add('on');
    el.classList.add('on');
  });
  document.body.classList.add('noscroll');
  const rec = { el, bd, onClose: opts.onClose || null };
  sheets.push(rec);
  if (!opts.noBackdropClose) bd.addEventListener('click', () => closeTop());
  return rec;
}

function closeTop() {
  const rec = sheets.pop();
  if (!rec) return;
  rec.bd.classList.remove('on');
  rec.el.classList.remove('on');
  setTimeout(() => { rec.bd.remove(); rec.el.remove(); }, 280);
  if (!sheets.length) document.body.classList.remove('noscroll');
  if (rec.onClose) { try { rec.onClose(); } catch (e) { } }
}

function closeAllSheets() { while (sheets.length) closeTop(); }

window.__back = function () {
  if (sheets.length) { closeTop(); return true; }
  if (stack.length > 1) { stack.pop(); render(); return true; }
  return false;
};

/* ---------------- 10. 动作表 / 确认框 ---------------- */
function actionSheet(title, options, explain) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };
    const html = `<div class="grabber"></div>
      <div class="sheet-head"><div class="ttl">${esc(title)}</div></div>
      ${explain ? `<div class="explain">${esc(explain)}</div>` : ''}
      <div class="actions-list">
        ${options.map((o, i) => `<button data-opt="${i}" class="${o.danger ? 'danger' : ''}">${esc(o.label)}</button>`).join('')}
      </div>
      <button class="cancel-btn" data-opt="-1">取消</button>`;
    const rec = mountSheet(html, { onClose: () => finish(null) });
    rec.el.addEventListener('click', ev => {
      const b = ev.target.closest('[data-opt]');
      if (!b) return;
      const i = Number(b.dataset.opt);
      const v = i < 0 ? null : options[i].value;
      finish(v);
      closeTop();
    });
  });
}

function confirmSheet(title, message, okText = '确定', danger = false) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };
    const html = `<div class="grabber"></div>
      <div class="sheet-head"><div class="ttl">${esc(title)}</div></div>
      <div class="explain" style="font-size:13.5px;color:var(--sub);padding:2px 18px 16px;line-height:1.6">${esc(message)}</div>
      <div class="sheet-foot" style="display:flex;gap:10px">
        <button class="primary" style="background:var(--card2);color:var(--text)" data-opt="0">取消</button>
        <button class="primary" style="${danger ? 'background:var(--expense)' : ''}" data-opt="1">${esc(okText)}</button>
      </div>`;
    const rec = mountSheet(html, { onClose: () => finish(false) });
    rec.el.addEventListener('click', ev => {
      const b = ev.target.closest('[data-opt]');
      if (!b) return;
      finish(b.dataset.opt === '1');
      closeTop();
    });
  });
}

/* ---------------- 11. 记账弹层 ---------------- */
function openEntrySheet(opts) {
  const cats = db.categories.filter(c => !c.archived).sort((a, b) => a.sort - b.sort);
  if (!cats.length) { toast('先新建一个分类'); return; }
  const entry = opts.entry || null;
  const cat0 = entry ? getCat(entry.catId) : (getCat(opts.catId) || cats[0]);
  const lastDir = db.settings.lastDir && db.settings.lastDir[cat0.id];

  const st = {
    entry,
    dir: entry ? entry.dir : (lastDir || cat0.defaultDir || 'out'),
    amt: entry ? (entry.amount / 100).toFixed(2) : '',
    fresh: !!entry,
    catId: cat0.id,
    at: entry ? new Date(entry.at) : new Date(),
    note: entry ? entry.note : ''
  };
  if (!entry) st.at.setSeconds(0, 0);

  const html = `<div class="grabber"></div>
    <div class="seg" id="seg">
      <button data-dir="out" class="${st.dir === 'out' ? 'on' : ''}">支出</button>
      <button data-dir="in" class="${st.dir === 'in' ? 'on' : ''}">收入</button>
    </div>
    <div class="amt-line">
      <span class="cur">¥</span><span class="amt ${st.amt ? '' : 'placeholder'}" id="amtView">${st.amt ? amtText(st.amt) : '0'}</span>
    </div>
    <div class="meta">
      <button class="meta-row" id="catRow">
        <span class="k">分类</span>
        <span class="v"><span class="dot" id="catDot" style="background:${cat0.color}"></span><span id="catName">${esc(cat0.emoji)} ${esc(cat0.name)}</span></span>
        <span class="chev">›</span>
      </button>
      <label class="meta-row">
        <span class="k">时间</span>
        <input type="datetime-local" id="dtInput" value="${inputVal(st.at)}">
        <span class="chev">›</span>
      </label>
      <div class="meta-row">
        <span class="k">备注</span>
        <input type="text" id="noteInput" placeholder="写点什么（可不填）" maxlength="60" value="${esc(st.note)}">
      </div>
    </div>
    <div class="keypad" id="keypad">
      ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => `<button data-key="${k}">${k}</button>`).join('')}
      <button data-key=".">.</button><button data-key="0">0</button><button data-key="del">⌫</button>
    </div>
    <div class="sheet-foot">
      <button class="primary" id="saveBtn" ${parseAmt(st.amt) > 0 ? '' : 'disabled'}>保存</button>
      ${entry ? `<button class="danger-link" id="delBtn">删除这一笔</button>` : ''}
    </div>`;

  const rec = mountSheet(html);
  const el = rec.el;
  const amtView = el.querySelector('#amtView');
  const saveBtn = el.querySelector('#saveBtn');
  const keypad = el.querySelector('#keypad');

  const refreshSave = () => { saveBtn.disabled = !(parseAmt(st.amt) > 0); };
  const refreshAmt = () => {
    amtView.textContent = st.amt ? amtText(st.amt) : '0';
    amtView.classList.toggle('placeholder', !st.amt);
    refreshSave();
  };

  el.querySelector('#seg').addEventListener('click', ev => {
    const b = ev.target.closest('[data-dir]');
    if (!b) return;
    st.dir = b.dataset.dir;
    el.querySelectorAll('#seg button').forEach(x => x.classList.toggle('on', x.dataset.dir === st.dir));
  });

  keypad.addEventListener('click', ev => {
    const b = ev.target.closest('[data-key]');
    if (!b) return;
    pressKey(b.dataset.key);
  });

  function pressKey(k) {
    if (st.fresh) { st.amt = ''; st.fresh = false; }
    if (k === 'del') {
      st.amt = st.amt.slice(0, -1);
    } else if (k === '.') {
      if (!st.amt) st.amt = '0.';
      else if (!st.amt.includes('.')) st.amt += '.';
    } else {
      const parts = st.amt.split('.');
      const dec = parts[1] || '';
      if (parts.length > 1 && dec.length >= 2) return;
      if (parts.length === 1 && parts[0].length >= 7) return;
      if (st.amt === '0') st.amt = k;
      else st.amt += k;
    }
    refreshAmt();
  }

  el.querySelector('#catRow').addEventListener('click', () => {
    openCatPicker(st.catId, id => {
      st.catId = id;
      const c = getCat(id);
      el.querySelector('#catDot').style.background = c.color;
      el.querySelector('#catName').textContent = c.emoji + ' ' + c.name;
      if (!st.entry) st.dir = (db.settings.lastDir && db.settings.lastDir[id]) || c.defaultDir || 'out';
      el.querySelectorAll('#seg button').forEach(x => x.classList.toggle('on', x.dataset.dir === st.dir));
    });
  });

  el.querySelector('#dtInput').addEventListener('change', ev => {
    const d = new Date(ev.target.value);
    if (!isNaN(d)) st.at = d;
  });

  const noteInput = el.querySelector('#noteInput');
  noteInput.addEventListener('input', () => { st.note = noteInput.value; });
  noteInput.addEventListener('focus', () => keypad.classList.add('hidden'));
  noteInput.addEventListener('blur', () => keypad.classList.remove('hidden'));

  saveBtn.addEventListener('click', () => {
    const cents = parseAmt(st.amt);
    if (!(cents > 0)) { toast('请输入金额'); return; }
    const note = (st.note || '').trim().slice(0, 60);
    let id = null;
    if (st.entry) {
      const e = db.entries.find(x => x.id === st.entry.id);
      if (e) {
        Object.assign(e, { catId: st.catId, amount: cents, dir: st.dir, at: toLocalIso(st.at), note, updatedAt: toLocalIso(new Date()) });
        id = e.id;
      }
    } else {
      id = uid('e_');
      db.entries.push({
        id, catId: st.catId, amount: cents, dir: st.dir, at: toLocalIso(st.at), note,
        createdAt: toLocalIso(new Date()), updatedAt: toLocalIso(new Date()), deletedAt: null
      });
    }
    db.settings.lastDir = db.settings.lastDir || {};
    db.settings.lastDir[st.catId] = st.dir;
    save();
    ui.flash = id;
    closeTop();
    render();
    toast(st.entry ? '已保存' : '记好了');
  });

  const delBtn = el.querySelector('#delBtn');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      const ok = await confirmSheet('删除这一笔？', '删除后可以马上撤销。', '删除', true);
      if (!ok) return;
      const e = db.entries.find(x => x.id === st.entry.id);
      if (e) { e.deletedAt = toLocalIso(new Date()); save(); }
      closeTop();
      render();
      undoBar('已删除', () => {
        if (e) { e.deletedAt = null; save(); render(); }
      });
    });
  }
}

function amtText(s) {
  if (!s) return '0';
  const parts = s.split('.');
  const intNum = parts[0] === '' ? '0' : parts[0];
  const intFmt = Number(intNum).toLocaleString('en-US');
  return s.includes('.') ? intFmt + '.' + (parts[1] || '') : intFmt;
}
function parseAmt(s) {
  const f = parseFloat(s || '0');
  return isFinite(f) ? Math.round(f * 100) : 0;
}

/* 撤销条 */
let undoEl = null, undoTimer = null;
function undoBar(text, cb) {
  if (undoEl) { undoEl.remove(); undoEl = null; }
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:16px;right:16px;bottom:calc(24px + env(safe-area-inset-bottom));' +
    'background:rgba(24,26,30,.95);color:#fff;border-radius:14px;padding:12px 14px;display:flex;' +
    'align-items:center;gap:10px;z-index:70;font-size:13.5px;box-shadow:0 12px 30px rgba(0,0,0,.28)';
  el.innerHTML = `<span style="flex:1">${esc(text)}</span><b style="color:#7FB0FF">撤销</b>`;
  el.querySelector('b').onclick = () => { el.remove(); undoEl = null; cb(); };
  document.body.appendChild(el);
  undoEl = el;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { el.remove(); undoEl = null; }, 5000);
}

/* ---------------- 12. 分类选择 ---------------- */
function openCatPicker(currentId, onPick) {
  const cats = db.categories.filter(c => !c.archived).sort((a, b) => a.sort - b.sort);
  const html = `<div class="grabber"></div>
    <div class="sheet-head"><div class="ttl">选择分类</div></div>
    <div class="pick-list">
      ${cats.map(c => `<button data-pick="${c.id}">
        <span class="dot" style="background:${c.color}"></span>
        <span class="nm">${esc(c.emoji)} ${esc(c.name)}</span>
        ${c.id === currentId ? '<span class="ck">✓</span>' : ''}
      </button>`).join('')}
    </div>`;
  const rec = mountSheet(html);
  rec.el.addEventListener('click', ev => {
    const b = ev.target.closest('[data-pick]');
    if (!b) return;
    closeTop();
    onPick(b.dataset.pick);
  });
}

/* ---------------- 13. 分类编辑 ---------------- */
/* ---------------- 13. 笔记弹层 ----------------
   每个分类、每个月一篇，写在分类详情里，跟着月份切换。 */
function openNoteSheet(catId, ym) {
  const c = getCat(catId);
  if (!c) return;
  const exist = noteOf(catId, ym);
  const html = `<div class="grabber"></div>
    <div class="sheet-head">
      <div class="ttl">${esc(c.emoji)} ${esc(c.name)} · ${ymLabel(ym)}</div>
      <button class="x" data-close="1">✕</button>
    </div>
    <div class="sheet-body">
      <div class="note-form">
        <textarea id="nText" maxlength="${NOTE_MAX}" placeholder="随便写：这个月买了什么、比上个月多花在哪、下个月想怎么改。">${esc(exist ? exist.text : '')}</textarea>
        <div class="n-foot"><span id="nCount"></span><span>只存在这台手机</span></div>
      </div>
    </div>
    <div class="sheet-foot">
      <button class="primary" id="nSave">保存</button>
      ${exist ? '<button class="danger-link" id="nDel">删除这篇笔记</button>' : ''}
    </div>`;

  const rec = mountSheet(html);
  const el = rec.el;
  const ta = el.querySelector('#nText');
  const cnt = el.querySelector('#nCount');
  const sync = () => { cnt.textContent = ta.value.length + ' / ' + NOTE_MAX; };
  ta.addEventListener('input', sync);
  sync();
  el.querySelector('[data-close]').addEventListener('click', () => closeTop());

  el.querySelector('#nSave').addEventListener('click', () => {
    const text = ta.value.trim().slice(0, NOTE_MAX);
    if (!text) {
      if (!exist) { toast('写点什么再保存'); try { ta.focus(); } catch (e) { } return; }
      removeNote(exist, () => closeTop());
      return;
    }
    const now = toLocalIso(new Date());
    if (exist) {
      exist.text = text;
      exist.updatedAt = now;
    } else {
      db.notes.push({ id: uid('n_'), catId, ym, text, createdAt: now, updatedAt: now });
    }
    save();
    closeTop();
    render();
    toast(exist ? '笔记已更新' : '笔记已保存');
  });

  const del = el.querySelector('#nDel');
  if (del) del.addEventListener('click', () => removeNote(exist, () => closeTop()));
}

function removeNote(note, after) {
  confirmSheet('删除这篇笔记？', ymLabel(note.ym) + ' 的笔记会被清空，无法恢复。', '删除', true).then(ok => {
    if (!ok) return;
    db.notes = db.notes.filter(x => x.id !== note.id);
    save();
    if (after) after();
    render();
    toast('笔记已删除');
  });
}

function openCatEditor(cat) {
  const isNew = !cat;
  const c = isNew
    ? { name: '', emoji: '🍜', color: PALETTE[0], defaultDir: 'out', budgetMonth: null, archived: false }
    : Object.assign({}, cat);

  const html = `<div class="grabber"></div>
    <div class="sheet-head">
      <div class="ttl">${isNew ? '新建分类' : '编辑分类'}</div>
      <button class="x" data-close="1">✕</button>
    </div>
    <div class="sheet-body">
      <div class="form">
        <div class="field">
          <span class="label">名称</span>
          <input type="text" id="fName" maxlength="12" placeholder="例如 饮食 / 兼职 / 房租" value="${esc(c.name)}">
        </div>
        <div class="field">
          <span class="label">图标</span>
          <div class="emoji-grid" id="fEmoji">
            ${EMOJIS.map(e => `<button data-emoji="${e}" class="${c.emoji === e ? 'on' : ''}">${e}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <span class="label">颜色</span>
          <div class="color-grid" id="fColor">
            ${PALETTE.map(col => `<button data-color="${col}" style="background:${col}" class="${c.color === col ? 'on' : ''}"></button>`).join('')}
          </div>
        </div>
        <div class="field">
          <span class="label">默认方向（记账时预选）</span>
          <div class="seg" style="margin:0" id="fDir">
            <button data-dir="out" class="${c.defaultDir !== 'in' ? 'on' : ''}">支出</button>
            <button data-dir="in" class="${c.defaultDir === 'in' ? 'on' : ''}">收入</button>
          </div>
        </div>
        <div class="field">
          <span class="label">月度预算（可选，留空不设）</span>
          <input type="number" id="fBudget" inputmode="decimal" placeholder="例如 3000" value="${c.budgetMonth ? c.budgetMonth / 100 : ''}">
        </div>
      </div>
    </div>
    <div class="sheet-foot">
      <button class="primary" id="fSave">${isNew ? '创建' : '保存'}</button>
      ${isNew ? '' : `<button class="danger-link" id="fDel">删除这个分类</button>`}
    </div>`;

  const rec = mountSheet(html);
  const el = rec.el;

  el.querySelector('[data-close]').addEventListener('click', () => closeTop());
  el.querySelector('#fEmoji').addEventListener('click', ev => {
    const b = ev.target.closest('[data-emoji]'); if (!b) return;
    c.emoji = b.dataset.emoji;
    el.querySelectorAll('#fEmoji button').forEach(x => x.classList.toggle('on', x.dataset.emoji === c.emoji));
  });
  el.querySelector('#fColor').addEventListener('click', ev => {
    const b = ev.target.closest('[data-color]'); if (!b) return;
    c.color = b.dataset.color;
    el.querySelectorAll('#fColor button').forEach(x => x.classList.toggle('on', x.dataset.color === c.color));
  });
  el.querySelector('#fDir').addEventListener('click', ev => {
    const b = ev.target.closest('[data-dir]'); if (!b) return;
    c.defaultDir = b.dataset.dir;
    el.querySelectorAll('#fDir button').forEach(x => x.classList.toggle('on', x.dataset.dir === c.defaultDir));
  });

  el.querySelector('#fSave').addEventListener('click', () => {
    const name = el.querySelector('#fName').value.trim();
    if (!name) { toast('给分类起个名字'); return; }
    const budgetRaw = el.querySelector('#fBudget').value.trim();
    const budget = budgetRaw ? Math.round(parseFloat(budgetRaw) * 100) : null;

    if (isNew) {
      const maxSort = db.categories.reduce((m, x) => Math.max(m, x.sort), 0);
      db.categories.push({
        id: uid('c_'), name: name.slice(0, 12), emoji: c.emoji, color: c.color,
        defaultDir: c.defaultDir, sort: maxSort + 10,
        budgetMonth: budget && budget > 0 ? budget : null,
        archived: false, createdAt: toLocalIso(new Date())
      });
    } else {
      const t = getCat(cat.id);
      if (t) Object.assign(t, {
        name: name.slice(0, 12), emoji: c.emoji, color: c.color, defaultDir: c.defaultDir,
        budgetMonth: budget && budget > 0 ? budget : null
      });
    }
    save();
    closeTop();
    render();
    toast(isNew ? '分类已创建' : '已保存');
  });

  const delBtn = el.querySelector('#fDel');
  if (delBtn) delBtn.addEventListener('click', () => { closeTop(); setTimeout(() => deleteCategory(cat), 260); });
}

function deleteCategory(cat) {
  const n = liveEntries().filter(e => e.catId === cat.id).length;
  const nNotes = db.notes.filter(x => x.catId === cat.id).length;
  const notePart = nNotes ? `，以及 ${nNotes} 篇笔记` : '';
  if (n === 0) {
    confirmSheet('删除分类', `「${cat.name}」里没有账目${notePart}，确定删除？`, '删除', true).then(ok => {
      if (!ok) return;
      db.categories = db.categories.filter(x => x.id !== cat.id);
      db.notes = db.notes.filter(x => x.catId !== cat.id);
      save(); render(); toast('已删除');
    });
    return;
  }
  actionSheet('「' + cat.name + '」里有 ' + n + ' 笔账', [
    { label: '归档：隐藏分类，保留账目', value: 'archive' },
    { label: '把账目迁移到其他分类', value: 'move' },
    { label: '连同账目一起删除', value: 'purge', danger: true }
  ], '归档最安全：首页不再显示，历史记录和统计都还在。').then(v => {
    if (!v) return;
    if (v === 'archive') {
      const t = getCat(cat.id); if (t) t.archived = true;
      save(); render(); toast('已归档');
    } else if (v === 'purge') {
      confirmSheet('确定删除？', `将永久删除「${cat.name}」和其中 ${n} 笔账${notePart}，无法撤销。`, '删除', true).then(ok => {
        if (!ok) return;
        db.entries = db.entries.filter(e => e.catId !== cat.id);
        db.notes = db.notes.filter(x => x.catId !== cat.id);
        db.categories = db.categories.filter(x => x.id !== cat.id);
        save(); render(); toast('已删除');
      });
    } else if (v === 'move') {
      const targets = db.categories.filter(x => x.id !== cat.id && !x.archived);
      if (!targets.length) { toast('没有其他分类可接收'); return; }
      openCatPicker(cat.id, targetId => {
        db.entries.forEach(e => { if (e.catId === cat.id) e.catId = targetId; });
        /* 笔记跟着走；目标分类同月已有笔记时，两段文字合并，不丢内容 */
        const drop = [];
        db.notes.forEach(x => {
          if (x.catId !== cat.id) return;
          const dup = db.notes.find(y => y !== x && y.catId === targetId && y.ym === x.ym);
          if (dup) {
            dup.text = (dup.text + '\n\n' + x.text).slice(0, NOTE_MAX);
            dup.updatedAt = toLocalIso(new Date());
            drop.push(x.id);
          } else {
            x.catId = targetId;
          }
        });
        if (drop.length) db.notes = db.notes.filter(x => drop.indexOf(x.id) < 0);
        db.categories = db.categories.filter(x => x.id !== cat.id);
        save(); render(); toast('已迁移');
      });
    }
  });
}

/* ---------------- 14. 导入导出 ---------------- */
function openExport() {
  const txt = JSON.stringify(db, null, 2);
  const html = `<div class="grabber"></div>
    <div class="sheet-head"><div class="ttl">导出备份</div><button class="x" data-close="1">✕</button></div>
    <div class="sheet-body" style="padding:0 16px 8px">
      <div class="explain" style="padding-bottom:8px">下面是全部数据的 JSON。点按钮复制，粘贴到备忘录或微信收藏里保存。</div>
      <textarea class="json" id="expTa" readonly>${esc(txt)}</textarea>
    </div>
    <div class="sheet-foot"><button class="primary" id="expCopy">复制全部</button></div>`;
  const rec = mountSheet(html);
  rec.el.querySelector('[data-close]').addEventListener('click', () => closeTop());
  rec.el.querySelector('#expCopy').addEventListener('click', async () => {
    const ta = rec.el.querySelector('#expTa');
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = await copyText(ta.value);
    toast(ok ? '已复制，去粘贴保存吧' : '复制失败，请长按文本框手动复制');
  });
}

function openImport() {
  const html = `<div class="grabber"></div>
    <div class="sheet-head"><div class="ttl">导入备份</div><button class="x" data-close="1">✕</button></div>
    <div class="sheet-body" style="padding:0 16px 8px">
      <div class="explain" style="padding-bottom:8px">把之前导出的 JSON 粘进来。导入会覆盖当前全部数据。</div>
      <textarea class="json" id="impTa" placeholder='{"version":1,"categories":[...]}'></textarea>
    </div>
    <div class="sheet-foot"><button class="primary" id="impGo">导入</button></div>`;
  const rec = mountSheet(html);
  rec.el.querySelector('[data-close]').addEventListener('click', () => closeTop());
  rec.el.querySelector('#impGo').addEventListener('click', () => {
    const raw = rec.el.querySelector('#impTa').value.trim();
    if (!raw) { toast('先粘贴备份内容'); return; }
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { toast('格式不对，不是有效的 JSON'); return; }
    if (!obj || !Array.isArray(obj.categories)) { toast('这不是本 App 的备份文件'); return; }
    const next = normalize(obj);
    confirmSheet('覆盖当前数据？', `导入后有 ${next.categories.length} 个分类、${next.entries.length} 笔记录，当前数据会被替换。`, '导入', true).then(ok => {
      if (!ok) return;
      db = next;
      save();
      closeTop();
      stack.length = 0; stack.push({ view: 'home' });
      ui.editHome = false;
      applyTheme();
      render();
      toast('导入完成');
    });
  });
}

/* ---------------- 15. 事件分发 ---------------- */
function moveCat(id, dir) {
  const cats = db.categories.sort((a, b) => a.sort - b.sort);
  const i = cats.findIndex(c => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cats.length) return;
  const a = cats[i].sort, b = cats[j].sort;
  cats[i].sort = b; cats[j].sort = a;
  if (a === b) { cats.forEach((c, k) => c.sort = k * 10); }
  save();
  render();
}

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  const eid = el.dataset.eid;

  switch (act) {
    case 'back': stack.pop(); render(); break;
    case 'open-cat': stack.push({ view: 'cat', id }); render(); break;
    case 'settings': stack.push({ view: 'settings' }); render(); break;
    case 'new-cat': openCatEditor(null); break;
    case 'edit-cat': openCatEditor(getCat(id)); break;
    case 'toggle-summary':
      db.settings.homeCollapsed = !db.settings.homeCollapsed;
      save(); render(); break;
    case 'end-edit-home': ui.editHome = false; render(); break;
    case 'tidy-home':
      ui.editHome = true;
      stack.length = 0; stack.push({ view: 'home' });
      render(); break;
    case 'move-up': moveCat(id, -1); break;
    case 'move-down': moveCat(id, 1); break;
    case 'add-entry': openEntrySheet({ catId: id }); break;
    case 'note-open': openNoteSheet(id, ui.range.ym); break;
    case 'note-edit': openNoteSheet(id, Number(el.dataset.ym)); break;
    case 'edit-entry': {
      const e = db.entries.find(x => x.id === eid);
      if (e) openEntrySheet({ entry: e });
      break;
    }
    case 'range-month': ui.range.mode = 'month'; render(); break;
    case 'range-all': ui.range.mode = 'all'; render(); break;
    case 'month-prev': {
      const y = Math.floor(ui.range.ym / 100), m = ui.range.ym % 100;
      const d = new Date(y, m - 2, 1);
      ui.range.ym = ymOf(d); render(); break;
    }
    case 'month-next': {
      const y = Math.floor(ui.range.ym / 100), m = ui.range.ym % 100;
      const d = new Date(y, m, 1);
      ui.range.ym = ymOf(d); render(); break;
    }
    case 'theme': db.settings.theme = el.dataset.v; save(); applyTheme(); render(); break;
    case 'toggle-colors':
      db.settings.showColors = !db.settings.showColors; save(); applyTheme(); render(); break;
    case 'toggle-compact':
      db.settings.compactList = !db.settings.compactList; save(); render(); break;
    case 'toggle-collapsed':
      db.settings.homeCollapsed = !db.settings.homeCollapsed; save(); render(); break;
    case 'export': openExport(); break;
    case 'import': openImport(); break;
    case 'clear':
      confirmSheet('清空所有数据？', '所有分类和记录都会被删除，且无法撤销。建议先导出备份。', '清空', true).then(ok => {
        if (!ok) return;
        db = emptyDB();
        save();
        stack.length = 0; stack.push({ view: 'home' });
        applyTheme(); render(); toast('已清空');
      });
      break;
    case 'cat-menu': openCatMenu(id); break;
  }
});

function openCatMenu(id) {
  const c = getCat(id);
  if (!c) return;
  actionSheet('分类操作', [
    { label: '编辑分类', value: 'edit' },
    { label: c.archived ? '取消归档' : '归档（隐藏）', value: 'archive' },
    { label: '删除分类', value: 'delete', danger: true }
  ]).then(v => {
    if (!v) return;
    if (v === 'edit') { openCatEditor(c); return; }
    if (v === 'archive') {
      c.archived = !c.archived; save();
      if (c.archived) {
        stack.length = 0; stack.push({ view: 'home' });
        toast('已归档，可在「整理」里取消');
      }
      render(); return;
    }
    deleteCategory(c);
  });
}

/* 长按首页卡片进入整理模式 */
let lpTimer = null, lpStart = null;
document.addEventListener('pointerdown', ev => {
  const card = ev.target.closest('.grid .cat-card[data-id]');
  if (!card || ui.editHome) return;
  lpStart = { x: ev.clientX, y: ev.clientY };
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => { lpTimer = null; ui.editHome = true; render(); }, 520);
});
document.addEventListener('pointermove', ev => {
  if (!lpStart || !lpTimer) return;
  if (Math.abs(ev.clientX - lpStart.x) > 8 || Math.abs(ev.clientY - lpStart.y) > 8) {
    clearTimeout(lpTimer); lpTimer = null;
  }
});
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, () => {
  clearTimeout(lpTimer); lpTimer = null; lpStart = null;
}));

/* ---------------- 16. 启动 ---------------- */
function seedDemo() {
  const mk = (name, emoji, color, dir, sort, budget) => ({
    id: uid('c_'), name, emoji, color, defaultDir: dir, sort,
    budgetMonth: budget || null, archived: false, createdAt: toLocalIso(new Date())
  });
  const foods = mk('饮食', '🍜', '#F97316', 'out', 10, 200000);
  const life = mk('生活', '🛒', '#10B981', 'out', 20, null);
  const work = mk('兼职', '💼', '#3B82F6', 'in', 30, null);
  const bus = mk('交通', '🚌', '#8B5CF6', 'out', 40, null);
  db.categories = [foods, life, work, bus];

  const now = new Date();
  const at = (dayOffset, h, m) => {
    const d = new Date(now);
    d.setDate(d.getDate() - dayOffset);
    d.setHours(h, m, 0, 0);
    return toLocalIso(d);
  };
  const add = (cat, amount, dir, day, h, m, note) => db.entries.push({
    id: uid('e_'), catId: cat.id, amount, dir, at: at(day, h, m), note,
    createdAt: at(day, h, m), updatedAt: at(day, h, m), deletedAt: null
  });

  add(foods, 4500, 'out', 0, 12, 30, '午饭 牛肉面');
  add(foods, 3800, 'out', 0, 19, 5, '晚饭 外卖');
  add(foods, 1200, 'out', 1, 8, 40, '早餐 豆浆油条');
  add(foods, 5000, 'out', 1, 18, 20, '超市 做饭食材');
  add(foods, 20000, 'in', 2, 10, 0, '同事 AA 退款');
  add(foods, 6200, 'out', 2, 12, 10, '火锅');
  add(life, 12900, 'out', 1, 15, 0, '洗衣液 纸巾');
  add(life, 39900, 'out', 3, 20, 30, '拖鞋 收纳盒');
  add(life, 8900, 'out', 5, 11, 0, '理发');
  add(work, 200000, 'in', 4, 21, 0, '设计外包 第一期');
  add(bus, 300, 'out', 0, 8, 10, '地铁');
  add(bus, 2600, 'out', 1, 9, 0, '打车去客户');
  add(bus, 300, 'out', 2, 18, 45, '地铁');
  db.notes = [{
    id: uid('n_'), catId: foods.id, ym: ymOf(now),
    text: '这个月买了一箱苹果（60 块），水果比上个月多；外卖少点了两次，总体差不多。',
    createdAt: toLocalIso(now), updatedAt: toLocalIso(now)
  }];
  save();
}

function boot() {
  db = load();
  const q = new URLSearchParams(location.search);
  if (q.get('theme') === 'dark' || q.get('theme') === 'light') db.settings.theme = q.get('theme');
  if (!store.get(KEY)) {
    if (q.get('seed') === 'demo') seedDemo();
  }
  applyTheme();
  render();

  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (db.settings.theme === 'auto') applyTheme();
    });
  } catch (e) { }

  if (q.get('sheet') === 'entry') {
    const first = db.categories.filter(c => !c.archived)[0];
    if (first) setTimeout(() => openEntrySheet({ catId: first.id }), 120);
  }
  if (q.get('view') === 'cat') {
    const first = db.categories.filter(c => !c.archived)[0];
    if (first) { stack.push({ view: 'cat', id: first.id }); render(); }
  }
  if (q.get('view') === 'settings') { stack.push({ view: 'settings' }); render(); }
}

boot();