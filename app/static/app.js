'use strict';

/* ===================== 小工具 ===================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  me: null, tab: 'dash', timer: null, procSort: 'cpu', points: 180,
  xterm: null, fit: null, ws: null, pending: [], termConnected: false, connecting: false,
  lastPoints: [], resizeTimer: null, filesPath: null, lastUpdated: null,
};

function fmtBytes(n, digits) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : (digits === undefined ? 1 : digits)) + ' ' + units[i];
}
const fmtRate = (n) => fmtBytes(n) + '/s';

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return (d ? d + ' 天 ' : '') + ((d || h) ? h + ' 小时 ' : '') + m + ' 分钟';
}
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000), p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const pct = (n) => (Number(n) || 0).toFixed(1) + '%';
const themeColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const barColor = (p) => (p >= 90 ? 'var(--danger)' : p >= 70 ? 'var(--warning)' : 'var(--accent)');
const staticVersion = new URL(document.currentScript?.src || location.href).searchParams.get('v');
const iconSprite = '/static/icons.svg' + (staticVersion ? '?v=' + encodeURIComponent(staticVersion) : '');

function icon(name, extra = '') {
  return `<svg viewBox="0 0 24 24" class="icon ${extra}" aria-hidden="true"><use href="${iconSprite}#${name}"/></svg>`;
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateText(el, value) {
  const text = String(value ?? '');
  if (el.textContent !== text) el.textContent = text;
}
function updateAttribute(el, name, value) {
  if (el.getAttribute(name) !== String(value)) el.setAttribute(name, value);
}
// Keep unchanged nodes in place, including focus, native scroll state and SVGs.
function reconcileChildren(parent, nodes) {
  let next = parent.firstElementChild;
  for (const node of nodes) {
    if (node === next) next = next.nextElementSibling;
    else parent.insertBefore(node, next);
  }
  const keep = new Set(nodes);
  for (const child of Array.from(parent.children)) if (!keep.has(child)) child.remove();
}

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) {
    showLogin();
    const err = new Error('未登录或会话已过期');
    err.handled = true;
    throw err;
  }
  if (!res.ok) {
    let detail = data && data.detail;
    if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
    throw new Error(detail || ('HTTP ' + res.status));
  }
  return data;
}

/* ===================== 登录 / 登出 ===================== */
function showLogin() {
  state.me = null;
  window.panelAppearance?.suspend();
  stopTimers();
  closeTerminal();
  closeFileMenu();
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-pass').value = '';
  setTimeout(() => $('#login-user').focus(), 30);
}
function showApp() {
  window.panelAppearance?.start();
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#login-btn'), err = $('#login-err');
  err.textContent = '';
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const body = JSON.stringify({ username: $('#login-user').value.trim(), password: $('#login-pass').value });
    const res = await api('/api/auth/login', { method: 'POST', body });
    state.me = res.user;
    await boot();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = '登录';
  }
});

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
  closeTerminal();
  state.me = null;
  showLogin();
}
$('#btn-logout').addEventListener('click', logout);

/* ===================== 标签切换 ===================== */
const pageInfo = {
  dash: ['概览', '监控', '资源、负载与进程，尽在眼前。'],
  files: ['文件管理', '存储', '浏览文件，整理空间，管理你的服务器。'],
  system: ['系统信息', '主机', '主机配置、磁盘、网络与操作记录。'],
  ssh: ['SSH 连接', '访问', '查看并管理当前的远程登录连接。'],
  terminal: ['Web 终端', '控制台', '打开服务器命令行，保持操作在手边。'],
};
const navigation = {entry:null, token:null, index:0, max:0, ready:false, hash:null, views:{}};
const navigationKey = 'cyan-panel.navigation';
let viewSaveTimer;
function readRoute() {
  const [name,query] = location.hash.slice(1).split('?');
  const tab = pageInfo[name] ? name : 'dash';
  return {tab,path:tab === 'files' ? new URLSearchParams(query || '').get('path') : null};
}
function routeHash(route) { return '#' + route.tab + (route.tab === 'files' && route.path ? '?path=' + encodeURIComponent(route.path) : ''); }
function rememberNavigation() {
  try { sessionStorage.setItem(navigationKey,JSON.stringify({token:navigation.token,max:navigation.max,views:navigation.views})); } catch (_) { /* storage is optional */ }
  $('#btn-files-back').disabled = navigation.index <= 0;
  $('#btn-files-forward').disabled = navigation.index >= navigation.max;
}
function replaceEntry(entry) {
  navigation.entry = entry; navigation.hash = routeHash(entry);
  const previous = history.state?.cyanPanel;
  if (location.hash !== navigation.hash) history.replaceState({...history.state,cyanPanel:entry},'',navigation.hash);
  else if (!previous || previous.token !== entry.token || previous.index !== entry.index) history.replaceState({...history.state,cyanPanel:entry},'');
}
function saveRouteView() {
  clearTimeout(viewSaveTimer);
  if (!navigation.ready || !navigation.entry || filesState.loading) return;
  const view = {pageY:window.scrollY};
  if (navigation.entry.tab === 'system') view.storageCategory = storageCategory;
  if (navigation.entry.tab === 'files') Object.assign(view,{
    query:filesState.query,sort:filesState.sort,hidden:filesState.hidden,
    top:$('#file-drop-zone').scrollTop,left:$('#file-drop-zone').scrollLeft,
    treeTop:$('#file-tree').scrollTop,treeLeft:$('#file-tree').scrollLeft,
  });
  // View snapshots are not navigations. Avoid address-bar activity on scroll, search and sorting.
  navigation.entry = {...navigation.entry,view};
  navigation.views[navigation.index] = view;
  rememberNavigation();
}
function scheduleRouteView() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveRouteView,160);
}
function pushRoute(route) {
  for (const index of Object.keys(navigation.views)) if (Number(index) > navigation.index) delete navigation.views[index];
  navigation.index++; navigation.max = navigation.index;
  const entry = {...route,token:navigation.token,index:navigation.index,view:null};
  navigation.entry = entry; navigation.hash = routeHash(entry);
  history.pushState({cyanPanel:entry},'',navigation.hash);
  rememberNavigation();
}
function initNavigation() {
  let saved; try { saved = JSON.parse(sessionStorage.getItem(navigationKey)); } catch (_) { /* storage is optional */ }
  const entry = history.state?.cyanPanel;
  const route = readRoute();
  if (entry && saved?.token === entry.token && routeHash(entry) === routeHash(route)) {
    navigation.token = entry.token; navigation.index = entry.index; navigation.max = Math.max(entry.index,saved.max); navigation.views = saved.views || {}; navigation.entry = {...entry,view:navigation.views[entry.index] || entry.view};
    navigation.hash = routeHash(entry);
  } else {
    navigation.token = crypto.randomUUID(); navigation.index = 0; navigation.max = 0; navigation.views = {};
    replaceEntry({...route,token:navigation.token,index:0,view:null});
  }
  history.scrollRestoration = 'manual'; rememberNavigation();
  switchTab(route.tab,navigation.entry);
}
function navigateTab(tab) {
  if (!pageInfo[tab]) tab = 'dash';
  if (state.tab === tab) return;
  saveRouteView();
  pushRoute({tab,path:tab === 'files' ? state.filesPath : null});
  switchTab(tab,navigation.entry);
}
function switchTab(tab, route = navigation.entry) {
  if (!pageInfo[tab]) tab = 'dash';
  navigation.ready = false;
  state.tab = tab;$('#app').dataset.workspace=tab;
  showNavHint();
  closeFileMenu();
  if (treeDialog.open) treeDialog.close();
  if (tab !== 'files') {
    ++filesState.request; filesState.loading = false;
    $('#file-drop-zone').setAttribute('aria-busy','false'); $('#btn-files-refresh').classList.remove('is-loading');
  }
  $$('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $$('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
  const [title, category, description] = pageInfo[tab];
  $('#page-title').textContent = title; $('#page-category').textContent = category; $('#page-description').textContent = description;
  document.title = title + ' · cyan-panel';
  updateTerminalLayout();
  if (tab === 'terminal') { initTerminal(); loadTermSessions(); setTimeout(fitTerminal, 60); }
  else if (tab === 'system') {
    if (storageResult) showStorageCategory(route?.view?.storageCategory || null,false);
    else storageCategory=route?.view?.storageCategory || null;
    loadSystem();
  }
  else if (tab === 'files') loadFiles(route?.path || state.filesPath,{navigation:'none',restore:route?.view});
  else if (tab === 'ssh') loadSsh();
  else refresh(true);
  if (tab !== 'files') { window.scrollTo(0,route?.view?.pageY || 0); navigation.ready = true; }
}
$$('.tab').forEach((btn) => btn.addEventListener('click', () => navigateTab(btn.dataset.tab)));
$('.skip-link').addEventListener('click',(ev) => { ev.preventDefault(); $('#main').focus(); });
$('.brand').addEventListener('click',(ev) => { ev.preventDefault(); navigateTab('dash'); });
function restoreHistory() {
  clearTimeout(viewSaveTimer);
  if (!state.me) return;
  const entry = history.state?.cyanPanel;
  // Unknown hash entries (including a pasted fragment) join the same history without an extra push.
  if (entry?.token === navigation.token && routeHash(entry) === location.hash) {
    navigation.entry = {...entry,view:navigation.views[entry.index] || entry.view}; navigation.index = entry.index; navigation.hash = location.hash;
  } else {
    navigation.index++; navigation.max = navigation.index;
    replaceEntry({...readRoute(),token:navigation.token,index:navigation.index,view:null});
  }
  rememberNavigation(); switchTab(navigation.entry.tab,navigation.entry);
}
window.addEventListener('popstate',restoreHistory);
window.addEventListener('hashchange',() => { if (location.hash !== navigation.hash) restoreHistory(); });
window.addEventListener('scroll',scheduleRouteView,{passive:true});
window.addEventListener('pagehide',saveRouteView);
window.addEventListener('pointerdown',(ev) => { if (ev.button === 3 || ev.button === 4) saveRouteView(); },{passive:true});

$$('.seg-btn').forEach((btn) => btn.addEventListener('click', () => {
  state.procSort = btn.dataset.sort;
  $$('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  refresh(true);
}));

const navPages = $('#sidebar-pages'), navPrimary = $('#nav-primary'), navUtilities = $('#nav-utilities'), navPageSwitch = $('#btn-nav-page');
let navPage = 0, navScrollTimer, navHintTimer;
const bottomNavigation = () => matchMedia('(max-width:719px)').matches && !matchMedia('(orientation:landscape) and (max-height:520px)').matches;
function showNavHint() {
  if (!bottomNavigation() || $('#app').classList.contains('hidden')) return;
  const sidebar = $('.sidebar');
  sidebar.classList.add('nav-hint-visible');
  clearTimeout(navHintTimer);
  navHintTimer = setTimeout(()=>sidebar.classList.remove('nav-hint-visible'),1200);
}
function updateNavPage(page) {
  navPage = page ? 1 : 0;
  $('.sidebar').dataset.navPage = String(navPage);
  navPageSwitch.setAttribute('aria-pressed',String(navPage === 1));
  navPageSwitch.setAttribute('aria-label',navPage ? '返回功能导航' : '显示设置和账号');
  navPageSwitch.title = navPage ? '返回功能导航' : '设置和账号';
  for (const [index,element] of [navPrimary,navUtilities].entries()) {
    element.inert = bottomNavigation() && index !== navPage;
    if (element.inert) element.setAttribute('aria-hidden','true');else element.removeAttribute('aria-hidden');
  }
}
function showNavPage(page, smooth = true) {
  updateNavPage(page);
  if (smooth) showNavHint();
  if (bottomNavigation()) navPages.scrollTo({left:navPage*navPages.clientWidth,behavior:smooth&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'auto'});
}
navPageSwitch.addEventListener('click',()=>showNavPage(1-navPage));
navPageSwitch.addEventListener('focus',showNavHint);
navPages.addEventListener('pointerdown',showNavHint,{passive:true});
navPages.addEventListener('keydown',showNavHint);
navPages.addEventListener('scroll',()=>{
  showNavHint();
  clearTimeout(navScrollTimer);
  navScrollTimer = setTimeout(()=>{if(bottomNavigation())updateNavPage(Math.round(navPages.scrollLeft/Math.max(1,navPages.clientWidth)));},90);
},{passive:true});
function adaptNavPages() {
  if (bottomNavigation()) {
    if (window.panelAppearance?.settings?.dialog.open) navPage = 1;
    showNavPage(navPage,false);
  } else {navPrimary.inert = navUtilities.inert = false;navPrimary.removeAttribute('aria-hidden');navUtilities.removeAttribute('aria-hidden');navPages.scrollLeft=0;}
}
new ResizeObserver(adaptNavPages).observe(navPages);
window.addEventListener('resize',adaptNavPages);
adaptNavPages();

/* ===================== 概览 ===================== */
function gaugeCard(id, label) {
  return `<div class="card gauge-card" data-gauge="${id}"><div class="card-head"><span>${label}</span><span class="gauge-status muted" data-field="status"></span></div><div class="gauge-body"><div class="resource-gauge" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="gauge-track" cx="60" cy="60" r="49"/><circle class="gauge-fill" cx="60" cy="60" r="49" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg><div class="gauge-value"><span class="metric" data-field="value">—</span></div></div><div class="gauge-details" data-field="detail"></div></div></div>`;
}
function renderCards(o, m, points = []) {
  const cards = $('#cards');
  if (!cards.firstElementChild) {
    cards.innerHTML = [['cpu','CPU'],['memory','内存'],['disk','磁盘 /'],['load','系统负载']].map(([id,label]) => gaugeCard(id,label)).join('');
    $('#telemetry').innerHTML = `<div class="card core-card"><div class="card-head"><span>CPU 核心</span><span class="muted" id="core-count"></span></div><div class="core-bars" id="core-bars"></div><div class="capacity-heading"><span>Swap</span><span id="swap-value"></span></div><div class="capacity-track" role="meter" aria-label="Swap 使用率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="swap-bar"></i></div></div><div class="card traffic-card"><div class="card-head"><span>网络吞吐</span><span class="muted small">最近采样</span></div><div class="traffic-values"><div><span class="muted small">下行</span><strong class="metric" id="traffic-rx"></strong></div><div><span class="muted small">上行</span><strong class="metric" id="traffic-tx"></strong></div></div><svg class="traffic-histogram" viewBox="0 0 280 55" preserveAspectRatio="none" role="img" aria-label="最近 12 次网络采样，下行与上行吞吐量"><g id="traffic-bars"></g></svg></div><div class="card host-card"><div class="card-head"><span>运行状态</span><span class="muted" id="host-processes"></span></div><strong class="metric" id="uptime-value"></strong><dl class="host-facts"><div><dt>启动时间</dt><dd id="boot-value"></dd></div><div><dt>登录用户</dt><dd id="users-value"></dd></div><div><dt>面板会话</dt><dd id="sessions-value"></dd></div></dl></div>`;
  }
  const load = Number(o.cpu.load[0]) || 0;
  const cores = Math.max(1, Number(o.cpu.cores) || 1);
  const loadPercent = load / cores * 100;
  const metrics = [
    ['cpu',o.cpu.percent,`${o.cpu.cores} 核 · ${o.cpu.model || 'CPU'}`],
    ['memory',o.memory.percent,`${fmtBytes(o.memory.used)} / ${fmtBytes(o.memory.total)}`],
    ['disk',o.disk_root.percent,`${fmtBytes(o.disk_root.used)} / ${fmtBytes(o.disk_root.total)}`],
    ['load',loadPercent,`1 / 5 / 15 分钟：${o.cpu.load.join(' / ')}`],
  ];
  for (const [id,value,detail] of metrics) {
    const card = cards.querySelector(`[data-gauge="${id}"]`);
    const gauge = card.querySelector('.resource-gauge');
    const amount = Math.max(0,Math.min(100,Number(value) || 0));
    updateAttribute(gauge,'aria-valuenow',amount.toFixed(1));
    updateAttribute(gauge,'aria-valuetext',`${pct(value)}，${detail}`);
    updateAttribute(gauge,'data-level',value >= 90 ? 'high' : value >= 70 ? 'elevated' : 'normal');
    updateAttribute(card.querySelector('.gauge-fill'),'stroke-dashoffset',(100 - amount).toFixed(2));
    updateText(card.querySelector('[data-field=value]'),pct(value));
    updateText(card.querySelector('[data-field=detail]'),detail);
    updateText(card.querySelector('[data-field=status]'), id === 'load' ? (loadPercent >= 100 ? '超过核心数基准' : '低于核心数基准') : '已用 / 总量');
  }
  updateText($('#core-count'),`${cores} 逻辑核心`);
  const perCore = Array.isArray(o.cpu.per_core) ? o.cpu.per_core : [];
  const parent = $('#core-bars');
  const coreNodes = perCore.map((value,index) => {
    let el = parent.children[index];
    if (!el || !el.dataset.core) {
      el = document.createElement('div'); el.className='core-row'; el.dataset.core=String(index+1);
      el.innerHTML = '<span></span><div class="core-track"><i></i></div><strong></strong>';
    }
    updateText(el.children[0],`CPU ${index}`); updateText(el.children[2],pct(value));
    const width = Math.max(0,Math.min(100,Number(value) || 0)).toFixed(1) + '%';
    if (el.querySelector('i').style.width !== width) el.querySelector('i').style.width = width;
    updateAttribute(el,'aria-label',`CPU ${index}，使用率 ${pct(value)}`);
    return el;
  });
  if (!coreNodes.length) {
    let empty=parent.querySelector('.core-unavailable');
    if (!empty) {empty=document.createElement('p');empty.className='core-unavailable muted';empty.textContent='核心明细暂不可用';}
    coreNodes.push(empty);
  }
  reconcileChildren(parent,coreNodes);
  const swap = o.swap;
  updateText($('#swap-value'),swap.total ? `${fmtBytes(swap.used)} / ${fmtBytes(swap.total)} · ${pct(swap.percent)}` : '未配置');
  $('#swap-bar').style.width = Math.max(0,Math.min(100,swap.percent || 0)) + '%';
  updateAttribute($('.capacity-track'),'aria-valuenow',Math.max(0,Math.min(100,swap.percent || 0)));
  const latest = points.at(-1) || (m && m.latest) || {};
  updateText($('#traffic-rx'),fmtRate(latest.net_rx)); updateText($('#traffic-tx'),fmtRate(latest.net_tx));
  const recent = points.slice(-12);
  const peak = Math.max(1,...recent.flatMap((point) => [point.net_rx || 0,point.net_tx || 0]));
  const bars = $('#traffic-bars');
  if (!bars.children.length) {
    bars.innerHTML = Array.from({length:24},(_,i) => `<rect x="${Math.floor(i/2)*23.3+(i%2)*9}" width="7" y="52" height="0" rx="1" class="traffic-${i%2 ? 'tx' : 'rx'}"/>`).join('');
  }
  for (let i=0;i<12;i++) for (let direction=0;direction<2;direction++) {
    const value = recent[i]?.[direction ? 'net_tx' : 'net_rx'] || 0;
    const height = value / peak * 48;
    const bar = bars.children[i*2+direction];
    updateAttribute(bar,'height',height.toFixed(2)); updateAttribute(bar,'y',(52-height).toFixed(2));
  }
  updateText($('#host-processes'),`${o.process_count} 个进程`);
  updateText($('#uptime-value'),o.uptime_human); updateText($('#boot-value'),fmtTime(o.boot_time));
  updateText($('#users-value'),`${o.user_count} 人`); updateText($('#sessions-value'),`${o.panel?.sessions || 0} 个`);
}

function renderProcTable(items) {
  const table = $('#proc-table');
  if (!table.tHead) table.innerHTML = '<thead><tr><th class="num">PID</th><th>名称</th><th>用户</th><th class="num">CPU%</th><th class="num">内存%</th><th class="num">RSS</th><th>命令行</th></tr></thead><tbody></tbody>';
  const previous = table.procRows || new Map(), next = new Map();
  const rows = items.map(p => {
    const row = previous.get(p.pid) || document.createElement('tr');
    if (!row.cells.length) row.innerHTML = '<td class="num"></td><td></td><td></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="muted"></td>';
    const values = [p.pid,p.name,p.user,`${Number(p.cpu).toFixed(1)}%`,`${Number(p.mem_percent).toFixed(1)}%`,fmtBytes(p.rss),(p.cmdline || '').slice(0,80)];
    values.forEach((value,index) => updateText(row.cells[index],String(value)));
    updateAttribute(row.cells[6],'title',p.cmdline || '');row.dataset.pid = p.pid;
    next.set(p.pid,row);return row;
  });
  reconcileChildren(table.tBodies[0],rows);table.procRows = next;
}

/* ---------- 曲线 ---------- */
const CHART_FALLBACK_HEIGHT = 176; // CSS controls the display height, including text zoom.

function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * exp;
}

function drawChart(canvas, defs, opts) {
  opts = opts || {};
  if (!canvas) return;
  // 隐藏的标签页里 clientWidth 是 0，这时画出来的是垃圾位图，直接跳过
  if (!canvas.clientWidth) return;
  const fmt = opts.format || ((v) => String(Math.round(v)));
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(80, Math.round(canvas.clientWidth));
  const displayStyle = getComputedStyle(canvas);
  const h = parseFloat(displayStyle.height) || CHART_FALLBACK_HEIGHT;
  const labelSize = parseFloat(displayStyle.fontSize) || 14;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);   // 注意：这会同时改掉 height 属性（位图尺寸）
    canvas.height = Math.round(h * dpr);  // 所以逻辑高度必须另存，不能反过来读属性
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: Math.ceil(labelSize * 5.8), r: 12, t: labelSize, b: labelSize * 1.5 };
  const iw = Math.max(10, w - pad.l - pad.r), ih = Math.max(10, h - pad.t - pad.b);

  let max = 0;
  defs.forEach((d) => d.data.forEach((v) => { if (v > max) max = v; }));
  if (opts.fixedMax) max = opts.fixedMax;
  max = opts.maximum ?? niceMax(max);

  ctx.strokeStyle = themeColor('--ct-line');
  ctx.fillStyle = themeColor('--ct-muted');
  ctx.font = `${labelSize}px ${displayStyle.fontFamily}`;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + iw, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const label = fmt(max * (1 - i / 4));
    ctx.fillText(label, pad.l - 6, y);
  }

  const n = Math.max(...defs.map((d) => d.data.length), 2);
  defs.forEach((d) => {
    if (!d.data.length) return;
    ctx.beginPath();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = d.color;
    d.data.forEach((v, i) => {
      const x = pad.l + (iw * i) / Math.max(1, n - 1);
      const y = pad.t + ih - (ih * Math.min(v, max)) / max;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = d.color; ctx.lineWidth = 1.6; ctx.stroke();
  });
}

function paintCharts(points, limits = chartLimits(points)) {
  const legendColors=[['--ct-accent','--chart-memory'],['--chart-rx','--chart-tx'],['--chart-disk','--chart-write'],['--chart-load']];
  $$('.chartgrid .card').forEach((card,index)=>card.querySelectorAll('.legend i').forEach((dot,n)=>{const color=themeColor(legendColors[index][n]);if(dot.dataset.color!==color){dot.style.background=color;dot.dataset.color=color;}}));
  const series = (key) => points.map((p) => Number(p[key]) || 0);
  drawChart($('#chart-cpu'), [
    { data: series('cpu'), color: themeColor('--ct-accent') },
    { data: series('mem'), color: themeColor('--chart-memory') },
  ], { fixedMax: 100, maximum:limits[0], format: (v) => v.toFixed(0) + '%' });
  drawChart($('#chart-net'), [
    { data: series('net_rx'), color: themeColor('--chart-rx') },
    { data: series('net_tx'), color: themeColor('--chart-tx') },
  ], { maximum:limits[1], format: (v) => fmtBytes(v, 0) + '/s' });
  drawChart($('#chart-dio'), [
    { data: series('disk_r'), color: themeColor('--chart-disk') },
    { data: series('disk_w'), color: themeColor('--chart-write') },
  ], { maximum:limits[2], format: (v) => fmtBytes(v, 0) + '/s' });
  drawChart($('#chart-load'), [{ data: series('load1'), color: themeColor('--chart-load') }], { maximum:limits[3], format: (v) => v.toFixed(1) });

}
const chartKeys = ['cpu','mem','net_rx','net_tx','disk_r','disk_w','load1'];
let chartAnimation = 0, chartDisplay = [];
function chartLimits(points) {
  const peak = keys => niceMax(Math.max(0,...points.flatMap(point => keys.map(key => Number(point[key]) || 0))));
  return [100,peak(['net_rx','net_tx']),peak(['disk_r','disk_w']),peak(['load1'])];
}
function renderCharts(points = [], animate = false) {
  cancelAnimationFrame(chartAnimation);chartAnimation = 0;
  state.lastPoints = points;
  const last = points.at(-1) || {};
  updateText($('#chart-cpu-now'),`CPU ${pct(last.cpu)} · 内存 ${pct(last.mem)}`);
  updateText($('#chart-net-now'),`↓ ${fmtRate(last.net_rx || 0)} ↑ ${fmtRate(last.net_tx || 0)}`);
  updateText($('#chart-dio-now'),`读 ${fmtRate(last.disk_r || 0)} 写 ${fmtRate(last.disk_w || 0)}`);
  updateText($('#chart-load-now'),`load1 ${(last.load1 || 0).toFixed(2)}`);
  const same = points.length === chartDisplay.length && points.every((p,i) => chartKeys.every(key => (p[key] || 0) === (chartDisplay[i][key] || 0)));
  if (animate && same) return;
  if (!animate || chartDisplay.length < 2 || points.length < 2 || document.hidden || state.tab !== 'dash' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    chartDisplay = points;paintCharts(points);return;
  }
  const old = chartDisplay, fromLimits = chartLimits(old), toLimits = chartLimits(points), began = performance.now();
  const from = points.map((p,i) => {
    const position = i * (old.length - 1) / (points.length - 1), index = Math.floor(position), fraction = position - index;
    return Object.fromEntries(chartKeys.map(key => [key,(Number(old[index][key]) || 0) * (1-fraction) + (Number(old[Math.min(index+1,old.length-1)][key]) || 0) * fraction]));
  });
  const frame = now => {
    if (state.tab !== 'dash' || document.hidden) {chartDisplay = points;chartAnimation = 0;return;}
    const progress = Math.min(1,(now - began) / 280), amount = 1 - (1-progress) ** 3;
    chartDisplay = points.map((p,i) => Object.fromEntries(chartKeys.map(key => [key,from[i][key] + ((Number(p[key]) || 0)-from[i][key]) * amount])));
    paintCharts(chartDisplay,fromLimits.map((value,i) => value + (toLimits[i]-value)*amount));
    if (progress < 1) chartAnimation = requestAnimationFrame(frame);else {chartDisplay = points;chartAnimation = 0;}
  };
  chartAnimation = requestAnimationFrame(frame);
}

async function refresh(silent, background = false) {
  if (state.tab !== 'dash' && !background) return;
  try {
    const [ov, mt, pr] = await Promise.all([
      api('/api/system/overview'),
      api(`/api/system/metrics?points=${state.points}`),
      api(`/api/system/processes?limit=15&sort=${state.procSort === 'mem' ? 'mem' : 'cpu'}`),
    ]);
    state.lastUpdated = new Date();
    $('#last-updated').textContent = state.lastUpdated.toLocaleTimeString('zh-CN', {hour12:false});
    $('#last-updated').dateTime = state.lastUpdated.toISOString();
    $('#refresh-error').textContent = '';
    renderCards(ov, ov.metrics, mt.points || []);
    renderCharts(mt.points || [], true);
    renderProcTable(pr.items || []);
  } catch (e) {
    if (!e.handled) {
      $('#refresh-error').textContent = '连接异常，正在重试';
      console.error(e);
    }
  }
}

/* ===================== 系统页 ===================== */
function factList(el, rows) {
  el.innerHTML = rows.map(([label,value,wide]) => `<div${wide ? ' class="fact-wide"' : ''}><dt>${esc(label)}</dt><dd>${esc(value ?? '—')}</dd></div>`).join('');
}
function resourceBar(label, value, detail) {
  const amount = Math.max(0,Math.min(100,Number(value) || 0));
  return `<div><div class="resource-label"><span>${esc(label)}</span><strong>${pct(value)}</strong></div><div class="capacity-track" role="meter" aria-label="${esc(label)}使用率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${amount}"><i style="width:${amount}%;background:${barColor(amount)}"></i></div><p class="resource-detail">${esc(detail)}</p></div>`;
}
let systemRequest = 0;
async function loadSystem() {
  const request = ++systemRequest;
  setMsg('#system-err', '');
  loadStorage();
  try {
    const [ov, dk, nw] = await Promise.all([
      api('/api/system/overview'), api('/api/system/disks'), api('/api/system/network'),
    ]);
    if (request !== systemRequest) return;
    updateText($('#system-host'),ov.hostname); updateText($('#system-os'),ov.os);
    updateText($('#system-uptime'),ov.uptime_human); updateText($('#system-ip'),ov.primary_ip || '暂无出口地址');
    factList($('#system-facts'),[
      ['操作系统',ov.os,true],['内核版本',ov.kernel,true],['架构',ov.arch],['虚拟化',ov.virtualization],
      ['启动时间',fmtTime(ov.boot_time)],['当前进程',ov.process_count],['面板版本',`cyan-panel ${ov.panel.version}`],['面板会话 / 用户',`${ov.panel.sessions} / ${ov.panel.users}`],
    ]);
    factList($('#hardware-facts'),[
      ['处理器',ov.cpu.model,true],['核心数',`${ov.cpu.cores} 逻辑 / ${ov.cpu.physical ?? '—'} 物理`],['负载 · 1 / 5 / 15 分钟',ov.cpu.load.join(' / ')],
    ]);
    $('#system-resources').innerHTML = resourceBar('CPU',ov.cpu.percent,`${ov.cpu.cores} 个逻辑核心`)
      + resourceBar('内存',ov.memory.percent,`${fmtBytes(ov.memory.used)} 已用 / ${fmtBytes(ov.memory.total)} 总量`)
      + resourceBar('Swap',ov.swap.percent,`${fmtBytes(ov.swap.used)} 已用 / ${fmtBytes(ov.swap.total)} 总量`);
    $('#system-disks').innerHTML = (dk.items || []).map((d) => `<section><div class="system-item-heading"><h3>${esc(d.mountpoint)}</h3><span>${esc(d.fstype)}</span></div><p class="disk-device">${esc(d.device)}</p>${resourceBar('已用空间',d.percent,`${fmtBytes(d.used)} / ${fmtBytes(d.total)} · 可用 ${fmtBytes(d.free)}`)}</section>`).join('') || '<p class="system-empty">暂无磁盘挂载信息</p>';
    const interfaces = new Map(Object.keys(nw.io || {}).map((name) => [name,[]]));
    for (const address of nw.addresses || []) {
      if (!interfaces.has(address.interface)) interfaces.set(address.interface,[]);
      interfaces.get(address.interface).push(address);
    }
    $('#system-network').innerHTML = Array.from(interfaces,([name,addresses]) => {
      const io = (nw.io || {})[name];
      return `<section><div class="system-item-heading"><h3>${esc(name)}</h3><span>${addresses.length} 个地址</span></div><ul class="network-addresses">${addresses.map((a) => `<li><span class="pill">${a.ipv6 ? 'IPv6' : 'IPv4'}</span><span class="address-value" title="${esc(a.netmask || '')}">${esc(a.ip)}</span></li>`).join('') || '<li class="system-empty">暂无 IP 地址</li>'}</ul><div class="network-traffic"><span>累计接收 <strong>${io ? fmtBytes(io.rx) : '—'}</strong></span><span>累计发送 <strong>${io ? fmtBytes(io.tx) : '—'}</strong></span></div></section>`;
    }).join('') || '<p class="system-empty">暂无网络接口信息</p>';
    loadAudit();
  } catch (e) {
    if (request === systemRequest && !e.handled) setMsg('#system-err','系统信息读取失败：' + e.message);
  }
}

const storageColors = Object.fromEntries(['system','apps','config','cache','logs','backups','users','other'].map(id=>[id,`var(--storage-${id})`]));
const storageCategoryId = id => ({data:'apps',temp:'cache'}[id] || id);
function groupStorageCategories(categories) {
  const merged=new Map();
  for(const category of categories){
    const id=storageCategoryId(category.id);
    if(!merged.has(id)) merged.set(id,{...category,id,label:({apps:'应用与数据',cache:'缓存与临时文件'}[id] || category.label),size:0,groups:new Map()});
    const target=merged.get(id);target.size+=category.size;
    for(const group of category.groups)target.groups.set(group.path,(target.groups.get(group.path)||0)+group.size);
  }
  return [...merged.values()].map(category=>{
    const groups=[...category.groups].map(([path,size])=>({path,size})).sort((a,b)=>b.size-a.size).slice(0,6);
    return {...category,groups,remaining:category.size-groups.reduce((sum,group)=>sum+group.size,0)};
  });
}
let storageRequest = 0, storageRender = null, storageScope = '/', storageResult = null, storageCategory = null;
let storageAnimations = [], storageGhost = null;
async function loadStorage(refresh = false) {
  const request = ++storageRequest, button = $('#btn-storage-refresh');
  button.disabled = true;
  try {
    while (request === storageRequest && state.tab === 'system') {
      const data = await api('/api/system/storage' + (refresh ? '?refresh=true' : ''));
      refresh = false;
      if (request !== storageRequest || state.tab !== 'system') return;
      $('#storage-analysis').dataset.storageStatus=data.status;
      if (data.result) renderStorage(data.result);
      const status = $('#storage-status');
      if (data.status === 'running') {
        updateText(status, `正在扫描 · 已读取 ${(data.progress?.entries || 0).toLocaleString('zh-CN')} 项${data.result ? ' · 下方保留上次结果' : ''}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        const result = data.result;
        if (data.status === 'error') updateText(status, data.error || '存储信息读取失败，请重试。');
        else if (result) updateText(status, `${data.status === 'partial' ? '部分结果 · ' : ''}扫描于 ${fmtTime(result.finished_at)} · ${result.entries.toLocaleString('zh-CN')} 项${result.errors ? ` · ${result.errors} 项无法读取` : ''}${result.partial_reason === 'timeout' ? ' · 已达到扫描时限，可重新扫描' : result.partial_reason === 'entry_limit' ? ' · 已达到本次扫描数量上限' : ''}`);
        else updateText(status, '暂无存储分析结果，请重新扫描。');
        return;
      }
    }
  } catch (e) {
    if (request === storageRequest && !e.handled) updateText($('#storage-status'), '存储信息读取失败：' + e.message);
  } finally { if (request === storageRequest) button.disabled = false; }
}
function storageSegments(result) {
  const disk=result.disk, height=376;
  const capacity=Math.max(disk.total,result.scanned_bytes+Math.max(0,result.difference)+(disk.reserved||0),1);
  const layers=[{id:'reserved',size:disk.reserved||0,color:'var(--ct-muted)'},{id:'difference',size:Math.max(0,result.difference),color:'var(--ct-line)'},...[...result.categories].sort((a,b)=>a.size-b.size).map(c=>({...c,category:true,color:storageColors[c.id] || 'var(--ct-muted)'})),{id:'free',size:Math.max(0,capacity-result.scanned_bytes-Math.max(0,result.difference)-(disk.reserved||0)),color:'var(--ct-line)'}].filter(c=>c.size>0);
  // Clamp small categories without claiming that the resulting geometry is an exact ratio.
  let remaining=height,weight=layers.reduce((sum,c)=>sum+c.size,0),active=[...layers];
  while(active.length){
    const small=active.filter(c=>c.size/weight*remaining<(c.category?32:c.id==='free'?24:8));
    if(!small.length){active.forEach(c=>c.height=c.size/weight*remaining);break;}
    for(const c of small){c.height=c.category?32:c.id==='free'?24:8;remaining-=c.height;weight-=c.size;}
    active=active.filter(c=>!small.includes(c));
  }
  return layers;
}
function showStorageCategory(id, animate=true) {
  if(!storageResult || !$('#storage-panel')) return;
  id=storageCategoryId(id);
  const category=storageResult.categories.find(c=>c.id===id),previous=storageCategory;
  id=category?.id || null;
  storageAnimations.forEach(animation=>animation.cancel());storageAnimations=[];storageGhost?.remove();storageGhost=null;
  const panel=$('#storage-panel'),list=$('#storage-categories'),detail=$('#storage-detail');
  const outgoing=previous?detail:list;
  let ghost;
  if(animate && id!==previous && !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden){
    ghost=outgoing.cloneNode(true);ghost.removeAttribute('id');ghost.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id'));ghost.inert=true;ghost.setAttribute('aria-hidden','true');ghost.classList.add('storage-panel-ghost');panel.append(ghost);storageGhost=ghost;
  }
  storageCategory=id;
  list.hidden=!!id;list.inert=!!id;detail.hidden=!id;detail.inert=!id;
  for(const node of document.querySelectorAll('[data-storage-category]')){
    const selected=!!id&&node.dataset.storageCategory===id;
    node.setAttribute('aria-pressed',String(selected));node.classList.toggle('is-selected',selected);
    node.classList.toggle('is-dimmed',!!id&&!selected);
  }
  if(category){
    const percentage=storageResult.scanned_bytes?category.size/storageResult.scanned_bytes*100:0;
    detail.innerHTML=`<div class="storage-detail-head"><button type="button" class="icon-button" data-storage-back aria-label="返回分类">${icon('arrow-left')}</button><h3 id="storage-detail-title" tabindex="-1">${esc(category.label)}</h3></div>
      <div class="storage-detail-summary"><strong>${fmtBytes(category.size)}</strong><span class="muted small" aria-label="占已扫描空间 ${percentage.toFixed(1)}%">占比 ${percentage.toFixed(1)}%</span></div>
      <div class="storage-directories">${category.groups.map(group=>`<button type="button" class="storage-directory" data-storage-path="${esc(group.path)}" title="${esc(group.path)}" aria-label="在文件管理查看 ${esc(group.path)}，当前分类 ${fmtBytes(group.size)}"><span>${esc(group.path)}</span><strong>${fmtBytes(group.size)}</strong>${icon('chevron')}</button>`).join('')||'<p class="muted storage-empty">未发现对应文件</p>'}</div>
      <p class="muted small storage-detail-note">${category.remaining>0 ? `其他位置 ${fmtBytes(category.remaining)} · 仅此分类` : '目录大小仅包含当前分类'}</p>`;
  }
  if(ghost){
    const direction=id?1:-1,options={duration:280,easing:'cubic-bezier(.22,.75,.18,1)'};
    const old=ghost.animate([{opacity:1,transform:'translateX(0)'},{opacity:0,transform:`translateX(${-direction*12}px)`}],{...options,duration:200});
    const incoming=(id?detail:list).animate([{opacity:0,transform:`translateX(${direction*16}px)`},{opacity:1,transform:'translateX(0)'}],options);
    storageAnimations=[old,incoming];old.finished.catch(()=>{}).finally(()=>{ghost.remove();if(storageGhost===ghost)storageGhost=null;});
  }
  if(animate && id!==previous){
    if(id) $('#storage-detail-title').focus({preventScroll:true});
    else list.querySelector('[data-category="'+CSS.escape(previous || '')+'"]')?.focus({preventScroll:true});
    saveRouteView();
  }
}
function renderStorage(result) {
  result={...result,categories:groupStorageCategories(result.categories)};
  storageResult=result;storageScope=result.scope;
  if(storageRender===result.finished_at){showStorageCategory(storageCategory,false);return;}
  storageRender=result.finished_at;
  const host=$('#storage-content'),categories=[...result.categories].sort((a,b)=>b.size-a.size),disk=result.disk,layers=storageSegments(result);
  let y=388;
  const bands=layers.map(c=>{
    const bottom=y;y-=c.height;
    return `<path class="storage-band storage-${c.id}" data-storage-bytes="${c.size}" data-storage-height="${c.height}" fill="${c.color}" d="M16 ${y}H104V${bottom}H16Z"${c.category?` data-storage-category="${c.id}" role="button" tabindex="0" aria-pressed="false" aria-label="${esc(c.label)} ${fmtBytes(c.size)}，查看或关闭详情"`:''}/>`;
  }).join('');
  host.innerHTML=`<p class="storage-capacity"><span class="muted">已用 <strong>${fmtBytes(disk.used)}</strong></span><span class="muted">可用 <strong>${fmtBytes(disk.available)}</strong></span><span class="muted">共 <strong>${fmtBytes(disk.total)}</strong></span></p>
    <div class="storage-overview"><div class="storage-visual"><div class="storage-cylinder"><svg viewBox="0 0 120 400" preserveAspectRatio="none" role="group" aria-label="磁盘分类占用，点击色块查看或关闭详情；微小分类放大显示"><defs><clipPath id="storage-clip"><rect x="16" y="12" width="88" height="376" rx="14"/></clipPath></defs><rect x="16" y="12" width="88" height="376" rx="14" fill="var(--ct-line)" opacity=".18"/><g clip-path="url(#storage-clip)">${bands}</g><rect class="storage-outline" x="16" y="12" width="88" height="376" rx="14" fill="none" stroke="var(--ct-fg)" stroke-opacity=".12"/></svg></div><p class="storage-used"><strong>${(disk.total?disk.used/disk.total*100:0).toFixed(1)}%</strong><span class="muted small">磁盘已用</span></p><span class="storage-scale-note muted small">小项放大，非等比</span></div>
    <div class="storage-panel" id="storage-panel"><div class="storage-categories" id="storage-categories">${categories.map(c=>`<button type="button" class="storage-category" data-category="${c.id}" style="--storage-color:${storageColors[c.id] || 'var(--ct-muted)'}" aria-label="${esc(c.label)} ${fmtBytes(c.size)}，查看详情"><span class="storage-category-title"><i aria-hidden="true"></i><span>${esc(c.label)}</span></span><strong>${fmtBytes(c.size)}</strong></button>`).join('')}</div><section class="storage-detail" id="storage-detail" aria-labelledby="storage-detail-title" hidden></section></div></div>`;
  const difference=result.difference>=0?`${result.partial_reason?'尚未扫描 / 磁盘差额':'文件系统等差额'} ${fmtBytes(result.difference)}`:`分类统计比已用多 ${fmtBytes(-result.difference)}（文件变化或口径差异）`;
  $('#storage-method').textContent=`统计范围 ${result.scope} · 已扫描 ${fmtBytes(result.scanned_bytes)} · ${difference} · 文件系统预留 ${fmtBytes(disk.reserved)}。按目录及文件类型归类，每份占用仅计一类；目录数值仅包含当前分类。灰色为预留 / 差额，上方为可用空间。微小分类保留最小显示高度，实际占用以数值为准。`;
  host.hidden=false;showStorageCategory(storageCategory,false);
}
$('#btn-storage-refresh').addEventListener('click',()=>loadStorage(true));
$('#storage-content').addEventListener('click',event=>{
  if(event.target.closest('[data-storage-back]')){showStorageCategory(null);return;}
  const band=event.target.closest('[data-storage-category]');
  if(band){showStorageCategory(storageCategory===band.dataset.storageCategory?null:band.dataset.storageCategory);return;}
  if(storageCategory && event.target.closest('.storage-cylinder')){showStorageCategory(null);return;}
  const category=event.target.closest('[data-category]');
  if(category){showStorageCategory(category.dataset.category);return;}
  const button=event.target.closest('[data-storage-path]');
  if(!button || !withinRoot(button.dataset.storagePath,storageScope))return;
  saveRouteView();pushRoute({tab:'files',path:button.dataset.storagePath});switchTab('files',navigation.entry);
});
$('#storage-content').addEventListener('keydown',event=>{
  const band=event.target.closest('[data-storage-category]');
  if(event.key==='Escape' && storageCategory){event.preventDefault();showStorageCategory(null);return;}
  if(band && ['Enter',' '].includes(event.key)){event.preventDefault();band.dispatchEvent(new MouseEvent('click',{bubbles:true}));}
});

const auditLabels = {
  startup:'面板启动',login_ok:'登录成功',login_failed:'登录失败',login_blocked:'登录受限',logout:'退出登录',
  password_changed:'修改密码',password_change_failed:'修改密码失败',file_download:'下载文件',file_upload:'上传文件',file_upload_failed:'上传失败',
  file_write:'保存文件',file_mkdir:'新建文件夹',file_rename:'重命名',file_delete:'删除文件',file_chmod:'修改权限',
  ssh_disconnect:'断开 SSH',ssh_disconnect_failed:'断开 SSH 失败',terminal_open:'打开终端',terminal_close:'关闭终端',terminal_kill:'结束终端',terminal_error:'终端异常',
};
async function loadAudit() {
  const button = $('#btn-audit'); button.disabled = true;
  setMsg('#audit-err','');
  try {
    const res = await api('/api/audit?limit=50');
    $('#audit-table').innerHTML = '<thead><tr><th>时间</th><th>账号</th><th>来源地址</th><th>操作</th><th>详情</th></tr></thead><tbody>' +
      ((res.items || []).map((a) => `<tr><td class="muted">${fmtTime(a.ts)}</td><td>${esc(a.username)}</td><td>${esc(a.ip)}</td><td>${esc(auditLabels[a.action] || a.action)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('') || '<tr><td colspan="5" class="audit-empty">暂无操作记录</td></tr>') + '</tbody>';
  } catch (e) { if (!e.handled) setMsg('#audit-err','操作记录读取失败：' + e.message); }
  finally { button.disabled = false; }
}
$('#btn-audit').addEventListener('click', loadAudit);

/* ===================== Web 终端 ===================== */
const terminalWorkspace = $('#terminal-workspace');
const terminalHome = document.createComment('terminal workspace');
terminalWorkspace.before(terminalHome);
const termModifiers = {ctrl:false,alt:false,meta:false};
const termViewport = {mobile:false,width:0,height:0,frame:0};
function resetTermModifiers() {
  Object.keys(termModifiers).forEach(key => termModifiers[key] = false);
  $$('#term-keys [data-modifier]').forEach(button => button.setAttribute('aria-pressed','false'));
}
function consumeTermModifiers(data) {
  if (!Object.values(termModifiers).some(Boolean)) return data;
  // Do not turn IME commits or multi-character pastes into control characters.
  if (termModifiers.ctrl && data.length === 1 && /^[ -~]$/.test(data)) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95 || code === 32) data = String.fromCharCode(code & 31);
    else if (code === 63) data = '\x7f';
  }
  // A PTY has no Windows desktop key. Win is the terminal's Meta modifier (ESC prefix).
  if (termModifiers.alt || termModifiers.meta) data = '\x1b' + data;
  resetTermModifiers();
  return data;
}
function terminalKey(key) {
  const arrows = {ArrowUp:'A',ArrowDown:'B',ArrowRight:'C',ArrowLeft:'D',Home:'H',End:'F'};
  const modifier = 1 + (termModifiers.alt || termModifiers.meta ? 2 : 0) + (termModifiers.ctrl ? 4 : 0);
  if (arrows[key]) {
    const data = modifier > 1 ? `\x1b[1;${modifier}${arrows[key]}` : (state.xterm?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + arrows[key];
    resetTermModifiers(); return data;
  }
  const tilde = {Delete:3,PageUp:5,PageDown:6};
  if (tilde[key]) {const data = `\x1b[${tilde[key]}${modifier > 1 ? ';' + modifier : ''}~`;resetTermModifiers();return data;}
  const direct = {Escape:'\x1b',Tab:'\t',Enter:'\r',Backspace:'\x7f',interrupt:'\x03',eof:'\x04',suspend:'\x1a'};
  return consumeTermModifiers(direct[key] || '');
}
function focusTerminal() { state.xterm?.textarea?.focus({preventScroll:true}); }
$('#term-keys').addEventListener('pointerdown',event => {if (event.target.closest('button')) event.preventDefault();});
$('#term-keys').addEventListener('click',event => {
  const button = event.target.closest('button');
  if (!button || !state.xterm || !state.termConnected) return;
  if (button.dataset.modifier) {
    const key = button.dataset.modifier; termModifiers[key] = !termModifiers[key];
    button.setAttribute('aria-pressed',String(termModifiers[key])); focusTerminal();
  } else {
    const data = terminalKey(button.dataset.termKey);
    if (data) state.xterm.input(data,true);
  }
});
$('#btn-term-keyboard').addEventListener('click',() => {
  if (document.activeElement === state.xterm?.textarea) state.xterm.blur(); else focusTerminal();
});
$('#btn-term-keyboard').addEventListener('pointerdown',event => event.preventDefault());
$('#btn-term-return').addEventListener('click',() => {state.xterm?.blur();navigateTab('dash');});
$('#btn-term-sessions').addEventListener('click',() => {
  state.xterm?.blur();
  const list = $('.terminal-sessions'), home = document.createComment('terminal sessions'), wasOpen = list.open;
  list.before(home);
  const dialog = modal('<div id="term-session-slot"></div><div class="modal-actions"><button type="button" id="term-session-close">关闭</button></div>');
  dialog.wrap.setAttribute('aria-label','终端会话');
  dialog.q('#term-session-slot').append(list);list.open = true;
  dialog.q('#term-session-close').onclick = dialog.close;
  dialog.wrap.addEventListener('close',() => {home.replaceWith(list);list.open = wasOpen;},{once:true});
  loadTermSessions();
});
function updateTerminalLayout(forceOff = false) {
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const mobile = !forceOff && !!state.me && state.tab === 'terminal' && (innerWidth <= 599 || touch && innerWidth <= 959);
  if (mobile && !termViewport.mobile) {
    termViewport.height = Math.max(innerHeight,window.visualViewport?.height || 0);
    termViewport.width = innerWidth;
    document.body.append(terminalWorkspace);
  } else if (!mobile && termViewport.mobile) {
    terminalHome.after(terminalWorkspace);
  }
  termViewport.mobile = mobile;
  document.documentElement.classList.toggle('terminal-mobile',mobile);
  if (!mobile) {document.documentElement.classList.remove('terminal-keyboard-open');return;}
  const viewport = window.visualViewport;
  const unzoomed = !viewport || viewport.scale < 1.1;
  const height = unzoomed ? viewport?.height || innerHeight : innerHeight;
  if (Math.abs(innerWidth - termViewport.width) > 80) {termViewport.height = height;termViewport.width = innerWidth;}
  termViewport.height = Math.max(termViewport.height,height);
  const focused = document.activeElement === state.xterm?.textarea;
  const keyboard = focused && unzoomed && termViewport.height - height > 120;
  document.documentElement.classList.toggle('terminal-keyboard-open',keyboard);
  const rail = $('.sidebar').getBoundingClientRect();
  const bottom = !keyboard && rail.width > innerWidth * .7 ? rail.height : 0;
  const left = !keyboard && rail.width <= innerWidth * .7 ? rail.width : 0;
  terminalWorkspace.style.setProperty('--term-view-height',Math.max(0,height - bottom) + 'px');
  terminalWorkspace.style.setProperty('--term-view-top',(unzoomed ? viewport?.offsetTop || 0 : 0) + 'px');
  terminalWorkspace.style.setProperty('--term-view-left',((unzoomed ? viewport?.offsetLeft || 0 : 0) + left) + 'px');
  terminalWorkspace.style.setProperty('--term-view-width',((unzoomed ? viewport?.width || innerWidth : innerWidth) - left) + 'px');
}
function scheduleTerminalLayout() {
  if (termViewport.frame) return;
  termViewport.frame = requestAnimationFrame(() => {termViewport.frame = 0;updateTerminalLayout();if (state.tab === 'terminal') fitTerminal();});
}
window.visualViewport?.addEventListener('resize',scheduleTerminalLayout);
window.visualViewport?.addEventListener('scroll',scheduleTerminalLayout);

function setTermStatus(text, bad) {
  $('#term-status').textContent = text;
  $('#term-status').style.color = bad ? themeColor('--ct-danger') : '';
  $$('#term-keys button').forEach(button => button.disabled = !state.termConnected);
  if (!state.termConnected) resetTermModifiers();
}

function initTerminal() {
  updateTerminalLayout();
  if (state.xterm) { setTimeout(fitTerminal, 30); return; }
  if (typeof Terminal === 'undefined') {
    setTermStatus('xterm.js 未加载，无法启动终端', true);
    return;
  }
  const term = new Terminal({
    fontSize: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    cursorBlink: true,
    scrollback: 3000,
    theme: {
      background: themeColor('--ct-input'), foreground: themeColor('--ct-fg'), cursor: themeColor('--ct-accent'),
      selectionBackground: themeColor('--ct-accent-soft'), black: '#1c222b', brightBlack: '#8b98ab',
    },
  });
  state.xterm = term;
  if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
    state.fit = new FitAddon.FitAddon();
    term.loadAddon(state.fit);
  }
  term.open($('#term'));
  term.textarea.setAttribute('aria-label','终端输入');
  term.textarea.setAttribute('autocapitalize','off');
  term.textarea.setAttribute('autocomplete','off');
  term.textarea.setAttribute('autocorrect','off');
  term.textarea.spellcheck = false;
  term.textarea.addEventListener('focus',() => {$('#btn-term-keyboard').setAttribute('aria-pressed','true');scheduleTerminalLayout();});
  term.textarea.addEventListener('blur',() => {$('#btn-term-keyboard').setAttribute('aria-pressed','false');scheduleTerminalLayout();});
  term.onData((data) => {
    data = consumeTermModifiers(data);
    if (state.termConnected) sendTerm({ type: 'input', data });
    else state.pending.push(data);
  });
  term.onResize(({ cols, rows }) => sendTerm({ type: 'resize', cols, rows }));
  connectTerminal();
}

function fitTerminal() {
  if (!state.fit) return;
  try { state.fit.fit(); } catch (e) { /* 容器还没布局好 */ }
}

function sendTerm(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function connectTerminal() {
  if (state.connecting) return;
  state.connecting = true;
  state.termConnected = false;
  fitTerminal();
  const cols = (state.xterm && state.xterm.cols) || 100;
  const rows = (state.xterm && state.xterm.rows) || 30;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws/terminal?cols=${cols}&rows=${rows}`;
  setTermStatus('连接中…', false);
  let ws;
  try { ws = new WebSocket(url); } catch (e) { state.connecting = false; setTermStatus('连接失败：' + e.message, true); return; }
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    state.connecting = false;
    state.termConnected = true;
    setTermStatus('已连接', false);
    const pending = state.pending.splice(0);
    pending.forEach((data) => sendTerm({ type: 'input', data }));
    sendTerm({ type: 'resize', cols:state.xterm?.cols || cols, rows:state.xterm?.rows || rows });
    if (state.xterm && !termViewport.mobile && state.tab === 'terminal') focusTerminal();
    loadTermSessions();                     // 连上就立刻刷新会话表，不等定时器
  };
  ws.onmessage = (ev) => {
    if (!state.xterm || state.ws !== ws) return;
    if (typeof ev.data === 'string') state.xterm.write(ev.data);
    else state.xterm.write(new Uint8Array(ev.data));
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.connecting = false;
    state.termConnected = false;
    const why = ev.code === 1008 ? '鉴权失败，请重新登录'
      : ev.code === 1013 ? '并发终端数已达上限'
      : ev.code === 1006 ? '连接被拒绝：未登录或会话已过期，请刷新页面重新登录'
      : `连接已关闭 (${ev.code})`;
    setTermStatus(why, true);
    if (state.xterm) state.xterm.write(`\r\n\x1b[31m[${why}]\x1b[0m\r\n`);
  };
  ws.onerror = () => {if (state.ws === ws) setTermStatus('WebSocket 错误', true);};
}

function closeTerminal() {
  if (state.ws) { try { state.ws.close(); } catch (e) { /* 忽略 */ } state.ws = null; }
  state.termConnected = false;
  state.connecting = false; state.pending = []; resetTermModifiers();
  updateTerminalLayout(true);
  if (state.xterm) { state.xterm.dispose(); state.xterm = null; state.fit = null; }
}

$('#btn-term-reconnect').addEventListener('click', () => {
  if (!state.xterm) { initTerminal(); return; }
  closeTerminal();
  initTerminal();
});
$('#btn-term-clear').addEventListener('click', () => { if (state.xterm) state.xterm.clear(); });
window.addEventListener('resize', () => {
  scheduleTerminalLayout();
  if (state.tab === 'dash') {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => renderCharts(state.lastPoints || []), 120);
  }
});

/* ===================== 通用：提示 / 模态框 ===================== */
function setMsg(sel, text, ok) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text || '';
  el.style.color = ok === true ? 'var(--accent)' : '';
}

function modal(html) {
  const previous = document.activeElement;
  const wrap = document.createElement('dialog');
  wrap.className = 'modal-wrap';
  wrap.setAttribute('aria-label', '操作对话框');
  wrap.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(wrap);
  const finish = () => {
    wrap.remove();
    if (previous && document.contains(previous)) previous.focus();
  };
  const close = () => { if (wrap.open) wrap.close(); };
  wrap.addEventListener('close', finish, {once:true});
  wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(); });
  wrap.showModal();
  return { wrap, close, q: (sel) => wrap.querySelector(sel) };
}
function toast(message) {
  document.querySelector('.file-feedback')?.remove();
  const el = document.createElement('div');
  el.className = 'file-feedback'; el.setAttribute('role', 'status'); el.textContent = message;
  document.body.appendChild(el); setTimeout(() => el.remove(), 5000);
}

/* ===================== 文件管理 ===================== */
const filesState = {
  path: null, root: '/', items: [], parent: null, request: 0, loading: false,
  query: '', sort: 'name', hidden: true, tree: new Map(), expanded: new Set(),
  treeNodes: new Map(), treeRequests: new Map(), treeErrors: new Map(), rows: new Map(),
  listings: new Map(),
};
let fileMenu = null;
let uploading = false;
const isFolder = (it) => it.type === 'dir' || (it.type === 'link' && it.target_type === 'dir');
const withinRoot = (path, root) => root === '/' || path === root || path.startsWith(root + '/');
const baseName = (path) => path.split('/').filter(Boolean).pop() || '/';
// The preference is a pixel width, clamped again whenever the workspace resizes.
const fileManager = $('.file-manager');
const treeResizer = $('#file-sidebar-resizer');
const fileSidebar = $('#file-sidebar');
const treeDialog = $('#file-tree-dialog');
const treeDrawerButton = $('#btn-tree-drawer');
let preferredTreeWidth = null;
try { preferredTreeWidth = Number(localStorage.getItem('cyan-panel.tree-width')) || null; } catch (_) { /* storage is optional */ }
function treeWidthLimits() {
  const width = fileManager.clientWidth;
  return {min:220, max:Math.max(220, Math.min(640, Math.floor(width * 0.48), width - 640))};
}
function setTreeWidth(value, persist = false) {
  if (fileManager.classList.contains('tree-compact')) return;
  const limits = treeWidthLimits();
  const width = Math.round(Math.max(limits.min, Math.min(limits.max, value ?? Math.min(320, fileManager.clientWidth * 0.23))));
  fileManager.style.setProperty('--file-sidebar-width', width + 'px');
  updateAttribute(treeResizer, 'aria-valuenow', width);
  updateAttribute(treeResizer, 'aria-valuemin', limits.min);
  updateAttribute(treeResizer, 'aria-valuemax', limits.max);
  if (persist) {
    preferredTreeWidth = width;
    try { localStorage.setItem('cyan-panel.tree-width', String(width)); } catch (_) { /* storage is optional */ }
  }
}
treeResizer.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault(); treeResizer.focus(); treeResizer.setPointerCapture(ev.pointerId);
  const start = ev.clientX; const width = $('#file-sidebar').getBoundingClientRect().width;
  document.body.classList.add('resizing-tree');
  const move = (event) => setTreeWidth(width + event.clientX - start);
  const end = () => {
    document.body.classList.remove('resizing-tree');
    treeResizer.removeEventListener('pointermove', move);
    setTreeWidth($('#file-sidebar').getBoundingClientRect().width, true);
  };
  treeResizer.addEventListener('pointermove', move);
  treeResizer.addEventListener('lostpointercapture', end, {once:true});
});
treeResizer.addEventListener('keydown', (ev) => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(ev.key)) return;
  ev.preventDefault(); const limits = treeWidthLimits(); const current = Number(treeResizer.getAttribute('aria-valuenow'));
  const value = ev.key === 'Home' ? limits.min : ev.key === 'End' ? limits.max : current + (ev.key === 'ArrowRight' ? 16 : -16);
  setTreeWidth(value, true);
});
treeResizer.addEventListener('dblclick', () => {
  preferredTreeWidth = null;
  try { localStorage.removeItem('cyan-panel.tree-width'); } catch (_) { /* storage is optional */ }
  setTreeWidth(null);
});
treeDrawerButton.addEventListener('click', () => {
  treeDialog.showModal(); treeDrawerButton.setAttribute('aria-expanded','true');
});
$('#btn-tree-close').addEventListener('click', () => treeDialog.close());
treeDialog.addEventListener('click', (ev) => { if (ev.target === treeDialog) treeDialog.close(); });
treeDialog.addEventListener('close', () => {
  treeDrawerButton.setAttribute('aria-expanded','false');
  if (treeDrawerButton.offsetParent) treeDrawerButton.focus();
});
function adaptFileLayout() {
  if (!fileManager.clientWidth) return;
  // Base this on the space available for content, including a larger root font.
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const compact = fileManager.clientWidth < Math.max(960,rem * 60);
  fileManager.classList.toggle('tree-compact',compact);
  if (compact && fileSidebar.parentElement !== treeDialog) treeDialog.appendChild(fileSidebar);
  if (!compact && fileSidebar.parentElement !== fileManager) {
    if (treeDialog.open) treeDialog.close();
    fileManager.insertBefore(fileSidebar,treeResizer);
  }
  if (!compact && !document.body.classList.contains('resizing-tree')) setTreeWidth(preferredTreeWidth);
}
new ResizeObserver(adaptFileLayout).observe(fileManager);
window.addEventListener('resize',adaptFileLayout);
function joinPath(dir, name) { return name.startsWith('/') ? name : (dir.endsWith('/') ? dir : dir + '/') + name; }
function fileKind(it) {
  if (it.type === 'link') return ['link', 'link', isFolder(it) ? '链接文件夹' : '符号链接'];
  if (it.type === 'dir') return ['folder', 'folder', '文件夹'];
  const ext = it.name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','svg','webp','gif','ico','avif'].includes(ext)) return ['image','image',ext.toUpperCase() + ' 图像'];
  if (['zip','gz','tar','xz','bz2','7z','rar','tgz'].includes(ext)) return ['archive','archive','压缩归档'];
  if (['py','js','ts','json','yaml','yml','sh','conf','css','html','toml','xml','service','ini','md','txt','log','env'].includes(ext) || it.name.startsWith('.env')) return ['code','code',ext.toUpperCase() + ' 文本'];
  return ['file','file',it.name.includes('.') ? ext.toUpperCase() + ' 文件' : '文件'];
}
async function loadFiles(path, options = {}) {
  saveRouteView();
  const request = ++filesState.request;
  filesState.loading = true;
  setMsg('#files-err', '');
  closeFileMenu();
  $('#file-drop-zone').setAttribute('aria-busy', 'true');
  if (!filesState.path) updateText($('#files-count'), '正在读取文件…');
  // Only show activity if a request is slow; never fade or clear existing content.
  const busy = setTimeout(() => {
    if (request === filesState.request) $('#btn-files-refresh').classList.add('is-loading');
  }, 180);
  const cached = filesState.listings.get(path);
  let applied = false;
  const show = (data) => { applyFileListing(data,applied ? {navigation:'none'} : options); applied = true; };
  if (cached && Date.now() - cached.at < 15000 && path !== filesState.path) show(cached.data);
  try {
    const data = await api('/api/files/list' + (path ? '?path=' + encodeURIComponent(path) : ''));
    if (request !== filesState.request) return;
    filesState.listings.set(data.path, {data, at:Date.now()});
    show(data);
    loadDirectoryUsage(data.path, request, options.refreshUsage === true);
  } catch (e) {
    if (request === filesState.request && !e.handled) {
      setMsg('#files-err', '无法打开文件夹：' + e.message);
      $('#files-count').textContent = filesState.path ? '保留上次成功读取的文件' : '读取失败，请刷新重试';
      if (!filesState.path) $('#files-table').innerHTML = '<tbody><tr><td class="file-empty">' + icon('folder') + '<strong>无法读取文件夹</strong><p>检查路径或访问权限，然后刷新重试。</p></td></tr></tbody>';
    }
  } finally {
    clearTimeout(busy);
    if (request === filesState.request) {
      filesState.loading = false; navigation.ready = true; saveRouteView(); $('#file-drop-zone').setAttribute('aria-busy', 'false');
      $('#btn-files-refresh').classList.remove('is-loading');
    }
  }
}
async function loadDirectoryUsage(path, request, refresh) {
  const pending = filesState.items.filter(it => it.type === 'dir');
  const fresh = new Set(refresh ? pending.map(it => it.path) : []);
  const current = () => request === filesState.request && filesState.path === path && state.tab === 'files';
  while (pending.length && current()) {
    const batch = pending.slice(0, 48);
    try {
      // Refresh each folder at most once; subsequent polls only read the running job.
      const renew = fresh.has(batch[0].path);
      const selected = batch.filter(it => fresh.has(it.path) === renew);
      const data = await api('/api/files/usage', {method:'POST', body:JSON.stringify({path,names:selected.map(it => it.name),refresh:renew})});
      if (!current()) return;
      const results = new Map((data.items || []).map(it => [it.path,it]));
      for (const it of selected) {
        fresh.delete(it.path);
        const result = results.get(it.path);
        it.usage = result || {status:'unavailable',size:null};
        if (!['pending','calculating'].includes(it.usage.status)) pending.splice(pending.indexOf(it),1);
      }
      renderFiles();
    } catch (e) {
      if (!current() || e.handled) return;
      for (const it of pending) it.usage = {status:'unavailable',size:null};
      renderFiles(); return;
    }
    if (pending.length) await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
function fileSize(it) {
  if (it.type === 'dir') return Number.isFinite(it.usage?.size) ? it.usage.size : -1;
  return isFolder(it) ? -1 : it.size;
}
function fileSizeLabel(it) {
  if (!isFolder(it)) return [fmtBytes(it.size),'文件内容大小'];
  if (it.type === 'link') return ['—','符号链接，不重复统计目标目录'];
  const usage = it.usage;
  const description = '文件夹磁盘占用，包含子目录；不跟随符号链接，不跨文件系统';
  if (Number.isFinite(usage?.size)) return [(usage.status === 'partial' ? '≥ ' : '') + fmtBytes(usage.size),usage.status === 'partial' ? '部分内容无法读取，仅显示已统计的占用' : description];
  if (usage?.status === 'excluded') return ['—','不统计虚拟系统目录'];
  if (usage?.status === 'timeout') return ['统计超时','目录扫描超过时间限制，可刷新后重试'];
  if (usage?.status === 'unavailable') return ['无法统计','目录已变化或无法读取，可刷新后重试'];
  return ['计算中…',description];
}
function applyFileListing(data, options = {}) {
  const changedPath = filesState.path !== data.path;
  if (state.tab !== 'files') return;
  const target = {tab:'files',path:data.path};
  if (options.navigation !== 'none' && navigation.entry?.path !== data.path) pushRoute(target);
  else replaceEntry({...navigation.entry,...target});
  filesState.path = data.path; filesState.root = data.root || '/';
  filesState.items = data.items || []; filesState.parent = data.parent;
  state.filesPath = data.path;
  if (changedPath) filesState.query = '';
  if (options.restore) {
    filesState.query = options.restore.query || '';
    filesState.sort = options.restore.sort || 'name';
    filesState.hidden = options.restore.hidden !== false;
  }
  $('#files-search').value = filesState.query; $('#files-sort').value = filesState.sort;
  $('#btn-files-hidden').setAttribute('aria-pressed',String(filesState.hidden));
  $('#btn-files-hidden').setAttribute('aria-label',filesState.hidden ? '隐藏以点开头的文件' : '显示以点开头的文件');
  filesState.tree.set(data.path, filesState.items);
  updateText($('#files-disk'), data.disk ? `磁盘可用 ${fmtBytes(data.disk.free)} / ${fmtBytes(data.disk.total)}` : '');
  $('#btn-files-up').disabled = !data.parent;
  rememberNavigation();
  $('#files-address').value = data.path;
  if (changedPath) renderBreadcrumbs();
  renderShortcuts(); renderFiles();
  if (treeDialog.open) treeDialog.close();
  if (changedPath) $('#file-drop-zone').scrollTop = 0;

  let ancestor = data.parent;
  filesState.expanded.add(filesState.root);
  while (ancestor && withinRoot(ancestor, filesState.root)) {
    filesState.expanded.add(ancestor);
    if (ancestor === filesState.root) break;
    ancestor = ancestor.slice(0, ancestor.lastIndexOf('/')) || '/';
  }
  renderTree();
  if (options.restore) {
    $('#file-drop-zone').scrollTo(options.restore.left || 0,options.restore.top || 0);
    $('#file-tree').scrollTo(options.restore.treeLeft || 0,options.restore.treeTop || 0);
    window.scrollTo(0,options.restore.pageY || 0);
  }
  for (const path of filesState.expanded) {
    if (data.path === path || data.path.startsWith(path === '/' ? '/' : path + '/')) ensureTree(path);
  }
}
function renderBreadcrumbs() {
  const root = filesState.root;
  const suffix = filesState.path.slice(root === '/' ? 1 : root.length).split('/').filter(Boolean);
  let current = root;
  const crumbs = [{name: root === '/' ? '根目录' : baseName(root), path: root}];
  for (const name of suffix) { current = joinPath(current, name); crumbs.push({name, path:current}); }
  $('#files-path').innerHTML = crumbs.map((c, i) => `<span class="breadcrumb">${i ? icon('chevron') : ''}<button data-path="${esc(c.path)}" ${i === crumbs.length - 1 ? 'aria-current="location"' : ''} title="${esc(c.path)}">${i ? '' : icon('server')}${esc(c.name)}</button></span>`).join('');
  $('#files-path').scrollLeft = $('#files-path').scrollWidth;
}
function renderShortcuts() {
  const root = filesState.root;
  const items = [[root, '根目录', 'server'], ['/opt','应用目录','folder'], ['/etc','系统配置','code'], ['/var/log','系统日志','file']]
    .filter(([path], i, all) => withinRoot(path, root) && all.findIndex((a) => a[0] === path) === i);
  const parent = $('#file-shortcuts');
  const buttons = items.map(([path,name,glyph]) => {
    let button = Array.from(parent.children).find((el) => el.dataset.path === path);
    if (!button) {
      button = document.createElement('button'); button.dataset.path = path; button.title = path;
      button.innerHTML = icon(glyph) + esc(name);
    }
    updateAttribute(button, 'class', 'file-shortcut' + (filesState.path === path ? ' active' : ''));
    return button;
  });
  reconcileChildren(parent, buttons);
}
function ensureTree(path, force = false) {
  if (filesState.treeRequests.has(path)) return filesState.treeRequests.get(path);
  if (!force && filesState.tree.has(path)) return Promise.resolve();
  filesState.treeErrors.delete(path);
  const request = (async () => {
    try {
      const data = await api('/api/files/list?path=' + encodeURIComponent(path));
      filesState.tree.set(path, data.items || []);
    } catch (e) {
      if (!e.handled) filesState.treeErrors.set(path, e.message);
    } finally {
      filesState.treeRequests.delete(path); renderTree();
    }
  })();
  filesState.treeRequests.set(path, request); renderTree();
  return request;
}
function renderTree() {
  function branch(path, name, depth) {
    let node = filesState.treeNodes.get(path);
    if (!node) {
      node = document.createElement('div'); node.className = 'tree-node'; node.dataset.nodePath = path;
      node.innerHTML = `<div class="tree-row"><button class="tree-toggle">${icon('chevron')}</button><button class="tree-open">${icon('folder')}<span></span></button></div><div class="tree-children"></div><div class="tree-note" role="status" hidden></div>`;
      node.row = node.children[0]; node.group = node.children[1]; node.note = node.children[2];
      node.toggle = node.row.children[0]; node.open = node.row.children[1];
      node.toggle.dataset.expand = path; node.open.dataset.path = path; node.open.title = path;
      node.row.style.paddingLeft = depth * 14 + 'px';
      node.note.style.paddingLeft = depth * 14 + 26 + 'px';
      filesState.treeNodes.set(path, node);
    }
    const open = filesState.expanded.has(path);
    const children = filesState.tree.get(path);
    updateAttribute(node.row, 'class', 'tree-row' + (path === filesState.path ? ' active' : ''));
    updateAttribute(node.toggle, 'aria-expanded', open);
    updateAttribute(node.toggle, 'aria-label', (open ? '收起 ' : '展开 ') + name);
    updateText(node.open.querySelector('span'), name);
    if (path === filesState.path) updateAttribute(node.open, 'aria-current', 'location');
    else if (node.open.hasAttribute('aria-current')) node.open.removeAttribute('aria-current');
    node.group.hidden = !open;
    if (open && children) {
      const dirs = children.filter((it) => isFolder(it) && (filesState.hidden || !it.name.startsWith('.')));
      reconcileChildren(node.group, dirs.map((it) => branch(it.path, it.name, depth + 1)));
    }
    const error = filesState.treeErrors.get(path);
    const note = error ? '读取失败，点击箭头重试' : filesState.treeRequests.has(path) && !children ? '读取中…' : '';
    node.note.hidden = !open || !note;
    updateText(node.note, note); node.note.title = error || '';
    return node;
  }
  reconcileChildren($('#file-tree'), [branch(filesState.root, filesState.root === '/' ? '/' : baseName(filesState.root), 0)]);
}
function renderFiles() {
  const query = filesState.query.toLocaleLowerCase();
  const items = filesState.items.filter((it) => (filesState.hidden || !it.name.startsWith('.')) && it.name.toLocaleLowerCase().includes(query));
  items.sort((a,b) => {
    if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
    if (filesState.sort === 'modified' && a.mtime !== b.mtime) return b.mtime - a.mtime;
    if (filesState.sort === 'size' && fileSize(a) !== fileSize(b)) return fileSize(b) - fileSize(a);
    return a.name.localeCompare(b.name, 'zh-CN', {numeric:true});
  });
  const table = $('#files-table');
  if (!table.tHead) table.innerHTML = '<thead><tr><th>文件名称</th><th class="num">大小</th><th>修改时间</th><th>权限 / 所有者</th><th class="num">操作</th></tr></thead><tbody></tbody>';
  const nodes = items.map((it) => {
    const {usage, ...metadata} = it;
    const signature = JSON.stringify(metadata);
    let row = filesState.rows.get(it.path);
    if (!row) { row = document.createElement('tr'); row.dataset.path = it.path; filesState.rows.set(it.path,row); }
    if (row.signature !== signature) {
      const [glyph,style,label] = fileKind(it);
      // Type is available to assistive technology; filenames have no redundant subtitles.
      row.innerHTML = `<td class="file-cell"><button class="file-open" data-act="open" title="${esc(it.name)}${it.target ? ' → ' + esc(it.target) : ''}" aria-label="${esc(label + ' ' + it.name)}"><span class="file-kind-icon ${style}">${icon(glyph)}</span><span class="file-name">${esc(it.name)}</span></button></td>
        <td class="num muted file-size"></td><td class="muted">${fmtTime(it.mtime)}</td><td class="file-permissions" title="${esc(it.mode_str || it.mode)}">${esc(it.mode)}<br>${esc(it.owner)}:${esc(it.group)}</td>
        <td><div class="file-actions">${!isFolder(it) && (it.type === 'file' || it.target_type === 'file') ? `<button class="icon-button" data-act="edit" aria-label="编辑 ${esc(it.name)}" title="编辑">${icon('edit')}</button><a class="icon-button" href="/api/files/download?path=${encodeURIComponent(it.path)}" aria-label="下载 ${esc(it.name)}" title="下载">${icon('download')}</a>` : ''}<button class="icon-button" data-act="more" aria-label="${esc(it.name)} 的更多操作" aria-haspopup="menu" title="更多操作">${icon('more')}</button></div></td>`;
      row.signature = signature;
    }
    const [sizeText,sizeTitle] = fileSizeLabel(it);
    updateText(row.querySelector('.file-size'),sizeText);
    updateAttribute(row.querySelector('.file-size'),'title',sizeTitle);
    return row;
  });
  if (!nodes.length) {
    const key = query ? 'search' : 'empty';
    if (!table.emptyRow || table.emptyRow.dataset.kind !== key) {
      table.emptyRow = document.createElement('tr'); table.emptyRow.dataset.kind = key;
      table.emptyRow.innerHTML = `<td colspan="5" class="file-empty">${icon(query ? 'search' : 'folder')}<strong>${query ? '没有匹配的文件' : '这个文件夹是空的'}</strong><p>${query ? '试试其他关键词，或清空搜索。' : '上传文件，或新建一个文件夹开始整理。'}</p></td>`;
    }
    nodes.push(table.emptyRow);
  }
  const focused = table.contains(document.activeElement) ? document.activeElement : null;
  reconcileChildren(table.tBodies[0], nodes);
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({preventScroll:true});
  const dirs = items.filter(isFolder).length;
  $('#files-count').textContent = `${dirs} 个文件夹，${items.length - dirs} 个文件${query || !filesState.hidden ? ` · 共 ${filesState.items.length} 项` : ''}`;
}
$('#files-path').addEventListener('click', (ev) => { const b = ev.target.closest('[data-path]'); if (b) loadFiles(b.dataset.path); });
$('#file-shortcuts').addEventListener('click', (ev) => { const b = ev.target.closest('[data-path]'); if (b) loadFiles(b.dataset.path); });
$('#file-tree').addEventListener('click', (ev) => {
  const toggle = ev.target.closest('[data-expand]');
  if (toggle) {
    const path = toggle.dataset.expand;
    if (filesState.expanded.has(path)) filesState.expanded.delete(path);
    else { filesState.expanded.add(path); ensureTree(path, filesState.treeErrors.has(path)); }
    renderTree(); return;
  }
  const b = ev.target.closest('[data-path]'); if (b) loadFiles(b.dataset.path);
});
$('#btn-tree-refresh').addEventListener('click', async (ev) => {
  const button = ev.currentTarget; button.disabled = true;
  const paths = Array.from(filesState.expanded).filter((path) => !filesState.treeNodes.get(path)?.closest('[hidden]'));
  try { await Promise.all((paths.length ? paths : [filesState.root]).map((path) => ensureTree(path,true))); }
  finally { button.disabled = false; }
});
$('#files-search').addEventListener('input', (ev) => { filesState.query = ev.target.value; closeFileMenu(); renderFiles(); saveRouteView(); });
$('#files-sort').addEventListener('change', (ev) => { filesState.sort = ev.target.value; closeFileMenu(); renderFiles(); saveRouteView(); });
$('#btn-files-hidden').addEventListener('click', (ev) => {
  filesState.hidden = !filesState.hidden;
  const button = ev.currentTarget;
  button.setAttribute('aria-pressed', String(filesState.hidden));
  button.setAttribute('aria-label', filesState.hidden ? '隐藏以点开头的文件' : '显示以点开头的文件');
  renderFiles(); renderTree(); saveRouteView();
});
$('#btn-files-back').addEventListener('click', () => { saveRouteView(); history.back(); });
$('#btn-files-forward').addEventListener('click', () => { saveRouteView(); history.forward(); });
$('#file-drop-zone').addEventListener('scroll',scheduleRouteView,{passive:true});
$('#file-tree').addEventListener('scroll',scheduleRouteView,{passive:true});
window.addEventListener('keydown',(ev) => {
  if (ev.altKey && ev.key === 'ArrowUp' && state.tab === 'files' && !document.querySelector('dialog[open]') && !ev.target.closest('input,textarea,[contenteditable=true]')) {
    ev.preventDefault(); if (filesState.parent) loadFiles(filesState.parent);
  }
});
$('#btn-files-up').addEventListener('click', () => { if (filesState.parent) loadFiles(filesState.parent); });
$('#btn-files-refresh').addEventListener('click', () => { filesState.listings.delete(filesState.path); loadFiles(filesState.path, {refreshUsage:true}); });
$('#btn-files-address').addEventListener('click', () => {
  $('#files-address-form').classList.toggle('hidden');
  $('#files-address').value = filesState.path || filesState.root;
  if (!$('#files-address-form').classList.contains('hidden')) { $('#files-address').focus(); $('#files-address').select(); }
});
$('#btn-address-cancel').addEventListener('click', () => $('#files-address-form').classList.add('hidden'));
$('#files-address-form').addEventListener('submit', (ev) => {
  ev.preventDefault(); const path = $('#files-address').value.trim();
  if (!path) return;
  $('#files-address-form').classList.add('hidden'); loadFiles(path);
});
$('#files-address').addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { $('#files-address-form').classList.add('hidden'); $('#btn-files-address').focus(); } });
function closeFileMenu() {
  if (fileMenu) { fileMenu.remove(); fileMenu = null; }
}
function showFileMenu(item, anchor) {
  closeFileMenu();
  const menu = document.createElement('div');
  menu.className = 'action-menu'; menu.setAttribute('popover','auto'); menu.setAttribute('role','menu');
  menu.setAttribute('aria-label', item.name + ' 的操作');
  menu.innerHTML = (!isFolder(item) ? '<button role="menuitem" data-act="edit">编辑</button><button role="menuitem" data-act="download">下载</button>' : '') + '<button role="menuitem" data-act="rename">重命名</button><button role="menuitem" data-act="chmod">修改权限</button><button role="menuitem" data-act="copy-path">复制路径</button><button role="menuitem" data-act="delete" class="destructive">删除</button>';
  document.body.appendChild(menu); fileMenu = menu; menu.showPopover();
  menu.dataset.scroll = $('#file-drop-zone').scrollTop;
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed'; menu.style.inset = 'auto';
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(r.bottom + 5, innerHeight - menu.offsetHeight - 80)) + 'px';
  menu.querySelector('button').focus();
  menu.addEventListener('click', async (ev) => {
    const button = ev.target.closest('[data-act]'); if (!button) return;
    closeFileMenu(); anchor.focus();
    if (button.dataset.act === 'copy-path') {
      try { await navigator.clipboard.writeText(item.path); toast('已复制路径'); } catch (e) { toast('复制失败，请通过路径栏选中复制'); }
    } else if (button.dataset.act === 'edit') editFile(item.path);
    else if (button.dataset.act === 'download') location.assign('/api/files/download?path=' + encodeURIComponent(item.path));
    else fileAction(button.dataset.act, item);
  });
  menu.addEventListener('keydown', (ev) => {
    const buttons = Array.from(menu.querySelectorAll('button'));
    if (['ArrowDown','ArrowUp','Home','End'].includes(ev.key)) {
      ev.preventDefault(); const current = buttons.indexOf(document.activeElement);
      const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? buttons.length - 1 : (current + (ev.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
    if (ev.key === 'Escape') { closeFileMenu(); anchor.focus(); }
  });
}
window.addEventListener('resize', closeFileMenu);
$('#file-drop-zone').addEventListener('scroll', () => {
  if (fileMenu && Number(fileMenu.dataset.scroll) !== $('#file-drop-zone').scrollTop) closeFileMenu();
});
$('#files-table').addEventListener('click', (ev) => {
  const control = ev.target.closest('[data-act]'); const row = ev.target.closest('tr[data-path]');
  if (!control || !row || filesState.loading) return;
  const item = filesState.items.find((it) => it.path === row.dataset.path); if (!item) return;
  if (control.dataset.act === 'more') return showFileMenu(item, control);
  if (control.dataset.act === 'open' && isFolder(item)) return loadFiles(item.path);
  editFile(item.path);
});
function fileDialog({title, item, label, value = '', action = '保存', destructive = false, recursive = false}, run) {
  closeFileMenu();
  const box = modal(`<form id="file-action-form"><h3 id="file-dialog-title">${esc(title)}</h3><p class="dialog-path">${esc(item?.path || filesState.path || filesState.root)}</p>${label ? `<label class="form-field" for="file-action-value">${esc(label)}<input id="file-action-value" value="${esc(value)}" required autocomplete="off" spellcheck="false"></label>` : ''}${recursive ? '<label class="form-field"><input id="file-action-recursive" type="checkbox">连同文件夹中的内容一起删除</label>' : ''}${destructive ? '<p class="danger-note">删除后无法通过面板恢复，请确认路径。</p>' : ''}<p class="err" id="file-action-error" role="alert"></p><div class="modal-actions"><button type="button" id="file-action-cancel" class="ghost">取消</button><button type="submit" id="file-action-submit" class="${destructive ? 'danger-button' : 'primary'}">${esc(action)}</button></div></form>`);
  box.wrap.setAttribute('aria-labelledby','file-dialog-title');
  box.q('#file-action-cancel').addEventListener('click', box.close);
  const field = box.q('#file-action-value');
  if (field) { field.focus(); field.select(); } else box.q('#file-action-cancel').focus();
  box.q('#file-action-form').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const submit = box.q('#file-action-submit'); submit.disabled = true;
    box.q('#file-action-error').textContent = '';
    try {
      await run(field ? field.value.trim() : '', !!box.q('#file-action-recursive')?.checked);
      box.close(); filesState.listings.delete(filesState.path); await loadFiles(filesState.path);
    } catch (e) { if (!e.handled) box.q('#file-action-error').textContent = e.message; }
    finally { submit.disabled = false; }
  });
}
function fileAction(action, item) {
  if (action === 'rename') fileDialog({title:'重命名',item,label:'新名称或绝对路径',value:item.name}, async (name) => {
    if (!name) throw new Error('请输入新名称');
    await api('/api/files/rename', {method:'POST',body:JSON.stringify({src:item.path,dst:joinPath(filesState.path,name)})});
    toast('已重命名');
  });
  if (action === 'chmod') fileDialog({title:'修改权限',item,label:'八进制权限，例如 644 或 755',value:item.mode}, async (mode) => {
    if (!/^[0-7]{3,4}$/.test(mode)) throw new Error('请输入 3 或 4 位八进制权限');
    await api('/api/files/chmod', {method:'POST',body:JSON.stringify({path:item.path,mode})}); toast('权限已更新');
  });
  if (action === 'delete') fileDialog({title:'删除 ' + item.name,item,action:'确认删除',destructive:true,recursive:item.type === 'dir'}, async (_,recursive) => {
    const result = await api('/api/files/delete', {method:'POST',body:JSON.stringify({paths:[item.path],recursive})});
    if (result.skipped?.length) throw new Error(result.skipped[0].reason);
    toast('已删除 ' + item.name);
  });
}
async function editFile(path) {
  try {
    const data = await api('/api/files/read?path=' + encodeURIComponent(path));
    const box = modal(`<div class="editor"><h3 id="editor-title">编辑 ${esc(baseName(data.path))}</h3><p class="dialog-path">${esc(data.path)}</p><p class="muted">${fmtBytes(data.size)} · UTF-8 · 保存前自动保留 .bak 备份</p><label class="sr-only" for="ed-text">文件内容</label><textarea id="ed-text" spellcheck="false"></textarea><div class="toolbar"><span class="err" id="ed-msg" role="status"></span><span class="spacer"></span><button id="ed-close" class="ghost">关闭</button><button id="ed-save" class="primary">保存更改</button></div></div>`);
    box.wrap.setAttribute('aria-labelledby','editor-title');
    box.q('#ed-text').value = data.content;
    let saved = data.content;
    function closeEditor() {
      if (box.q('#ed-text').value !== saved && !confirm('更改尚未保存，确定放弃更改？')) return;
      box.close();
    }
    box.wrap.addEventListener('cancel', (ev) => { ev.preventDefault(); closeEditor(); });
    box.wrap.addEventListener('click', (ev) => { if (ev.target === box.wrap) ev.stopImmediatePropagation(); }, {capture:true});
    box.q('#ed-close').addEventListener('click', closeEditor);
    box.q('#ed-save').addEventListener('click', async () => {
      const button = box.q('#ed-save'); button.disabled = true;
      try {
        const content = box.q('#ed-text').value;
        await api('/api/files/write', {method:'POST',body:JSON.stringify({path:data.path,content})});
        saved = content; box.q('#ed-msg').textContent = '已保存'; toast('文件已保存'); loadFiles(filesState.path);
      } catch (e) { if (!e.handled) box.q('#ed-msg').textContent = e.message; }
      finally { button.disabled = false; }
    });
    box.q('#ed-text').addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); box.q('#ed-save').click(); }
    });
  } catch (e) { if (!e.handled) setMsg('#files-err', e.message); }
}
function createItem(folder) {
  fileDialog({title:folder ? '新建文件夹' : '新建文件',label:folder ? '文件夹名称' : '文件名称',action:'创建'}, async (name) => {
    if (!name || name === '.' || name === '..' || /[\/\\]/.test(name)) throw new Error('请输入不含斜杠的名称');
    if (filesState.items.some((it) => it.name === name)) throw new Error('同名文件或文件夹已存在');
    const path = joinPath(filesState.path, name);
    await api(folder ? '/api/files/mkdir' : '/api/files/write', {method:'POST',body:JSON.stringify(folder ? {path} : {path,content:'',create_only:true})});
    toast(folder ? '文件夹已创建' : '文件已创建');
  });
}
$('#btn-files-newdir').addEventListener('click', () => createItem(true));
$('#btn-files-newfile').addEventListener('click', () => createItem(false));
$('#btn-files-upload').addEventListener('click', () => { if (!filesState.loading && filesState.path) $('#files-upload-input').click(); });
$('#files-upload-input').addEventListener('change', (ev) => { const files = Array.from(ev.target.files || []); ev.target.value = ''; uploadFiles(files); });
async function uploadFiles(files) {
  if (uploading || filesState.loading || !filesState.path || !files.length) return;
  uploading = true; const destination = filesState.path; const failed = [];
  $('#btn-files-upload').disabled = true;
  try {
    for (const [index,file] of files.entries()) {
      setMsg('#files-err', `上传 ${index + 1}/${files.length}：${file.name} · ${fmtBytes(file.size)}`);
      try {
        const res = await fetch('/api/files/upload?path=' + encodeURIComponent(destination) + '&name=' + encodeURIComponent(file.name), {method:'PUT',body:file});
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) { showLogin(); throw new Error('会话已过期'); }
        if (!res.ok) throw new Error(data.detail || 'HTTP ' + res.status);
      } catch (e) { failed.push(file.name + '：' + e.message); }
    }
    filesState.listings.delete(filesState.path); await loadFiles(filesState.path);
    if (failed.length) setMsg('#files-err', failed.join('；'));
    else toast(`已上传 ${files.length} 个文件至 ${destination}`);
  } finally { uploading = false; $('#btn-files-upload').disabled = false; }
}
let dragDepth = 0;
$('#file-drop-zone').addEventListener('dragenter', (ev) => { ev.preventDefault(); dragDepth++; $('#file-drop-zone').classList.add('drag-over'); });
$('#file-drop-zone').addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
$('#file-drop-zone').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#file-drop-zone').classList.remove('drag-over'); } });
$('#file-drop-zone').addEventListener('drop', (ev) => { ev.preventDefault(); dragDepth = 0; $('#file-drop-zone').classList.remove('drag-over'); uploadFiles(Array.from(ev.dataTransfer.files || [])); });

/* ===================== SSH 远程终端 ===================== */
async function loadSsh() {
  setMsg('#ssh-err', '');
  try {
    const data = await api('/api/ssh/status');
    const svc = data.service || {};
    $('#ssh-summary').textContent =
      `sshd ${svc.active ? '运行中' : '未运行'}｜端口 ${(data.ports || []).join(', ') || '-'}`
      + `｜SSH 登录 ${data.ssh_count || 0} 个`;
    const items = (data.connections || []).filter((c) => c.ssh_session);
    const rows = items.map((c) => `<tr data-tty="${esc(c.tty)}" data-pid="${c.sshd_pid || ''}"
        data-user="${esc(c.user)}" data-from="${esc(c.from)}">
      <td>${esc(c.user)}</td>
      <td class="mono">${esc(c.tty)}</td>
      <td class="mono small">${esc(c.from)}</td>
      <td class="muted">${esc(c.since)}</td>
      <td class="num">${fmtDuration(c.idle_seconds)}</td>
      <td class="muted small">sshd ${c.sshd_pid || '-'}</td>
      <td><div class="row-actions"><button data-act="disconnect">断开</button></div></td>
    </tr>`).join('');
    $('#ssh-conn-table').innerHTML = `<thead><tr><th>用户</th><th>终端</th><th>来源 IP</th>
        <th>登录时间</th><th class="num">空闲</th><th>进程</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td class="muted">当前没有 SSH 登录会话</td><td colspan="6"></td></tr>'}</tbody>`;
  } catch (e) {
    if (!e.handled) setMsg('#ssh-err', e.message);
  }
}

$('#btn-ssh-refresh').addEventListener('click', loadSsh);
$('#ssh-conn-table').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || btn.dataset.act !== 'disconnect') return;
  const row = btn.closest('tr');
  const tty = row.dataset.tty, from = row.dataset.from, who = row.dataset.user;
  if (!confirm(`断开这条 SSH 登录？\n\n用户 ${who} · 终端 ${tty} · 来源 ${from}\n\n如果是你正在用的这条，点确定后立刻掉线。`)) return;
  try {
    await api('/api/ssh/disconnect', {
      method: 'POST',
      body: JSON.stringify({ tty, sshd_pid: row.dataset.pid ? Number(row.dataset.pid) : null }),
    });
    loadSsh();
  } catch (e) {
    if (!e.handled) setMsg('#ssh-err', e.message);
  }
});

/* ===================== 终端会话管理 ===================== */
async function loadTermSessions() {
  try {
    const data = await api('/api/terminal/sessions');
    $('#term-max').textContent = data.max;
    const rows = (data.items || []).map((s) => `<tr>
      <td class="mono small">${esc(s.id)}</td>
      <td>${esc(s.user)}</td>
      <td>${esc(s.ip)}</td>
      <td class="num">${s.pid || '-'}</td>
      <td class="num">${s.cols}×${s.rows}</td>
      <td class="muted">${fmtTime(s.created)}</td>
      <td class="num">${fmtDuration(s.idle_seconds)}</td>
      <td class="num">${fmtBytes((s.bytes_out || 0) + (s.bytes_in || 0))}</td>
      <td><div class="row-actions"><button data-id="${esc(s.id)}" data-act="kill">断开</button></div></td>
    </tr>`).join('');
    $('#term-sessions-table').innerHTML = `<thead><tr><th>会话</th><th>用户</th><th>来源</th><th class="num">PID</th>
        <th class="num">尺寸</th><th>建立时间</th><th class="num">空闲</th><th class="num">流量</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td class="muted">当前没有终端会话</td><td colspan="8"></td></tr>'}</tbody>`;
  } catch (e) { if (!e.handled) setMsg('#term-err', e.message); }
}
$('#btn-term-refresh').addEventListener('click', loadTermSessions);
$('#term-sessions-table').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || btn.dataset.act !== 'kill') return;
  if (!confirm('断开这个终端会话？会话里的进程会收到 SIGHUP。')) return;
  try {
    await api('/api/terminal/kill', { method: 'POST', body: JSON.stringify({ id: btn.dataset.id }) });
    loadTermSessions();
  } catch (e) { if (!e.handled) setMsg('#term-err', e.message); }
});

document.addEventListener('cyan-theme:change', () => {
  renderCharts(state.lastPoints);
  if (state.xterm) state.xterm.options.theme = {background:themeColor('--ct-input'),foreground:themeColor('--ct-fg'),cursor:themeColor('--ct-accent'),selectionBackground:themeColor('--ct-accent-soft')};
});

/* ===================== 启动 / 定时器 ===================== */
function startTimers() {
  stopTimers();
  state.timer = setInterval(() => {
    if (document.hidden) return;
    if (state.tab === 'dash') refresh(true);
    else if (state.tab === 'terminal') loadTermSessions();
  }, 3000);
}
function stopTimers() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.me = me.user;
    $('#whoami').textContent = me.user;
    $('#whoami').title = `${me.user} · 会话有效期 ${me.session_ttl_hours} 小时`;
    // Resolve the URL before enabling navigation; slow metrics must never restore an old route.
    initNavigation();
    showApp();
    if (state.tab !== 'dash') refresh(true, true);
    startTimers();
  } catch (e) {
    if (!e.handled) console.error(e);
  }
}

(async function start() {
  try { await boot(); } catch (e) { showLogin(); }
})();
