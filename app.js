'use strict';
(() => {
/* ================= helpers ================= */
const M = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const peso = (n, d = 0) => (n < 0 ? '−' : '') + '₱' + Math.abs(n).toLocaleString('en-PH', {minimumFractionDigits: d, maximumFractionDigits: d});
const pesoS = n => { const a = Math.abs(n); return (n < 0 ? '−' : '') + '₱' + (a >= 1e6 ? (a/1e6).toFixed(2) + 'M' : a >= 1e3 ? (a/1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k' : a.toFixed(0)); };
const sum = a => a.reduce((s, x) => s + (+x.a || 0), 0);
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtDate = (d, o) => new Date(d + (String(d).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-PH', o || {month: 'short', day: 'numeric', year: 'numeric'});
// accepts "1,200", "₱500", "1.84+329", "=100-25"
const parseAmt = s => {
  s = String(s).replace(/[₱,\s=]/g, '').replace(/(\d*\.?\d+)k/gi, (_, n) => String(parseFloat(n) * 1000));
  if (!/^[-+]?\d*\.?\d+([-+]\d*\.?\d+)*$/.test(s)) return NaN;
  return Math.round((s.match(/[-+]?\d*\.?\d+/g) || []).reduce((t, x) => t + parseFloat(x), 0) * 100) / 100;
};
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) {
    const txt = JSON.stringify(v);
    for (let tries = 0; tries < 8; tries++) {
      try { localStorage.setItem(k, txt); return true; }
      catch (e) {   // storage full: drop the oldest safety copy and try again
        const sk = Object.keys(localStorage).find(x => x.startsWith('pera:snaps:') && x !== k); if (!sk) return false;
        try { const l = JSON.parse(localStorage.getItem(sk)) || []; if (l.length > 1) localStorage.setItem(sk, JSON.stringify(l.slice(0, l.length - 1))); else localStorage.removeItem(sk); } catch { localStorage.removeItem(sk); }
      }
    }
    return false;
  },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const today = () => new Date();
// a bill is repaid from the month BEFORE its due date (due Jan 5, 2027 → December 2026)
// which month pays a bill: paid every 15th & 30th → due on the 15th or later comes out of that month's pay,
// due before the 15th comes out of the previous month's (S.meta.payCut, 0 = always the month before)
const ord = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
const payCut = () => { const c = S && S.meta && S.meta.payCut; return c == null ? 15 : +c; };
const billMonth = due => { const d = new Date(due + 'T00:00:00'), cut = payCut(), same = cut > 0 && d.getDate() >= cut; d.setDate(1); if (!same) d.setMonth(d.getMonth() - 1); return {y: String(d.getFullYear()), i: d.getMonth()}; };
const billsIn = (y, i) => (S.meta.bills || []).map((b, j) => ({...b, j})).filter(b => b.count !== false && !b.paid && b.due && (m => m.y === y && m.i === i)(billMonth(b.due)));

/* ================= state ================= */
const cfg = window.PERA_CONFIG || {};
const sb = (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase)
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {auth: {persistSession: true, autoRefreshToken: true, lock: async (_name, _wait, fn) => await fn()}})
  : null;

let user = null;          // supabase user
let S = blank();          // {meta, years}
let dirty = new Set();    // doc keys waiting to upload
let syncState = 'idle';   // idle | saving | offline | error
let pushing = false;
let selYear = String(today().getFullYear());
let hideTotal = store.get('pera:hideTotal') === true;   // remembered on this device
let detail = null;        // {y,i} month shown in the desktop side panel
const desk = matchMedia('(min-width:900px)');

function blank() { return {meta: {years: [], bills: [], accounts: [], maya: null, phone: null, trash: []}, years: {}}; }
const TRASH_DAYS = 30;
const kData = () => 'pera:data:' + user.id;
const kDirty = () => 'pera:dirty:' + user.id;
const kBase = () => 'pera:base:' + user.id;      // last copy agreed with the server, per doc
const kSnaps = () => 'pera:snaps:' + user.id;    // safety copies kept on this device
let base = {};
let dataVer = 0;
function saveLocal() { dataVer++; store.set(kData(), S); store.set(kDirty(), [...dirty]); store.set(kBase(), base); }
function loadLocal() {
  const d = store.get(kData()); S = d && d.meta ? d : blank();
  dirty = new Set(store.get(kDirty()) || []);
  base = store.get(kBase()) || {};
}
/* ---- three-way merge: keep what this device changed, take everything else from the server ---- */
// stable JSON (keys sorted) so the same data always compares equal, whatever order its fields were written in
const J = x => JSON.stringify(x === undefined ? null : x, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, key) => (o[key] = v[key], o), {}) : v);
function pick(b, l, r, hasBase) {
  // changed here since the last sync → ours; otherwise the server's (fall back to ours if the server has nothing)
  if (hasBase && J(l) !== J(b)) return l;
  return r !== undefined ? r : l;
}
function mergeById(b, l, r, hasBase) {           // arrays of objects with ids (savings accounts)
  if (!Array.isArray(l) || !Array.isArray(r)) return pick(b, l, r, hasBase);
  const bm = new Map((b || []).map(x => [x.id, x])), lm = new Map(l.map(x => [x.id, x])), rm = new Map(r.map(x => [x.id, x])), out = [];
  const ids = [...new Set([...r.map(x => x.id), ...l.map(x => x.id)])];
  for (const id of ids) {
    const bx = bm.get(id), lx = lm.get(id), rx = rm.get(id);
    if (lx && rx) out.push(hasBase && J(lx) !== J(bx) ? lx : rx);
    else if (lx && !rx) { if (!hasBase || !bx || J(lx) !== J(bx)) out.push(lx); }      // new here, or server deleted something we didn't touch
    else if (rx && !lx) { if (!hasBase || !bx || J(rx) !== J(bx)) out.push(rx); }      // new on server, or we deleted it
  }
  return out;
}
function merge3(key, b, l, r) {
  const hasBase = b !== undefined && b !== null;
  if (r === undefined || r === null) return l;
  if (key === 'meta') {
    const out = {};
    for (const f of new Set([...Object.keys(l || {}), ...Object.keys(r || {})])) {
      out[f] = f === 'savings' ? mergeById(hasBase ? b[f] : undefined, l[f], r[f], hasBase && b[f] !== undefined) : pick(hasBase ? b[f] : undefined, l[f], r[f], hasBase);
      if (out[f] === undefined) delete out[f];
    }
    return out;
  }
  const lm = (l && l.months) || [], rm = (r && r.months) || [], bm = hasBase ? (b.months || []) : [];
  return {months: M.map((_, i) => pick(bm[i], lm[i], rm[i], hasBase) || {inc: [], exp: [], sav: 0})};
}
function snapshot(reason) {
  const list = store.get(kSnaps()) || [], last = list[0];
  if (last && Date.now() - last.at < 3 * 3600e3 && reason !== 'force') return;   // at most one every 3 hours
  list.unshift({at: Date.now(), reason, data: JSON.parse(JSON.stringify(S))});
  store.set(kSnaps(), list.slice(0, 6));
}
function docOf(key) { return key === 'meta' ? S.meta : {months: S.years[key.slice(1)]}; }
// Put a synced copy into place, keeping every object that didn't change.
// Undo buttons hold on to those objects, so swapping them out would break Undo.
function patchInto(cur, next) {
  if (J(cur) === J(next)) return cur;
  if (Array.isArray(cur) && Array.isArray(next)) {
    const byId = new Map(cur.filter(x => x && x.id != null).map(x => [x.id, x]));
    const out = next.map((x, k) => { const old = x && x.id != null ? byId.get(x.id) : cur[k]; return old !== undefined && old !== null && typeof old === 'object' && typeof x === 'object' ? patchInto(old, x) : x; });
    cur.length = 0; cur.push(...out); return cur;
  }
  if (cur && next && typeof cur === 'object' && typeof next === 'object' && !Array.isArray(cur) && !Array.isArray(next)) {
    for (const k of Object.keys(cur)) if (!(k in next)) delete cur[k];
    for (const k of Object.keys(next)) cur[k] = cur[k] !== null && typeof cur[k] === 'object' && next[k] !== null && typeof next[k] === 'object' ? patchInto(cur[k], next[k]) : next[k];
    return cur;
  }
  return next;
}
function applyDoc(key, data) {
  if (!data) return;
  data = JSON.parse(JSON.stringify(data));
  if (key === 'meta') { const full = Object.assign(blank().meta, data); S.meta = S.meta ? patchInto(S.meta, full) : full; }
  else if (/^y\d{4}$/.test(key) && Array.isArray(data.months)) { const y = key.slice(1); S.years[y] = S.years[y] ? patchInto(S.years[y], data.months) : data.months; }
}
function ensureYear(y) {
  y = String(y);
  if (!S.years[y]) {
    S.years[y] = M.map(() => ({inc: [], exp: [], sav: 0}));
    S.meta.years = [...new Set([...(S.meta.years || []), y])].sort();
    dirty.add('meta'); dirty.add('y' + y);
  }
  return S.years[y];
}
/* every change goes through here: save on the phone first, then upload */
function commit(...keys) { keys.forEach(k => dirty.add(k)); saveLocal(); render(); push(); }

/* ================= sync ================= */
async function pull() {
  if (!sb || !user) return false;
  let data, error;
  try { ({data, error} = await within(sb.from('pera_docs').select('key,data'), 'downloading')); } catch (e) { error = e; }
  if (error) { await syncFailed(error); return false; }
  const remote = new Map(data.map(r => [r.key, r.data]));
  // keep a safety copy before the server's version replaces anything on this device
  const changes = [...remote].some(([k, v]) => !dirty.has(k) && J(v) !== J(k === 'meta' ? S.meta : (S.years[k.slice(1)] ? {months: S.years[k.slice(1)]} : null)));
  if (changes && (Object.keys(S.years).length || (S.meta.savings || []).length)) snapshot('before sync');
  for (const [k, v] of remote) {
    if (dirty.has(k)) continue;                     // our edits get merged on the next upload
    applyDoc(k, JSON.parse(J(v))); base[k] = JSON.parse(J(v));   // separate copies: edits must never touch the base
  }
  if (data.length) {   // a year deleted on another device
    for (const y of Object.keys(S.years)) if (!remote.has('y' + y) && !dirty.has('y' + y) && base['y' + y] !== undefined) { delete S.years[y]; delete base['y' + y]; }
  }
  S.meta.years = Object.keys(S.years).sort();
  saveLocal(); render();
  return true;
}
// every server call gets a time limit, so a stuck request is reported and retried instead of hanging forever
const SYNC_MS = 20000;
const within = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({message: `The server didn’t answer in ${SYNC_MS / 1000} seconds (${what}). Will retry.`, timeout: true}), SYNC_MS))]);
let pushStart = 0, lastSynced = store.get('pera:lastSynced') || 0;
async function push() {
  if (pushing && Date.now() - pushStart > SYNC_MS * 3) pushing = false;   // watchdog
  if (!sb || !user || pushing) return;
  if (!dirty.size) { setSync('idle'); return; }
  pushing = true; pushStart = Date.now(); setSync('saving');
  try {
    for (let round = 0; dirty.size && round < 5; round++) {
      const keys = [...dirty];
      // 1. read what the server has now
      const {data, error} = await within(sb.from('pera_docs').select('key,data').in('key', keys), 'reading');
      if (error) throw error;
      const remote = new Map(data.map(r => [r.key, r.data]));
      // 2. merge with this device's changes (no awaits here, so nothing can change in between)
      const gone = [], rows = [], sent = {};
      for (const k of keys) {
        const local = k === 'meta' ? S.meta : (S.years[k.slice(1)] ? {months: S.years[k.slice(1)]} : null);
        if (local === null) { gone.push(k); continue; }
        const merged = merge3(k, base[k], JSON.parse(JSON.stringify(local)), remote.get(k));
        applyDoc(k, JSON.parse(J(merged)));
        rows.push({user_id: user.id, key: k, data: merged, updated_at: new Date().toISOString()});
        sent[k] = J(merged);
      }
      if (rows.length) S.meta.years = Object.keys(S.years).sort();
      saveLocal(); render();
      // 3. upload the merged result
      if (gone.length) { const {error: e2} = await within(sb.from('pera_docs').delete().eq('user_id', user.id).in('key', gone), 'deleting'); if (e2) throw e2; }
      if (rows.length) { const {error: e3} = await within(sb.from('pera_docs').upsert(rows, {onConflict: 'user_id,key'}), 'uploading'); if (e3) throw e3; }
      // 4. done for keys that didn't change again while uploading
      for (const k of keys) {
        if (gone.includes(k)) { if (!S.years[k.slice(1)]) { dirty.delete(k); delete base[k]; } continue; }
        const now = J(k === 'meta' ? S.meta : {months: S.years[k.slice(1)]});
        base[k] = JSON.parse(sent[k]);
        if (now === sent[k]) dirty.delete(k);
      }
      saveLocal();
    }
    if (dirty.size) throw {message: `Uploaded, but ${[...dirty].join(', ')} kept changing. Will retry.`};
    setSync('idle');
  } catch (e) {
    pushing = false; await syncFailed(e);
  } finally { pushing = false; }
}
let syncErr = null;   // last real error from the server, shown in Settings
const isAuthErr = e => e && (e.status === 401 || e.code === 'PGRST301' || e.code === 'PGRST303' || /jwt|token|not authenticated|refresh/i.test(e.message || ''));
async function syncFailed(e) {
  console.warn('sync failed', e);
  if (!navigator.onLine) { syncErr = null; setSync('offline'); return; }
  syncErr = {msg: (e && (e.message || e.error_description || e.code)) || (e && JSON.stringify(e)) || String(e), at: Date.now(), auth: isAuthErr(e)};
  if (syncErr.auth && sb) {   // the sign-in expired: try to renew it once
    const {error} = await sb.auth.refreshSession().catch(x => ({error: x}));
    if (!error) { syncErr = null; setSync('saving'); setTimeout(() => push(), 300); return; }
  }
  setSync(syncErr.auth ? 'auth' : 'error');
}
function setSync(s) {
  syncState = s;
  const el = $('sync'), n = dirty.size;
  el.className = 'sync ' + (s === 'idle' ? 'ok' : 'wait');
  $('syncTxt').textContent = s === 'idle' ? 'Synced' : s === 'saving' ? 'Saving…'
    : s === 'offline' ? `Offline · ${n} change${n === 1 ? '' : 's'} waiting` : s === 'auth' ? 'Sign in again to sync' : 'Not synced · tap for details';
  if (s === 'idle') { syncErr = null; lastSynced = Date.now(); store.set('pera:lastSynced', lastSynced); }
}
addEventListener('online', () => push());
document.addEventListener('visibilitychange', () => { if (!document.hidden && user) { pull().then(() => push()); } });
setInterval(() => { if (dirty.size && navigator.onLine) push(); }, 30000);

/* ================= maths ================= */
// money that went into savings left as a transfer: count it as saved, not spent
// (₱29k transferred, ₱10k of it deposited to savings → ₱19k spent, ₱10k saved)
function savedOut(y, i) {
  const m = S.years[y] && S.years[y][i]; if (!m) return 0;
  const linked = potDepositsIn(y, i).reduce((t, x) => t + x.d.a, 0); if (!linked) return 0;
  const tr = m.exp.reduce((t, x) => t + ((x.c && CAT_NAMES.includes(x.c) ? x.c : catOf(x.n || '')) === 'Transfers' && +x.a > 0 ? +x.a : 0), 0);
  return Math.min(linked, tr);
}
function series() {
  const out = [], now = today(), CY = now.getFullYear(), CM = now.getMonth();
  let run = 0;
  for (const y of Object.keys(S.years).sort()) S.years[y].forEach((m, i) => {
    const inc = sum(m.inc), exp = sum(m.exp) + sum(billsIn(y, i)), manual = +m.sav || 0;
    const linked = potDepositsIn(y, i).reduce((t, x) => t + x.d.a, 0);
    run = run + inc - manual - exp;          // savings deposits are shown, never subtracted
    const carved = savedOut(y, i);
    out.push({y, i, inc, exp, spent: Math.max(0, exp - carved), carved, sav: linked || manual, linked, manual, total: run, past: +y < CY || (+y === CY && i <= CM), now: +y === CY && i === CM});
  });
  return out;
}

/* ================= render ================= */
/* ---- motion: screens slide in, numbers count, lines draw (off when the phone asks for less motion) ---- */
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const shown = new Map();   // last value each counter showed
let entering = true;       // first paint counts up too
const counting = new Map();   // key → running count, so a redraw mid-count carries on instead of jumping
function animateCounts() {
  document.querySelectorAll('[data-count]').forEach(el => {
    const key = el.dataset.count, to = +el.dataset.n, dec = +el.dataset.d || 0, prev = shown.get(key), run = counting.get(key);
    shown.set(key, to);
    if (calm.matches || !isFinite(to) || el.offsetParent === null) return;
    if (run && run.to === to && !entering) { run.el = el; el.textContent = run.now; return; }   // same count, new element
    const from = entering ? 0 : run ? run.cur : prev; if (from == null || Math.abs(from - to) < 0.005) return;
    const a = {to, from, cur: from, now: peso(from, dec), el, t0: performance.now(), dur: entering ? 750 : 450};
    counting.set(key, a);
    const step = t => {
      if (counting.get(key) !== a) return;
      const k = Math.min(1, (t - a.t0) / a.dur), e = 1 - Math.pow(1 - k, 3);
      a.cur = a.from + (a.to - a.from) * e; a.now = peso(a.cur, dec);
      if (a.el.dataset.count === key) a.el.textContent = a.now;
      if (k < 1) requestAnimationFrame(step); else counting.delete(key);
    };
    requestAnimationFrame(step);
  });
}
function enterView(v) {
  if (calm.matches) return;
  const el = document.getElementById('v-' + v); if (!el) return;
  el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
  clearTimeout(el._enter); el._enter = setTimeout(() => el.classList.remove('enter'), 900);
  entering = true; requestAnimationFrame(() => { animateCounts(); entering = false; });
  const c = $('chart'); if (v === 'home' && c) { c.classList.remove('drawn'); void c.getBoundingClientRect(); c.classList.add('drawn'); clearTimeout(c._d); c._d = setTimeout(() => c.classList.remove('drawn'), 1300); }
}
function render() {
  const ser = series();
  renderHome(ser); renderInsights(ser); renderMonths(ser); renderSavings(); renderBills();
  if (desk.matches) renderDetail(ser);
  else if (sheetOpen && sheetMonth && S.years[sheetMonth.y]) $('sheetBody').innerHTML = monthHTML(sheetMonth.y, sheetMonth.i, ser);
  if (sheetOpen && sheetPot) potSheet(sheetPot.id, sheetPot.k);
  if (sheetOpen && sheetBill) $('sheetBody').innerHTML = billGroupHTML(sheetBill);
  if (!entering) animateCounts();
}
function renderHome(ser) {
  const cur = ser.find(p => p.now) || ser.filter(p => p.past).pop() || ser[0];
  if (!cur) {
    $('homeLbl').textContent = 'Total money';
    $('homeTotal').textContent = '₱0';
    $('homeChg').textContent = '';
    ['hMonth', 'hBills', 'hNotes'].forEach(id => { $(id).hidden = true; });
    $('homeMonthLink').hidden = true;
    $('homeList').innerHTML = `<li><button class="rowbtn" data-act="settings"><span class="dot s">⇪</span><span class="t">Import your backup<small>Load pera-backup.json from Settings</small></span></button></li>
      <li><button class="rowbtn" data-act="statement"><span class="dot s">⇩</span><span class="t">Import a bank statement<small>Excel, PDF or CSV</small></span></button></li>
      <li><button class="rowbtn" data-act="fab"><span class="dot i">+</span><span class="t">Or start fresh<small>Add your first income or expense</small></span></button></li>`;
    drawChart(); return;
  }
  $('homeLbl').textContent = `Total money · end of ${M[cur.i]} ${cur.y}`;
  $('homeTotal').textContent = hideTotal ? '₱ ••••••' : peso(cur.total, 2);
  if (hideTotal) delete $('homeTotal').dataset.count; else Object.assign($('homeTotal').dataset, {count: 'total', n: cur.total, d: 2});
  $('homeTotal').classList.toggle('masked', hideTotal);
  setEye();
  const prev = ser[ser.indexOf(cur) - 1];
  if (prev) { const d = cur.total - prev.total; $('homeChg').innerHTML = `<span class="${d >= 0 ? 'up' : 'dn'}">${d >= 0 ? '▲' : '▼'} ${esc(peso(Math.abs(d)))}</span> vs ${esc(M[prev.i])}`; }
  else $('homeChg').textContent = '';
  homeMonth(cur, prev); homeFlow(); homeBills(); homeNotes(cur, ser); homeSummary();
  $('homeList').innerHTML = '';
  const ml = $('homeMonthLink'); ml.hidden = false; ml.dataset.y = cur.y; ml.dataset.i = cur.i;
  ml.textContent = `See all of ${M[cur.i]}’s entries →`;
  drawChart();
}
/* ---- Home cards: the few numbers people check every day ---- */
const dayOf = (x, y, i) => { if (!x.d) return 1; const dt = new Date(dnum(x.d)); return dt.getFullYear() === +y && dt.getMonth() === i ? dt.getDate() : 1; };
function spentByDay(y, i, day) {   // spending in a month up to a day of that month (undated entries and bills count from day 1)
  const m = S.years[y] && S.years[y][i]; if (!m) return 0;
  return m.exp.filter(x => dayOf(x, y, i) <= day).reduce((s, x) => s + +x.a, 0) + sum(billsIn(y, i)) + (+m.sav || 0);
}
function homeMonth(cur, prev) {
  const box = $('hMonth'), t = today(), isNow = cur.now;
  const days = new Date(+cur.y, cur.i + 1, 0).getDate(), day = isNow ? t.getDate() : days;
  const out = cur.exp + cur.manual, left = cur.inc - out, over = left < 0, savedPart = cur.carved + cur.manual;
  const pct = cur.inc > 0 ? Math.min(100, out / cur.inc * 100) : (out > 0 ? 100 : 0), sPct = cur.inc > 0 ? Math.min(pct, savedPart / cur.inc * 100) : 0;
  let pace = '';
  if (prev && isNow && S.years[prev.y]) {
    const lastBy = spentByDay(prev.y, prev.i, day), nowBy = spentByDay(cur.y, cur.i, day), diff = nowBy - lastBy;
    if (lastBy > 0 || nowBy > 0) pace = Math.abs(diff) < 1 ? `Spending the same as ${M[prev.i]} by this day`
      : `<span class="${diff > 0 ? 'dn' : 'up'}">${diff > 0 ? '▲' : '▼'} ${esc(pesoS(Math.abs(diff)))} ${diff > 0 ? 'more' : 'less'}</span> than ${M[prev.i]} by day ${day}`;
  }
  const tick = isNow && cur.inc > 0 ? Math.min(100, day / days * 100) : null;
  box.hidden = false;
  box.innerHTML = `<div class="hhead"><h3>${isNow ? 'This month' : M[cur.i] + ' ' + cur.y}</h3>${isNow ? `<span class="muted">Day ${day} of ${days}</span>` : ''}</div>
    <div class="leftnum"><b class="${over ? 'dn' : ''}" data-count="left" data-n="${Math.abs(left)}" data-d="0">${esc(peso(Math.abs(left)))}</b><span>${over ? 'more went out than came in' : cur.inc ? 'left after spending and saving' : 'no income added yet'}</span></div>
    <div class="pbar${over ? ' over' : ''}" role="img" aria-label="${Math.round(pct)}% of income used"><b style="width:${pct.toFixed(1)}%"></b>${sPct > 0 && !over ? `<b class="savpart" style="left:${(pct - sPct).toFixed(1)}%;width:${sPct.toFixed(1)}%"></b>` : ''}${tick != null ? `<i style="left:${tick.toFixed(1)}%" title="Even pace for day ${day}"></i>` : ''}</div>
    <div class="pmeta"><span>${cur.inc ? (savedPart > 0 && !over ? `${Math.round(cur.spent / cur.inc * 100)}% spent · <span class="savtxt">${Math.round(savedPart / cur.inc * 100)}% saved</span>` : Math.round(out / cur.inc * 100) + '% of income used') : ''}</span>${tick != null ? '<span class="muted">┆ even pace</span>' : ''}</div>
    ${pace ? `<p class="pace">${pace}</p>` : ''}
    <div class="mini"><button data-act="goto-month" data-y="${esc(cur.y)}" data-i="${cur.i}"><span>In</span><b class="up">${esc(pesoS(cur.inc))}</b></button><button data-act="goto-month" data-y="${esc(cur.y)}" data-i="${cur.i}"><span>Spent</span><b class="dn">${esc(pesoS(cur.spent))}</b></button><button data-act="go-view" data-v="savings"><span>Saved</span><b>${esc(pesoS(cur.sav))}</b></button></div>`;
}
function homeBills() {
  const box = $('hBills'), t0 = todayIso(), from = iso(new Date(today().getFullYear(), today().getMonth(), today().getDate() - 30)), lim = iso(new Date(today().getFullYear(), today().getMonth(), today().getDate() + 35));
  const list = (S.meta.bills || []).map((b, j) => ({...b, j})).filter(b => !b.paid && b.due && b.due >= from && b.due <= lim).sort((a, b) => a.due < b.due ? -1 : 1);
  const late = list.filter(b => b.due < t0), soon = list.filter(b => b.due >= t0), show = [...late, ...soon].slice(0, 5);
  if (!list.length) { box.hidden = !(S.meta.bills || []).length; box.innerHTML = `<div class="hhead"><h3>Coming up</h3><button class="plain" data-act="go-view" data-v="bills">Bills →</button></div><p class="muted">No unpaid bills in the next 5 weeks.</p>`; return; }
  const total = list.reduce((s, b) => s + +b.a, 0), dd = d => { const n = Math.round((new Date(dnum(d)) - new Date(dnum(t0))) / 864e5); return n < 0 ? `<span class="dn">${-n} day${n === -1 ? '' : 's'} late</span>` : n === 0 ? '<span class="dn">due today</span>' : n === 1 ? 'tomorrow' : `in ${n} days`; };
  box.hidden = false;
  box.innerHTML = `<div class="hhead"><h3>Coming up</h3><button class="plain" data-act="go-view" data-v="bills">All bills →</button></div>
    <p class="muted">${esc(peso(total))} due in the next 5 weeks${late.length ? ` · ${late.length} past due` : ''}</p>
    <ul class="blist">${show.map(b => `<li><span class="bd"><b>${esc(fmtDate(b.due, {day: 'numeric'}))}</b><small>${esc(fmtDate(b.due, {month: 'short'}))}</small></span><span class="bn">${esc(b.name)}<small>${dd(b.due)}</small></span><span class="ba">${esc(peso(+b.a, 2))}</span><button class="paybtn" data-act="bill-pay" data-j="${b.j}" aria-label="Mark ${esc(b.name)} due ${esc(fmtDate(b.due))} as paid">Paid</button></li>`).join('')}</ul>
    ${list.length > show.length ? `<p class="muted">+ ${list.length - show.length} more</p>` : ''}`;
}
function homeNotes(cur, ser) {
  const box = $('hNotes'), notes = [], t = today();
  // 1. a category running well above its usual level
  const prevM = []; for (let k = 1; k <= 3; k++) { const d = new Date(+cur.y, cur.i - k, 1); if (S.years[d.getFullYear()]) prevM.push({y: String(d.getFullYear()), i: d.getMonth()}); }
  if (prevM.length) {
    const byNow = {}, byPrev = {};
    spendingIn([{y: cur.y, i: cur.i}]).forEach(r => { if (r.cat !== 'Transfers' && r.cat !== 'No description') byNow[r.cat] = (byNow[r.cat] || 0) + r.a; });
    spendingIn(prevM).forEach(r => { if (r.cat !== 'Transfers' && r.cat !== 'No description') byPrev[r.cat] = (byPrev[r.cat] || 0) + r.a / prevM.length; });
    const up = Object.entries(byNow).map(([c, v]) => ({c, v, avg: byPrev[c] || 0, d: v - (byPrev[c] || 0)})).filter(x => x.d > 1000 && x.v > x.avg * 1.3).sort((a, b) => b.d - a.d)[0];
    if (up) notes.push({ic: '▲', cls: 'dn', act: `data-act="nudge-cat" data-c="${esc(up.c)}"`, h: `<b>${esc(up.c)}</b> is ${esc(pesoS(up.d))} above your usual`, s: `${esc(peso(up.v))} this month vs ${esc(peso(up.avg))} a month on average`});
    const down = Object.entries(byPrev).map(([c, avg]) => ({c, avg, v: byNow[c] || 0, d: avg - (byNow[c] || 0)})).filter(x => cur.now && t.getDate() >= 20 && x.d > 1500 && x.v < x.avg * 0.6).sort((a, b) => b.d - a.d)[0];
    if (down) notes.push({ic: '▼', cls: 'up', act: `data-act="nudge-cat" data-c="${esc(down.c)}"`, h: `Less on <b>${esc(down.c)}</b> than usual`, s: `${esc(peso(down.v))} so far vs ${esc(peso(down.avg))} a month on average`});
  }
  // 2. bills already sitting in next month
  const nd = new Date(+cur.y, cur.i + 1, 1), ny = String(nd.getFullYear()), ni = nd.getMonth();
  const nb = S.years[ny] ? billsIn(ny, ni) : [], nbt = nb.reduce((s, b) => s + +b.a, 0);
  if (nbt > 0) notes.push({ic: '↓', cls: '', act: `data-act="goto-month" data-y="${ny}" data-i="${ni}"`, h: `${esc(peso(nbt))} of bills already counted for ${M[ni]}`, s: `${nb.length} payment${nb.length === 1 ? '' : 's'} · plan next month’s spending around it`});
  // 3. spending without a note can't be sorted
  const rows = spendingIn([{y: cur.y, i: cur.i}]), nod = rows.filter(r => r.cat === 'No description').reduce((s, r) => s + r.a, 0), all = rows.reduce((s, r) => s + r.a, 0);
  if (all > 0 && nod / all > 0.25) notes.push({ic: '✎', cls: '', act: `data-act="goto-month" data-y="${esc(cur.y)}" data-i="${cur.i}"`, h: `${Math.round(nod / all * 100)}% of this month’s spending has no note`, s: 'Add a short note so Insights can sort it'});
  box.hidden = !notes.length;
  box.innerHTML = `<div class="hhead"><h3>Worth a look</h3></div><ul class="nlist">${notes.slice(0, 3).map(n => `<li><button ${n.act}><span class="ni ${n.cls}">${n.ic}</span><span class="nt">${n.h}<small>${n.s}</small></span><span class="chev">›</span></button></li>`).join('')}</ul>`;
}
function setEye() {
  const b = $('eyeBtn'); b.setAttribute('aria-pressed', hideTotal); b.setAttribute('aria-label', hideTotal ? 'Show total money' : 'Hide total money');
  $('eyeIc').setAttribute('d', hideTotal
    ? 'M3 3l18 18 M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1 M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2'
    : 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z');
}
function entryRows(y, i) {
  const m = S.years[y][i];
  const rows = [...m.inc.map(x => ['inc', x]), ...m.exp.map(x => ['exp', x])]
    .sort((a, b) => (b[1].d || '').localeCompare(a[1].d || '') || (a[0] === 'inc' ? -1 : 1));
  let lastKey = null;
  const dayHead = key => {
    const list = rows.filter(([, x]) => (x.d || '') === key), out = list.filter(([t]) => t === 'exp').reduce((s, [, x]) => s + +x.a, 0), inn = list.filter(([t]) => t === 'inc').reduce((s, [, x]) => s + +x.a, 0);
    return `<li class="dayh"><span>${key ? esc(new Date(dnum(key)).toLocaleDateString('en-PH', {weekday: 'short', month: 'short', day: 'numeric'})) : 'No exact day'}</span><span>${inn ? `<b class="up">+${esc(pesoS(inn))}</b> ` : ''}${out ? `−${esc(pesoS(out))}` : ''}</span></li>`;
  };
  let h = rows.map(([t, x]) => {
    const key = x.d || ''; const head = key !== lastKey ? dayHead(key) : ''; lastKey = key;
    return head + entryRow(t, x, y, i);
  }).join('');
  const billRows = billsIn(y, i), depRows = potDepositsIn(y, i);
  if (billRows.length || depRows.length || +m.sav) h += `<li class="dayh"><span>Bills & savings this month</span><span></span></li>`;
  return h + billsAndSav(y, i, m);
}
function entryRow(t, x, y, i) {
  {
    const inc = t === 'inc';
    return `<li><button class="rowbtn" data-act="edit-entry" data-t="${t}" data-y="${esc(y)}" data-i="${i}" data-id="${esc(x.id)}">
      <span class="dot ${inc ? 'i' : 'e'}">${inc ? '↓' : '↑'}</span>
      <span class="t">${esc(showName(x.n) || (inc ? 'Income' : 'Expense'))}<small>${inc ? 'Received' : x.a < 0 ? 'Refund / adjustment' : (() => { const c = x.c || catOf(x.n || ''); return `<b class="catdot2" style="background:${catCol(c)}"></b>${esc(c)}`; })()}</small></span>
      <span class="amt ${inc ? 'up' : ''}">${inc ? '+' : x.a < 0 ? '+' : '−'}${esc(peso(Math.abs(x.a), 2))}</span></button>
      <button class="x" data-act="entry-del" data-t="${t}" data-y="${esc(y)}" data-i="${i}" data-id="${esc(x.id)}" aria-label="Delete ${esc(x.n || (inc ? 'income' : 'expense'))}">×</button></li>`;
  }
}
function billsAndSav(y, i, m) {
  let h = '';
  h += billsIn(y, i).map(b => `<li><button class="rowbtn" data-act="bill-edit" data-j="${b.j}"><span class="dot e">↑</span><span class="t">${esc(b.name)}<small>Bill due ${esc(fmtDate(b.due))}</small></span><span class="amt">−${esc(peso(+b.a, 2))}</span></button><span class="x" aria-hidden="true"></span></li>`).join('');
  h += potDepositsIn(y, i).map(({pot, d}) => `<li><button class="rowbtn" data-act="pot-open" data-p="${esc(pot.id)}"><span class="dot s">₱</span><span class="t">${esc(pot.name)}<small>Saved · ${esc(fmtDate(d.date, {month: 'short', day: 'numeric'}))}${d.date > todayIso() ? ' · planned' : ''} · not subtracted</small></span><span class="amt">${esc(peso(d.a, 2))}</span></button><span class="x" aria-hidden="true"></span></li>`).join('');
  if (+m.sav) h += `<li><button class="rowbtn" data-act="edit-sav" data-y="${esc(y)}" data-i="${i}"><span class="dot s">₱</span><span class="t">To savings${potDepositsIn(y, i).length ? ' (old entry)' : ''}<small>Subtracted from total</small></span><span class="amt">${esc(peso(+m.sav, 2))}</span></button>
      <button class="x" data-act="sav-del" data-y="${esc(y)}" data-i="${i}" aria-label="Remove savings for ${M[i]}">×</button></li>`;
  return h;
}
function drawChart() {
  const s = $('chart'), W = s.clientWidth, H = s.clientHeight;
  if (!W) return;
  const all = series(), first = all.findIndex(p => p.inc || p.exp);
  const ser = first < 0 ? [] : all.slice(first);
  if (ser.length < 2) { s.innerHTML = ''; return; }
  const vals = ser.map(p => p.total), lo = Math.min(0, ...vals), hi = Math.max(1, ...vals) * 1.08, pl = 6, pr = 6, pt = 22, pb = 22;
  const X = i => pl + i * (W - pl - pr) / (ser.length - 1), Y = v => pt + (hi - v) * (H - pt - pb) / ((hi - lo) || 1);
  const k = Math.max(0, ser.map(p => p.past).lastIndexOf(true));
  const path = (a, b) => ser.slice(a, b + 1).map((p, j) => (j ? 'L' : 'M') + X(a + j).toFixed(1) + ' ' + Y(p.total).toFixed(1)).join('');
  const area = path(0, k) + `L${X(k)} ${H - pb}L${X(0)} ${H - pb}Z`;
  const yrs = [...new Set(ser.map(p => p.y))].map(y => { const j = ser.findIndex(p => p.y === y); return `<line x1="${X(j)}" x2="${X(j)}" y1="${pt}" y2="${H - pb}" stroke="var(--line)"/><text x="${X(j) + 3}" y="${H - 6}" font-size="11" fill="var(--mute)">${esc(y)}</text>`; }).join('');
  const last = ser[ser.length - 1], kx = X(k), anchor = kx > W * 0.7 ? 'end' : kx < W * 0.3 ? 'start' : 'middle';
  s.innerHTML = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--blue)" stop-opacity=".22"/><stop offset="1" stop-color="var(--blue)" stop-opacity="0"/></linearGradient></defs>${yrs}
  <path d="${area}" fill="url(#g)"/><path class="cline" pathLength="1" d="${path(0, k)}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round"/>
  ${k < ser.length - 1 ? `<path d="${path(k, ser.length - 1)}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="4 5" opacity=".65"/>` : ''}
  <circle cx="${kx}" cy="${Y(ser[k].total)}" r="5" fill="var(--bg)" stroke="var(--blue)" stroke-width="2.5"/>
  <text x="${kx}" y="${Math.max(13, Y(ser[k].total) - 10)}" text-anchor="${anchor}" font-size="12" font-weight="600" fill="var(--ink)">Now</text>
  ${k < ser.length - 1 && W > 340 ? `<text x="${W - pr}" y="${Math.max(13, Y(last.total) - 9)}" text-anchor="end" font-size="11" fill="var(--mute)">${esc(M[last.i].slice(0, 3) + ' ' + last.y)} · ${esc(pesoS(last.total))}</text>` : ''}`;
}
const chartRO = new ResizeObserver(drawChart); chartRO.observe($('chart'));

function renderMonths(ser) {
  const ys = Object.keys(S.years).sort();
  if (!ys.includes(selYear) && ys.length) selYear = ys.includes(String(today().getFullYear())) ? String(today().getFullYear()) : ys[ys.length - 1];
  const lo = ys.length ? +ys[0] - 1 : today().getFullYear() - 1, hi = ys.length ? +ys[ys.length - 1] + 1 : today().getFullYear();
  $('yearSeg').innerHTML = `<button class="yadd" data-act="year" data-y="-" aria-label="Add ${lo}" title="Add ${lo}">＋</button>`
    + ys.map(y => `<button data-act="year" data-y="${esc(y)}" aria-pressed="${y === selYear}">${esc(y)}</button>`).join('')
    + `<button class="yadd" data-act="year" data-y="+" aria-label="Add ${hi}" title="Add ${hi}">＋</button>`;
  { const seg = $('yearSeg'), on = seg.querySelector('[aria-pressed=true]');   // keep the chosen year in view when the row scrolls
    if (on && seg.scrollWidth > seg.clientWidth) seg.scrollLeft = on.offsetLeft - seg.clientWidth / 2 + on.offsetWidth / 2; }
  const rows = ser.filter(p => p.y === selYear);
  const sel = desk.matches && detail && detail.y === selYear ? detail.i : -1;
  $('monthList').innerHTML = rows.map(p => `<li class="${p.i === sel ? 'sel' : p.now ? 'now' : ''}"><button class="rowbtn" data-act="month" data-i="${p.i}">
    <span class="t"><b>${M[p.i]}</b><small><span class="up">+${esc(pesoS(p.inc))}</span> · <span class="dn">−${esc(pesoS(p.exp))}</span> · saved ${esc(pesoS(p.sav))}</small></span>
    <span class="mr">${p.past ? 'Total' : 'Planned'}<b>${esc(peso(p.total))}</b></span></button></li>`).join('')
    || '<li class="empty">No months yet. Tap ＋ Year.</li>';
  const binN = (S.meta.trash || []).length + (S.meta.savings || []).reduce((t, p) => t + (p.trash || []).length, 0);
  $('yearActions').innerHTML = (rows.length ? `<button class="danger" data-act="year-del" data-y="${esc(selYear)}">Delete ${esc(selYear)}</button>` : '')
    + `<button class="plain" data-act="statement">Import a bank statement</button>`
    + (binN ? `<button class="plain" data-act="settings">Recycle bin (${binN})</button>` : '');
  $('yearFoot').textContent = rows.length ? `${selYear}: income ${peso(rows.reduce((a, p) => a + p.inc, 0))}, spent ${peso(rows.reduce((a, p) => a + p.exp, 0))}, saved ${peso(rows.reduce((a, p) => a + p.sav, 0))}.` : '';
}

function billTotals(now) {
  const box = $('billSum'), un = (S.meta.bills || []).filter(x => !x.paid && x.due);
  if (!un.length) { box.hidden = true; return; }
  const t = iso(now), sum = l => l.reduce((s, x) => s + +x.a, 0);
  const late = un.filter(x => x.due < t), cm = {y: String(now.getFullYear()), i: now.getMonth()}, nd = new Date(now.getFullYear(), now.getMonth() + 1, 1), nm = {y: String(nd.getFullYear()), i: nd.getMonth()};
  const inM = m => un.filter(x => x.count !== false && (b => b.y === m.y && b.i === m.i)(billMonth(x.due)));
  const thisM = inM(cm), nextM = inM(nm), later = un.filter(x => !thisM.includes(x) && !nextM.includes(x) && x.due >= t);
  const by = {}; un.forEach(x => { const k = x.name.toLowerCase(), e = by[k] = by[k] || {name: x.name, a: 0, n: 0, last: x.due, next: null}; e.a += +x.a; e.n++; if (x.due > e.last) e.last = x.due; if (x.due >= t && (!e.next || x.due < e.next.due)) e.next = x; });
  const per = Object.values(by).sort((p, q) => q.a - p.a);
  box.hidden = false;
  box.innerHTML = `<div class="muted">Unpaid bills</div><div class="big billbig" data-count="bills" data-n="${sum(un)}" data-d="2">${esc(peso(sum(un), 2))}</div>
    <div class="muted">${un.length} payment${un.length === 1 ? '' : 's'}${late.length ? ` · <span class="dn">${esc(peso(sum(late), 2))} past due</span> <button class="plain inl" data-act="bills-late-paid">Mark all paid</button>` : ''}</div>
    <div class="trio billtrio"><div class="tile"><span>This month</span><b class="dn">${esc(pesoS(sum(thisM)))}</b><small>${M[cm.i].slice(0, 3)} · ${thisM.length} bill${thisM.length === 1 ? '' : 's'}</small></div><div class="tile"><span>Next month</span><b>${esc(pesoS(sum(nextM)))}</b><small>${M[nm.i].slice(0, 3)} · ${nextM.length} bill${nextM.length === 1 ? '' : 's'}</small></div><div class="tile"><span>Later</span><b>${esc(pesoS(sum(later)))}</b><small>${later.length} bill${later.length === 1 ? '' : 's'}</small></div></div>
    <details class="perbill"${per.length <= 4 ? ' open' : ''}><summary>By bill</summary><ul>${per.map(e => `<li><button class="pbrow" data-act="bill-group" data-n="${esc(e.name)}"><span>${esc(e.name)}<small>${e.n} left${e.next ? ` · next ${esc(fmtDate(e.next.due, {month: 'short', day: 'numeric'}))} ${esc(peso(+e.next.a, 2))}` : ''}${e.n > 1 ? ` · until ${esc(fmtDate(e.last, {month: 'short', year: 'numeric'}))}` : ''}</small></span><b>${esc(peso(e.a, 2))}</b><span class="chev">›</span></button></li>`).join('')}</ul></details>`;
}
function renderBills() {
  const now = today(); now.setHours(0, 0, 0, 0);
  const b = (S.meta.bills || []).map((x, j) => ({...x, j})).sort((p, q) => (p.paid - q.paid) || p.due.localeCompare(q.due));
  $('billList').innerHTML = b.map(x => billRow(x, now)).join('') || '<li class="empty">No bills yet. Type one above.</li>';
  billTotals(now);
  const ba = $('billAI'); if (ba) ba.innerHTML = (S.meta.bills || []).some(b => !b.paid) ? aiCardHTML('bills', 'card') : '';
  fillPicker();
  // your own bills first, then the common ones
  const used = uniqNames((S.meta.bills || []).slice().reverse().map(x => x.name));
  const names = [...used, ...PRESETS.filter(p => !used.some(u => sameName(u, p)))];
  $('qbChips').innerHTML = names.map(n => `<button type="button" class="chip" data-act="qb-name" data-n="${esc(n)}" aria-pressed="false">${esc(n)}</button>`).join('');
  markChip();
}
function billRow(x, now, grouped) {
    const late = !x.paid && Date.parse(x.due + 'T00:00:00') < now.getTime();
    if (grouped) return `<li><button class="chk ${x.paid ? 'on' : ''}" data-act="bill-pay" data-j="${x.j}" aria-label="${x.paid ? 'Mark unpaid' : 'Mark paid'}: due ${esc(fmtDate(x.due))}"><span>${x.paid ? '✓' : ''}</span></button>
      <button class="rowbtn" data-act="bill-edit" data-j="${x.j}"><span class="t">${esc(fmtDate(x.due))}<small class="${late ? 'dn' : ''}">${x.paid ? 'Paid' : late ? 'Past due' : 'Upcoming'}${x.count === false || x.paid ? '' : ` · expense in ${M[billMonth(x.due).i].slice(0, 3)} ${billMonth(x.due).y}`}</small></span>
      <span class="amt" style="${x.paid ? 'opacity:.5;text-decoration:line-through' : ''}">${esc(peso(+x.a, 2))}</span></button>
      <button class="x" data-act="bill-del" data-j="${x.j}" aria-label="Delete payment due ${esc(fmtDate(x.due))}">×</button></li>`;
    return `<li><button class="chk ${x.paid ? 'on' : ''}" data-act="bill-pay" data-j="${x.j}" aria-label="${x.paid ? 'Mark unpaid' : 'Mark paid'}: ${esc(x.name)}"><span>${x.paid ? '✓' : ''}</span></button>
      <button class="rowbtn" data-act="bill-edit" data-j="${x.j}"><span class="t">${esc(x.name)}<small class="${late ? 'dn' : ''}">${x.paid ? 'Paid · ' : late ? 'Past due · ' : 'Due '}${esc(fmtDate(x.due))}${x.count === false ? '' : x.paid ? ' · not counted as expense' : ` · expense in ${M[billMonth(x.due).i].slice(0, 3)} ${billMonth(x.due).y}`}</small></span>
      <span class="amt" style="${x.paid ? 'opacity:.5;text-decoration:line-through' : ''}">${esc(peso(+x.a, 2))}</span></button>
      <button class="x" data-act="bill-del" data-j="${x.j}" aria-label="Delete ${esc(x.name)} due ${esc(fmtDate(x.due))}">×</button></li>`;
}
// all payments of one bill, to check, tick or delete them
let sheetBill = null;
function billGroupHTML(name) {
  const now = today(); now.setHours(0, 0, 0, 0);
  const all = (S.meta.bills || []).map((x, j) => ({...x, j})).filter(x => sameName(x.name, name)).sort((p, q) => p.due.localeCompare(q.due));
  const un = all.filter(x => !x.paid), sum = l => l.reduce((s, x) => s + +x.a, 0);
  return `<div class="sheethead"><h2>${esc(name)}</h2><button type="button" class="ghost" data-act="close">Done</button></div>
    ${all.length ? `<p class="muted">${esc(peso(sum(un), 2))} unpaid · ${un.length} of ${all.length} payment${all.length === 1 ? '' : 's'} left${all.length - un.length ? ` · ${esc(peso(sum(all.filter(x => x.paid)), 2))} paid` : ''}</p>
    <p class="muted">Tap the circle when paid, tap a payment to edit it, or × to delete it.</p>
    <ul class="list">${all.map(x => billRow(x, now, true)).join('')}</ul>
    <button class="danger" data-act="bill-group-del" data-n="${esc(name)}">Delete all ${all.length} ${esc(name)} payment${all.length === 1 ? '' : 's'}</button>` : '<p class="empty">No payments left for this bill.</p>'}`;
}
function billGroupSheet(name) { openSheet(billGroupHTML(name)); sheetBill = name; }


/* ================= quick-add bills: "SPayLater 10,794 Jan 5 x3" ================= */
const MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MRE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mkDate = (y, m, day) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));   // clamps 31 → 28/30
function parseBill(text) {
  let t = ' ' + String(text).replace(/\s+/g, ' ') + ' ';
  const t0 = today(); t0.setHours(0, 0, 0, 0);
  let date = null, day = null, n = 1, m;
  const cut = r => { t = t.slice(0, r.index) + ' ' + t.slice(r.index + r[0].length); };
  const year = y => !y ? null : +y < 100 ? 2000 + +y : +y;
  const future = (mo, d, y) => { if (y) return mkDate(y, mo, d); let x = mkDate(t0.getFullYear(), mo, d); if (x < t0) x = mkDate(t0.getFullYear() + 1, mo, d); return x; };
  // repeats: x3, 3x, for 3 months, 3 installments
  if ((m = /\s(?:x\s?(\d{1,2})|(\d{1,2})\s?x|(?:for\s+)?(\d{1,2})\s*(?:months?|mos?|installments?|payments?))(?=\s)/i.exec(t))) { n = +(m[1] || m[2] || m[3]); cut(m); }
  // dates
  if ((m = /\s(\d{4})-(\d{1,2})-(\d{1,2})(?=\s)/.exec(t))) { date = mkDate(+m[1], +m[2] - 1, +m[3]); cut(m); }
  else if ((m = new RegExp(`\\s(?:due\\s+|on\\s+)?(${MRE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?(?=[\\s,])`, 'i').exec(t))) { date = future(MON.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2], year(m[3])); cut(m); }
  else if ((m = new RegExp(`\\s(?:due\\s+|on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MRE})\\.?(?:,?\\s+(20\\d{2}))?(?=[\\s,])`, 'i').exec(t))) { date = future(MON.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1], year(m[3])); cut(m); }
  else if ((m = /\s(?:due\s+|on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/.exec(t))) { date = future(+m[1] - 1, +m[2], year(m[3])); cut(m); }
  else if ((m = /\s(?:due\s+|on\s+)?(?:every\s+|the\s+)*(\d{1,2})(?:st|nd|rd|th)(?:\s+of\s+the\s+month)?(?=\s)/i.exec(t))) { day = +m[1]; cut(m); }
  else if ((m = /\s(today|tomorrow|next month)(?=\s)/i.exec(t))) { const w = m[1].toLowerCase(); date = new Date(t0); if (w === 'tomorrow') date.setDate(date.getDate() + 1); if (w === 'next month') date = mkDate(t0.getFullYear(), t0.getMonth() + 1, t0.getDate()); cut(m); }
  if (day && day <= 31) { date = mkDate(t0.getFullYear(), t0.getMonth(), day); if (date < t0) date = mkDate(t0.getFullYear(), t0.getMonth() + 1, day); }
  // amount: ₱10,794 · 10794.50 · 2.5k · php 500
  let a = NaN;
  if ((m = /\s(?:₱|php\s?|p(?=\d))?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(k)?(?=[\s,])/i.exec(t))) { a = Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1) * 100) / 100; cut(m); }
  const name = t.replace(/\b(due|on|every|for|each|monthly|bill|pay|php|the|of)\b/gi, ' ').replace(/[,·-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const dates = [];
  if (date) { const d0 = date.getDate(); for (let k = 0; k < Math.min(n, 36); k++) dates.push(iso(mkDate(date.getFullYear(), date.getMonth() + k, day || d0))); }
  // reuse the spelling of a bill you already have ("spaylater" → "SPayLater")
  const known = (S.meta.bills || []).map(x => x.name).find(x => x.toLowerCase() === name.toLowerCase());
  return {name: known || (name ? name[0].toUpperCase() + name.slice(1) : ''), a, dates};
}
// bill names are the same bill whatever the capitals ("SPaylater" = "SPayLater")
const uniqNames = list => { const seen = new Set(); return list.filter(n => { const k = String(n).trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
// one spelling per bill: the common list's spelling if it matches, otherwise the most used one
function unifyBillNames() {
  const bills = S.meta.bills || [], groups = {};
  bills.forEach(b => { const k = b.name.trim().toLowerCase(); (groups[k] = groups[k] || []).push(b); });
  let changed = false;
  for (const g of Object.values(groups)) {
    const preset = PRESETS.find(p => sameName(p, g[0].name));
    const counts = {}; g.forEach(b => { counts[b.name] = (counts[b.name] || 0) + 1; });
    const best = preset || Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    g.forEach(b => { if (b.name !== best) { b.name = best; changed = true; } });
  }
  return changed;
}
const PRESETS = ['SPayLater', 'Maya Black', 'Lazada PayLater', 'GGives', 'Atome', 'Home Credit', 'BillEase', 'Credit card', 'Meralco', 'Internet', 'Rent'];
const NOPTS = [1, 2, 3, 4, 5, 6, 9, 12, 18, 24];
let qbMode = store.get('pera:qbmode') === 'type' ? 'type' : 'pick', pickSig = '';
function setQbMode(m) {
  qbMode = m; store.set('pera:qbmode', m);
  $('qbPick').hidden = m !== 'pick'; $('qbType').hidden = m !== 'type';
  $('qbMode').textContent = m === 'pick' ? 'Type it instead' : 'Pick from lists';
  quickPreview();
}
function fillPicker() {
  const used = uniqNames((S.meta.bills || []).slice().reverse().map(x => x.name));
  const names = [...used, ...PRESETS.filter(p => !used.some(u => sameName(u, p)))];
  const sig = names.join('|');
  if (sig === pickSig) return;
  const keep = $('pkName').value;
  $('pkName').innerHTML = `<option value="">Choose…</option>` +
    (used.length ? `<optgroup label="Your bills">${used.map(n => `<option>${esc(n)}</option>`).join('')}</optgroup>` : '') +
    `<optgroup label="Common">${names.slice(used.length).map(n => `<option>${esc(n)}</option>`).join('')}</optgroup>` +
    `<option value="__other">Other…</option>`;
  if (keep && [...$('pkName').options].some(o => o.value === keep)) $('pkName').value = keep;
  if (!pickSig) {   // first time: months, days, payments
    const t = today();
    $('pkMon').innerHTML = Array.from({length: 13}, (_, k) => { const d = new Date(t.getFullYear(), t.getMonth() + k, 1); return `<option value="${d.getFullYear()}-${d.getMonth()}">${M[d.getMonth()].slice(0, 3)} ${d.getFullYear()}</option>`; }).join('');
    $('pkDay').innerHTML = Array.from({length: 31}, (_, k) => `<option>${k + 1}</option>`).join('');
    $('pkN').innerHTML = NOPTS.map(n => `<option value="${n}">${n === 1 ? 'Once' : n + ' months'}</option>`).join('');
    $('pkMon').selectedIndex = 1; $('pkDay').value = '5';
  }
  pickSig = sig;
}
// choosing a bill you've had before fills its usual amount and day, and the month after its latest due date
function onPickName() {
  const v = $('pkName').value;
  $('pkOther').hidden = v !== '__other';
  if (v === '__other') { $('pkOther').focus(); quickPreview(); return; }
  const past = (S.meta.bills || []).filter(x => sameName(x.name, v)).sort((p, q) => p.due.localeCompare(q.due));
  if (past.length) {
    const last = past[past.length - 1], d = new Date(last.due + 'T00:00:00'), t = today();
    $('pkAmt').value = last.a;
    $('pkDay').value = String(d.getDate());
    let next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const first = new Date(t.getFullYear(), t.getMonth(), 1);
    if (next < first) next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
    const val = `${next.getFullYear()}-${next.getMonth()}`;
    if ([...$('pkMon').options].some(o => o.value === val)) $('pkMon').value = val;
  }
  quickPreview();
  if (!$('pkAmt').value) $('pkAmt').focus();
}
function pickedBill() {
  let nm = $('pkName').value === '__other' ? $('pkOther').value.trim() : $('pkName').value;
  nm = ((S.meta.bills || []).find(x => sameName(x.name, nm)) || {name: nm}).name;
  const [y, m] = $('pkMon').value.split('-').map(Number), day = +$('pkDay').value, n = +$('pkN').value;
  const dates = isNaN(y) ? [] : Array.from({length: n}, (_, k) => iso(mkDate(y, m + k, day)));
  return {name: nm, a: parseAmt($('pkAmt').value || 'x'), dates};
}
function markChip() {
  const typed = $('qb').value.trim().toLowerCase();
  let hit = null;
  $('qbChips').querySelectorAll('.chip').forEach(c => {
    const n = c.dataset.n.toLowerCase(), on = !!typed && (typed === n || typed.startsWith(n + ' ')) && (!hit || n.length > hit.dataset.n.length);
    if (on) { if (hit) hit.setAttribute('aria-pressed', 'false'); hit = c; }
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if (hit && hit.scrollIntoView && !matchMedia('(hover:hover) and (pointer:fine)').matches) hit.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'smooth'});
}
function quickPreview() {
  if (qbMode === 'type') markChip();
  const out = $('qbPrev'), go = $('qbGo');
  if (qbMode === 'type' && !$('qb').value.trim()) { out.innerHTML = '<span class="muted">Try “SPayLater 10,794 Jan 5” or “Lazada 12,252.53 every 16th x3”.</span>'; go.disabled = true; return null; }
  const p = qbMode === 'type' ? parseBill($('qb').value.trim()) : pickedBill(), miss = [];
  if (!p.name) miss.push('a bill'); if (isNaN(p.a)) miss.push('an amount'); if (!p.dates.length) miss.push('a due date');
  if (qbMode === 'pick' && !p.name && isNaN(p.a)) { out.innerHTML = '<span class="muted">Choose a bill and enter the amount.</span>'; go.disabled = true; return null; }
  const bits = [`<b>${esc(p.name || '—')}</b>`, isNaN(p.a) ? '<span class="muted">amount?</span>' : esc(peso(p.a, 2))];
  if (p.dates.length) {
    const first = billMonth(p.dates[0]);
    bits.push(p.dates.length > 1 ? `${p.dates.length} payments, ${esc(fmtDate(p.dates[0], {month: 'short', day: 'numeric'}))} – ${esc(fmtDate(p.dates[p.dates.length - 1]))}` : `due ${esc(fmtDate(p.dates[0]))}`);
    bits.push(`expense in ${M[first.i].slice(0, 3)} ${first.y}${p.dates.length > 1 ? ' onward' : ''}`);
  } else bits.push('<span class="muted">due date?</span>');
  out.innerHTML = bits.join(' · ') + (miss.length ? `<br><span class="muted">Still need ${miss.join(', ')}.</span>` : '');
  go.disabled = !!miss.length;
  go.textContent = p.dates.length > 1 ? `Add ${p.dates.length} payments` : 'Add bill';
  return miss.length ? null : p;
}
/* the same bill already in Pera: same name, due within 10 days (apps move due dates a little) */
function findBill(name, due, taken) {
  const c = (S.meta.bills || []).filter(b => sameName(b.name, name) && b.due && !(taken && taken.has(b)));
  return c.find(b => b.due === due) || c.map(b => ({b, d: Math.abs(dnum(b.due) - dnum(due)) / 864e5})).filter(x => x.d <= 10).sort((p, q) => p.d - q.d).map(x => x.b)[0] || null;
}
// add bills, or update the amount/date of ones you already have; returns a summary and an undo
function putBills(name, items, extra) {
  name = ((S.meta.bills || []).find(b => sameName(b.name, name)) || {name}).name;
  const before = JSON.parse(JSON.stringify(S.meta.bills || [])), taken = new Set(), keys = new Set(['meta']), res = {added: 0, updated: 0, same: 0};
  for (const it of items) {
    const ex = findBill(name, it.due, taken);
    if (ex) { taken.add(ex); if (Math.abs(+ex.a - it.a) < 0.005 && ex.due === it.due) res.same++; else { ex.a = it.a; ex.due = it.due; res.updated++; } }
    else { const b = {name, a: it.a, due: it.due, paid: false, count: true, ...(extra || {})}; S.meta.bills.push(b); taken.add(b); res.added++; }
    const m = billMonth(it.due); if (!S.years[m.y]) { ensureYear(m.y); keys.add('y' + m.y); }
  }
  res.keys = [...keys]; res.name = name;
  res.msg = [res.added && `${res.added} ${name} ${res.added === 1 ? 'bill' : 'payments'} added`, res.updated && `${res.added ? '' : name + ': '}${res.updated} updated with the new amount`, !res.added && !res.updated && `${name} is already in Pera`].filter(Boolean).join(' · ');
  res.undo = () => { S.meta.bills = before; commit('meta'); };
  return res;
}
function quickAdd() {
  const p = quickPreview(); if (!p) return;
  const r = putBills(p.name, p.dates.map(due => ({a: p.a, due})));
  commit(...r.keys);
  if (qbMode === 'type') $('qb').value = '';
  else { $('pkName').value = ''; $('pkAmt').value = ''; $('pkOther').value = ''; $('pkOther').hidden = true; $('pkN').value = '1'; }
  quickPreview();
  toast(r.msg, r.undo);
}
/* ================= savings: time deposits with top-ups, MP2, plain savings accounts ================= */
// meta.savings = [pot]
//   td    {id, name, kind:'td', rate, tax, cycleDays, cycles:[{start, end, rate, carry, deposits:[{id, date, a}]}]}
//   mp2   {id, name, kind:'mp2', rate, rates:{year: rate}, payout:'compound'|'annual', deposits:[{id, date, a}]}
//   basic {id, name, kind:'basic', rate, tax, txns:[{id, date, a}]}   (a < 0 = withdrawal)
// Deposits show up as a month's "Saved" but are never subtracted from total money:
// the transfer itself already appears as money out in the imported statement.
const DAYMS = 864e5;
const dnum = s => Date.parse(s + 'T00:00:00');
const addDays = (s, n) => iso(new Date(dnum(s) + n * DAYMS));
const daysBetween = (a, b) => Math.round((dnum(b) - dnum(a)) / DAYMS);
const todayIso = () => iso(today());
const pots = () => (S.meta.savings = S.meta.savings || []);
const potById = id => pots().find(p => p.id === id);
const KIND = {td: 'Time deposit with top-ups', mp2: 'Pag-IBIG MP2', basic: 'Savings account'};
const pct = r => (Math.round(r * 10000) / 100).toString().replace(/\.0+$/, '') + '%';

function migrateSavings() {
  if (S.meta.savingsMigrated) return false;
  S.meta.savingsMigrated = true;
  // older versions kept simple balances in meta.accounts (e.g. Seabank) — turn them into savings accounts
  S.meta.savings = (S.meta.savings || []).concat((S.meta.accounts || []).filter(a => !(S.meta.savings || []).some(p => p.name === a.name)).map(a => ({id: uid(), name: a.name, kind: 'basic', rate: /seabank/i.test(a.name) ? 0.035 : 0, tax: 0.2,
    txns: [{id: uid(), date: parseDateStr(String(a.asof || '').replace(/\(.*\)/, ''), today().getFullYear()) || todayIso(), a: +a.bal || 0}]})));
  return true;
}

/* ---- time deposit cycles ---- */
function tdCycle(pot, c) {
  const rate = c.rate ?? pot.rate, tax = pot.tax ?? 0.2, end = c.end || addDays(c.start, pot.cycleDays || 181), t = todayIso();
  const net = (a, date) => a * rate * Math.max(0, daysBetween(date, end)) / 365 * (1 - tax);
  const items = [];
  if (+c.carry) items.push({carry: true, date: c.start, a: +c.carry});
  [...(c.deposits || [])].sort((p, q) => p.date.localeCompare(q.date)).forEach(d => items.push({...d}));
  let bal = 0, interest = 0, principal = 0, now = 0;
  items.forEach(it => { it.days = Math.max(0, daysBetween(it.date, end)); it.net = net(it.a, it.date); interest += it.net; principal += it.a; bal += it.a + it.net; it.bal = bal; it.planned = it.date > t; if (!it.planned) now += it.a; });
  return {end, rate, items, closing: principal + interest, principal, interest, now, done: t >= end, prog: Math.min(1, Math.max(0, daysBetween(c.start, t) / Math.max(1, daysBetween(c.start, end))))};
}
const tdCurrent = pot => { const t = todayIso(), cs = pot.cycles || []; let k = cs.length - 1; for (let i = 0; i < cs.length; i++) if (cs[i].start <= t) k = i; return Math.max(0, k); };

/* ---- MP2: dividend = rate × average monthly balance, credited each year end, 5-year term ---- */
function mp2Calc(pot) {
  const deps = [...(pot.deposits || [])].sort((p, q) => p.date.localeCompare(q.date)), t = todayIso();
  if (!deps.length) return {years: [], contrib: 0, divs: 0, now: 0, maturity: null, atMaturity: 0, contribNow: 0};
  const start = deps[0].date, sd = new Date(dnum(start)), maturity = iso(new Date(sd.getFullYear() + 5, sd.getMonth(), sd.getDate()));
  const years = []; let credited = 0, paidOut = 0, divNow = 0;
  for (let y = sd.getFullYear(); y <= +maturity.slice(0, 4); y++) {
    let sumBal = 0, contribY = 0;
    for (let m = 0; m < 12; m++) {
      const me = iso(new Date(y, m + 1, 0)); if (me < start.slice(0, 8) + '01' || me.slice(0, 7) > maturity.slice(0, 7)) continue;
      const c = deps.filter(d => d.date <= me && d.date <= maturity).reduce((s, d) => s + d.a, 0);
      sumBal += c + (pot.payout === 'annual' ? 0 : credited);
    }
    contribY = deps.filter(d => d.date.startsWith(String(y)) && d.date <= maturity).reduce((s, d) => s + d.a, 0);
    const rate = (pot.rates && pot.rates[y] != null) ? pot.rates[y] : pot.rate, div = rate * sumBal / 12;
    const creditDate = String(y) === maturity.slice(0, 4) ? maturity : `${y}-12-31`;
    if (pot.payout === 'annual') paidOut += div; else credited += div;
    if (creditDate <= t) divNow += div;
    years.push({y, contrib: contribY, rate, div, end: deps.filter(d => d.date <= `${y}-12-31` && d.date <= maturity).reduce((s, d) => s + d.a, 0) + (pot.payout === 'annual' ? 0 : credited), est: creditDate > t});
  }
  const contrib = deps.filter(d => d.date <= maturity).reduce((s, d) => s + d.a, 0), contribNow = deps.filter(d => d.date <= t).reduce((s, d) => s + d.a, 0);
  return {years, contrib, contribNow, divs: credited + paidOut, now: contribNow + (pot.payout === 'annual' ? 0 : divNow), maturity, atMaturity: contrib + credited, paidOut, start};
}

/* ---- plain savings account: daily interest on the running balance, after tax ---- */
function basicCalc(pot) {
  const tx = [...(pot.txns || [])].sort((p, q) => p.date.localeCompare(q.date)), t = todayIso(), r = (pot.rate || 0) * (1 - (pot.tax ?? 0.2)) / 365;
  let bal = 0, interest = 0, prev = null;
  for (const x of tx.filter(x => x.date <= t)) { if (prev) { const n = daysBetween(prev, x.date), g = bal * (Math.pow(1 + r, n) - 1); interest += g; bal += g; } bal += x.a; prev = x.date; }
  if (prev) { const n = daysBetween(prev, t), g = bal * (Math.pow(1 + r, n) - 1); interest += g; bal += g; }
  return {now: bal, interest, monthly: bal * (Math.pow(1 + r, 30) - 1), txns: tx};
}
const potNow = p => p.kind === 'td' ? (p.cycles && p.cycles.length ? tdCycle(p, p.cycles[tdCurrent(p)]).now : 0) : p.kind === 'mp2' ? mp2Calc(p).now : basicCalc(p).now;

/* ---- link to months: deposits made in a month = that month's Saved ---- */
function potDepositsIn(y, i) {
  const key = `${y}-${String(i + 1).padStart(2, '0')}`, out = [];
  for (const p of (S.meta.savings || [])) {
    const list = p.kind === 'td' ? (p.cycles || []).flatMap(c => c.deposits || []) : p.kind === 'mp2' ? (p.deposits || []) : (p.txns || []).filter(x => x.a > 0);
    list.filter(d => d.date.startsWith(key)).forEach(d => out.push({pot: p, d}));
  }
  return out.sort((a, b) => a.d.date.localeCompare(b.d.date));
}

/* ---- Savings tab ---- */
function renderSavings() {
  const w = $('savWrap'), ps = pots();
  const total = ps.reduce((s, p) => s + potNow(p), 0);
  const card = p => {
    let sub = '', big = potNow(p), bar = null;
    if (p.kind === 'td') {
      if (!(p.cycles || []).length) sub = 'No cycle yet · tap to start one';
      else { const k = tdCurrent(p), c = tdCycle(p, p.cycles[k]); bar = c.prog; sub = c.done ? `Cycle ended ${fmtDate(c.end)} · tap to start the next` : `${esc(peso(c.closing))} at maturity, ${esc(fmtDate(c.end))}`; }
    } else if (p.kind === 'mp2') { const m = mp2Calc(p); sub = m.maturity ? `${esc(peso(m.atMaturity))} projected at maturity, ${esc(fmtDate(m.maturity, {month: 'short', year: 'numeric'}))} · ${pct(p.rate)} dividend` : 'No contributions yet'; if (m.maturity) bar = Math.min(1, Math.max(0, daysBetween(m.start, todayIso()) / daysBetween(m.start, m.maturity))); }
    else { const b = basicCalc(p); sub = `${pct(p.rate || 0)} p.a.${b.interest ? ` · ${esc(peso(b.interest, 2))} interest so far` : ''}`; }
    return `<button class="card potcard" data-act="pot-open" data-p="${esc(p.id)}"><div class="muted">${esc(p.name)} · ${esc(KIND[p.kind])}</div>
      <div class="serif" style="font-size:28px">${esc(peso(big, 2))}</div>${bar != null ? `<div class="bar"><i style="width:${(bar * 100).toFixed(1)}%"></i></div>` : ''}<div class="muted">${sub}</div></button>`;
  };
  w.innerHTML = `<div class="savtotal"><div class="muted">In savings now</div><div class="big" style="font-size:clamp(34px,10vw,44px)" data-count="sav" data-n="${total}" data-d="2">${esc(peso(total, 2))}</div>
      <p class="muted">Deposits here show as each month’s <b>Saved</b> in Months, but aren’t subtracted from total money — the transfer already shows as money out in your imported statement.</p></div>
    ${goalsHTML()}
    ${pots().length || goals().length ? aiCardHTML('savings', 'card') : ''}
    <h2 class="sech">Accounts</h2>
    <div class="potgrid">${ps.map(card).join('') || '<p class="empty">No savings yet. Add your Maya time deposit, MP2 or a savings account, or import the Maya file from your spreadsheet in Settings.</p>'}</div>
    <button class="go" data-act="pot-new">Add savings</button>
    ${forecastHTML()}`;
  const fcs = $('fcChart'); if (fcs) { fcRO.disconnect(); fcRO.observe(fcs); drawForecast(); }
}

/* ---- goals: "I want ₱X — how long, and how much a month?" ---- */
const goals = () => (S.meta.goals = S.meta.goals || []);
const netRate = p => p.kind === 'mp2' ? (p.rate || 0) : ((p.kind === 'td' && (p.cycles || []).length ? (p.cycles[p.cycles.length - 1].rate ?? p.rate) : p.rate) || 0) * (1 - (p.tax ?? 0.2));
function goalSource(g) {
  if (g.from === 'none') return {have: +g.have || 0, rate: 0, label: 'Money you set aside yourself'};
  const ps = g.from === 'all' ? pots() : pots().filter(p => p.id === g.from);
  const vals = ps.map(p => ({p, v: potNow(p)})), have = vals.reduce((s, x) => s + x.v, 0) + (+g.have || 0);
  const rate = vals.length ? (have > 0 ? vals.reduce((s, x) => s + x.v * netRate(x.p), 0) / Math.max(1, have) : vals.reduce((s, x) => s + netRate(x.p), 0) / vals.length) : 0;
  return {have, rate, label: g.from === 'all' ? 'All your savings' : (ps[0] ? ps[0].name : 'Savings account')};
}
// monthly-compounded future value: what you have grows, plus a deposit every month
const gFV = (cur, pmt, n, r) => r > 0 ? cur * (1 + r) ** n + pmt * (((1 + r) ** n - 1) / r) : cur + pmt * n;
function gNeed(cur, target, n, r) { if (n <= 0) return Math.max(0, target - cur); const g = (1 + r) ** n; return Math.max(0, r > 0 ? (target - cur * g) * r / (g - 1) : (target - cur) / n); }
function gMonths(cur, target, pmt, r) {
  if (cur >= target) return 0;
  if (pmt <= 0 && r <= 0) return Infinity;
  if (r <= 0) return Math.ceil((target - cur) / pmt);
  if (pmt <= 0 && cur <= 0) return Infinity;
  const n = Math.log((target * r + pmt) / (cur * r + pmt)) / Math.log(1 + r);
  return isFinite(n) ? Math.ceil(n) : Infinity;
}
const monthsTo = ym => { const t = today(), [y, m] = ym.split('-').map(Number); return (y - t.getFullYear()) * 12 + (m - 1 - t.getMonth()); };
const inMonths = n => { const t = today(); return new Date(t.getFullYear(), t.getMonth() + n, 1).toLocaleDateString('en-PH', {month: 'short', year: 'numeric'}); };
const spanTxt = n => !isFinite(n) ? 'never at this rate' : n <= 0 ? 'now' : n < 12 ? `${n} month${n === 1 ? '' : 's'}` : `${Math.floor(n / 12)} yr${n >= 24 ? 's' : ''}${n % 12 ? ` ${n % 12} mo` : ''}`;
function habits() {   // your last 6 finished months
  const past = series().filter(p => p.past && !p.now && (p.inc || p.exp)).slice(-6);
  if (!past.length) return {save: 0, left: 0, n: 0};
  const save = past.reduce((s, p) => s + p.sav, 0) / past.length, left = past.reduce((s, p) => s + p.inc - p.exp - p.manual, 0) / past.length;
  // room = what you could put aside: what's left plus what you already save (deposits already count as money out)
  return {n: past.length, save, left, room: Math.max(0, left + save)};
}
function goalCalc(g) {
  const src = goalSource(g), r = src.rate / 12, target = +g.target, cur = src.have, left = Math.max(0, target - cur), h = habits();
  const nBy = g.by ? monthsTo(g.by) : null, need = g.by ? gNeed(cur, target, Math.max(1, nBy), r) : null;
  const pmt = +g.monthly || 0, nAt = pmt ? gMonths(cur, target, pmt, r) : null, nUsual = h.save > 0 ? gMonths(cur, target, h.save, r) : null;
  return {src, r, target, cur, left, h, nBy, need, pmt, nAt, nUsual, prog: target > 0 ? Math.min(1, cur / target) : 0, done: cur >= target};
}
function goalLine(g, c) {
  if (c.done) return '<span class="up">Reached</span>';
  if (g.by) return c.nBy <= 0 ? `<span class="dn">Target date has passed</span> · ${esc(peso(c.left))} to go` : `Save <b>${esc(peso(Math.ceil(c.need)))}</b> a month to reach it by ${esc(inMonths(c.nBy))}`;
  if (c.pmt) return `At ${esc(peso(c.pmt))} a month: <b>${isFinite(c.nAt) ? esc(inMonths(c.nAt)) : 'not reachable'}</b> (${spanTxt(c.nAt)})`;
  if (c.nUsual != null) return `At your usual ${esc(pesoS(c.h.save))}/month: <b>${isFinite(c.nUsual) ? esc(inMonths(c.nUsual)) : 'not reachable'}</b>`;
  return 'Set a date or a monthly amount to see your plan';
}
function goalsHTML() {
  const gs = goals();
  return `<div class="inshead"><h2 class="sech">Goals</h2><button class="ghost" data-act="goal-new">＋ Goal</button></div>
    ${gs.length ? `<div class="potgrid">${gs.map(g => { const c = goalCalc(g); return `<button class="card goalcard" data-act="goal-open" data-g="${esc(g.id)}">
      <div class="muted">${esc(g.name)} · ${esc(c.src.label)}</div><div class="gnum"><span class="serif">${esc(peso(c.cur))}</span> <span class="muted">of ${esc(peso(c.target))}</span></div>
      <div class="bar"><i style="width:${(c.prog * 100).toFixed(1)}%"></i></div><div class="gline">${goalLine(g, c)}</div></button>`; }).join('')}</div>`
    : `<button class="card goalempty" data-act="goal-new"><b>What are you saving for?</b><span class="muted">Set an amount, and Pera works out how much a month and how long it takes, using your savings and their interest.</span></button>`}`;
}
let goalEdit = null;
function goalSheet(id, editing) {
  const g = goals().find(x => x.id === id); if (!g) return closeSheet();
  const c = goalCalc(g), h = c.h;
  const base = g.by ? c.need : c.pmt || h.save || c.left / 12;
  const step = base > 20000 ? 1000 : 500, amts = [...new Set([0.5, 0.75, 1, 1.5, 2].map(f => Math.max(step, Math.round(base * f / step) * step)))].slice(0, 5);
  const afford = x => h.n && h.room > 0 ? Math.round(x / h.room * 100) : null;
  const affTxt = x => { const a = afford(x); return a == null ? '' : a > 100 ? `<span class="dn">more than the ${esc(pesoS(h.room))} you can usually set aside</span>` : `${a}% of the ${esc(pesoS(h.room))} you can usually set aside`; };
  const ratePct = (c.src.rate * 100).toFixed(2).replace(/\.?0+$/, '');
  const body = `<div class="sheethead"><h2>${esc(g.name)}</h2><button class="ghost" data-act="close">Done</button></div>
    <div class="gnum big2"><span class="serif">${esc(peso(c.cur))}</span> <span class="muted">of ${esc(peso(c.target))}</span></div>
    <div class="bar"><i style="width:${(c.prog * 100).toFixed(1)}%"></i></div>
    <p class="muted">${c.done ? 'You’ve reached this goal.' : `${esc(peso(c.left))} to go · ${Math.round(c.prog * 100)}% there`} · counting ${esc(c.src.label)}</p>
    ${c.done ? '' : `<div class="gplans">
      ${g.by ? `<div class="gplan"><span>To reach it by ${esc(inMonths(Math.max(0, c.nBy)))}</span><b>${c.nBy <= 0 ? 'Date passed' : esc(peso(Math.ceil(c.need))) + ' / month'}</b><small>${c.nBy > 0 ? `for ${spanTxt(c.nBy)} · ${affTxt(c.need)}` : 'Pick a later date'}</small></div>` : ''}
      ${c.pmt ? `<div class="gplan"><span>Saving ${esc(peso(c.pmt))} a month</span><b>${isFinite(c.nAt) ? esc(inMonths(c.nAt)) : 'Not reachable'}</b><small>${spanTxt(c.nAt)}${affTxt(c.pmt) ? ' · ' + affTxt(c.pmt) : ''}</small></div>` : ''}
      ${h.save > 0 ? `<div class="gplan"><span>At your usual pace (${esc(peso(h.save))} saved a month)</span><b>${isFinite(c.nUsual) ? esc(inMonths(c.nUsual)) : 'Not reachable'}</b><small>${spanTxt(c.nUsual)} · average of your last ${h.n} months</small></div>` : ''}
    </div>
    <h3>If you save each month…</h3>
    <table class="gtable"><thead><tr><th>A month</th><th>You reach it</th><th>Takes</th></tr></thead><tbody>
      ${amts.map(x => { const n = gMonths(c.cur, c.target, x, c.r), a = afford(x); return `<tr${g.by && n <= c.nBy ? ' class="ok"' : ''}><td>${esc(peso(x))}${a != null ? `<small class="${a > 100 ? 'dn' : ''}">${a}% of your room</small>` : ''}</td><td>${isFinite(n) ? esc(inMonths(n)) : '—'}</td><td>${spanTxt(n)}</td></tr>`; }).join('')}
    </tbody></table>
    <p class="muted">${+ratePct ? `Includes about ${ratePct}% a year interest after tax, from ${esc(c.src.label)}. ` : 'No interest counted. '}“Room” is what you can usually set aside: income minus spending over the last ${h.n || 0} months, counting what you already save as room.${g.by ? ' Highlighted rows reach it in time.' : ''}</p>`}
    ${editing ? goalForm(g) : `<div class="row2"><button class="ghost" data-act="goal-edit" data-g="${esc(g.id)}">Edit goal</button><button class="ghost danger" data-act="goal-del" data-g="${esc(g.id)}">Delete</button></div>`}`;
  goalEdit = editing ? id : null;
  if (sheetOpen && document.querySelector('#sheetBody [data-goal]')) $('sheetBody').innerHTML = `<div data-goal="${esc(id)}">${body}</div>`; else openSheet(`<div data-goal="${esc(id)}">${body}</div>`);
  if (editing) bindGoalForm(g);
}
function goalForm(g) {
  const ps = pots();
  return `<form id="gf" class="gform" novalidate>
    <label for="gN">Goal</label><input id="gN" maxlength="40" placeholder="Emergency fund, house down payment…" value="${esc(g.name || '')}">
    <label for="gT">Amount</label><input id="gT" class="amtin" inputmode="decimal" value="${g.target ? esc(g.target) : ''}" placeholder="500k">
    <label for="gF">Count money from</label><select id="gF"><option value="all" ${g.from === 'all' ? 'selected' : ''}>All your savings</option>${ps.map(p => `<option value="${esc(p.id)}" ${g.from === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="none" ${g.from === 'none' ? 'selected' : ''}>Nothing yet / money outside Pera</option></select>
    <label for="gH" id="gHL">Already set aside elsewhere (optional)</label><input id="gH" class="amtin" inputmode="decimal" value="${g.have ? esc(g.have) : ''}" placeholder="0">
    <div class="two"><div><label for="gB">Reach it by (optional)</label><input id="gB" type="month" value="${esc(g.by || '')}"></div><div><label for="gM">Or save a month (optional)</label><input id="gM" class="amtin" inputmode="decimal" value="${g.monthly ? esc(g.monthly) : ''}" placeholder="10k"></div></div>
    <p class="muted" id="gErr"></p>
    <button class="go" type="submit">${g.id ? 'Save goal' : 'Add goal'}</button>
    ${g.id ? '<button type="button" class="ghost" id="gCancel">Cancel</button>' : ''}
  </form>`;
}
function bindGoalForm(g) {
  const lbl = () => { $('gHL').textContent = $('gF').value === 'none' ? 'Already set aside (optional)' : 'Plus money outside Pera (optional)'; };
  $('gF').addEventListener('change', lbl); lbl();
  const cn = $('gCancel'); if (cn) cn.addEventListener('click', () => goalSheet(g.id, false));
  $('gf').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('gN').value.trim() || 'Savings goal', target = parseAmt($('gT').value), have = $('gH').value.trim() ? parseAmt($('gH').value) : 0, monthly = $('gM').value.trim() ? parseAmt($('gM').value) : 0, by = $('gB').value;
    if (!(target > 0)) { $('gT').classList.add('bad'); $('gT').focus(); return; }
    if (isNaN(have) || isNaN(monthly)) { $('gErr').textContent = 'Check the amounts.'; return; }
    if (by && monthsTo(by) <= 0) { $('gB').classList.add('bad'); $('gErr').textContent = 'Pick a month after this one.'; return; }
    const isNew = !g.id, before = JSON.parse(JSON.stringify(goals()));
    const x = isNew ? {id: uid()} : goals().find(z => z.id === g.id);
    Object.assign(x, {name, target, from: $('gF').value, have, by: by || '', monthly});
    if (isNew) goals().push(x);
    commit('meta'); goalSheet(x.id, false);
    if (isNew) toast(`${name} added`, () => { S.meta.goals = before; commit('meta'); closeSheet(); });
  });
}
function goalNew(target) {
  openSheet(`<div data-goal="new"><div class="sheethead"><h2>New goal</h2><button class="ghost" data-act="close">Cancel</button></div>
    <p class="muted">Tell Pera how much and either when or how much a month. It does the rest.</p>${goalForm({from: pots().length ? 'all' : 'none', target})}</div>`);
  bindGoalForm({}); setTimeout(() => $('gN').focus(), 50);
}
/* ---- pot sheet ---- */
let sheetPot = null;   // {id, k} — the open pot, refreshed after every change
function potSheet(id, k) {
  const p = potById(id); if (!p) return closeSheet();
  if (p.kind === 'td') k = k == null || k >= (p.cycles || []).length ? tdCurrent(p) : Math.max(0, k);
  const editing = sheetPot && sheetPot.id === id ? sheetPot.edit : null;
  const keep = sheetPot && sheetPot.id === id;
  const html = potHTML(p, k, editing, keep && sheetPot.k === k && sheetPot.cedit, keep && sheetPot.fedit, keep ? sheetPot.frate : null);
  if (sheetOpen && sheetPot && sheetPot.id === id) $('sheetBody').innerHTML = html; else openSheet(html);
  const same = sheetPot && sheetPot.id === id;
  sheetPot = {id, k, edit: same ? sheetPot.edit : null, cedit: same && sheetPot.k === k ? sheetPot.cedit : false, fedit: same ? sheetPot.fedit : false, frate: same ? sheetPot.frate : null}; bindPot(p);
  const on = document.querySelector('#sheetBody .cyclechips [aria-pressed=true]');   // keep the chosen cycle in view
  if (on) on.parentElement.scrollLeft = on.offsetLeft - on.parentElement.clientWidth / 2 + on.offsetWidth / 2;
}
function potHTML(p, k, editing, cedit, fedit, frate) {
  // a row being edited turns into a small form in place
  const editRow = (cyc, d, label) => `<li class="editing"><form class="depedit" data-c="${cyc}" data-id="${esc(d.id)}" novalidate>
      <div class="two"><div><label>Date</label><input type="date" name="date" value="${esc(d.date)}"></div><div><label>${label}</label><input name="a" inputmode="decimal" value="${esc(d.a)}" class="amtin" style="font-size:20px"></div></div>
      <div class="two" style="margin-top:8px"><button type="button" class="plain" data-act="dep-cancel" style="margin:0">Cancel</button><button class="go" type="submit" style="margin:0">Save</button></div></form></li>`;
  const rowBtn = (cyc, d, inner) => `<button class="rowbtn depbtn" data-act="dep-edit" data-p="${esc(p.id)}" data-c="${cyc}" data-id="${esc(d.id)}" aria-label="Edit deposit on ${esc(fmtDate(d.date))}">${inner}</button>`;
  const head = `<div class="sheethead potsheet"><h2>${esc(p.name)}</h2><span style="display:flex;gap:2px"><button class="ghost" data-act="pot-edit" data-p="${esc(p.id)}">Edit</button><button class="ghost" data-act="close">Done</button></span></div>`;
  const delBtn = (cyc, d) => `<button class="x" data-act="dep-del" data-p="${esc(p.id)}" data-c="${cyc}" data-id="${esc(d.id)}" aria-label="Delete deposit">×</button>`;
  const addForm = (label, extra = '') => `<form id="depForm" class="depform" novalidate>
      <div class="two"><div><label for="depDate">Date</label><input id="depDate" type="date" value="${todayIso()}"></div><div><label for="depAmt">${label}</label><input id="depAmt" inputmode="decimal" placeholder="₱0" class="amtin" style="font-size:20px"></div></div>${extra}
      <button class="go" type="submit">Add</button></form>`;
  if (p.kind === 'td') {
    const cs = p.cycles || [];
    const binHtml = (p.trash || []).length ? `<h2>Deleted cycles</h2><ul class="list deplist">${p.trash.map((x, i) => { const cc = tdCycle(p, x.cycle), left = Math.max(0, Math.ceil((Date.parse(x.at) + TRASH_DAYS * 864e5 - Date.now()) / 864e5)); return `<li><span class="t">${esc(fmtDate(x.cycle.start))} – ${esc(fmtDate(cc.end))}<small>${esc(peso(cc.closing))} at maturity · ${left} day${left === 1 ? '' : 's'} left</small></span><button class="ghost" data-act="cyc-restore" data-p="${esc(p.id)}" data-k="${i}">Restore</button><button class="x" data-act="cyc-forever" data-p="${esc(p.id)}" data-k="${i}" aria-label="Delete for good">×</button></li>`; }).join('')}</ul>` : '';
    if (!cs.length) return head + `<p class="muted">${esc(KIND.td)} · ${pct(p.rate)} p.a. · ${pct(p.tax ?? .2)} tax · ${p.cycleDays || 181}-day cycles</p><button class="go" data-act="cycle-new" data-p="${esc(p.id)}">Start the first cycle today</button>` + binHtml;
    const c = tdCycle(p, cs[k]), last = k === cs.length - 1;
    return head + `<div class="chips cyclechips">${cs.map((x, i) => `<button class="chip" data-act="pot-cycle" data-p="${esc(p.id)}" data-k="${i}" aria-pressed="${i === k}">${esc(fmtDate(x.start, {month: 'short', year: 'numeric'}))}</button>`).join('')}</div>
      <div class="trio"><div class="tile"><span>Put in</span><b>${esc(pesoS(c.principal))}</b></div><div class="tile"><span>Interest</span><b class="up">+${esc(peso(c.interest, 2))}</b></div><div class="tile"><span>At maturity</span><b>${esc(pesoS(c.closing))}</b></div></div>
      ${cedit ? `<form id="cycF" class="depedit" novalidate><div class="two"><div><label for="cRate">Interest % per year</label><input id="cRate" inputmode="decimal" value="${(c.rate * 100).toFixed(3).replace(/\.?0+$/, '')}"></div><div><label for="cCarry">Carried over</label><input id="cCarry" inputmode="decimal" value="${esc(cs[k].carry || 0)}"></div></div>
        <div class="two"><div><label for="cStart">Starts</label><input id="cStart" type="date" value="${esc(cs[k].start)}"></div><div><label for="cEnd">Ends</label><input id="cEnd" type="date" value="${esc(c.end)}"></div></div>
        <div class="two" style="margin-top:10px"><button type="button" class="plain" data-act="cyc-cancel" style="margin:0">Cancel</button><button class="go" type="submit" style="margin:0">Save cycle</button></div>
        <button type="button" class="danger" data-act="cyc-del" data-p="${esc(p.id)}">Delete this cycle</button></form>`
      : `<button class="cycinfo" data-act="cyc-edit" data-p="${esc(p.id)}"><span>${esc(fmtDate(cs[k].start))} – ${esc(fmtDate(c.end))} · <b>${pct(c.rate)} p.a.</b> · ${pct(p.tax ?? .2)} tax · each deposit earns only for the days left</span><span class="ghost">Edit cycle</span></button>`}
      <div class="bar"><i style="width:${(c.prog * 100).toFixed(1)}%"></i></div>
      <ul class="list deplist">${c.items.map(it => {
        if (!it.carry && it.id === editing) return editRow(k, it, 'Deposit');
        const inner = `<span class="t">${it.carry ? 'Carried over' : esc(fmtDate(it.date))}<small>${it.days} days · +${esc(peso(it.net, 2))} interest${it.planned ? ' · planned' : ''}</small></span><span class="amtcol"><b class="amt">${esc(peso(it.a, 2))}</b><small>${esc(peso(it.bal, 2))}</small></span>`;
        return `<li class="${it.planned ? 'planned' : ''}">${it.carry ? `<button class="rowbtn depbtn" data-act="cyc-edit" data-p="${esc(p.id)}" aria-label="Edit carried-over amount and interest rate">${inner}</button><span class="x" aria-hidden="true"></span>` : rowBtn(k, it, inner) + delBtn(k, it)}</li>`;
      }).join('')}</ul>
      <p class="muted">Tap a deposit to change its date or amount. Tap “Carried over” or the cycle line to change the interest rate.</p>
      ${addForm('Deposit')}
      ${last ? `<button class="${c.done ? 'go' : 'plain'}" data-act="cycle-next" data-p="${esc(p.id)}">Start next cycle${c.done ? '' : ' early'} with ${esc(peso(c.closing, 2))}</button>` : ''}
      ${tdForecastHTML(p, fedit, frate)}${binHtml}`;
  }
  if (p.kind === 'mp2') {
    const m = mp2Calc(p), deps = [...(p.deposits || [])].sort((a, b) => b.date.localeCompare(a.date));
    return head + `<div class="trio"><div class="tile"><span>Contributed</span><b>${esc(pesoS(m.contribNow))}</b></div><div class="tile"><span>Dividends</span><b class="up">+${esc(pesoS(m.divs))}</b></div><div class="tile"><span>At maturity</span><b>${esc(pesoS(m.atMaturity))}</b></div></div>
      <p class="muted">${pct(p.rate)} dividend (2025 rate: 7.12%) · tax-free · ${p.payout === 'annual' ? 'paid out yearly' : 'compounded'}${m.maturity ? ` · matures ${esc(fmtDate(m.maturity))}` : ''}. Dividend = rate × average monthly balance; future years are estimates.</p>
      ${m.years.length ? `<table class="ytable"><thead><tr><th>Year</th><th>Added</th><th>Dividend</th><th>Balance</th></tr></thead><tbody>${m.years.map(r => `<tr class="${r.est ? 'est' : ''}"><td>${r.y}</td><td>${esc(pesoS(r.contrib))}</td><td class="up">+${esc(peso(r.div))}</td><td>${esc(pesoS(r.end))}</td></tr>`).join('')}</tbody></table>` : ''}
      ${addForm('Contribution', `<label class="check"><input type="checkbox" id="depRep"><span>Repeat monthly for <select id="depN" style="width:auto;min-height:36px;padding:4px 28px 4px 8px;display:inline-block">${[3, 6, 12, 24, 36, 60].map(n => `<option>${n}</option>`).join('')}</select> months</span></label>`)}
      <ul class="list deplist">${deps.map(d => d.id === editing ? editRow(-1, d, 'Contribution') : `<li class="${d.date > todayIso() ? 'planned' : ''}">${rowBtn(-1, d, `<span class="t">${esc(fmtDate(d.date))}<small>${d.date > todayIso() ? 'planned' : 'contribution'}</small></span><b class="amt">${esc(peso(d.a, 2))}</b>`)}${delBtn(-1, d)}</li>`).join('')}</ul>`;
  }
  const b = basicCalc(p);
  return head + `<div class="trio"><div class="tile"><span>Balance</span><b>${esc(pesoS(b.now))}</b></div><div class="tile"><span>Interest so far</span><b class="up">+${esc(peso(b.interest, 2))}</b></div><div class="tile"><span>Next 30 days</span><b class="up">+${esc(peso(b.monthly, 2))}</b></div></div>
    <p class="muted">${pct(p.rate || 0)} p.a. · ${pct(p.tax ?? .2)} tax · interest added daily. Use a minus amount for withdrawals.</p>
    ${addForm('Deposit (− to withdraw)')}
    <ul class="list deplist">${[...b.txns].reverse().map(d => d.id === editing ? editRow(-1, d, 'Amount (− to withdraw)') : `<li>${rowBtn(-1, d, `<span class="t">${esc(fmtDate(d.date))}<small>${d.a < 0 ? 'withdrawal' : 'deposit'}</small></span><b class="amt ${d.a < 0 ? 'dn' : ''}">${esc(peso(d.a, 2))}</b>`)}${delBtn(-1, d)}</li>`).join('')}</ul>`;
}
function bindPot(p) {
  const pf = $('planF');
  if (pf) pf.addEventListener('submit', e => {
    e.preventDefault();
    const a = parseAmt($('plA').value || '0'), st = +$('plS').value, r = parseFloat($('plR').value) / 100, cd = +$('plD').value;
    const bad = isNaN(a) || a < 0 || !(st >= 1) || isNaN(r) || !(cd >= 7);
    ['plA', 'plS', 'plR', 'plD'].forEach(i => $(i).classList.toggle('bad', bad)); if (bad) return;
    const old = p.plan ? JSON.parse(JSON.stringify(p.plan)) : null;
    p.plan = {...planOf(p), amount: a, step: st, rate: r, cycleDays: cd, cycles: +$('plN').value};
    sheetPot.fedit = false; commit('meta');
    toast('Forecast plan saved', () => { p.plan = old; commit('meta'); });
  });
  const rf = $('fcRateF');
  if (rf) { $('fcR').focus(); $('fcR').select(); rf.addEventListener('submit', e => {
    e.preventDefault(); const r = parseFloat($('fcR').value) / 100; $('fcR').classList.toggle('bad', isNaN(r)); if (isNaN(r)) return;
    p.plan = {...planOf(p)}; p.plan.rates = {...(p.plan.rates || {}), [+rf.dataset.i]: r}; sheetPot.frate = null; commit('meta');
  }); }
  const cf = $('cycF');
  if (cf) cf.addEventListener('submit', e => {
    e.preventDefault();
    const c = p.cycles[sheetPot.k], rate = parseFloat($('cRate').value) / 100, carry = parseAmt($('cCarry').value || '0'), st = $('cStart').value, en = $('cEnd').value;
    const bad = isNaN(rate) || rate < 0 || isNaN(carry) || !st || !en || en <= st;
    $('cRate').classList.toggle('bad', isNaN(rate) || rate < 0); $('cEnd').classList.toggle('bad', !en || en <= st); if (bad) return;
    const old = {...c}; Object.assign(c, {rate, carry, start: st, end: en}); sheetPot.cedit = false; commit('meta');
    toast(`Cycle saved · ${pct(rate)} p.a.`, () => { Object.assign(c, old); commit('meta'); });
  });
  const ef = document.querySelector('#sheetBody form.depedit:not(#cycF):not(#planF):not(#fcRateF)');
  if (ef) {
    const amt = ef.querySelector('[name=a]'); amt.focus(); amt.select();
    ef.addEventListener('submit', e => {
      e.preventDefault();
      const a = parseAmt(amt.value), date = ef.querySelector('[name=date]').value;
      const bad = isNaN(a) || !date || (p.kind !== 'basic' && a <= 0); amt.classList.toggle('bad', bad); if (bad) return;
      const c = +ef.dataset.c, list = p.kind === 'td' ? p.cycles[c].deposits : p.kind === 'mp2' ? p.deposits : p.txns, d = list.find(x => x.id === ef.dataset.id); if (!d) return;
      const old = {date: d.date, a: d.a}; d.date = date; d.a = a; sheetPot.edit = null; commit('meta');
      toast('Deposit updated', () => { d.date = old.date; d.a = old.a; commit('meta'); });
    });
  }
  const f = $('depForm'); if (!f) return;
  f.addEventListener('submit', e => {
    e.preventDefault();
    const a = parseAmt($('depAmt').value), date = $('depDate').value;
    $('depAmt').classList.toggle('bad', isNaN(a) || (p.kind !== 'basic' && a <= 0)); if (isNaN(a) || !date || (p.kind !== 'basic' && a <= 0)) return;
    const added = [];
    if (p.kind === 'td') { const c = p.cycles[sheetPot.k]; const it = {id: uid(), date, a}; (c.deposits = c.deposits || []).push(it); added.push([c.deposits, it]); }
    else if (p.kind === 'mp2') {
      const n = $('depRep') && $('depRep').checked ? +$('depN').value : 1, d0 = new Date(dnum(date));
      for (let i = 0; i < n; i++) { const it = {id: uid(), date: iso(mkDate(d0.getFullYear(), d0.getMonth() + i, d0.getDate())), a}; (p.deposits = p.deposits || []).push(it); added.push([p.deposits, it]); }
    } else { const it = {id: uid(), date, a}; (p.txns = p.txns || []).push(it); added.push([p.txns, it]); }
    commit('meta');
    toast(added.length > 1 ? `${added.length} contributions added` : `${peso(Math.abs(a), 2)} ${a < 0 ? 'withdrawal' : 'deposit'} added`, () => { added.forEach(([list, it]) => { const i = list.indexOf(it); if (i >= 0) list.splice(i, 1); }); commit('meta'); });
  });
}
function potForm(id) {
  const p = id ? potById(id) : {name: '', kind: 'td', rate: 0.06, tax: 0.2, cycleDays: 181, payout: 'compound'};
  openSheet(`<div class="sheethead"><h2>${id ? 'Edit ' + esc(p.name) : 'Add savings'}</h2><button type="button" class="ghost" data-act="${id ? 'pot-open' : 'close'}" data-p="${esc(id || '')}">Cancel</button></div>
    <form id="potF" novalidate>
      <label for="pName">Name</label><input id="pName" maxlength="40" value="${esc(p.name)}" placeholder="Maya time deposit, MP2, Seabank…">
      <label for="pKind">Type</label><select id="pKind" ${id ? 'disabled' : ''}>${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="two"><div><label for="pRate" id="pRateL">Interest % per year</label><input id="pRate" inputmode="decimal" value="${(p.rate * 100).toFixed(2).replace(/\.?0+$/, '')}"></div>
        <div id="pTaxW"><label for="pTax">Tax on interest %</label><input id="pTax" inputmode="decimal" value="${((p.tax ?? .2) * 100).toFixed(0)}"></div></div>
      <div id="pTdW"><label for="pDays">Cycle length (days)</label><input id="pDays" inputmode="numeric" value="${p.cycleDays || 181}">
        ${id ? '' : `<div class="two"><div><label for="pStart">First cycle starts</label><input id="pStart" type="date" value="${todayIso()}"></div><div><label for="pOpen">Opening amount</label><input id="pOpen" inputmode="decimal" placeholder="₱0"></div></div>`}</div>
      <div id="pMp2W"><label for="pPay">Dividends</label><select id="pPay"><option value="compound" ${p.payout !== 'annual' ? 'selected' : ''}>Compounded (added to savings)</option><option value="annual" ${p.payout === 'annual' ? 'selected' : ''}>Paid out every year</option></select></div>
      <div id="pBasicW">${id ? '' : `<div class="two"><div><label for="pBDate">Balance as of</label><input id="pBDate" type="date" value="${todayIso()}"></div><div><label for="pBal">Current balance</label><input id="pBal" inputmode="decimal" placeholder="₱0"></div></div>`}</div>
      <button class="go" type="submit">${id ? 'Save' : 'Add'}</button>
      ${id ? '<button type="button" class="danger" id="pDel">Delete this savings</button>' : ''}
    </form>`, () => {
    const show = () => { const k = $('pKind').value; $('pTdW').hidden = k !== 'td'; $('pMp2W').hidden = k !== 'mp2'; $('pBasicW').hidden = k !== 'basic'; $('pTaxW').hidden = k === 'mp2'; $('pRateL').textContent = k === 'mp2' ? 'Dividend % per year' : k === 'td' && id ? 'Interest % for new cycles' : 'Interest % per year'; if (!id && k === 'mp2' && $('pRate').value === '6') $('pRate').value = '7.12'; if (!id && k === 'basic' && $('pRate').value === '6') $('pRate').value = '3.5'; };
    $('pKind').addEventListener('change', show); show();
    $('potF').addEventListener('submit', e => {
      e.preventDefault();
      const name = $('pName').value.trim(), rate = parseFloat($('pRate').value) / 100, tax = parseFloat($('pTax').value) / 100;
      $('pName').classList.toggle('bad', !name); $('pRate').classList.toggle('bad', isNaN(rate)); if (!name || isNaN(rate)) return;
      if (id) {
        Object.assign(p, {name, rate, tax: isNaN(tax) ? p.tax : tax, cycleDays: +$('pDays').value || p.cycleDays, payout: $('pPay').value});
        commit('meta'); return potSheet(p.id);
      }
      const kind = $('pKind').value, np = {id: uid(), name, kind, rate};
      if (kind === 'td') { Object.assign(np, {tax: isNaN(tax) ? .2 : tax, cycleDays: +$('pDays').value || 181}); const st = $('pStart').value || todayIso(), op = parseAmt($('pOpen').value || '0'); np.cycles = [{start: st, end: addDays(st, np.cycleDays), rate, carry: 0, deposits: op > 0 ? [{id: uid(), date: st, a: op}] : []}]; }
      if (kind === 'mp2') Object.assign(np, {payout: $('pPay').value, rates: {2025: 0.0712, 2024: 0.071, 2023: 0.0705}, deposits: []});
      if (kind === 'basic') { const b = parseAmt($('pBal').value || '0'); Object.assign(np, {tax: isNaN(tax) ? .2 : tax, txns: b ? [{id: uid(), date: $('pBDate').value || todayIso(), a: b}] : []}); }
      pots().push(np); commit('meta'); potSheet(np.id);
    });
    const d = $('pDel'); if (d) d.addEventListener('click', () => {
      const list = pots(), i = list.indexOf(p); list.splice(i, 1); closeSheet(); commit('meta');
      toast(`${p.name} deleted`, () => { list.splice(i, 0, p); commit('meta'); });
    });
  });
}
function savingsAct(d) {
  const p = d.p ? potById(d.p) : null;
  switch (d.act) {
    case 'pot-open': return potSheet(d.p);
    case 'pot-new': return potForm(null);
    case 'pot-edit': return potForm(d.p);
    case 'pot-cycle': if (sheetPot) sheetPot.edit = null; return potSheet(d.p, +d.k);
    case 'dep-edit': sheetPot.edit = d.id; return potSheet(d.p, sheetPot.k);
    case 'dep-cancel': sheetPot.edit = null; return potSheet(sheetPot.id, sheetPot.k);
    case 'plan-edit': sheetPot.fedit = true; sheetPot.frate = null; return potSheet(d.p, sheetPot.k);
    case 'plan-cancel': sheetPot.fedit = false; return potSheet(sheetPot.id, sheetPot.k);
    case 'fc-rate': sheetPot.frate = +d.i; sheetPot.fedit = false; return potSheet(d.p, sheetPot.k);
    case 'fc-rate-cancel': sheetPot.frate = null; return potSheet(sheetPot.id, sheetPot.k);
    case 'fc-rate-reset': { const q = potById(sheetPot.id), plan = q.plan = q.plan || {}; plan.rates = {...(plan.rates || {})}; delete plan.rates[+d.i]; sheetPot.frate = null; commit('meta'); return; }
    case 'cyc-edit': sheetPot.cedit = true; sheetPot.edit = null; return potSheet(d.p, sheetPot.k);
    case 'cyc-cancel': sheetPot.cedit = false; return potSheet(sheetPot.id, sheetPot.k);
    case 'cyc-del': {
      const k = sheetPot.k, [c] = p.cycles.splice(k, 1), item = {cycle: c, at: new Date().toISOString()};
      (p.trash = p.trash || []).unshift(item); sheetPot.cedit = false; commit('meta'); potSheet(p.id, Math.min(k, p.cycles.length - 1));
      toast(`${fmtDate(c.start, {month: 'short', year: 'numeric'})} cycle deleted`, () => restoreCycle(p, item)); return;
    }
    case 'cyc-restore': { const item = (p.trash || [])[+d.k]; if (item) restoreCycle(p, item); return; }
    case 'cyc-forever': { const t = p.trash || [], k = +d.k, [item] = t.splice(k, 1), inSettings = !sheetPot; if (!item) return; commit('meta'); if (inSettings) settings(); toast('Cycle deleted for good', () => { t.splice(k, 0, item); commit('meta'); if (inSettings) settings(); }); return; }
    case 'cycle-new': { const st = todayIso(); p.cycles = [{start: st, end: addDays(st, p.cycleDays || 181), rate: p.rate, carry: 0, deposits: []}]; commit('meta'); return potSheet(p.id, 0); }
    case 'cycle-next': {
      const last = p.cycles[p.cycles.length - 1], c = tdCycle(p, last), st = c.end;
      p.cycles.push({start: st, end: addDays(st, p.cycleDays || 181), rate: p.rate, carry: Math.round(c.closing * 100) / 100, deposits: []});
      commit('meta'); potSheet(p.id, p.cycles.length - 1);
      toast(`New cycle started with ${peso(c.closing, 2)}`, () => { p.cycles.pop(); commit('meta'); potSheet(p.id); }); return;
    }
    case 'dep-del': {
      const list = p.kind === 'td' ? p.cycles[+d.c].deposits : p.kind === 'mp2' ? p.deposits : p.txns, i = list.findIndex(x => x.id === d.id); if (i < 0) return;
      const [x] = list.splice(i, 1); commit('meta'); toast('Deposit deleted', () => { list.splice(i, 0, x); commit('meta'); }); return;
    }
  }
}
function restoreCycle(p, item) {
  p.trash = (p.trash || []).filter(x => x !== item);
  p.cycles = p.cycles || []; p.cycles.push(item.cycle); p.cycles.sort((a, b) => a.start.localeCompare(b.start));
  commit('meta'); potSheet(p.id, p.cycles.indexOf(item.cycle));
  toast(`${fmtDate(item.cycle.start, {month: 'short', year: 'numeric'})} cycle restored`);
}
function purgeCycleTrash() {
  const cut = Date.now() - TRASH_DAYS * 864e5; let changed = false;
  for (const p of (S.meta.savings || [])) if (p.trash && p.trash.length) { const keep = p.trash.filter(x => Date.parse(x.at) > cut); if (keep.length !== p.trash.length) { p.trash = keep; changed = true; } }
  if (changed) { dirty.add('meta'); saveLocal(); }
}
function importSavingsFile(d) {
  const add = (d.savings || []).filter(p => p && p.kind && p.name);
  if (!add.length) throw new Error('bad');
  const before = JSON.parse(JSON.stringify(pots()));
  add.forEach(p => { const i = pots().findIndex(x => x.id === p.id || x.name === p.name); if (i >= 0) pots()[i] = p; else pots().push(p); });
  closeSheet(); commit('meta'); showView('savings');
  toast(`Added ${add.map(p => p.name).join(', ')}`, () => { S.meta.savings = before; commit('meta'); });
}

/* ================= savings forecast ================= */
// td pots carry a plan: {amount, step (days between deposits), cycleDays, rate, cycles (how many ahead), rates: {start: rate}}
const defaultPlan = p => {
  const cs = p.cycles || [], last = cs[cs.length - 1], deps = last ? (last.deposits || []) : [];
  const amount = deps.length ? deps[deps.length - 1].a : 10000;
  return {amount, step: 15, cycleDays: p.cycleDays || 181, rate: p.rate, cycles: 6, rates: {}};
};
const planOf = p => Object.assign(defaultPlan(p), p.plan || {});
function tdForecast(p) {
  const cs = p.cycles || []; if (!cs.length) return [];
  const plan = planOf(p), out = [];
  let prev = tdCycle(p, cs[cs.length - 1]), start = prev.end, close = prev.closing;
  for (let i = 0; i < plan.cycles; i++) {
    const end = addDays(start, plan.cycleDays), deposits = [];
    for (let k = 1; k * plan.step < plan.cycleDays; k++) if (plan.amount > 0) deposits.push({id: 'f' + i + '-' + k, date: addDays(start, k * plan.step), a: plan.amount});
    const rate = plan.rates && plan.rates[i] != null ? plan.rates[i] : plan.rate;
    const c = {start, end, rate, carry: Math.round(close * 100) / 100, deposits}, cc = tdCycle(p, c);
    out.push({...c, i, own: plan.rates && plan.rates[i] != null, put: cc.principal - c.carry, interest: cc.interest, closing: cc.closing});
    close = cc.closing; start = end;
  }
  return out;
}
// value of one pot on a given date (interest of a time deposit counts when its cycle ends)
function potValueAt(p, d) {
  if (p.kind === 'td') {
    const all = [...(p.cycles || []), ...tdForecast(p)];
    if (!all.length) return 0;
    for (const c of all) { const end = c.end || addDays(c.start, p.cycleDays || 181); if (d >= c.start && d < end) return +c.carry + (c.deposits || []).filter(x => x.date <= d).reduce((s, x) => s + x.a, 0); }
    const last = all[all.length - 1]; if (d < all[0].start) return 0;
    const close = last.closing ?? tdCycle(p, last).closing, lastEnd = last.end || addDays(last.start, p.cycleDays || 181);
    const len = planOf(p).cycleDays || p.cycleDays || 181, rate = (last.rate ?? planOf(p).rate ?? p.rate ?? 0) * (1 - (p.tax ?? 0.2));
    const n = Math.floor(daysBetween(lastEnd, d) / len);          // whole cycles since, interest added at each maturity
    return close * Math.pow(1 + rate * len / 365, Math.max(0, n));
  }
  if (p.kind === 'mp2') {
    const m = mp2Calc(p); if (!m.maturity) return 0;
    if (d >= m.maturity) return m.atMaturity;
    const deps = (p.deposits || []).filter(x => x.date <= d).reduce((s, x) => s + x.a, 0);
    const divs = p.payout === 'annual' ? 0 : m.years.filter(r => `${r.y}-12-31` <= d).reduce((s, r) => s + r.div, 0);
    return deps + divs;
  }
  const b = basicCalc(p), t = todayIso(); if (d <= t) return b.now;
  return b.now * Math.pow(1 + (p.rate || 0) * (1 - (p.tax ?? 0.2)) / 365, daysBetween(t, d));
}
let fcYears = +(store.get('pera:fcYears') || 3);
function forecastHTML() {
  const ps = pots(); if (!ps.length) return '';
  const t = today(), months = fcYears * 12, pts = [];
  for (let k = 0; k <= months; k++) { const d = iso(new Date(t.getFullYear(), t.getMonth() + k + (k ? 1 : 0), k ? 0 : t.getDate())); pts.push({d, v: ps.reduce((s, p) => s + potValueAt(p, d), 0)}); }
  const yearEnds = []; for (let y = t.getFullYear(); y <= t.getFullYear() + fcYears; y++) { const d = `${y}-12-31`; if (d >= todayIso() && d <= pts[pts.length - 1].d) yearEnds.push({y, d, by: ps.map(p => ({p, v: potValueAt(p, d)})), v: ps.reduce((s, p) => s + potValueAt(p, d), 0)}); }
  const endV = pts[pts.length - 1].v, lastD = pts[pts.length - 1].d;
  if (!yearEnds.length || yearEnds[yearEnds.length - 1].d < lastD) yearEnds.push({y: fmtDate(lastD, {month: 'short', year: 'numeric'}), d: lastD, by: ps.map(p => ({p, v: potValueAt(p, lastD)})), v: endV});
  const ends = ps.filter(p => p.kind === 'td').map(p => { const f = tdForecast(p); return f.length ? f[f.length - 1].end : null; }).filter(Boolean).sort();
  const planEnd = ends.length ? ends[ends.length - 1] : null, showEnd = planEnd && planEnd < lastD;
  window.__fc = pts; window.__fcEnd = showEnd ? planEnd : null;
  const cols = ps.length > 1;
  return `<div class="card fccard"><div class="fchead"><div><div class="muted">Forecast · all savings</div><div class="serif" style="font-size:26px">${esc(peso(endV))}</div><div class="muted">by ${esc(fmtDate(lastD, {month: 'short', year: 'numeric'}))} if you keep your plans${showEnd ? `<br>Deposits planned until ${esc(fmtDate(planEnd, {month: 'short', year: 'numeric'}))}; after that it keeps earning interest` : ''}</div></div>
      <div class="seg fcseg">${[1, 2, 3, 5].map(n => `<button data-act="fc-years" data-n="${n}" aria-pressed="${n === fcYears}">${n}y</button>`).join('')}</div></div>
    <div class="fig" style="height:200px"><svg id="fcChart" role="img" aria-label="Forecast of total savings"></svg></div>
    <div class="tscroll"><table class="ytable"><thead><tr><th>End of</th>${cols ? ps.map(p => `<th>${esc(p.name.split(' ')[0])}</th>`).join('') : ''}<th>${cols ? 'Total' : esc(ps[0].name)}</th><th>Growth</th></tr></thead><tbody>
      ${yearEnds.map((r, k) => { const prevV = k ? yearEnds[k - 1].v : pts[0].v; return `<tr><td>${r.y}</td>${cols ? r.by.map(x => `<td>${esc(pesoS(x.v))}</td>`).join('') : ''}<td><b>${esc(pesoS(r.v))}</b></td><td class="up">+${esc(pesoS(r.v - prevV))}</td></tr>`; }).join('')}</tbody></table></div>
    <p class="muted">Uses each time deposit’s deposit plan, MP2’s planned contributions and current dividend rate, and savings-account interest. Tap an account to change its plan.</p></div>`;
}
function drawForecast() {
  const s = $('fcChart'); if (!s || !window.__fc) return; const W = s.clientWidth, H = s.clientHeight; if (!W) return;
  const pts = window.__fc, hi = Math.max(1, ...pts.map(p => p.v)) * 1.08, pl = 4, pr = 4, pt = 16, pb = 20;
  const X = i => pl + i * (W - pl - pr) / (pts.length - 1), Y = v => pt + (hi - v) * (H - pt - pb) / hi;
  const line = pts.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join('');
  const yrs = pts.map((p, i) => [p, i]).filter(([p], i) => i && p.d.slice(5, 7) === '01').map(([p, i]) => `<line x1="${X(i)}" x2="${X(i)}" y1="${pt}" y2="${H - pb}" stroke="var(--line)"/><text x="${X(i) + 3}" y="${H - 5}" font-size="11" fill="var(--mute)">${p.d.slice(0, 4)}</text>`).join('');
  s.innerHTML = `${yrs}<path d="${line}L${X(pts.length - 1)} ${H - pb}L${X(0)} ${H - pb}Z" fill="var(--blue)" opacity=".12"/><path d="${line}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${X(0)}" cy="${Y(pts[0].v)}" r="4" fill="var(--bg)" stroke="var(--blue)" stroke-width="2"/><text x="${X(0) + 8}" y="${Math.min(H - pb - 6, Y(pts[0].v) + 16)}" font-size="11" font-weight="600" fill="var(--ink)">Now</text>
    ${window.__fcEnd ? (() => { const i = pts.findIndex(p => p.d >= window.__fcEnd); if (i < 0) return ''; const x = X(i), right = x > W * 0.7; return `<line x1="${x}" x2="${x}" y1="${pt}" y2="${H - pb}" stroke="var(--mute)" stroke-dasharray="3 4"/><text x="${right ? x - 5 : x + 5}" y="${pt + 10}" text-anchor="${right ? 'end' : 'start'}" font-size="11" fill="var(--mute)">plan ends</text>`; })() : ''}`;
}
const fcRO = new ResizeObserver(drawForecast);
// forecast section inside a time-deposit sheet
function tdForecastHTML(p, fedit, frate) {
  const plan = planOf(p), fc = tdForecast(p), cs = p.cycles || [];
  const all = [...cs.map(c => ({start: c.start, end: tdCycle(p, c).end, closing: tdCycle(p, c).closing, actual: true})), ...fc];
  const max = Math.max(1, ...all.map(x => x.closing));
  return `<h2>Forecast</h2>
    ${fedit ? `<form id="planF" class="depedit" novalidate>
      <div class="two"><div><label for="plA">Deposit each time</label><input id="plA" inputmode="decimal" value="${esc(plan.amount)}"></div><div><label for="plS">Every (days)</label><input id="plS" inputmode="numeric" value="${esc(plan.step)}"></div></div>
      <div class="two"><div><label for="plR">Interest % for future cycles</label><input id="plR" inputmode="decimal" value="${(plan.rate * 100).toFixed(3).replace(/\.?0+$/, '')}"></div><div><label for="plD">Cycle length (days)</label><input id="plD" inputmode="numeric" value="${esc(plan.cycleDays)}"></div></div>
      <label for="plN">Cycles to forecast</label><select id="plN">${[1, 2, 3, 4, 6, 8, 10, 12].map(n => `<option ${n === plan.cycles ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <div class="two" style="margin-top:10px"><button type="button" class="plain" data-act="plan-cancel" style="margin:0">Cancel</button><button class="go" type="submit" style="margin:0">Save plan</button></div></form>`
    : `<button class="cycinfo" data-act="plan-edit" data-p="${esc(p.id)}"><span>Plan: <b>${esc(peso(plan.amount))}</b> every ${plan.step} days · <b>${pct(plan.rate)}</b> p.a. · ${plan.cycleDays}-day cycles · ${plan.cycles} cycles ahead</span><span class="ghost">Edit plan</span></button>`}
    <div class="ladder">${all.map(x => `<div class="r ${x.actual ? '' : 'f'}"><span>${esc(fmtDate(x.end, {month: 'short', year: 'numeric'}))}</span><i style="width:${(x.closing / max * 100).toFixed(1)}%"></i><span>${esc(pesoS(x.closing))}</span></div>`).join('')}</div>
    <p class="muted">Solid = your cycles, faded = forecast. Tap a forecast cycle to change just its rate.</p>
    <ul class="list deplist">${fc.map((c, i) => frate === i ? `<li class="editing"><form id="fcRateF" class="depedit" data-i="${i}" novalidate><label for="fcR">Interest % for the ${esc(fmtDate(c.start, {month: 'short', year: 'numeric'}))} cycle</label><input id="fcR" inputmode="decimal" value="${(c.rate * 100).toFixed(3).replace(/\.?0+$/, '')}">
      <div class="two" style="margin-top:8px"><button type="button" class="plain" data-act="${c.own ? 'fc-rate-reset' : 'fc-rate-cancel'}" data-i="${i}" style="margin:0">${c.own ? 'Use plan rate' : 'Cancel'}</button><button class="go" type="submit" style="margin:0">Save</button></div></form></li>` : `<li><button class="rowbtn depbtn" data-act="fc-rate" data-p="${esc(p.id)}" data-i="${i}"><span class="t">${esc(fmtDate(c.start, {month: 'short', year: 'numeric'}))} – ${esc(fmtDate(c.end, {month: 'short', year: 'numeric'}))}<small>${pct(c.rate)}${c.own ? ' (own rate)' : ''} · +${esc(peso(c.put))} put in · +${esc(peso(c.interest, 2))} interest</small></span><span class="amtcol"><b class="amt">${esc(peso(c.closing, 2))}</b><small>at maturity</small></span></button></li>`).join('')}</ul>`;
}

/* ================= insights (on Home) ================= */
// Categories come from each entry's description; entries without one (old spreadsheet rows) show as "No description".
const CATS = [
  ['Travel', /agoda|booking\.com|airasia|cebu ?pacific|philippine airlines|\bpal\b|klook|airbnb|hotel|lazada travel|traveloka|trip\.com/],
  ['Food & drinks', /jollibee|mcdo|mcdonald|food ?panda|fp\*|grab ?food|starbucks|kfc|chowking|mang inasal|greenwich|restaurant|resto|cafe|coffee|bakery|pizza|samgyup|milk ?tea|dunkin|krispy|shakey|max'?s|burger|bbq|lugaw|food/],
  ['Groceries', /supermarket|puregold|savemore|robinsons (super|easy)|grocery|waltermart|walter mart|landers|s&r|alfamart|7-?eleven|ministop|uncle john|mart\b/],
  ['Bills & PayLater', /spaylater|paylater|ggives|atome|home ?credit|billease|credit card|maya black|card payment|loan|amortization/],
  ['Utilities & load', /meralco|maynilad|manila water|pldt|globe|smart|converge|sky ?cable|dito|internet|wifi|postpaid|\bload\b|electric|water bill/],
  ['Subscriptions & games', /netflix|spotify|youtube|steam|playstation|psn|xbox|nintendo|apple\.com|itunes|google|disney|viu|hbo|chatgpt|openai|claude|anthropic|canva|icloud|prime video|game/],
  ['Transport', /\bgrab\b|angkas|joyride|move ?it|\blrt|\bmrt|beep|petron|shell|caltex|seaoil|cleanfuel|\bgas\b|toll|autosweep|easytrip|parking|taxi|bus\b|jeep/],
  ['Shopping', /shopee|lazada|zalora|uniqlo|\bh&m|sm store|\bmall\b|amazon|temu|shein|tiktok shop|decathlon|ikea|ace hardware|national book/],
  ['Health', /mercury drug|watsons|pharmacy|botika|hospital|clinic|dental|medical|lab test|doctor/],
  ['Fees & taxes', /withholding tax|tax withheld|service charge|bank fee|annual fee|transaction fee|convenience fee|penalty|late fee|\bfee\b|\bcharge\b/],
  ['Cash withdrawals', /\batm\b|withdraw/],
  ['Transfers', /sent to|transfer to|instapay|pesonet|send money|sent money|fund transfer/],
];
const CAT_NAMES = [...CATS.map(c => c[0]), 'Other'];
// the 7 categories that get their own colour, in the palette's slot order (checked for colour-blind separation);
// everything else shares the neutral "Other"
const CAT_SLOTS = ['Bills & PayLater', 'Food & drinks', 'Groceries', 'Utilities & load', 'Shopping', 'Transport', 'Subscriptions & games'];
const slotOf = c => CAT_SLOTS.indexOf(c);
const catCol = c => slotOf(c) >= 0 ? `var(--s${slotOf(c) + 1})` : c === 'No description' ? 'var(--s-none)' : 'var(--s-other)';
const catGroup = c => slotOf(c) >= 0 ? c : c === 'No description' ? 'No description' : 'Other';
// your own choices win: meta.catRules = {merchant: category}
const catOf = (n, bill) => {
  if (!n) return 'No description';
  const rules = S.meta.catRules || {}, m = merchantOf(n, bill); if (m && rules[m]) return rules[m];
  const s = n.toLowerCase(); const c = CATS.find(([, re]) => re.test(s)); return c ? c[0] : 'Other';
};
const isTransfer = (n, bill) => catOf(n, bill) === 'Transfers';
let insTr = store.get('pera:insTr') !== false;   // include transfers in spending? (on by default: money sent out is spent, except the part that went to savings)
const BRANDS = [['Shopee', /shopee/], ['Lazada Travel', /lazada travel/], ['Lazada', /lazada/], ['Food Panda', /food ?panda|fp\*/], ['Grab', /\bgrab/], ['Steam', /steam/], ['GCash', /gcash/],
  ['Netflix', /netflix/], ['Spotify', /spotify/], ['YouTube', /youtube/], ['Apple', /apple\.com|itunes/], ['Google', /google/], ['Jollibee', /jollibee/], ['McDonald’s', /mcdo|mcdonald/],
  ['Starbucks', /starbucks/], ['Meralco', /meralco/], ['Mercury Drug', /mercury drug/], ['Watsons', /watsons/], ['7-Eleven', /7-?eleven/], ['Puregold', /puregold/], ['SM Supermarket', /sm supermarket/], ['Angkas', /angkas/], ['Agoda', /agoda/]];
const merchantOf = (n, bill) => {
  if (!n) return null;
  if (bill) return n;                        // bills already have a clean name
  const lo = n.toLowerCase(), br = BRANDS.find(([, re]) => re.test(lo)); if (br) return br[0];
  let s = n.toLowerCase().replace(/^(visa|visae|mc|mastercard|pos purchase|pos|purchase|online purchase|payment to|payment)[-\s:*]*/i, '').replace(/^(wl|fp|sp)\s*\*/i, '');
  s = s.split(/[\s*_/]+/).filter(w => w && !/\d/.test(w) && !/^(ph|us|sg|hk|city|inc|corp|com|the|of|and|to|from)$/.test(w)).slice(0, 2).join(' ');
  if (!s) return null;
  return s.replace(/\b\w/g, c => c.toUpperCase()).replace(/\.Com\b/i, '.com');
};
let insP = store.get('pera:insP') || '3m', insYear = null;
function periodMonths(kind) {
  const t = today(), out = [];
  if (kind === 'month') out.push({y: String(t.getFullYear()), i: t.getMonth()});
  else if (kind === '3m') for (let k = 2; k >= 0; k--) { const d = new Date(t.getFullYear(), t.getMonth() - k, 1); out.push({y: String(d.getFullYear()), i: d.getMonth()}); }
  else { const y = kind === 'year' ? t.getFullYear() : t.getFullYear() - 1, last = kind === 'year' ? t.getMonth() : 11; for (let i = 0; i <= last; i++) out.push({y: String(y), i}); }
  return out.filter(m => S.years[m.y]);
}
function spendingIn(months) {
  const rows = [];
  for (const {y, i} of months) {
    const m = S.years[y][i];
    m.exp.forEach(x => rows.push({n: x.n || '', a: +x.a, y, i, c: x.c}));
    billsIn(y, i).forEach(b => rows.push({n: b.name, a: +b.a, y, i, bill: true}));
  }
  const out = rows.map(r => ({...r, cat: r.c && CAT_NAMES.includes(r.c) ? r.c : catOf(r.n, r.bill)}));
  for (const {y, i} of months) { const c = savedOut(y, i); if (c > 0) out.push({n: 'Moved to savings', a: -c, y, i, cat: 'Transfers', saved: true}); }
  return out;
}
// a month's income and spending as Insights counts them (transfers out unless switched on)
function monthFlows(y, i) {
  const m = S.years[y] && S.years[y][i]; if (!m) return {inc: 0, exp: 0, tin: 0, tout: 0};
  const sp = spendingIn([{y, i}]), tout = sp.filter(r => r.cat === 'Transfers').reduce((s, r) => s + r.a, 0);
  const tin = m.inc.filter(x => x.n && isTransfer(x.n)).reduce((s, x) => s + +x.a, 0);
  const inc = m.inc.reduce((s, x) => s + +x.a, 0), exp = sp.reduce((s, r) => s + r.a, 0);
  return insTr ? {inc, exp, tin, tout} : {inc: inc - tin, exp: exp - tout, tin, tout};
}
function catSheet(cat) {
  const rows = spendingIn(periodMonths(insP)).filter(r => r.cat === cat), by = {};
  rows.forEach(r => { const m = merchantOf(r.n, r.bill) || (r.n ? r.n : 'No description'); (by[m] = by[m] || {m, a: 0, c: 0, last: r}); by[m].a += r.a; by[m].c++; });
  const list = Object.values(by).sort((a, b) => b.a - a.a);
  openSheet(`<div class="sheethead"><h2>${esc(cat)}</h2><button class="ghost" data-act="close">Done</button></div>
    <p class="muted">${esc(peso(rows.reduce((s, r) => s + r.a, 0)))} · ${rows.length} payment${rows.length === 1 ? '' : 's'} in ${{month: 'this month', '3m': 'the last 3 months', year: 'this year', lastyear: 'last year'}[insP]}${cat === 'No description' ? '. Add a note to these entries in Months to sort them.' : '. Tap a merchant to move it to another category.'}</p>
    <ul class="list">${list.map(x => `<li><button class="rowbtn" ${cat === 'No description' ? 'disabled' : `data-act="cat-pick" data-m="${esc(x.m)}" data-c="${esc(cat)}"`}><span class="t">${esc(x.m)}<small>${x.c} time${x.c === 1 ? '' : 's'}${(S.meta.catRules || {})[x.m] ? ' · your choice' : ''}</small></span><b class="amt">${esc(peso(x.a))}</b></button></li>`).join('')}</ul>`);
}
function catPick(m, from) {
  const rules = S.meta.catRules || {};
  openSheet(`<div class="sheethead"><h2>${esc(m)}</h2><button class="ghost" data-act="ins-cat" data-c="${esc(from)}">Back</button></div>
    <p class="muted">Which category should ${esc(m)} be in? Pera will remember this for all its payments.</p>
    <div class="chips catpick">${CAT_NAMES.map(c => `<button class="chip" data-act="cat-set" data-m="${esc(m)}" data-c="${esc(c)}" aria-pressed="${c === from}">${esc(c)}</button>`).join('')}</div>
    ${rules[m] ? `<button class="plain" data-act="cat-set" data-m="${esc(m)}" data-c="">Go back to automatic</button>` : ''}`);
}
function renderInsights(ser) {
  const box = $('insights'); if (!box) return;
  if (!Object.keys(S.years).length) { box.innerHTML = ''; return; }
  const months = periodMonths(insP), allRows = spendingIn(months), rows = insTr ? allRows : allRows.filter(r => r.cat !== 'Transfers'), total = rows.reduce((s, r) => s + r.a, 0);
  const moved = allRows.filter(r => r.cat === 'Transfers').reduce((s, r) => s + r.a, 0);
  const pLabel = {month: 'this month', '3m': 'the last 3 months', year: 'this year', lastyear: 'last year'}[insP];
  // 1 — where the money goes
  const byCat = {}; rows.forEach(r => { byCat[r.cat] = (byCat[r.cat] || 0) + r.a; });
  const cats = Object.entries(byCat).filter(([, v]) => v > 0.004).sort((a, b) => b[1] - a[1]);
  const maxC = Math.max(1, ...cats.map(c => c[1]));
  const noDesc = byCat['No description'] || 0;
  // 2 — month vs month (last 6 months up to now)
  const t = today(), last6 = [];
  for (let k = 5; k >= 0; k--) { const d = new Date(t.getFullYear(), t.getMonth() - k, 1); const p = ser.find(q => +q.y === d.getFullYear() && q.i === d.getMonth()); if (p) last6.push({...p, ...monthFlows(p.y, p.i)}); }
  const maxM = Math.max(1, ...last6.flatMap(p => [p.inc, p.exp]));
  const avgExp = last6.length ? last6.reduce((s, p) => s + p.exp, 0) / last6.length : 0;
  // 3 — top merchants
  const byM = {}; rows.forEach(r => { const m = merchantOf(r.n, r.bill); if (!m || r.cat === 'Transfers') return; (byM[m] = byM[m] || {n: m, a: 0, c: 0}); byM[m].a += r.a; byM[m].c++; });
  const merch = Object.values(byM).filter(m => m.a > 0).sort((a, b) => b.a - a.a).slice(0, 8);
  // 4 — year in review
  const ys = Object.keys(S.years).sort(); if (!insYear || !S.years[insYear]) insYear = ys.includes(String(t.getFullYear())) ? String(t.getFullYear()) : ys[ys.length - 1];
  const yr = ser.filter(p => p.y === insYear && p.past).map(p => ({...p, ...monthFlows(p.y, p.i)})), yInc = yr.reduce((s, p) => s + p.inc, 0), yExp = yr.reduce((s, p) => s + p.exp, 0), ySav = yr.reduce((s, p) => s + p.sav, 0);
  const yEnd = +insYear === t.getFullYear() ? todayIso() : `${insYear}-12-31`, yStart = `${+insYear - 1}-12-31`;
  const potGrow = pots().reduce((s, p) => s + potValueAt(p, yEnd) - potValueAt(p, yStart), 0);
  const big = [...yr].sort((a, b) => b.exp - a.exp)[0], best = [...yr].sort((a, b) => (b.inc - b.exp) - (a.inc - a.exp))[0];
  const yRows = spendingIn(yr.map(p => ({y: p.y, i: p.i})));
  const yCat = {}; yRows.forEach(r => { const c = r.cat; if (c !== 'No description' && (insTr || c !== 'Transfers')) yCat[c] = (yCat[c] || 0) + r.a; });
  const topCat = Object.entries(yCat).sort((a, b) => b[1] - a[1])[0];
  const yM = {}; yRows.forEach(r => { const m = merchantOf(r.n, r.bill); if (m && r.cat !== 'Transfers') yM[m] = (yM[m] || 0) + r.a; });
  const topM = Object.entries(yM).sort((a, b) => b[1] - a[1])[0];
  const rate = (inc, exp) => inc > 0 ? Math.round((inc - exp) / inc * 100) : null;

  box.innerHTML = `<div class="inshead"><h2>Insights</h2><div class="seg insseg">${[['month', 'This month'], ['3m', '3 months'], ['year', 'This year'], ['lastyear', 'Last year']].map(([k, l]) => `<button data-act="ins-p" data-k="${k}" aria-pressed="${k === insP}">${l}</button>`).join('')}</div></div>
  <button class="aibar" data-act="sort-spend"><span class="sparkic">${SPARK}</span><span>Sort my spending<small>AI sorts bank text and catches entries in the wrong category</small></span><span class="chev">›</span></button>
  <div class="reports">${REPORTS.map(([k, l, ic]) => `<button class="repbtn" data-act="report" data-r="${k}"><span class="repic" aria-hidden="true">${ic}</span>${l}</button>`).join('')}</div>
  <div class="insgrid">
    <section class="card inscard"><div class="inshead"><h3>Where your money goes</h3><button class="chip trchip" data-act="ins-tr" aria-pressed="${insTr}">${insTr ? '✓ ' : ''}Include transfers</button></div>
      <p class="muted">${esc(peso(total))} spent in ${pLabel}${!insTr && moved ? ` · ${esc(peso(moved))} in transfers not counted` : ''}${(sv => sv ? ` · ${esc(peso(sv))} moved to savings not counted` : '')(-allRows.filter(r => r.saved).reduce((s, r) => s + r.a, 0))}</p>
      ${cats.length ? `<div class="catrows">${cats.map(([c, v]) => `<button class="cr" data-act="ins-cat" data-c="${esc(c)}" style="--c:${catCol(c)}"><span><b class="catdot"></b>${esc(c)}</span><i><b style="width:${(v / maxC * 100).toFixed(1)}%"></b></i><span>${esc(pesoS(v))}<small>${total ? Math.round(v / total * 100) : 0}%</small></span></button>`).join('')}</div>
      <p class="muted">Tap a category to see what’s in it and move merchants to the right one.</p>` : '<p class="empty">No spending in this period.</p>'}
      ${noDesc > 0 ? `<p class="muted">“No description” is spending without a note, mostly from your spreadsheet. Imported statements and new entries are sorted automatically.</p>` : ''}</section>
    <section class="card inscard"><h3>Month vs month</h3><p class="muted">Average spending ${esc(peso(avgExp))} a month</p>
      <div class="mvm">${last6.map((p, k) => { const prev = last6[k - 1], ch = prev && prev.exp ? Math.round((p.exp - prev.exp) / prev.exp * 100) : null, r = rate(p.inc, p.exp);
        return `<div class="mrow2"><span class="ml">${M[p.i].slice(0, 3)}${p.past ? '' : '<small>plan</small>'}</span><span class="mbars"><i class="bi" style="width:${(p.inc / maxM * 100).toFixed(1)}%"></i><i class="be" style="width:${(p.exp / maxM * 100).toFixed(1)}%"></i></span>
          <span class="mv"><b class="up">+${esc(pesoS(p.inc))}</b><b class="dn">−${esc(pesoS(p.exp))}</b></span><span class="mr2">${r == null ? '—' : r < 0 ? `<span class="dn">overspent ${esc(pesoS(p.exp - p.inc))}</span>` : r + '% kept'}${ch == null ? '' : ch === 0 ? '<small>same spending</small>' : `<small class="${ch > 0 ? 'dn' : 'up'}">${ch > 0 ? '▲' : '▼'} ${Math.abs(ch)}% spent</small>`}</span></div>`; }).join('')}</div>
      <p class="muted"><i class="key bi"></i> income · <i class="key be"></i> spent · “kept” = share of income not spent${insTr ? '' : ' · transfers between your accounts left out'}</p></section>
    <section class="card inscard"><h3>Top merchants</h3><p class="muted">${pLabel[0].toUpperCase() + pLabel.slice(1)}, transfers left out</p>
      ${merch.length ? `<ol class="mlist">${merch.map(m => `<li><span>${esc(m.n)}<small>${m.c} time${m.c === 1 ? '' : 's'}</small></span><b>${esc(peso(m.a))}</b></li>`).join('')}</ol>` : '<p class="empty">No merchants yet. They come from descriptions in imported statements and new entries.</p>'}</section>
    <section class="card inscard"><div class="inshead"><h3>Year in review</h3><div class="seg insseg">${ys.map(y => `<button data-act="ins-y" data-y="${esc(y)}" aria-pressed="${y === insYear}">${esc(y)}</button>`).join('')}</div></div>
      ${yr.length ? `<div class="yrgrid">
        <div><span>Earned</span><b class="up">${esc(pesoS(yInc))}</b></div><div><span>Spent</span><b class="dn">${esc(pesoS(yExp))}</b></div>
        <div><span>${yInc - yExp < 0 ? 'Overspent' : 'Kept'}</span><b class="${yInc - yExp < 0 ? 'dn' : ''}">${esc(pesoS(Math.abs(yInc - yExp)))}</b><small>${yInc - yExp < 0 ? 'more than you earned' : (rate(yInc, yExp) ?? '—') + '% of income'}</small></div><div><span>Saved</span><b>${esc(pesoS(ySav))}</b></div>
        <div><span>Savings grew</span><b class="up">${potGrow >= 0 ? '+' : '−'}${esc(pesoS(Math.abs(potGrow)))}</b><small>all accounts</small></div><div><span>Avg spent / month</span><b>${esc(pesoS(yExp / yr.length))}</b></div></div>
        <ul class="yrfacts">
          ${big ? `<li>Biggest spending month: <b>${M[big.i]}</b> (${esc(peso(big.exp))})</li>` : ''}
          ${best ? `<li>Best month: <b>${M[best.i]}</b>, kept ${esc(peso(best.inc - best.exp))}</li>` : ''}
          ${topCat ? `<li>Top category: <b>${esc(topCat[0])}</b> (${esc(peso(topCat[1]))})</li>` : ''}
          ${topM ? `<li>Top merchant: <b>${esc(topM[0])}</b> (${esc(peso(topM[1]))})</li>` : ''}
        </ul>${+insYear === t.getFullYear() ? '<p class="muted">So far this year.</p>' : ''}` : '<p class="empty">No months recorded yet for this year.</p>'}</section>
  </div>`;
}

/* ================= Pera AI (Gemini, through the "pera-ai" Supabase function; the key never touches this device) ================= */
const AI_MS = 60000;
let aiOk = store.get('pera:aiOk');   // null = unknown, true = worked before, false = not set up
const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
function aiError(msg, status) {
  if (/overloaded|unavailable|503/i.test(msg)) return 'Gemini is busy right now (Google’s servers are overloaded). Tap Try again in a moment.';
  if (/exhausted|quota|rate limit|429/i.test(msg)) return 'Gemini’s free limit is used up for now. Try again in a minute, or tomorrow if it’s the daily limit.';
  if (status === 404 || /requested function was not found|function not found/i.test(msg)) { aiOk = false; store.set('pera:aiOk', false); return 'Pera AI isn’t set up yet. See Settings → Pera AI.'; }
  return msg;
}
/* ---- AI queue: one request at a time, a short gap between them (free-tier limits),
   and automatic retries when Gemini is busy, rate-limited or the phone is offline ---- */
const AIQ = [], AI_GAP = 1500, AI_BACKOFF = [5, 15, 30, 60, 60];
let aiqBusy = false, aiqLast = 0, aiqTimer = null;
const retryable = m => /busy|free limit|took too long|couldn’t reach|offline|didn’t answer/i.test(m || '');
function aiQueue(label, run, onState = () => {}) {
  return new Promise((resolve, reject) => { AIQ.push({label, run, onState, tries: 0, waitUntil: 0, resolve, reject}); aiqNotify(); aiqPump(); });
}
function aiqNotify() {
  AIQ.forEach((j, k) => {
    if (j.running) return;
    if (j.waitUntil > Date.now()) j.onState({state: 'retry', secs: Math.ceil((j.waitUntil - Date.now()) / 1000), msg: j.lastMsg, tries: j.tries});
    else if (!navigator.onLine) j.onState({state: 'offline'});
    else j.onState({state: 'queued', ahead: AIQ.slice(0, k).length});
  });
}
async function aiqPump() {
  clearTimeout(aiqTimer);
  if (aiqBusy || !AIQ.length) return;
  const now = Date.now(), job = AIQ.find(j => j.waitUntil <= now);
  if (!job) { aiqTimer = setTimeout(aiqPump, Math.min(...AIQ.map(j => j.waitUntil)) - now); return; }
  if (!navigator.onLine) { aiqNotify(); return; }   // the 'online' event starts it again
  const gap = aiqLast + AI_GAP - now; if (gap > 0) { aiqTimer = setTimeout(aiqPump, gap); return; }
  aiqBusy = true; job.running = true; aiqLast = Date.now(); job.onState({state: 'running'});
  try { const v = await job.run(job); AIQ.splice(AIQ.indexOf(job), 1); job.resolve(v); }
  catch (e) {
    job.running = false;
    if (retryable(e.message) && !job.partial && job.tries < AI_BACKOFF.length) { job.lastMsg = e.message; job.waitUntil = Date.now() + AI_BACKOFF[job.tries++] * 1000; }
    else { AIQ.splice(AIQ.indexOf(job), 1); job.reject(e); }
  }
  aiqBusy = false; aiqNotify(); aiqPump();
}
addEventListener('online', () => { aiqNotify(); aiqPump(); });
addEventListener('offline', aiqNotify);
setInterval(() => { if (AIQ.some(j => !j.running && j.waitUntil > Date.now())) aiqNotify(); }, 1000);   // countdowns
// a line of status text for a waiting request
function aiqText(st) {
  if (!st) return '';
  if (st.state === 'offline') return 'Waiting for internet… it’ll continue when you’re back online.';
  if (st.state === 'retry') return `${/free limit/i.test(st.msg) ? 'Gemini’s free limit is reached' : 'Gemini is busy'} · trying again in ${st.secs}s (try ${st.tries + 1} of ${AI_BACKOFF.length + 1})`;
  if (st.state === 'queued' && st.ahead) return `Waiting in line (${st.ahead} ahead)…`;
  return '';
}
// fingerprint of the numbers the AI sees, so a write-up can tell when it's outdated (the date line is left out)
let fpCache = {v: -1, fp: ''};
function dataFP() {
  if (fpCache.v !== dataVer) { const t = aiContext().split('\n').slice(1).join('\n').toLowerCase(); let h = 5381; for (let k = 0; k < t.length; k++) h = ((h << 5) + h + t.charCodeAt(k)) | 0; fpCache = {v: dataVer, fp: (h >>> 0).toString(36)}; }
  return fpCache.fp;
}
// streamed answer: calls onText(textSoFar) as words arrive; works with the older non-streaming function too
async function aiStream(task, payload, onText) {
  if (!sb || !user) throw new Error('Sign in first.');
  if (!navigator.onLine) throw new Error('You’re offline. Pera AI needs the internet.');
  const {data: {session}} = await sb.auth.getSession();
  if (!session) throw new Error('Sign in first.');
  const ctl = new AbortController(); let timer = setTimeout(() => ctl.abort(), 90000);   // first words within 90 s (Gemini can think a while)
  let r;
  try {
    r = await fetch(`${cfg.supabaseUrl}/functions/v1/pera-ai`, {method: 'POST', signal: ctl.signal,
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: cfg.supabaseAnonKey},
      body: JSON.stringify({task, stream: true, ...payload})});
  } catch (e) { clearTimeout(timer); throw new Error(e.name === 'AbortError' ? 'The AI took too long. Try again.' : 'Couldn’t reach Pera AI. Check your connection.'); }
  if (!r.ok) { clearTimeout(timer); let msg = `Pera AI error (${r.status})`; try { const j = await r.json(); msg = j.error || j.message || msg; } catch {} throw new Error(aiError(msg, r.status)); }
  if (/json/i.test(r.headers.get('content-type') || '')) { clearTimeout(timer); const j = await r.json(); if (j.error) throw new Error(aiError(j.error)); aiOk = true; store.set('pera:aiOk', true); onText(j.text || ''); return j.text || ''; }
  const reader = r.body.getReader(), dec = new TextDecoder(); let text = '';
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 30000);   // keep going while words keep coming
      text += dec.decode(value, {stream: true}); onText(text);
    }
  } catch (e) { if (!text) throw new Error('The AI took too long. Try again.'); }
  finally { clearTimeout(timer); }
  const cut = /\n?\[\[cut:[A-Z_]*\]\]\s*$/.test(text) || looksCut(text);
  text = text.replace(/\n?\[\[cut:[A-Z_]*\]\]\s*$/, '');
  if (!text.trim()) throw new Error('The AI didn’t answer. Try again.');
  aiOk = true; store.set('pera:aiOk', true);
  aiStream.cut = cut;   // read right after the call (requests run one at a time)
  return text;
}
// an answer that stops mid-sentence ("…due on June 16, 20"): no closing punctuation, or it ends inside a number or bold
function looksCut(t) {
  const s = t.replace(/\n?\s*>>.*$/s, '').trimEnd(); if (!s) return false;
  if ((s.match(/\*\*/g) || []).length % 2) return true;
  return !/[.!?)”"’*:%]$/.test(s) && !/^\s*(?:[-*•]|\d+[.)])\s/.test(s.split('\n').pop());
}
async function ai(task, payload) {
  if (!sb || !user) throw new Error('Sign in first.');
  if (!navigator.onLine) throw new Error('You’re offline. Pera AI needs the internet.');
  let res;
  try { res = await Promise.race([sb.functions.invoke('pera-ai', {body: {task, ...payload}}), new Promise((_, rej) => setTimeout(() => rej(new Error('The AI took too long. Try again.')), AI_MS))]); }
  catch (e) { throw e; }
  const {data, error} = res;
  if (error) {
    let msg = error.message || 'Pera AI didn’t answer.';
    const status = error.context && error.context.status;
    try { const j = await error.context.json(); if (j && (j.error || j.message)) msg = j.error || j.message; } catch {}
    throw new Error(aiError(msg, status));
  }
  if (data && data.error) throw new Error(data.error);
  aiOk = true; store.set('pera:aiOk', true);
  return data.text || '';
}
const aiJSON = async (task, payload) => { const t = await ai(task, {...payload, json: true}); try { return JSON.parse(t); } catch { const m = t.match(/[\[{][\s\S]*[\]}]/); if (m) return JSON.parse(m[0]); throw new Error('The AI answer couldn’t be read. Try again.'); } };
// plain text from the AI → safe HTML (escape first, then **bold**, bullet lines, paragraphs)
function aiHTML(t) {
  const lines = esc(String(t).trim()).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>').split(/\n/);
  let h = '', inList = false;
  for (const l of lines) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)/.exec(l);
    if (m) { if (!inList) { h += '<ul>'; inList = true; } h += `<li>${m[1]}</li>`; continue; }
    if (inList) { h += '</ul>'; inList = false; }
    if (l.trim()) h += `<p>${l.replace(/^#+\s*/, '')}</p>`;
  }
  return h + (inList ? '</ul>' : '');
}
// what the AI is told about your money: compact lines, numbers already worked out by Pera
function aiContext(opts = {}) {
  const t = today(), ser = series().filter(p => p.inc || p.exp), L = [];
  L.push(`Today: ${todayIso()} (${t.toLocaleDateString('en-PH', {weekday: 'long'})}). Currency: Philippine peso (₱). Paid on the 15th and 30th; ${payCut() ? `bills due on the ${ord(payCut())} or later count in their own month, earlier ones in the month before` : 'bills count in the month before they are due'}.`);
  L.push('Months (income | spent incl. bills, not counting money moved to savings | saved | total money at month end):');
  ser.slice(-18).forEach(p => L.push(`${p.y}-${String(p.i + 1).padStart(2, '0')}${p.now ? ' (this month, so far)' : p.past ? '' : ' (planned)'}: ${Math.round(p.inc)} | ${Math.round(p.spent)} | ${Math.round(p.sav)} | ${Math.round(p.total)}`));
  L.push('Spending by category per month (transfers between own accounts left out):');
  lastMonths(6).forEach(m => { const by = {}; spendingIn([m]).forEach(r => { if (r.cat !== 'Transfers') by[r.cat] = (by[r.cat] || 0) + r.a; }); L.push(`${m.y}-${String(m.i + 1).padStart(2, '0')}: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${Math.round(v)}`).join(', ') || 'none'}`); });
  // bills: exact totals worked out here so the AI doesn't add them up itself, plus which payday pays each one
  const un = (S.meta.bills || []).filter(b => !b.paid && b.due).sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name) || a.a - b.a), ymS = m => `${m.y}-${String(m.i + 1).padStart(2, '0')}`;
  const payFrom = due => { const d = new Date(due + 'T00:00'), y = d.getFullYear(), mo = d.getMonth(), last = new Date(y, mo + 1, 0).getDate(), p30 = Math.min(30, last);
    const pick = d.getDate() >= p30 ? new Date(y, mo, p30) : d.getDate() >= 15 ? new Date(y, mo, 15) : new Date(y, mo, Math.min(30, new Date(y, mo, 0).getDate()) - new Date(y, mo, 0).getDate()) ;
    return `${pick.getFullYear()}-${String(pick.getMonth() + 1).padStart(2, '0')}-${String(pick.getDate()).padStart(2, '0')}`; };
  if (un.length) {
    const byM = {}, byPay = {}; un.forEach(b => { const k = ymS(billMonth(b.due)), pf = payFrom(b.due); byM[k] = (byM[k] || 0) + +b.a; byPay[pf] = (byPay[pf] || 0) + +b.a; });
    L.push(`Unpaid bills total (exact, use as is): ${(un.reduce((t, b) => t + +b.a, 0)).toFixed(2)} across ${un.length} payments, last one due ${un[un.length - 1].due}.`);
    L.push(`Unpaid bills by the month they count in: ${Object.entries(byM).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('; ')}`);
    L.push(`Unpaid bills by the payday that pays them (the last payday on or before the due date): ${Object.entries(byPay).map(([k, v]) => `${k} payday ${v.toFixed(2)}`).join('; ')}`);
  }
  L.push(`Unpaid bills: ${un.length ? un.map(b => `${b.name} ${(+b.a).toFixed(2)} due ${b.due}${b.due < todayIso() ? ' (overdue)' : ''} (counts in ${ymS(billMonth(b.due))}, paid from the ${payFrom(b.due)} payday)`).join('; ') : 'none'}`);
  const ps = pots(); if (ps.length) L.push(`Savings accounts: ${ps.map(p => `${p.name} (${p.kind === 'td' ? 'time deposit' : p.kind === 'mp2' ? 'Pag-IBIG MP2' : 'savings account'}) ${Math.round(potNow(p))} now, ${(netRate(p) * 100).toFixed(2)}%/yr after tax`).join('; ')}`);
  const gs = goals(); if (gs.length) L.push(`Goals: ${gs.map(g => { const c = goalCalc(g); return `${g.name}: ${Math.round(c.cur)} of ${Math.round(c.target)}${g.by ? `, wants it by ${g.by} (needs ${Math.round(c.need || 0)}/month)` : ''}`; }).join('; ')}`);
  const h = habits(); if (h.n) L.push(`Last ${h.n} finished months on average: saved ${Math.round(h.save)}/month, left over after spending and saving ${Math.round(h.left)}/month.`);
  if (opts.entries) {
    L.push('Individual entries, newest first (date | type | note | amount | category):'); let n = 0;
    outer: for (const m of lastMonths(opts.months || 4).reverse()) { const mo = S.years[m.y][m.i];
      const rows = [...mo.exp.map(x => ['out', x]), ...mo.inc.map(x => ['in', x])].sort((a, b) => (b[1].d || '').localeCompare(a[1].d || ''));
      for (const [k, x] of rows) { L.push(`${x.d || `${m.y}-${String(m.i + 1).padStart(2, '0')} (no exact day)`} | ${k} | ${x.n || 'no note'} | ${(+x.a).toFixed(2)} | ${k === 'out' ? (x.c || catOf(x.n || '')) : 'income'}`); if (++n >= 700) break outer; } }
  }
  return L.join('\n');
}
const AI_RULES = 'You are Pera, a friendly money helper inside a personal finance app for someone in the Philippines. Use only the data given; when it doesn’t cover something, say so plainly. Show peso amounts like ₱1,234. Be brief and concrete: lead with the answer, then a few short lines or bullets. "No description" means spending recorded without a note, mostly from an old spreadsheet. Only when the person asks about investing, taxes or legal matters, give general information and suggest checking with a licensed professional; never add that note otherwise.';
const FOLLOW_RULE = '\n\nAfter the answer, on its own last line, write ">>" followed by 2 or 3 short follow-up questions the person might tap next, in their voice, separated by " | " (each under 45 characters, about their own money, answerable from the data). Example: >> How much should I save each payday? | What if I save ₱25,000 a month?';
// split an answer into the text to show and the follow-up suggestions (also hides a half-written ">>" line while streaming)
function splitFollow(t) {
  t = t.replace(/\n?\[\[cut[^\]]*\]?\]?\s*$/, '');
  const k = t.search(/\n?\s*>>/); if (k < 0) return {text: t.replace(/\n\s*>?\s*$/, ''), sugg: []};
  return {text: t.slice(0, k).trimEnd(), sugg: t.slice(k).replace(/^\s*>>\s*/, '').split('|').map(x => x.trim().replace(/^["“]|["”]$/g, '')).filter(x => x && x.length < 70).slice(0, 3)};
}
// a peso amount in what the person typed (500k, ₱1.2m, 250,000)
function amtIn(q) {
  const m = /(?:₱|php|p)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\b/i.exec(q); if (!m) return 0;
  const v = parseFloat(m[1].replace(/,/g, '')) * ({k: 1e3, thousand: 1e3, m: 1e6, million: 1e6}[(m[2] || '').toLowerCase()] || 1);
  return v >= 1000 ? Math.round(v) : 0;
}
// starter questions that fit the data (no goal yet → ask about one)
function starterQs() {
  const last = lastMonths(2)[0], mn = last ? new Date(last.y, last.i).toLocaleDateString('en-PH', {month: 'long'}) : 'last month';
  const top = last ? Object.entries(spendingIn([last]).reduce((o, r) => (!['Transfers', 'Other', 'No description'].includes(r.cat) && (o[r.cat] = (o[r.cat] || 0) + r.a), o), {})).sort((a, b) => b[1] - a[1])[0] : null;
  return [top ? `How much did I spend on ${top[0].toLowerCase()} in ${mn}?` : 'How much did I spend last month?', 'Where can I cut back?',
    goals().length ? `When will I reach ${goals()[0].name}?` : 'How long to save ₱500,000?', (S.meta.bills || []).some(b => !b.paid) ? 'What bills are coming up?' : 'How much can I save each payday?'];
}

/* ---- Ask Pera: chat about your money ---- */
let chat = [];
function askSheet() {
  openSheet(`<div class="sheethead"><h2>Ask Pera</h2><button type="button" class="ghost" data-act="close">Done</button></div>
    <div class="chat" id="chatLog" aria-live="polite">${chat.length ? '' : `<p class="muted">Ask anything about your money. Pera sends a summary of your numbers to Google Gemini to answer.</p>`}</div>
    <div class="chips aisugg" id="chatSugg"></div>
    <form id="chatF" class="chatf" novalidate><input id="chatQ" autocomplete="off" enterkeyhint="send" placeholder="Ask about your money…" aria-label="Your question"><button class="go" type="submit" aria-label="Send">${SPARK}</button></form>`);
  $('sheet').classList.add('tall'); paintChat();
  $('chatF').addEventListener('submit', e => { e.preventDefault(); const q = $('chatQ').value.trim(); if (q) { $('chatQ').value = ''; askPera(q); } });
  setTimeout(() => $('chatQ') && $('chatQ').focus(), 80);
}
let chatBusy = 0, chatTick = null, chatState = null;
const ASKC = 'pera:askCache', askKey = q => q.toLowerCase().replace(/[^a-z0-9₱]+/g, ' ').trim() + '|' + dataFP();
function paintChat(thinking) {
  const log = $('chatLog'); if (!log) return;
  const secs = chatBusy ? Math.round((Date.now() - chatBusy) / 1000) : 0;
  if (chat.length) log.innerHTML = chat.map((m, k) => m.role === 'user' ? `<div class="msg me">${esc(m.text)}</div>`
    : `<div class="msg ai${m.err ? ' err' : ''}">${m.err ? `${esc(m.text)}${k === chat.length - 1 && !chatBusy ? '<br><button class="retry" data-act="ask-retry">Try again</button>' : ''}` : aiHTML(splitFollow(m.text).text)}${m.cached && k === chat.length - 1 ? `<p class="cachednote">Saved answer · your numbers haven’t changed since. <button class="linkbtn" data-act="ask-fresh">Ask again</button></p>` : ''}</div>`).join('')
    + (thinking ? `<div class="msg ai thinking"><i></i><i></i><i></i>${aiqText(chatState) ? `<span>${esc(aiqText(chatState))}</span>` : secs >= 4 ? `<span>Thinking… ${secs}s</span>` : ''}</div>` : '');
  const sg = $('chatSugg');
  if (sg) {
    const last = chat[chat.length - 1], busy = thinking || chatBusy || (last && last.live);
    let qs = [], extra = '';
    if (!chat.length) qs = starterQs();
    else if (!busy && last.role === 'model' && !last.err) {
      qs = splitFollow(last.text).sugg;
      // they named a target and have no goal for it → offer to save it
      const amt = [...chat].reverse().filter(m => m.role === 'user').slice(0, 2).map(m => amtIn(m.text)).find(Boolean);
      if (amt && /goal|reach|save|saving|target/i.test(chat.map(m => m.text).join(' ')) && !goals().some(g => Math.abs(+g.target - amt) < 1))
        extra = `<button class="chip act" data-act="ask-goal" data-a="${amt}">＋ Save ${esc(peso(amt))} as a goal</button>`;
    }
    sg.innerHTML = extra + qs.map(q => `<button class="chip" data-act="ask-q" data-q="${esc(q)}">${esc(q)}</button>`).join('');
  }
  log.scrollIntoView({block: 'end'}); $('sheet').scrollTop = $('sheet').scrollHeight;
}
async function askPera(q, again, fresh) {
  if (chatBusy) return;
  if (!again) chat.push({role: 'user', text: q});
  // the same first question with unchanged numbers: show the saved answer instantly
  const first = chat.filter(m => m.role === 'user').length === 1, ck = askKey(q), cache = store.get(ASKC) || {};
  if (first && !fresh && cache[ck]) { chat.push({role: 'model', text: cache[ck].text, cached: true}); paintChat(); return; }
  chatBusy = Date.now(); paintChat(true);
  clearInterval(chatTick); chatTick = setInterval(() => { if (chatBusy && !chat.some(m => m.live)) paintChat(true); }, 1000);
  const needRows = /\b(spent|spend|spending|bought|paid|grab|jollibee|shopee|lazada|food|transaction|entry|entries|where|which|list|biggest|most|cut|save|saving|savings|improve)/i.test(q);
  const msgs = chat.filter(m => !m.err).slice(-12).map(m => ({role: m.role, text: m.text})), live = {role: 'model', text: '', live: true};
  try {
    const text = await aiQueue('Ask Pera', job => aiStream('ask', {system: AI_RULES + FOLLOW_RULE + '\n\nThe person’s data:\n' + aiContext({entries: needRows}), messages: msgs, maxTokens: 3000, think: 'low'}, t => {
      job.partial = true; chatState = null;
      if (!chat.includes(live)) chat.push(live);
      live.text = t; paintChat();
    }), st => { chatState = st; if (!chat.includes(live)) paintChat(true); });
    const cut = aiStream.cut; live.text = text;
    if (cut) live.text = splitFollow(text).text + '\n\n*(Cut off. Tap Ask again or rephrase.)*';
    if (first && !cut) { const c = store.get(ASKC) || {}; c[ck] = {text, at: Date.now()}; const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at); keys.slice(30).forEach(k => delete c[k]); store.set(ASKC, c); }
  } catch (e) { if (chat.includes(live) && live.text) live.text += '\n\n(cut off — try again)'; else chat.push({role: 'model', text: e.message, err: true}); }
  delete live.live; chatBusy = 0; chatState = null; clearInterval(chatTick); paintChat();
}

/* ---- Sort my spending: the AI suggests categories for bank text it can't place; you approve ---- */
let sortSug = null;
async function sortSpending() {
  // every distinct note with its current category: unplaced ones to sort, placed ones to double-check
  const by = {};
  for (const y of Object.keys(S.years)) S.years[y].forEach(m => m.exp.forEach(x => {
    if (!x.n || +x.a < 0) return; const k = x.n.trim(), c = x.c || catOf(x.n); if (c === 'No description') return;
    const e = by[k] = by[k] || {note: k, n: 0, sum: 0, cats: {}}; e.n++; e.sum += +x.a; e.cats[c] = (e.cats[c] || 0) + 1;
  }));
  const all = Object.values(by).map(e => ({...e, cur: Object.entries(e.cats).sort((a, b) => b[1] - a[1])[0][0]}));
  const unplaced = all.filter(e => e.cur === 'Other').sort((a, b) => b.n - a.n).slice(0, 120);
  const placed = all.filter(e => e.cur !== 'Other').sort((a, b) => b.sum - a.sum).slice(0, 200);   // the ones that move the most money
  const items = [...unplaced, ...placed];
  const nod = spendingIn(lastMonths(12)).filter(r => r.cat === 'No description').length;
  openSheet(`<div class="sheethead"><h2>Sort my spending</h2><button type="button" class="ghost" data-act="close">Cancel</button></div><div id="sortBody"><p class="muted">${items.length ? `Checking ${items.length} note${items.length === 1 ? '' : 's'}: placing ${unplaced.length} Pera couldn’t sort and double-checking ${placed.length} already sorted…` : 'There’s nothing with a note to sort yet.'}</p>${items.length ? '<div class="msg ai thinking"><i></i><i></i><i></i></div>' : ''}${nod ? `<p class="muted">${nod} entries have no note at all, so there’s nothing to sort them by. Adding a short note to big ones helps.</p>` : ''}</div>`);
  if (!items.length) return;
  const cats = CAT_NAMES.filter(c => c !== 'No description');
  try {
    const res = await aiQueue('Sort my spending', () => aiJSON('sort', {system: AI_RULES, maxTokens: 6000, think: 'low',
      messages: [{role: 'user', text: `These are Philippine bank/e-wallet transaction notes, each with the category it has now ("Other" means not sorted). Categories: ${cats.join(', ')}. "Transfers" is for moving money to the person's own accounts or sending it to other people (InstaPay/PESONet sends, "Sent to", "Transfer to", savings, Pag-IBIG MP2); "Bills & PayLater" is for card, loan, PayLater, utility and subscription payments.\nReturn ONLY the notes whose category should change: every "Other" note you can place, and any sorted note that is clearly in the wrong category (be sure; leave borderline ones alone). Also give a short clean shop/payee name.\nNotes (number. note — current category):\n${items.map((e, k) => `${k + 1}. ${e.note} — ${e.cur}`).join('\n')}`}],
      schema: {type: 'ARRAY', items: {type: 'OBJECT', properties: {n: {type: 'INTEGER'}, category: {type: 'STRING', enum: cats}, name: {type: 'STRING'}}, required: ['n', 'category']}}}),
      st => { const p = $('sortBody') && $('sortBody').querySelector('p.muted'); if (p && aiqText(st)) p.textContent = aiqText(st); });
    const seen = new Set();
    sortSug = (Array.isArray(res) ? res : []).map(r => { const e = items[r.n - 1]; if (!e || seen.has(e.note) || !cats.includes(r.category) || r.category === e.cur) return null; seen.add(e.note);
      return {note: e.note, from: e.cur, c: r.category, name: r.name || '', count: e.n, on: r.category !== 'Other'}; }).filter(Boolean);
    renderSort();
  } catch (e) { $('sortBody').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function renderSort() {
  const box = $('sortBody'); if (!box || !sortSug) return;
  const cats = CAT_NAMES.filter(c => c !== 'No description'), on = sortSug.filter(r => r.on).length;
  const row = r => { const k = sortSug.indexOf(r); return `<li><button class="chk ${r.on ? 'on' : ''}" data-act="sort-tog" data-k="${k}" aria-label="${r.on ? 'Skip' : 'Use'} ${esc(r.note)}"><span>${r.on ? '✓' : ''}</span></button>
      <span class="t">${esc(r.note)}<small>${r.from !== 'Other' ? `Now <b class="catdot2" style="background:${catCol(r.from)}"></b>${esc(r.from)} · ` : ''}${r.count} entr${r.count === 1 ? 'y' : 'ies'}${r.name && r.name.toLowerCase() !== r.note.toLowerCase() ? ` · ${esc(r.name)}` : ''}</small></span>
      <select data-k="${k}" class="sortsel" aria-label="Category for ${esc(r.note)}" style="--c:${catCol(r.c)}">${cats.map(c => `<option ${c === r.c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></li>`; };
  const fix = sortSug.filter(r => r.from !== 'Other'), place = sortSug.filter(r => r.from === 'Other');
  box.innerHTML = !sortSug.length ? `<p class="muted">Everything looks sorted correctly. Nothing to change.</p>`
    : `<p class="muted">Check the suggestions, change any category, untick what you don’t want. Pera remembers these for future imports too.</p>
    ${fix.length ? `<h3 class="sortsec">Looks miscategorized <span class="muted">${fix.length}</span></h3><ul class="list implist sortlist">${fix.map(row).join('')}</ul>` : ''}
    ${place.length ? `<h3 class="sortsec">Not sorted yet <span class="muted">${place.length}</span></h3><ul class="list implist sortlist">${place.map(row).join('')}</ul>` : ''}
    <button class="go" data-act="sort-apply" ${on ? '' : 'disabled'}>Apply ${on} change${on === 1 ? '' : 's'}</button>`;
  box.querySelectorAll('.sortsel').forEach(sel => sel.addEventListener('change', () => { const r = sortSug[+sel.dataset.k]; r.c = sel.value; r.on = true; renderSort(); }));
}
function applySort() {
  const pick = sortSug.filter(r => r.on); if (!pick.length) return;
  const before = JSON.parse(JSON.stringify({rules: S.meta.catRules || {}})), touched = [], keys = new Set(['meta']);
  S.meta.catRules = {...(S.meta.catRules || {})};
  for (const r of pick) {
    const m = merchantOf(r.note);
    if (m) S.meta.catRules[m] = r.c;
    for (const y of Object.keys(S.years)) S.years[y].forEach(mo => mo.exp.forEach(x => {
      if (!x.n || x.n.trim() !== r.note || (x.c || catOf(x.n)) === r.c) return;
      touched.push([x, x.c]); x.c = r.c; keys.add('y' + y);
    }));
  }
  sortSug = null; closeSheet(); commit(...keys);
  toast(`${pick.length} change${pick.length === 1 ? '' : 's'} applied`, () => { S.meta.catRules = before.rules; touched.forEach(([x, c]) => { if (c === undefined) delete x.c; else x.c = c; }); commit(...keys); });
}

/* ---- AI cards: short write-ups on Home, each month, Savings and Bills (kept on this device) ---- */
function summaryMonth() { const t = today(); return t.getDate() >= 25 ? {y: String(t.getFullYear()), i: t.getMonth()} : (d => ({y: String(d.getFullYear()), i: d.getMonth()}))(new Date(t.getFullYear(), t.getMonth() - 1, 1)); }
const ym = () => { const t = today(); return `${t.getFullYear()}-${t.getMonth()}`; };
const NO_FLUFF = 'Friendly, no headings, no greeting, no disclaimers, no advice to see a professional.';
function aiSpec(id) {
  const [kind, y, i] = String(id).split('|');
  if (kind === 'month') return {id, key: `sum:${y}-${i}`, title: `${M[+i]} in words`, intro: `A short recap of ${M[+i]}: what changed, and one or two things to try.`,
    prompt: () => `Data:\n${aiContext()}\n\nWrite a recap of ${M[+i]} ${y} in under 110 words. Three short parts: one line on how the month went (income, spending, what was kept); 2–3 bullets on the biggest changes against their usual months, with peso amounts; then one or two specific, doable tips. ${NO_FLUFF}`};
  if (kind === 'savings') return {id, key: `sav:${ym()}`, title: 'Savings check-in', intro: 'Where your savings and goals stand, whether your pace gets you there, and what to do next.',
    prompt: () => `Data:\n${aiContext()}\n\nWrite a savings check-in in under 110 words: one line on total savings now and how it grew; a bullet per goal (or per account if there are no goals) saying if the current pace reaches it on time, with peso amounts; then one concrete next step, like how much to move on each payday (15th and 30th). ${NO_FLUFF}`};
  if (kind === 'bills') return {id, key: `bills:${ym()}`, title: 'Bills plan', intro: 'What your upcoming bills mean for each payday, and when you’ll be clear of them.',
    prompt: () => `Data:\n${aiContext()}\n\nWrite a bills plan in under 110 words: total still owed and when the last one ends (use the exact totals given, don’t add them up yourself); bullets for the heaviest upcoming month(s) with how much to set aside from each payday, using the payday each bill is paid from (a bill isn’t split across paydays that come after its due date); then one tip to get clear sooner or avoid piling up more PayLater. ${NO_FLUFF}`};
  return null;
}
const aiWriting = {};   // key → {text} while a card is being written
// write-ups are kept with your synced data (one write serves every device); older ones may still be only on this device
const aiSaved = key => ((S.meta.aiNotes || {})[key]) || store.get('pera:ai:' + key) || (key.startsWith('sum:') ? store.get('pera:' + key) : null);
function saveAiNote(key, note) {
  const all = {...(S.meta.aiNotes || {}), [key]: note}, keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  keys.slice(30).forEach(k => delete all[k]);   // keep the 30 newest
  S.meta.aiNotes = all; store.set('pera:ai:' + key, note); commit('meta');
}
const AIQ_KEY = 'pera:aiPending';
const pendingCards = () => store.get(AIQ_KEY) || [];
function setPending(id, on) { const l = pendingCards().filter(x => x !== id); if (on) l.push(id); store.set(AIQ_KEY, l); }
function resumeAiCards() { pendingCards().forEach(id => writeAiCard(id)); }
function aiCardHTML(id, extraClass = 'hcard') {
  const sp = aiSpec(id); if (!sp) return '';
  const saved = aiSaved(sp.key), w = aiWriting[sp.key], dots = '<div class="msg ai thinking" aria-label="Writing"><i></i><i></i><i></i></div>';
  const wait = w && aiqText(w.st), stale = saved && saved.fp !== dataFP();
  const btn = w ? `<span class="aiwriting"><span class="spin" aria-hidden="true"></span>${wait ? 'Waiting…' : 'Writing…'}</span>` : saved ? `<button class="plain" data-act="ai-card" data-id="${esc(id)}">Rewrite</button>` : '';
  const body = w ? (w.text ? `<div class="aitext">${aiHTML(w.text)}</div>` : `${saved ? `<div class="aitext faded">${aiHTML(saved.text)}</div>` : ''}${dots}`) + `<p class="muted aifoot">${esc(wait || 'Writing a fresh one…')}</p>`
    : saved ? `<div class="aitext">${aiHTML(saved.text)}</div>${stale ? `<p class="stalenote">Your numbers changed since this was written. <button class="linkbtn" data-act="ai-card" data-id="${esc(id)}">Rewrite</button></p>` : ''}<p class="muted aifoot">Written by AI ${esc(new Date(saved.at).toLocaleDateString('en-PH', {month: 'short', day: 'numeric'}))} · double-check the numbers</p>`
    : `<p class="muted">${sp.intro} Uses Google Gemini.</p><button class="ghost wide" data-act="ai-card" data-id="${esc(id)}">${SPARK}Write it</button>`;
  return `<section class="${extraClass} aicard" data-aikey="${esc(sp.key)}" data-aiid="${esc(id)}" aria-busy="${!!w}"><div class="hhead"><h3><span class="sparkic">${SPARK}</span>${esc(sp.title)}</h3>${btn}</div>${body}</section>`;
}
function paintAiCards(key) {
  document.querySelectorAll(`[data-aikey="${CSS.escape(key)}"]`).forEach(el => {
    const cls = el.classList.contains('hcard') ? 'hcard' : 'card', id = el.id;
    el.outerHTML = aiCardHTML(el.dataset.aiid, cls).replace('<section ', id ? `<section id="${id}" ` : '<section ');
  });
}
async function writeAiCard(id) {
  const sp = aiSpec(id); if (!sp || aiWriting[sp.key]) return;
  const w = aiWriting[sp.key] = {text: '', st: null}; paintAiCards(sp.key);
  const had = !!aiSaved(sp.key); setPending(id, true);
  try {
    const once = tokens => aiQueue(sp.title, job => aiStream('card', {system: AI_RULES, maxTokens: tokens, think: 'low', messages: [{role: 'user', text: sp.prompt()}]}, t => { job.partial = true; w.st = null; w.text = splitFollow(t).text; paintAiCards(sp.key); }).then(t => ({t, cut: aiStream.cut})),
      st => { w.st = st; if (!w.text) paintAiCards(sp.key); });
    let r = await once(2500);
    if (r.cut) { w.text = ''; w.st = {state: 'running'}; paintAiCards(sp.key); r = await once(5000); }   // stopped early: one more go with more room
    if (r.cut) throw new Error('The AI stopped mid-answer twice. Tap Rewrite to try again.');
    const text = r.t;
    delete aiWriting[sp.key]; setPending(id, false);
    saveAiNote(sp.key, {text, at: Date.now(), fp: dataFP()});
    paintAiCards(sp.key); toast(had ? `${sp.title} rewritten` : `${sp.title} written`);
  } catch (e) { delete aiWriting[sp.key]; setPending(id, false); paintAiCards(sp.key); toast(e.message); }
}
function homeSummary() {
  const box = $('hSum'); if (!box) return;
  const m = summaryMonth(); if (!S.years[m.y]) { box.hidden = true; return; }
  box.hidden = false; box.outerHTML = aiCardHTML(`month|${m.y}|${m.i}`).replace('<section ', '<section id="hSum" ');
}

/* ---- Add by talking: several entries from one sentence ---- */
let talk = null;
function talkSheet(prefill) {
  openSheet(`<div class="sheethead"><h2>Add by talking</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <p class="muted">Type or use your keyboard’s mic. Several things at once is fine.</p>
    <textarea id="talkQ" rows="3" autocomplete="off" spellcheck="false" placeholder="grab 550 and jollibee 180 yesterday, salary 25k on the 15th, meralco 2,340 due dec 20">${esc(prefill || '')}</textarea>
    <button class="go" data-act="talk-go">${SPARK}Read it</button><div id="talkOut"></div>`);
  setTimeout(() => $('talkQ') && $('talkQ').focus(), 80);
}
async function talkRead() {
  const q = $('talkQ').value.trim(); if (!q) { $('talkQ').focus(); return; }
  const out = $('talkOut'); out.innerHTML = '<div class="msg ai thinking"><i></i><i></i><i></i></div>';
  const cats = CAT_NAMES.filter(c => c !== 'No description'), bills = uniqNames([...(S.meta.bills || []).map(b => b.name), ...PRESETS]);
  try {
    const res = await aiQueue('Add by talking', () => aiJSON('talk', {system: AI_RULES, maxTokens: 1500, think: 'low', messages: [{role: 'user', text: `Today is ${todayIso()}. Turn this into money entries. "exp" = money spent, "inc" = money received (salary, refunds, interest), "bill" = something to pay on a due date (PayLater, utilities, loans) — use these bill names when they match: ${bills.join(', ')}. Amounts: "25k" = 25000, "1.5k" = 1500. Dates as YYYY-MM-DD; "yesterday", weekdays and "on the 15th" are relative to today; when no date is given use today (for bills, the due date). For bills paid in installments, "payments" is how many months. Notes: short, readable, Title Case shop names.\nText: ${q}`}],
      schema: {type: 'ARRAY', items: {type: 'OBJECT', properties: {type: {type: 'STRING', enum: ['exp', 'inc', 'bill']}, amount: {type: 'NUMBER'}, note: {type: 'STRING'}, date: {type: 'STRING'}, category: {type: 'STRING', enum: cats}, payments: {type: 'INTEGER'}}, required: ['type', 'amount', 'note', 'date']}}}),
      st => { const o = $('talkOut'); if (o && aiqText(st)) o.innerHTML = `<div class="msg ai thinking"><i></i><i></i><i></i><span>${esc(aiqText(st))}</span></div>`; });
    talk = (Array.isArray(res) ? res : []).filter(r => r && +r.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.date)).map(r => ({...r, amount: Math.round(+r.amount * 100) / 100, payments: Math.max(1, Math.min(36, +r.payments || 1)), on: true}));
    renderTalk();
  } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function renderTalk() {
  const out = $('talkOut'); if (!out) return;
  if (!talk || !talk.length) { out.innerHTML = '<p class="muted">Couldn’t find amounts in that. Try “grab 550 yesterday”.</p>'; return; }
  const on = talk.filter(r => r.on);
  out.innerHTML = `<ul class="list implist">${talk.map((r, k) => { const inc = r.type === 'inc', bill = r.type === 'bill';
    return `<li><button class="chk ${r.on ? 'on' : ''}" data-act="talk-tog" data-k="${k}" aria-label="${r.on ? 'Skip' : 'Add'} ${esc(r.note)}"><span>${r.on ? '✓' : ''}</span></button>
      <span class="t">${esc(r.note)}<small>${bill ? `Bill due ${esc(fmtDate(r.date))}${r.payments > 1 ? ` · ${r.payments} payments` : ''}` : `${inc ? 'Income' : esc(r.category || catOf(r.note))} · ${esc(fmtDate(r.date, {month: 'short', day: 'numeric'}))}`}</small></span>
      <span class="amt ${inc ? 'up' : ''}">${inc ? '+' : '−'}${esc(peso(r.amount, 2))}</span></li>`; }).join('')}</ul>
    <button class="go" data-act="talk-add" ${on.length ? '' : 'disabled'}>Add ${on.length} entr${on.length === 1 ? 'y' : 'ies'}</button>`;
}
function talkAdd() {
  const pick = (talk || []).filter(r => r.on); if (!pick.length) return;
  const made = [], keys = new Set(), billsBefore = JSON.parse(JSON.stringify(S.meta.bills || [])); let billMsg = '';
  for (const r of pick) {
    if (r.type === 'bill') { const d0 = new Date(dnum(r.date)); const res = putBills(r.note, Array.from({length: r.payments}, (_, k) => ({a: r.amount, due: iso(mkDate(d0.getFullYear(), d0.getMonth() + k, d0.getDate()))}))); res.keys.forEach(k => keys.add(k)); billMsg = res.msg; continue; }
    const d = new Date(dnum(r.date)), y = String(d.getFullYear()), i = d.getMonth(), t = r.type === 'inc' ? 'inc' : 'exp';
    const it = {id: uid(), a: r.amount, n: r.note, d: r.date}; if (t === 'exp' && r.category && r.category !== catOf(r.note)) it.c = r.category;
    ensureYear(y)[i][t].push(it); made.push({y, i, t, it}); keys.add('y' + y);
  }
  keys.add('meta'); talk = null; closeSheet(); commit(...keys);
  toast(`${made.length ? `${made.length} entr${made.length === 1 ? 'y' : 'ies'} added` : ''}${made.length && billMsg ? ' · ' : ''}${billMsg}`, () => { made.forEach(({y, i, t, it}) => { const l = S.years[y][i][t], k = l.indexOf(it); if (k >= 0) l.splice(k, 1); }); S.meta.bills = billsBefore; commit(...keys); });
}

/* ---- Settings: status and a connection check ---- */
function aiSettingsHTML() {
  return `<h2>Pera AI</h2>
    <p class="muted">Ask Pera, Sort my spending, monthly summaries and Add by talking use Google Gemini through your Supabase project; the key stays on the server. When you use them, a summary of your numbers (and for some questions, recent entries) is sent to Google. On Gemini’s free tier Google may use that to improve its products.</p>
    <div class="note" id="aiStat">${aiOk === true ? 'Pera AI is working.' : aiOk === false ? 'Pera AI isn’t set up yet: deploy the <b>pera-ai</b> function in Supabase (steps in the project README).' : 'Not checked yet.'}</div>
    <button class="ghost wide" data-act="ai-check">${SPARK}Check Pera AI</button>`;
}
async function aiCheck() {
  const st = $('aiStat'); if (st) st.textContent = 'Checking…';
  try { const t = await ai('ping', {messages: [{role: 'user', text: 'Reply with just: OK'}], maxTokens: 50, think: 'minimal'}); if (st) st.textContent = `Pera AI is working (${t.trim().slice(0, 20)}).`; }
  catch (e) { if (st) st.textContent = e.message; }
}

/* ================= search: every entry, bill and deposit, by words, amount or category ================= */
let srch = {q: '', f: 'all'};
function searchSheet() {
  openSheet(`<div class="sheethead"><h2>Search</h2><button type="button" class="ghost" data-act="close">Done</button></div>
    <div class="srchbox"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="srQ" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Grab, 550, food, salary…" aria-label="Search entries" value="${esc(srch.q)}"></div>
    <div class="seg srseg">${[['all', 'All'], ['out', 'Money out'], ['in', 'Money in'], ['bill', 'Bills']].map(([k, l]) => `<button data-act="sr-f" data-k="${k}" aria-pressed="${srch.f === k}">${l}</button>`).join('')}</div>
    <p class="muted" id="srSum"></p><ul class="list srlist" id="srList"></ul>`);
  $('sheet').classList.add('tall');
  const q = $('srQ'); q.addEventListener('input', () => { srch.q = q.value; runSearch(); }); runSearch(); setTimeout(() => q.focus(), 60);
}
function runSearch() {
  const raw = srch.q.trim(), q = raw.toLowerCase(), num = /^[₱\s]*[\d,]+(\.\d+)?$/.test(raw) ? parseFloat(raw.replace(/[₱,\s]/g, '')) : null, res = [];
  const hit = (text, a, cat) => !q || (num != null ? Math.abs(Math.abs(+a) - num) < 0.5 || String(Math.abs(+a)).startsWith(String(num)) : (text || '').toLowerCase().includes(q) || (cat || '').toLowerCase().includes(q) || (merchantOf(text || '') || '').toLowerCase().includes(q));
  for (const y of Object.keys(S.years).sort().reverse()) for (let i = 11; i >= 0; i--) {
    const m = S.years[y][i]; if (!m) continue;
    if (srch.f !== 'bill') {
      if (srch.f !== 'in') m.exp.forEach(x => { const c = x.c || catOf(x.n || ''); if (hit(x.n, x.a, c)) res.push({t: 'exp', x, y, i, c, d: x.d || `${y}-${String(i + 1).padStart(2, '0')}-00`}); });
      if (srch.f !== 'out') m.inc.forEach(x => { if (hit(x.n, x.a, 'income')) res.push({t: 'inc', x, y, i, d: x.d || `${y}-${String(i + 1).padStart(2, '0')}-00`}); });
    }
  }
  if (srch.f === 'all' || srch.f === 'bill' || srch.f === 'out') (S.meta.bills || []).forEach((b, j) => { if (hit(b.name, b.a, 'bills paylater')) res.push({t: 'bill', b, j, d: b.due}); });
  res.sort((a, b) => b.d.localeCompare(a.d));
  const out = res.filter(r => r.t !== 'inc').reduce((s, r) => s + Math.abs(+(r.x ? r.x.a : r.b.a)), 0), inn = res.filter(r => r.t === 'inc').reduce((s, r) => s + +r.x.a, 0);
  $('srSum').innerHTML = !q && srch.f === 'all' ? 'Type a shop, note, amount or category. Newest first.' : res.length ? `<b>${res.length}</b> result${res.length === 1 ? '' : 's'}${out ? ` · <span class="dn">−${esc(peso(out, 2))}</span>` : ''}${inn ? ` · <span class="up">+${esc(peso(inn, 2))}</span>` : ''}` : `Nothing matches “${esc(raw)}”. Try fewer letters or an amount like 550.`;
  let last = '', h = '';
  for (const r of res.slice(0, 150)) {
    const mk = r.t === 'bill' ? 'Bills' : `${M[r.i]} ${r.y}`;
    if (mk !== last) { h += `<li class="dayh"><span>${esc(mk)}</span><span></span></li>`; last = mk; }
    if (r.t === 'bill') { const b = r.b; h += `<li><button class="rowbtn" data-act="bill-edit" data-j="${r.j}"><span class="dot e">↑</span><span class="t">${esc(b.name)}<small>Bill due ${esc(fmtDate(b.due))}${b.paid ? ' · paid' : ''}</small></span><span class="amt">−${esc(peso(+b.a, 2))}</span></button></li>`; continue; }
    const x = r.x, inc = r.t === 'inc';
    h += `<li><button class="rowbtn" data-act="edit-entry" data-t="${r.t}" data-y="${esc(r.y)}" data-i="${r.i}" data-id="${esc(x.id)}"><span class="dot ${inc ? 'i' : 'e'}">${inc ? '↓' : '↑'}</span><span class="t">${esc(x.n || (inc ? 'Income' : 'Expense'))}<small>${x.d ? esc(fmtDate(x.d, {month: 'short', day: 'numeric'})) + ' · ' : ''}${inc ? 'Received' : `<b class="catdot2" style="background:${catCol(r.c)}"></b>${esc(r.c)}`}</small></span><span class="amt ${inc ? 'up' : ''}">${inc ? '+' : '−'}${esc(peso(Math.abs(x.a), 2))}</span></button></li>`;
  }
  if (res.length > 150) h += `<li class="empty">Showing the newest 150. Type more to narrow it down.</li>`;
  $('srList').innerHTML = h;
}

/* ================= more reports (each in its own sheet) ================= */
/* ---- income vs spending: monthly lines with your average salary and average spending ---- */
const SALARY_RE = /inrem|payroll|salary|sahod|sweldo/i;   // same as the Salary name in INC_NAMES
function flowData(n = 12) {
  const t = today(), rows = lastMonths(n).map(m => { const f = monthFlows(m.y, m.i), mo = S.years[m.y][m.i];
    const sal = mo.inc.filter(x => x.n && SALARY_RE.test(x.n)).reduce((a, x) => a + +x.a, 0);
    return {...m, inc: f.inc, exp: f.exp, sal, now: +m.y === t.getFullYear() && m.i === t.getMonth()}; });
  // trim empty months at the start (before you started tracking)
  while (rows.length && !rows[0].inc && !rows[0].exp) rows.shift();
  const done = rows.filter(r => !r.now && (r.inc || r.exp)), avg = k => done.length ? done.reduce((a, r) => a + r[k], 0) / done.length : 0;
  const salMonths = done.filter(r => r.sal > 0).length, useSal = salMonths >= Math.max(2, done.length / 2);
  const aIn = useSal ? done.filter(r => r.sal > 0).reduce((a, r) => a + r.sal, 0) / salMonths : avg('inc');
  return {rows, done, useSal, aIn, aIncAll: avg('inc'), aExp: avg('exp')};
}
function flowSVG(svg, d, tips) {
  const {rows, aIn, aExp, useSal} = d; if (rows.length < 2) { svg.outerHTML = '<p class="muted">Needs at least two months of data.</p>'; return; }
  const W = svg.clientWidth || 340, H = svg.clientHeight || 180, pl = 42, pr = 70, pt = 10, pb = 22;
  const hi = niceUp(Math.max(1, ...rows.map(r => Math.max(r.inc, r.exp)), aIn, aExp)), X = k => pl + k * (W - pl - pr) / (rows.length - 1), Y = v => pt + (1 - v / hi) * (H - pt - pb);
  const line = (k, col) => { const pts = rows.map((r, j) => [X(j), Y(r[k])]), fin = rows.filter(r => !r.now).length;
    const solid = pts.slice(0, fin).map((p, j) => (j ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(''), dash = fin < pts.length && fin ? `M${pts[fin - 1].join(' ')}L${pts[fin].join(' ')}` : '';
    return `<path d="${solid}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dash ? `<path d="${dash}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round"/>` : ''}`
      + pts.map((p, j) => rows[j].now ? `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="var(--card)" stroke="${col}" stroke-width="2"/>` : '').join(''); };
  // average lines with end labels; nudge labels apart if they'd collide
  let yi = Y(aIn), ye = Y(aExp); if (Math.abs(yi - ye) < 14) { const mid = (yi + ye) / 2, up = yi < ye ? -1 : 1; yi = mid + up * 7; ye = mid - up * 7; }
  const avgLine = (v, ly, col, lbl) => v ? `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="${col}" stroke-dasharray="5 4" opacity=".55"/><text x="${W - pr + 9}" y="${ly + 4}" font-size="11" fill="var(--mute)">${lbl} ${esc(pesoS(v))}</text>` : '';
  const step = Math.ceil(rows.length / 6);
  svg.innerHTML = gridY(W, H, pl, pr, pt, pb, hi, pesoS)
    + avgLine(aIn, yi, 'var(--blue)', 'avg') + avgLine(aExp, ye, 'var(--red)', 'avg')
    + line('inc', 'var(--blue)') + line('exp', 'var(--red)')
    + rows.map((r, j) => (j % step === 0 || j === rows.length - 1) && !(j !== rows.length - 1 && rows.length - 1 - j < step) ? `<text x="${X(j)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--mute)">${M[r.i].slice(0, 3)}</text>` : '').join('')
    + (tips ? rows.map((r, j) => { const x0 = j ? (X(j - 1) + X(j)) / 2 : pl - 6, x1 = j < rows.length - 1 ? (X(j) + X(j + 1)) / 2 : W - pr + 6;
        const tip = `<b>${M[r.i]} ${r.y}${r.now ? ' (so far)' : ''}</b><div><i style="background:var(--blue)"></i>Income <span>${esc(peso(r.inc))}</span></div>${useSal && r.sal ? `<div><i style="background:var(--blue);opacity:.5"></i>Salary <span>${esc(peso(r.sal))}</span></div>` : ''}<div><i style="background:var(--red)"></i>Spent <span>${esc(peso(r.exp))}</span></div><div class="tt">${r.inc >= r.exp ? 'Kept' : 'Over by'} <span>${esc(peso(Math.abs(r.inc - r.exp)))}</span></div>`;
        return `<g class="hit" data-tip="${esc(tip)}"><rect x="${x0}" y="${pt}" width="${x1 - x0}" height="${H - pt - pb}" fill="transparent"/><line class="xh" x1="${X(j)}" x2="${X(j)}" y1="${pt}" y2="${H - pb}" stroke="var(--mute)" stroke-width="1"/><circle class="xh" cx="${X(j)}" cy="${Y(r.inc)}" r="4" fill="var(--blue)" stroke="var(--card)" stroke-width="2"/><circle class="xh" cx="${X(j)}" cy="${Y(r.exp)}" r="4" fill="var(--red)" stroke="var(--card)" stroke-width="2"/></g>`; }).join('') : '');
}
function flowStats(d) {
  const keep = d.aIncAll - d.aExp, pct = d.aIncAll > 0 ? Math.round(keep / d.aIncAll * 100) : 0;
  return `<div class="flowstats"><div><span>${d.useSal ? 'Avg salary' : 'Avg income'}</span><b class="up">${esc(pesoS(d.aIn))}</b></div><div><span>Avg spent</span><b class="dn">${esc(pesoS(d.aExp))}</b></div><div><span>${keep >= 0 ? 'Avg kept' : 'Avg over'}</span><b>${esc(pesoS(Math.abs(keep)))}${d.aIncAll > 0 ? ` <small>${Math.abs(pct)}%</small>` : ''}</b></div></div>`;
}
function homeFlow() {
  const box = $('hFlow'); if (!box) return;
  const d = flowData(12); if (d.done.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="hhead"><h3>Income vs spending</h3><button class="plain" data-act="report" data-r="flow">Details</button></div>
    ${flowStats(d)}${legendHTML([[d.useSal ? 'Income (dashed: avg salary)' : 'Income (dashed: average)', 'var(--blue)'], ['Spent (dashed: average)', 'var(--red)']])}
    <button class="flowfigbtn" data-act="report" data-r="flow" aria-label="Open income vs spending details"><svg class="flowfig" aria-hidden="true"></svg></button>
    <p class="muted flowfoot">Averages use the last ${d.done.length} finished month${d.done.length === 1 ? '' : 's'}${insTr ? '; money you moved to savings counts as kept, not spent' : '; transfers are left out'}.</p>`;
  requestAnimationFrame(() => { const svg = box.querySelector('svg'); if (svg) flowSVG(svg, d, false); });
}
const REPORTS = [['flow', 'Income vs spending', '⇅'], ['trend', 'Spending trend', '≡'], ['cal', 'Spending calendar', '#'], ['rate', 'Savings rate', '↗'], ['debt', 'PayLater payoff', '↓']];
let repState = {months: 6, cal: null};
const lastMonths = n => { const t = today(), out = []; for (let k = n - 1; k >= 0; k--) { const d = new Date(t.getFullYear(), t.getMonth() - k, 1); if (S.years[d.getFullYear()]) out.push({y: String(d.getFullYear()), i: d.getMonth()}); } return out; };
const niceUp = v => { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; };
const gridY = (W, H, pl, pr, pt, pb, hi, fmt, lo = 0) => [0, 0.5, 1].map(f => { const v = lo + (hi - lo) * f, y = pt + (1 - f) * (H - pt - pb); return `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="var(--line)"${f ? ' stroke-dasharray="2 4"' : ''}/><text x="${pl - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--mute)">${fmt(v)}</text>`; }).join('');
function legendHTML(items) { return `<div class="legend2">${items.map(([l, c]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join('')}</div>`; }
function reportSheet(r) {
  const head = t => `<div class="sheethead"><h2>${t}</h2><button type="button" class="ghost" data-act="close">Done</button></div>`;
  let html = '', draw = null;
  if (r === 'flow') {
    const d = flowData(repState.months);
    html = head('Income vs spending') + `<div class="seg repseg">${[6, 12].map(n => `<button data-act="rep-flow" data-n="${n}" aria-pressed="${repState.months === n}">${n} months</button>`).join('')}</div>
      ${flowStats(d)}<p class="muted">${d.useSal ? 'Average salary counts the months your pay came in. ' : ''}Dashed lines are the averages of finished months; the open dot is this month so far. Tap a month for details.</p>
      ${legendHTML([['Income', 'var(--blue)'], ['Spent', 'var(--red)']])}<div class="rfig"><svg id="repSvg" role="img" aria-label="Income and spending by month with average lines"></svg><div class="tip" id="repTip" hidden></div></div>
      <details class="rtable"><summary>Show as table</summary><div class="tscroll"><table class="ytable"><thead><tr><th>Month</th><th>Income</th>${d.useSal ? '<th>Salary</th>' : ''}<th>Spent</th><th>Kept</th></tr></thead><tbody>${d.rows.map(x => `<tr><td>${M[x.i].slice(0, 3)} ${x.y.slice(2)}${x.now ? '*' : ''}</td><td>${esc(peso(x.inc))}</td>${d.useSal ? `<td>${esc(peso(x.sal))}</td>` : ''}<td>${esc(peso(x.exp))}</td><td>${esc(peso(x.inc - x.exp))}</td></tr>`).join('')}</tbody></table></div></details>`;
    draw = svg => flowSVG(svg, d, true);
  }
  if (r === 'trend') {
    const ms = lastMonths(repState.months), rows = ms.map(m => { const by = {}; spendingIn([m]).forEach(x => { if (x.cat === 'Transfers' && !insTr) return; const g = catGroup(x.cat); by[g] = (by[g] || 0) + x.a; }); return {...m, by, tot: Object.values(by).reduce((s, v) => s + v, 0)}; });
    const groups = [...CAT_SLOTS, 'Other', 'No description'].filter(g => rows.some(x => x.by[g] > 0));
    const avg = rows.length ? rows.reduce((s, x) => s + x.tot, 0) / rows.length : 0, top = groups.map(g => [g, rows.reduce((s, x) => s + (x.by[g] || 0), 0)]).sort((a, b) => b[1] - a[1])[0];
    html = head('Spending trend') + `<div class="seg repseg">${[6, 12].map(n => `<button data-act="rep-months" data-n="${n}" aria-pressed="${repState.months === n}">${n} months</button>`).join('')}</div>
      <p class="muted">Average ${esc(peso(avg))} a month${top ? ` · biggest: ${esc(top[0])}` : ''}${insTr ? '' : ' · transfers between your accounts left out'}. Tap a bar for details.</p>
      ${legendHTML(groups.map(g => [g, catCol(g)]))}<div class="rfig"><svg id="repSvg" role="img" aria-label="Spending by month, stacked by category"></svg><div class="tip" id="repTip" hidden></div></div>
      <details class="rtable"><summary>Show as table</summary><div class="tscroll"><table class="ytable"><thead><tr><th>Month</th>${groups.map(g => `<th>${esc(g)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${rows.map(x => `<tr><td>${M[x.i].slice(0, 3)} ${x.y.slice(2)}</td>${groups.map(g => `<td>${esc(pesoS(x.by[g] || 0))}</td>`).join('')}<td><b>${esc(pesoS(x.tot))}</b></td></tr>`).join('')}</tbody></table></div></details>`;
    draw = svg => {
      const W = svg.clientWidth, H = svg.clientHeight, pl = 44, pr = 4, pt = 10, pb = 22, hi = niceUp(Math.max(1, ...rows.map(x => x.tot)));
      const bw = (W - pl - pr) / rows.length, w = Math.min(34, bw * 0.62), Y = v => pt + (1 - v / hi) * (H - pt - pb);
      svg.innerHTML = gridY(W, H, pl, pr, pt, pb, hi, pesoS) + rows.map((x, k) => {
        let y0 = H - pb, segs = '';
        const cx = pl + bw * k + bw / 2, tipTxt = `<b>${M[x.i]} ${x.y}</b>` + groups.filter(g => x.by[g] > 0).map(g => `<div><i style="background:${catCol(g)}"></i>${esc(g)} <span>${esc(peso(x.by[g]))}</span></div>`).join('') + `<div class="tt">Total <span>${esc(peso(x.tot))}</span></div>`;
        const live = groups.filter(g => x.by[g] > 0);
        live.forEach((g, gi) => { const h = Math.max(0, (H - pt - pb) * x.by[g] / hi); const y = y0 - h, last = gi === live.length - 1;
          segs += last ? `<path d="M${cx - w / 2} ${y0}V${y + 4}q0 -4 4 -4h${w - 8}q4 0 4 4V${y0}Z" fill="${catCol(g)}" stroke="var(--sheet)" stroke-width="1"/>` : `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h}" fill="${catCol(g)}" stroke="var(--sheet)" stroke-width="1"/>`; y0 = y; });
        return `<g class="hit" data-tip="${esc(tipTxt)}"><rect x="${pl + bw * k}" y="${pt}" width="${bw}" height="${H - pt - pb}" fill="transparent"/>${segs}</g><text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--mute)">${M[x.i].slice(0, 3)}</text>`;
      }).join('') + (avg ? `<line x1="${pl}" x2="${W - pr}" y1="${Y(avg)}" y2="${Y(avg)}" stroke="var(--ink)" stroke-dasharray="4 4" opacity=".5"/><text x="${pl + 3}" y="${Y(avg) - 4}" font-size="11" fill="var(--mute)">avg ${esc(pesoS(avg))}</text>` : '');
    };
  }
  if (r === 'cal') {
    const t = today(), cur = repState.cal || {y: t.getFullYear(), i: t.getMonth()}; repState.cal = cur;
    const days = new Date(cur.y, cur.i + 1, 0).getDate(), first = new Date(cur.y, cur.i, 1).getDay(), by = Array(days + 1).fill(0), cnt = Array(days + 1).fill(0);
    const m = S.years[cur.y] && S.years[cur.y][cur.i]; let undated = 0, total = 0;
    (m ? m.exp : []).forEach(x => { if (!insTr && catOf(x.n) === 'Transfers' && !x.c) return; if (x.c === 'Transfers' && !insTr) return; total += +x.a; const d = x.d && new Date(dnum(x.d)); if (d && d.getMonth() === cur.i && d.getFullYear() === cur.y) { by[d.getDate()] += +x.a; cnt[d.getDate()]++; } else undated += +x.a; });
    const hi = Math.max(1, ...by), step = v => v <= 0 ? 0 : Math.min(5, 1 + Math.floor(v / hi * 4.999));
    // weekday pattern over the last 3 months (dated spending only)
    const wd = Array(7).fill(0), wdn = Array(7).fill(0);
    lastMonths(3).forEach(mm => { const mo = S.years[mm.y][mm.i], nd = new Date(+mm.y, mm.i + 1, 0).getDate(); for (let dd = 1; dd <= nd; dd++) { const dt = new Date(+mm.y, mm.i, dd); if (dt > t) break; wdn[dt.getDay()]++; } mo.exp.forEach(x => { if ((x.c || catOf(x.n)) === 'Transfers' && !insTr) return; if (!x.d) return; const dt = new Date(dnum(x.d)); wd[dt.getDay()] += +x.a; }); });
    const wavg = wd.map((v, k) => wdn[k] ? v / wdn[k] : 0), wmax = Math.max(1, ...wavg), best = wavg.indexOf(Math.max(...wavg)), DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const topDay = by.indexOf(Math.max(...by));
    html = head('Spending calendar') + `<div class="calnav"><button class="ghost" data-act="cal-mv" data-d="-1" aria-label="Previous month">‹</button><b>${M[cur.i]} ${cur.y}</b><button class="ghost" data-act="cal-mv" data-d="1" aria-label="Next month">›</button></div>
      <p class="muted">${esc(peso(total))} spent${by[topDay] > 0 ? ` · busiest day: ${M[cur.i].slice(0, 3)} ${topDay} (${esc(peso(by[topDay]))})` : ''}${undated ? ` · ${esc(peso(undated))} has no exact day (bills, old entries)` : ''}. Darker = more spent.</p>
      <div class="calwrap"><div class="cal">${DN.map(d => `<span class="calh">${d[0]}</span>`).join('')}${'<span></span>'.repeat(first)}${Array.from({length: days}, (_, k) => k + 1).map(d => `<button class="calday s${step(by[d])}" data-tip="${esc(`<b>${M[cur.i].slice(0, 3)} ${d}, ${DN[new Date(cur.y, cur.i, d).getDay()]}</b><div>${by[d] ? esc(peso(by[d])) + ` · ${cnt[d]} payment${cnt[d] === 1 ? '' : 's'}` : 'Nothing spent'}</div>`)}"><span>${d}</span>${by[d] ? `<small>${esc(pesoS(by[d]))}</small>` : ''}</button>`).join('')}</div>
      <div class="tip" id="repTip" hidden></div></div>
      <div class="calkey"><span>Less</span>${[0, 1, 2, 3, 4, 5].map(k => `<i class="calday s${k}"></i>`).join('')}<span>More</span></div>
      <h3>By day of the week</h3><p class="muted">Average spent on each day, last 3 months${wavg[best] > 0 ? ` · most on <b>${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][best]}</b>` : ''}.</p>
      <div class="wdrows">${[1, 2, 3, 4, 5, 6, 0].map(k => `<div class="wdrow"><span>${DN[k]}</span><i><b style="width:${(wavg[k] / wmax * 100).toFixed(1)}%"></b></i><span>${esc(pesoS(wavg[k]))}</span></div>`).join('')}</div>`;
  }
  if (r === 'rate') {
    const rows = lastMonths(12).filter(m => { const t = today(); return +m.y < t.getFullYear() || m.i <= t.getMonth(); }).map(m => { const f = monthFlows(m.y, m.i); return {...m, ...f, r: f.inc > 0 ? (f.inc - f.exp) / f.inc * 100 : null}; }).filter(x => x.r != null);
    const avg = rows.length ? rows.reduce((s, x) => s + x.r, 0) / rows.length : 0, last = rows[rows.length - 1];
    html = head('Savings rate') + `<div class="hero2"><b>${last ? Math.round(last.r) + '%' : '—'}</b><span>kept in ${last ? M[last.i] : 'this month'}<br>${Math.round(avg)}% on average over ${rows.length} months</span></div>
      <p class="muted">The share of your income you didn’t spend (savings deposits count as kept). Below 0% means you spent more than came in. Tap a point for details.</p>
      <div class="rfig"><svg id="repSvg" role="img" aria-label="Savings rate by month"></svg><div class="tip" id="repTip" hidden></div></div>
      <details class="rtable"><summary>Show as table</summary><div class="tscroll"><table class="ytable"><thead><tr><th>Month</th><th>Income</th><th>Spent</th><th>Kept</th></tr></thead><tbody>${rows.map(x => `<tr><td>${M[x.i].slice(0, 3)} ${x.y.slice(2)}</td><td>${esc(pesoS(x.inc))}</td><td>${esc(pesoS(x.exp))}</td><td><b class="${x.r < 0 ? 'dn' : ''}">${Math.round(x.r)}%</b></td></tr>`).join('')}</tbody></table></div></details>`;
    draw = svg => {
      if (rows.length < 2) { svg.outerHTML = '<p class="empty">Needs at least two months with income.</p>'; return; }
      const W = svg.clientWidth, H = svg.clientHeight, pl = 40, pr = 10, pt = 12, pb = 22;
      const lo = Math.floor(Math.min(0, ...rows.map(x => x.r)) / 25) * 25, hi = Math.max(50, Math.ceil(Math.max(...rows.map(x => x.r)) / 25) * 25), stepT = hi - lo > 150 ? 50 : 25;
      const X = k => pl + k * (W - pl - pr) / (rows.length - 1), Y = v => pt + (hi - v) / (hi - lo) * (H - pt - pb);
      const line = rows.map((x, k) => (k ? 'L' : 'M') + X(k).toFixed(1) + ' ' + Y(x.r).toFixed(1)).join('');
      const ticks = []; for (let v = lo; v <= hi + 0.1; v += stepT) ticks.push(v);
      svg.innerHTML = ticks.map(v => `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? 'var(--mute)' : 'var(--line)'}"${v === 0 ? '' : ' stroke-dasharray="2 4"'}/><text x="${pl - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--mute)">${v}%</text>`).join('') +
        `<line x1="${pl}" x2="${W - pr}" y1="${Y(avg)}" y2="${Y(avg)}" stroke="var(--ink)" stroke-dasharray="4 4" opacity=".5"/><text x="${pl + 3}" y="${Y(avg) - 5}" font-size="11" fill="var(--mute)">avg ${Math.round(avg)}%</text>
        <path d="${line}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linejoin="round"/>` +
        rows.map((x, k) => `<g class="hit" data-tip="${esc(`<b>${M[x.i]} ${x.y}</b><div>Kept <span>${Math.round(x.r)}%</span></div><div>Income <span>${esc(peso(x.inc))}</span></div><div>Spent <span>${esc(peso(x.exp))}</span></div>`)}"><rect x="${X(k) - (W / rows.length) / 2}" y="${pt}" width="${W / rows.length}" height="${H - pt - pb}" fill="transparent"/><circle cx="${X(k)}" cy="${Y(x.r)}" r="4" fill="${x.r < 0 ? 'var(--red)' : 'var(--blue)'}" stroke="var(--sheet)" stroke-width="2"/></g>${k % (rows.length > 7 ? 2 : 1) === 0 || k === rows.length - 1 ? `<text x="${X(k)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--mute)">${M[x.i].slice(0, 3)}</text>` : ''}`).join('');
    };
  }
  if (r === 'debt') {
    const un = (S.meta.bills || []).filter(b => !b.paid && b.due && b.due >= todayIso()), names = uniqNames(un.map(b => b.name)).sort();
    const nameCol = n => { const k = names.indexOf(n); return k < 7 ? `var(--s${k + 1})` : 'var(--s-other)'; };
    const t = today(), ms = []; for (let k = 0; k < 12; k++) { const d = new Date(t.getFullYear(), t.getMonth() + k, 1); ms.push({y: String(d.getFullYear()), i: d.getMonth(), by: {}, tot: 0}); }
    un.forEach(b => { const m = billMonth(b.due), x = ms.find(z => z.y === m.y && z.i === m.i); if (x) { x.by[b.name] = (x.by[b.name] || 0) + +b.a; x.tot += +b.a; } });
    const total = un.reduce((s, b) => s + +b.a, 0), lastDue = un.map(b => b.due).sort().pop(), per = names.map(n => [n, un.filter(b => sameName(b.name, n)).reduce((s, b) => s + +b.a, 0), un.filter(b => sameName(b.name, n)).map(b => b.due).sort().pop()]);
    html = head('PayLater payoff') + `<div class="hero2"><b>${esc(peso(total))}</b><span>still to pay${lastDue ? `<br>debt-free after <b>${esc(fmtDate(lastDue, {month: 'long', year: 'numeric'}))}</b>` : ''}</span></div>
      <p class="muted">Upcoming unpaid bills by the month they count in (paid from that month’s income). Tap a bar for details.</p>
      ${names.length ? legendHTML(names.map(n => [n, nameCol(n)])) + `<div class="rfig"><svg id="repSvg" role="img" aria-label="Bills to pay each month"></svg><div class="tip" id="repTip" hidden></div></div>
      <ul class="dlist">${per.map(([n, a, end]) => `<li><span><i style="background:${nameCol(n)}"></i>${esc(n)}<small>done after ${esc(fmtDate(end, {month: 'short', year: 'numeric'}))}</small></span><b>${esc(peso(a, 2))}</b></li>`).join('')}</ul>` : '<p class="empty">No unpaid bills. You’re debt-free.</p>'}`;
    draw = svg => {
      const W = svg.clientWidth, H = svg.clientHeight, pl = 44, pr = 4, pt = 10, pb = 22, hi = niceUp(Math.max(1, ...ms.map(x => x.tot)));
      const bw = (W - pl - pr) / ms.length, w = Math.min(26, bw * 0.62);
      svg.innerHTML = gridY(W, H, pl, pr, pt, pb, hi, pesoS) + ms.map((x, k) => {
        let y0 = H - pb, segs = ''; const cx = pl + bw * k + bw / 2, live = names.filter(n => x.by[n] > 0);
        live.forEach((n, gi) => { const h = (H - pt - pb) * x.by[n] / hi, y = y0 - h, last = gi === live.length - 1;
          segs += last && h > 4 ? `<path d="M${cx - w / 2} ${y0}V${y + 4}q0 -4 4 -4h${w - 8}q4 0 4 4V${y0}Z" fill="${nameCol(n)}" stroke="var(--sheet)" stroke-width="1"/>` : `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h}" fill="${nameCol(n)}" stroke="var(--sheet)" stroke-width="1"/>`; y0 = y; });
        const tip = `<b>${M[x.i]} ${x.y}</b>` + (live.length ? live.map(n => `<div><i style="background:${nameCol(n)}"></i>${esc(n)} <span>${esc(peso(x.by[n], 2))}</span></div>`).join('') + `<div class="tt">Total <span>${esc(peso(x.tot, 2))}</span></div>` : '<div>No bills</div>');
        return `<g class="hit" data-tip="${esc(tip)}"><rect x="${pl + bw * k}" y="${pt}" width="${bw}" height="${H - pt - pb}" fill="transparent"/>${segs}</g>${k % 2 === 0 ? `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--mute)">${M[x.i].slice(0, 3)}</text>` : ''}`;
      }).join('');
    };
  }
  openSheet(html); sheetReport = r;
  const svg = $('repSvg'); if (svg && draw) requestAnimationFrame(() => draw(svg));
  bindTips();
}
let sheetReport = null;
function bindTips() {   // tap / hover a mark to see its numbers (delegated, so marks drawn later work too)
  const body = $('sheetBody'); if (body._tips) return; body._tips = true;
  const show = el => { const tip = body.querySelector('#repTip'); if (!tip) return; const wrap = tip.parentElement, r = el.getBoundingClientRect(), box = wrap.getBoundingClientRect();
    tip.innerHTML = el.dataset.tip; tip.hidden = false;
    const tw = tip.offsetWidth; let x, y;
    if (el.classList.contains('hit')) {   // chart column: beside it, at the top of the chart, never over the bar
      const right = r.right - box.left + 6, left = r.left - box.left - tw - 6;
      x = right + tw <= box.width ? right : left >= 0 ? left : Math.max(4, box.width - tw - 4); y = 4;
    } else {
      x = Math.min(Math.max(4, r.left - box.left + r.width / 2 - tw / 2), box.width - tw - 4);
      y = r.top - box.top - tip.offsetHeight - 8; if (y < 0) y = r.bottom - box.top + 8;
    }
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    body.querySelectorAll('.hit.on, .calday.on').forEach(z => z.classList.remove('on')); el.classList.add('on'); };
  const hide = () => { const tip = body.querySelector('#repTip'); if (tip) tip.hidden = true; body.querySelectorAll('.hit.on, .calday.on').forEach(z => z.classList.remove('on')); };
  body.addEventListener('click', e => { const el = e.target.closest('[data-tip]'); if (el && body.contains(el)) show(el); else hide(); });
  body.addEventListener('pointerover', e => { if (e.pointerType !== 'mouse') return; const el = e.target.closest('[data-tip]'); if (el) show(el); });
}

/* ================= sheet + toast ================= */
let sheetOpen = false;
function nameSheet() {   // a sheet is named by its title, for screen readers
  const t = $('sheetBody').querySelector('h2'), sh = $('sheet');
  if (t) { if (!t.id) t.id = 'sheetTitle'; sh.setAttribute('aria-labelledby', t.id); sh.removeAttribute('aria-label'); } else { sh.removeAttribute('aria-labelledby'); sh.setAttribute('aria-label', 'Details'); }
}
new MutationObserver(() => { if (sheetOpen) nameSheet(); }).observe($('sheetBody'), {childList: true});
function openSheet(html, onReady) {
  sheetMonth = null; sheetPot = null; sheetBill = null;
  $('sheetBody').innerHTML = html; nameSheet();
  $('scrim').classList.add('on'); $('sheet').classList.add('on'); document.body.classList.add('locked');
  $('sheet').style.transform = ''; $('scrim').style.opacity = ''; $('sheet').classList.remove('tall');
  if (!sheetOpen && !(history.state && history.state.peraSheet)) history.pushState({peraSheet: 1}, '');   // phone Back closes it
  sheetOpen = true;
  if (onReady) onReady($('sheetBody'));
}
let skipPop = 0;
function closeSheet(fromBack) {
  if (!sheetOpen) return;
  $('scrim').classList.remove('on'); $('sheet').classList.remove('on'); document.body.classList.remove('locked');
  $('sheet').style.transform = ''; $('sheet').style.transition = ''; $('scrim').style.opacity = '';
  sheetOpen = false; sheetMonth = null; sheetPot = null; sheetBill = null;
  if (fromBack !== true && history.state && history.state.peraSheet) { skipPop++; history.back(); }
}
addEventListener('popstate', () => {
  if (skipPop) { skipPop--; if (sheetOpen) history.pushState({peraSheet: 1}, ''); return; }   // a new sheet opened meanwhile
  if (sheetOpen) closeSheet(true);
});
// swipe the sheet down to close it (from the handle/title, or anywhere once scrolled to the top)
(() => {
  const sh = $('sheet'); let y0 = null, dy = 0, t0 = 0, drag = false;
  sh.addEventListener('touchstart', e => {
    if (desk.matches || e.touches.length !== 1) return;
    const top = e.target.closest('.grab, .sheethead');
    if (!top && sh.scrollTop > 0) { y0 = null; return; }
    if (e.target.closest('input, select, textarea, .chips, .cyclechips')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0; t0 = Date.now(); drag = false;
  }, {passive: true});
  sh.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (!drag && (dy < 8 || sh.scrollTop > 0)) { if (dy < -4) y0 = null; return; }
    drag = true; e.preventDefault();
    sh.style.transition = 'none'; sh.style.transform = `translateY(${Math.max(0, dy)}px)`;
    $('scrim').style.opacity = String(Math.max(0.15, 1 - dy / (sh.offsetHeight || 600)));
  }, {passive: false});
  const end = () => {
    if (y0 == null) return; y0 = null;
    if (!drag) return; drag = false;
    const fast = dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.6;
    sh.style.transition = '';
    if (dy > Math.min(140, sh.offsetHeight * 0.25) || fast) closeSheet();
    else { sh.style.transform = ''; $('scrim').style.opacity = ''; }
  };
  sh.addEventListener('touchend', end); sh.addEventListener('touchcancel', end);
})();
$('scrim').addEventListener('click', () => closeSheet());
$('sync').addEventListener('click', () => { if (user) settings(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen) closeSheet(); });

let toastTimer;
// toast(msg, undoFn?, buttonLabel?) — warnings are messages that start with "Couldn" / "Still" / "That" / contain "already"
function toast(msg, undo, label = 'Undo') {
  const t = $('toast'), b = $('toastBtn'), ms = undo ? 6000 : 3500;
  const warn = /^(Couldn|Still|That|Not|Pera AI|The AI|Gemini|You’re offline|Sign in)|already|offline|isn’t set up/i.test(msg);
  $('toastMsg').textContent = msg;
  $('toastIc').textContent = warn ? '!' : '✓';
  t.classList.toggle('warn', warn);
  b.hidden = !undo; b.textContent = label;
  b.onclick = e => { e.stopPropagation(); hideToast(); if (undo) undo(); };
  t.style.setProperty('--toast-ms', ms + 'ms');
  t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');   // restart the countdown bar
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { clearTimeout(toastTimer); $('toast').classList.remove('on'); }
$('toast').addEventListener('click', hideToast);

/* ================= forms ================= */
const yearOpts = sel => [...new Set([...Object.keys(S.years), String(today().getFullYear())])].sort().map(y => `<option ${y == sel ? 'selected' : ''}>${esc(y)}</option>`).join('');
const monOpts = sel => M.map((m, i) => `<option value="${i}" ${i == sel ? 'selected' : ''}>${m}</option>`).join('');
const title = t => ({inc: 'income', exp: 'expense', sav: 'savings'}[t]);

// your most used notes for one-tap shortcuts (last 4 months, used at least twice)
// your most used payees for one-tap shortcuts (last 4 months, used at least twice), with clean names
// bank reference text shown in a readable way (the saved note isn't changed): "VISAE CV_072425_767030_LAZADA" → "Lazada refund"
const showName = n => { const m = /^\s*VISAE?\s+CV_\d+_\d+_([A-Z0-9 ]+)\s*$/i.exec(n || ''); return m ? m[1].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) + ' refund' : n; };
const INC_NAMES = [['Salary', /inrem|payroll|salary|sahod|sweldo/i], ['Interest', /interest/i], ['Cashback', /cashback|rebate/i], ['Refund', /refund|reversal/i]];
const niceName = (n, t) => { if (t === 'inc') { const h = INC_NAMES.find(([, re]) => re.test(n)); if (h) return h[0]; } return merchantOf(n) || n; };
function frequent(t) {
  const cut = iso(new Date(today().getFullYear(), today().getMonth() - 4, 1)), by = {};
  for (const y of Object.keys(S.years)) S.years[y].forEach((m, i) => (m[t] || []).forEach(x => {
    if (!x.n || +x.a <= 0) return; const d = x.d || `${y}-${String(i + 1).padStart(2, '0')}-01`; if (d < cut) return;
    if (t === 'exp' && (x.c || catOf(x.n)) === 'Transfers') return;        // moving money between your accounts isn't a shortcut
    const name = niceName(x.n, t), k = name.toLowerCase(), e = by[k] = by[k] || {n: name, amts: [], c: x.c, d, cnt: 0};
    e.cnt++; e.amts.push(+x.a); if (d >= e.d) { e.d = d; if (x.c) e.c = x.c; }
  }));
  return Object.values(by).filter(e => e.cnt >= 2).sort((a, b) => b.cnt - a.cnt || (a.d < b.d ? 1 : -1)).slice(0, 8)
    .map(e => { const s = e.amts.slice().sort((p, q) => p - q); return {...e, a: s[Math.floor((s.length - 1) / 2)]}; });   // usual amount
}
// notes you've used before, most used first (for suggestions while typing)
function pastNotes() {
  const by = {};
  for (const y of Object.keys(S.years)) S.years[y].forEach(m => [...m.exp, ...m.inc].forEach(x => { if (x.n && x.n.length < 40) { const k = x.n.trim(); by[k] = (by[k] || 0) + 1; } }));
  return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 80).map(x => x[0]);
}
// a category picked for a merchant applies to its other payments too
function rememberCat(n, c) {
  const m = merchantOf(n); if (!m || !c) return;
  if (c === catOf(n) && !(S.meta.catRules || {})[m]) return;
  S.meta.catRules = {...(S.meta.catRules || {}), [m]: c};
}
// "150 jollibee yesterday" · "+25k salary" · "1.84+329 grab nov 20"
function parseQuick(text) {
  let t = ' ' + String(text).replace(/\s+/g, ' ') + ' ', m, d = null, inc = false;
  const t0 = today(); t0.setHours(0, 0, 0, 0);
  const cut = r => { t = t.slice(0, r.index) + ' ' + t.slice(r.index + r[0].length); };
  const past = (mo, dd) => { let x = mkDate(t0.getFullYear(), mo, dd); if (x > t0) x = mkDate(t0.getFullYear() - 1, mo, dd); return x; };
  if ((m = /\s(today|ngayon|yesterday|kahapon)(?=\s)/i.exec(t))) { const x = new Date(t0); if (/yesterday|kahapon/i.test(m[1])) x.setDate(x.getDate() - 1); d = iso(x); cut(m); }
  else if ((m = new RegExp(`\\s(?:on\\s+)?(${MRE})\\.?\\s+(\\d{1,2})(?=[\\s,])`, 'i').exec(t))) { d = iso(past(MON.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2])); cut(m); }
  else if ((m = /\s(?:last\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs?|rsday)?|fri(?:day)?|sat(?:urday)?)(?=\s)/i.exec(t))) { const w = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[1].toLowerCase()), x = new Date(t0); x.setDate(x.getDate() - ((x.getDay() - w + 7) % 7 || 7)); d = iso(x); cut(m); }
  let a = NaN;
  // the amount: one marked with ₱, otherwise the biggest number ("2 burgers 150" → 150)
  const re = /\s(\+)?(₱|php\s?)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?k?(?:\+(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?k?)*)(?=[\s,])/gi, all = [];
  while ((m = re.exec(t))) { all.push(m); re.lastIndex = m.index + m[0].length - 0; }
  m = all.find(x => x[2]) || all.sort((x, y) => parseAmt(y[3]) - parseAmt(x[3]))[0];
  if (m) { inc = !!m[1]; a = parseAmt(m[3]); cut(m); }
  const n = t.replace(/\s+/g, ' ').trim();
  if (/\b(salary|sahod|sweldo|payroll|income|received|refund)\b/i.test(n) && !/\bpaid\b/i.test(n)) inc = true;
  return {a, n: n ? n[0].toUpperCase() + n.slice(1) : '', d, inc};
}
function entryForm(o) {
  // o: {t, y, i, id, a, n, d, edit} — t: exp | inc | dep (savings deposit) | bill | sav (old monthly savings, edit only)
  if (o.edit && o.t === 'sav') return oldSavForm(o);
  const view = (document.querySelector('.view.on') || {}).id || '';
  let t = o.t || (view === 'v-savings' ? 'dep' : view === 'v-bills' ? 'bill' : 'exp');
  const T = {exp: 'expense', inc: 'income', dep: 'savings deposit', bill: 'bill'};
  // default date: today, or the same day inside the month you're adding to
  const tday = today(), dflt = o.d || (o.y != null ? iso(mkDate(+o.y, o.i, tday.getDate())) : iso(tday));
  const ps = pots(), billNames = uniqNames([...(S.meta.bills || []).slice().reverse().map(x => x.name), ...PRESETS]);
  const nm = new Date(tday.getFullYear(), tday.getMonth() + 1, 5);
  openSheet(`<div class="sheethead"><h2 id="efTitle">${o.edit ? 'Edit' : 'Add'} ${T[t]}</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    ${o.edit ? '' : `<div class="seg addseg">${[['exp', 'Expense'], ['inc', 'Income'], ['dep', 'Savings'], ['bill', 'Bill']].map(([k, l]) => `<button type="button" data-type="${k}" aria-pressed="${k === t}">${l}</button>`).join('')}</div>`}
    <form id="ef" novalidate>
      ${o.edit ? '' : `<div data-for="exp inc" class="quick"><div class="fqhead"><label for="fq">Type it</label><button type="button" class="plain aitalk" data-act="talk">${SPARK}Several at once</button></div><input id="fq" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="150 jollibee yesterday"><div class="chips shortcuts" data-for="exp">${frequent('exp').map((f, k) => `<button type="button" class="chip" data-sc="exp" data-k="${k}">${esc(f.n)} <small>${esc(pesoS(f.a))}</small></button>`).join('')}</div><div class="chips shortcuts" data-for="inc">${frequent('inc').map((f, k) => `<button type="button" class="chip" data-sc="inc" data-k="${k}">${esc(f.n)} <small>${esc(pesoS(f.a))}</small></button>`).join('')}</div></div>`}
      <div data-for="dep"><label for="fp">Savings account</label>${ps.length ? `<select id="fp">${ps.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>` : `<p class="note">You don’t have a savings account yet. <button type="button" class="ghost" data-act="pot-new">Add one</button></p>`}</div>
      <div data-for="bill"><label for="fbn">Bill</label><select id="fbn">${billNames.map(n => `<option>${esc(n)}</option>`).join('')}<option value="__other">Other…</option></select><input id="fbo" maxlength="40" placeholder="Name of the bill" hidden style="margin-top:8px"></div>
      <label for="fa">Amount (sums like 1.84+329 work)</label>
      <input id="fa" class="amtin" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${o.a != null ? esc(o.a) : ''}">
      <div data-for="exp inc"><label for="fn">Note</label><input id="fn" maxlength="60" enterkeyhint="done" autocomplete="off" autocorrect="off" spellcheck="false" list="fnList" placeholder="Groceries, salary, bills…" value="${esc(o.n || '')}"><datalist id="fnList">${pastNotes().map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
      <div data-for="exp"><label>Category <small class="muted" id="fcHint"></small></label><div class="chips catchips" id="fc">${CAT_NAMES.map(c => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('')}</div></div>
      <div class="two"><div><label for="fdt" id="fdtL">Date</label><input id="fdt" type="date" value="${esc(dflt)}"></div>
        <div data-for="bill"><label for="fbN">Payments</label><select id="fbN">${NOPTS.map(n => `<option value="${n}">${n === 1 ? 'Once' : n + ' months'}</option>`).join('')}</select></div></div>
      <p class="muted" id="efHint"></p>
      <button class="go" type="submit">${o.edit ? 'Save' : 'Add'}</button>
      ${o.edit ? '<button type="button" class="danger" id="fdel">Delete entry</button>' : ''}
    </form>`, body => {
    const show = () => {
      body.querySelectorAll('[data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(t); });
      $('efTitle').textContent = (o.edit ? 'Edit ' : 'Add ') + T[t];
      $('fdtL').textContent = t === 'bill' ? 'Due date' : 'Date';
      if (t === 'bill' && $('fdt').value === dflt && !o.edit) $('fdt').value = iso(nm);
      if (t !== 'bill' && $('fdt').value === iso(nm) && !o.edit) $('fdt').value = dflt;
      hint();
    };
    const hint = () => {
      const dt = $('fdt').value, h = $('efHint');
      if (!dt) { h.textContent = ''; return; }
      const [y, m] = dt.split('-');
      h.textContent = t === 'dep' ? `Shows as ${M[+m - 1]}’s Saved, not subtracted from total money.`
        : t === 'bill' ? (() => { const bm = billMonth(dt); return `Counted as an expense in ${M[bm.i]} ${bm.y} until you mark it paid.`; })()
        : `Goes into ${M[+m - 1]} ${y}.`;
    };
    body.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => { t = b.dataset.type; body.querySelectorAll('[data-type]').forEach(x => x.setAttribute('aria-pressed', x === b)); show(); }));
    $('fdt').addEventListener('input', hint);
    $('fbn').addEventListener('change', () => {
      const v = $('fbn').value; $('fbo').hidden = v !== '__other';
      const past = (S.meta.bills || []).filter(x => sameName(x.name, v)).sort((a, b) => a.due.localeCompare(b.due)).pop();
      if (past && !$('fa').value) { $('fa').value = past.a; const d = new Date(dnum(past.due)); $('fdt').value = iso(mkDate(d.getFullYear(), d.getMonth() + 1, d.getDate())); hint(); }
    });
    // category: guessed from the note until you pick one
    let cat = o.c || null, picked = !!o.c;
    const paintCat = () => {
      const g = picked ? cat : ($('fn').value.trim() ? catOf($('fn').value.trim()) : null);
      body.querySelectorAll('[data-cat]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cat === g));
      const m = merchantOf($('fn').value.trim());
      $('fcHint').textContent = picked ? (m && cat !== catOf($('fn').value.trim()) ? `· remembered for ${m}` : '') : g ? '· guessed from the note' : '';
    };
    body.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { picked = !(picked && cat === b.dataset.cat); cat = picked ? b.dataset.cat : null; paintCat(); }));
    $('fn').addEventListener('input', paintCat); paintCat();
    // quick line: "150 jollibee yesterday", "+25k salary"
    const fq = $('fq');
    if (fq) {
      fq.addEventListener('input', () => {
        const q = parseQuick(fq.value);
        if (q.inc && t === 'exp') body.querySelector('[data-type=inc]').click();
        $('fa').value = isNaN(q.a) ? '' : q.a; $('fn').value = q.n; if (q.d) $('fdt').value = q.d; else $('fdt').value = dflt;
        const f = frequent(t).find(x => q.n && sameName(x.n, q.n)); if (f && f.c && !picked) { cat = f.c; picked = true; }
        hint(); paintCat();
      });
      body.querySelectorAll('[data-sc]').forEach(b => b.addEventListener('click', () => {
        const f = frequent(b.dataset.sc)[+b.dataset.k]; if (!f) return;
        $('fn').value = f.n; $('fa').value = f.a; if (f.c) { cat = f.c; picked = true; } paintCat();
        $('fa').focus(); $('fa').select();
      }));
      setTimeout(() => fq.focus(), 50);
    }
    show();
    $('ef').addEventListener('submit', e => {
      e.preventDefault();
      const a = parseAmt($('fa').value), dt = $('fdt').value;
      const bad = isNaN(a) || (t !== 'exp' && t !== 'inc' && a <= 0); $('fa').classList.toggle('bad', bad); $('fdt').classList.toggle('bad', !dt);
      if (bad || !dt) { if (bad) $('fa').focus(); return; }
      const [y, mo] = dt.split('-'), i = +mo - 1, n = $('fn').value.trim();
      if (t === 'dep') {
        const p = potById($('fp') && $('fp').value); if (!p) return;
        if (p.kind === 'td' && (p.cycles || []).length && dt > todayIso()) {   // a future deposit after this cycle ends belongs to the forecast plan
          const end = tdCycle(p, p.cycles[p.cycles.length - 1]).end;
          if (dt >= end) { $('efHint').innerHTML = `<span class="dn">That’s after this cycle ends on ${esc(fmtDate(end))}. Future cycles come from the forecast plan; add it when the new cycle starts.</span>`; $('fdt').classList.add('bad'); return; }
        }
        closeSheet(); const undo = addDeposit(p, dt, a); commit('meta');
        toast(`${peso(a, 2)} added to ${p.name}`, () => { undo(); commit('meta'); }); return;
      }
      if (t === 'bill') {
        let name = $('fbn').value === '__other' ? $('fbo').value.trim() : $('fbn').value;
        name = ((S.meta.bills || []).find(x => sameName(x.name, name)) || {name}).name;
        if (!name) { $('fbo').classList.add('bad'); return; }
        const cnt = +$('fbN').value, d0 = new Date(dnum(dt));
        const r = putBills(name, Array.from({length: cnt}, (_, k) => ({a, due: iso(mkDate(d0.getFullYear(), d0.getMonth() + k, d0.getDate()))})));
        closeSheet(); commit(...r.keys); toast(r.msg, r.undo); return;
      }
      if (o.edit) {   // may move to another month when the date changes
        const from = S.years[o.y][o.i], k = from[t].findIndex(z => z.id === o.id); if (k < 0) return closeSheet();
        const x = from[t][k], before = {...x}, keys = new Set(['y' + o.y, 'y' + y]);
        x.a = a; x.n = n; if (o.d || dt !== dflt) x.d = dt;
        if (t === 'exp') { if (picked && cat) x.c = cat; else delete x.c; rememberCat(n, picked && cat); }
        if (y !== String(o.y) || i !== o.i) { from[t].splice(k, 1); ensureYear(y)[i][t].push(x); keys.add('meta'); }
        closeSheet(); commit(...keys); toast('Saved'); return;
      }
      const it = {id: uid(), a, n, d: dt}; if (t === 'exp' && picked && cat) { it.c = cat; rememberCat(n, cat); } ensureYear(y)[i][t].push(it); closeSheet(); commit('y' + y, 'meta');
      toast(`Added to ${M[i]}${y !== String(today().getFullYear()) ? ' ' + y : ''}`, () => { const m = S.years[y][i]; m[t] = m[t].filter(z => z.id !== it.id); commit('y' + y); });
    });
    const d = $('fdel');
    if (d) d.addEventListener('click', () => {
      const m = S.years[o.y][o.i], k = m[t].findIndex(z => z.id === o.id);
      closeSheet(); if (k < 0) return;
      const [x] = m[t].splice(k, 1); commit('y' + o.y);
      toast('Entry deleted', () => { m[t].splice(k, 0, x); commit('y' + o.y); });
    });
  });
}
// a deposit goes into the right place in the savings account; returns an undo function
function addDeposit(p, date, a) {
  const it = {id: uid(), date, a};
  if (p.kind === 'mp2') { (p.deposits = p.deposits || []).push(it); return () => { p.deposits = p.deposits.filter(x => x !== it); }; }
  if (p.kind === 'basic') { (p.txns = p.txns || []).push(it); return () => { p.txns = p.txns.filter(x => x !== it); }; }
  p.cycles = p.cycles || []; const added = [];
  if (!p.cycles.length) { p.cycles.push({start: date, end: addDays(date, p.cycleDays || 181), rate: p.rate, carry: 0, deposits: []}); added.push(p.cycles[0]); }
  // past the last cycle's end: roll over into new cycles first, like the bank does
  while (date >= tdCycle(p, p.cycles[p.cycles.length - 1]).end) { const last = tdCycle(p, p.cycles[p.cycles.length - 1]); const c = {start: last.end, end: addDays(last.end, p.cycleDays || 181), rate: p.rate, carry: Math.round(last.closing * 100) / 100, deposits: []}; p.cycles.push(c); added.push(c); }
  let c = p.cycles[0]; for (const x of p.cycles) if (x.start <= date) c = x;
  (c.deposits = c.deposits || []).push(it);
  return () => { c.deposits = c.deposits.filter(x => x !== it); p.cycles = p.cycles.filter(x => !added.includes(x)); };
}
// old-style monthly "To savings" amount (from the spreadsheet) — edit only
function oldSavForm(o) {
  openSheet(`<div class="sheethead"><h2>To savings · ${M[o.i]} ${esc(o.y)}</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <p class="muted">An amount from your spreadsheet that is subtracted from total money. New savings go into a savings account instead.</p>
    <form id="ef" novalidate><label for="fa">Amount</label><input id="fa" class="amtin" inputmode="decimal" value="${esc(o.a)}"><button class="go" type="submit">Save</button><button type="button" class="danger" id="fdel">Remove</button></form>`, () => {
    const m = S.years[o.y][o.i], old = m.sav;
    $('ef').addEventListener('submit', e => { e.preventDefault(); const a = parseAmt($('fa').value); if (isNaN(a)) return $('fa').classList.add('bad'); m.sav = a; closeSheet(); commit('y' + o.y); toast('Saved', () => { m.sav = old; commit('y' + o.y); }); });
    $('fdel').addEventListener('click', () => { m.sav = 0; closeSheet(); commit('y' + o.y); toast('Removed', () => { m.sav = old; commit('y' + o.y); }); });
  });
}

function monthHTML(y, i, ser) {
  const p = (ser || series()).find(q => q.y === y && q.i === i);
  if (!p) return '<p class="empty">Pick a month.</p>';
  return `<div class="sheethead"><h2>${M[i]} ${esc(y)}</h2><button class="ghost" data-act="add-in-month" data-y="${esc(y)}" data-i="${i}">+ Add</button></div>
    <div class="trio"><div class="tile"><span>Income</span><b class="up">${esc(peso(p.inc))}</b></div><div class="tile"><span>Spent</span><b class="dn">${esc(peso(p.exp))}</b></div><div class="tile"><span>Saved</span><b>${esc(peso(p.sav))}</b></div></div>
    <p class="muted">Total money at month end: <b style="color:var(--ink)">${esc(peso(p.total, 2))}</b></p>
    ${(S.years[y][i].inc.length || S.years[y][i].exp.length) ? aiCardHTML(`month|${y}|${i}`, 'card') : ''}
    <ul class="list">${entryRows(y, i) || '<li class="empty">No entries.</li>'}</ul>
    <button class="plain" data-act="add-dep-month" data-y="${esc(y)}" data-i="${i}">+ Add to savings</button>
    ${(S.years[y][i].inc.length || S.years[y][i].exp.length || +S.years[y][i].sav) ? `<button class="danger" data-act="month-clear" data-y="${esc(y)}" data-i="${i}">Clear ${M[i]}</button>` : ''}`;
}
let sheetMonth = null;   // month shown in the phone's bottom sheet
function monthSheet(y, i) {
  if (desk.matches) { detail = {y, i}; render(); return; }
  openSheet(monthHTML(y, i)); sheetMonth = {y, i};
}
function renderDetail(ser) {
  const ys = Object.keys(S.years);
  if (!detail || !S.years[detail.y]) {
    const now = today(), cy = String(now.getFullYear());
    detail = S.years[selYear] ? {y: selYear, i: selYear === cy ? now.getMonth() : 0} : ys.length ? {y: ys.sort()[0], i: 0} : null;
  }
  $('monthDetail').innerHTML = detail ? monthHTML(detail.y, detail.i, ser) : '<p class="empty">No months yet.</p>';
}

function billForm(j) {
  const b = j == null ? {name: '', a: '', due: '', paid: false, count: true} : S.meta.bills[j];
  const countLabel = due => { if (!due) return payCut() ? `Count as an expense (due before the ${ord(payCut())}: the month before)` : 'Count as an expense in the month before it’s due'; const m = billMonth(due); return `Count as an expense in ${M[m.i]} ${m.y}`; };
  openSheet(`<div class="sheethead"><h2>${j == null ? 'Add a bill' : 'Edit bill'}</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <form id="bf" novalidate><label for="bn">Name</label><input id="bn" maxlength="40" placeholder="SPayLater" value="${esc(b.name)}">
    <label for="ba">Amount</label><input id="ba" class="amtin" inputmode="decimal" value="${esc(b.a)}">
    <label for="bd">Due date</label><input id="bd" type="date" value="${esc(b.due)}">
    <label class="check"><input type="checkbox" id="bc" ${b.count !== false ? 'checked' : ''}><span id="bcl">${esc(countLabel(b.due))}</span></label>
    <p class="muted" style="margin:4px 0 0 34px">Stops counting once you mark it paid, so the payment from your statement isn’t counted twice.</p>
    <button class="go" type="submit">${j == null ? 'Add' : 'Save'}</button>
    ${j == null ? '' : '<button type="button" class="danger" id="bdel">Delete bill</button>'}</form>`, () => {
    $('bd').addEventListener('input', () => { $('bcl').textContent = countLabel($('bd').value); });
    $('bf').addEventListener('submit', e => {
      e.preventDefault();
      const a = parseAmt($('ba').value), d = $('bd').value, n = $('bn').value.trim();
      $('ba').classList.toggle('bad', isNaN(a)); $('bd').classList.toggle('bad', !d); $('bn').classList.toggle('bad', !n);
      if (isNaN(a) || !d || !n) return;
      const v = {name: n, a, due: d, paid: !!b.paid, count: $('bc').checked};
      if (j == null) { const r = putBills(n, [{a, due: d}], {count: v.count}); closeSheet(); commit(...r.keys); toast(r.msg, r.undo); return; }
      S.meta.bills[j] = v;
      const keys = ['meta'];
      if (v.count) { const m = billMonth(d); if (!S.years[m.y]) { ensureYear(m.y); keys.push('y' + m.y); } }
      closeSheet(); commit(...keys);
      toast(v.count ? `${j == null ? 'Bill added' : 'Bill saved'} · expense in ${M[billMonth(d).i]} ${billMonth(d).y}` : (j == null ? 'Bill added' : 'Bill saved'));
    });
    const del = $('bdel'); if (del) del.addEventListener('click', () => { closeSheet(); removeBill(j); });
  });
}
function addYear(y) {
  y = String(y); if (S.years[y]) return;
  ensureYear(y); selYear = y; if (desk.matches) detail = {y, i: 0};
  closeSheet(); commit();
  toast(`${y} added`, () => { delete S.years[y]; S.meta.years = Object.keys(S.years).sort(); commit('meta', 'y' + y); });
}
function confirmDeleteYear(y) {
  const ms = S.years[y] || [], n = ms.reduce((t, m) => t + m.inc.length + m.exp.length, 0);
  openSheet(`<div class="sheethead"><h2>Delete ${esc(y)}?</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <p>This removes all 12 months of ${esc(y)} (${n} income and expense entries plus savings amounts) from every device.</p>
    <p class="muted">It goes to the recycle bin in Settings for ${TRASH_DAYS} days, so you can restore it. Total money for later years is recalculated without it meanwhile.</p>
    <button class="go" style="background:var(--red)" data-act="year-del-yes" data-y="${esc(y)}">Delete ${esc(y)}</button>`);
}
function deleteYear(y) {
  const months = S.years[y]; if (!months) return closeSheet();
  closeSheet();
  delete S.years[y];
  S.meta.years = Object.keys(S.years).sort();
  S.meta.trash = [{y, months, at: new Date().toISOString()}, ...(S.meta.trash || []).filter(t => t.y !== y)];
  if (detail && detail.y === y) detail = null;
  commit('meta', 'y' + y);
  toast(`${y} moved to recycle bin`, () => restoreYear(y, true));
}
function removeBill(j) {
  const [x] = S.meta.bills.splice(j, 1); commit('meta');
  toast(`${x.name} removed`, () => { S.meta.bills.splice(Math.min(j, S.meta.bills.length), 0, x); commit('meta'); });
}

function acctForm(j) {
  const a = j === 'new' ? {name: '', bal: ''} : S.meta.accounts[+j];
  openSheet(`<div class="sheethead"><h2>${j === 'new' ? 'Add account' : 'Update ' + esc(a.name)}</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <form id="af" novalidate><label for="an">Name</label><input id="an" maxlength="40" value="${esc(a.name)}" placeholder="GCash, Seabank…">
    <label for="ab">Balance</label><input id="ab" class="amtin" inputmode="decimal" value="${esc(a.bal)}">
    <button class="go" type="submit">Save</button>${j === 'new' ? '' : '<button type="button" class="danger" id="adel">Remove account</button>'}</form>`, () => {
    $('af').addEventListener('submit', e => {
      e.preventDefault();
      const b = parseAmt($('ab').value), n = $('an').value.trim();
      $('ab').classList.toggle('bad', isNaN(b)); $('an').classList.toggle('bad', !n);
      if (isNaN(b) || !n) return;
      const v = {name: n, bal: b, asof: today().toLocaleDateString('en-PH', {month: 'short', day: 'numeric', year: 'numeric'})};
      S.meta.accounts = S.meta.accounts || [];
      if (j === 'new') S.meta.accounts.push(v); else S.meta.accounts[+j] = v;
      closeSheet(); commit('meta');
    });
    const d = $('adel'); if (d) d.addEventListener('click', () => {
      const [x] = S.meta.accounts.splice(+j, 1); closeSheet(); commit('meta');
      toast(`${x.name} removed`, () => { S.meta.accounts.splice(+j, 0, x); commit('meta'); });
    });
  });
}

/* ---- show / hide password: an eye button on every password field, including ones added later ---- */
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function addReveal(inp) {
  if (inp.dataset.reveal) return; inp.dataset.reveal = '1';
  const wrap = document.createElement('span'); wrap.className = 'pwwrap'; inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'pweye'; btn.innerHTML = EYE; btn.setAttribute('aria-label', 'Show password'); btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => {
    const show = inp.type === 'password'; inp.type = show ? 'text' : 'password';
    btn.innerHTML = show ? EYE_OFF : EYE; btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); btn.setAttribute('aria-pressed', String(show));
    const end = inp.value.length; inp.focus(); try { inp.setSelectionRange(end, end); } catch {}
  });
  wrap.appendChild(btn);
  inp.form && inp.form.addEventListener('submit', () => { inp.type = 'password'; btn.innerHTML = EYE; btn.setAttribute('aria-pressed', 'false'); });
}
document.querySelectorAll('input[type=password]').forEach(addReveal);
new MutationObserver(() => document.querySelectorAll('input[type=password]:not([data-reveal])').forEach(addReveal)).observe(document.body, {childList: true, subtree: true});
/* ---- look: theme, accent colour, colourful surfaces (this device) ---- */
const ACCENTS = [['blue', 'Blue', '#2f7fd0'], ['teal', 'Teal', '#14a396'], ['purple', 'Purple', '#8b5cf6'], ['pink', 'Pink', '#e2468e'], ['orange', 'Orange', '#ea6a26'], ['green', 'Green', '#22a052']];
const look = () => ({theme: 'system', accent: 'blue', style: 'plain', ...(store.get('pera:look') || {})});
function applyLook() {
  const L = look(), R = document.documentElement;
  if (L.theme === 'system') delete R.dataset.theme; else R.dataset.theme = L.theme;
  if (L.accent === 'blue') delete R.dataset.accent; else R.dataset.accent = L.accent;
  if (L.style === 'colorful') R.dataset.style = 'colorful'; else delete R.dataset.style;
  requestAnimationFrame(() => { const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = getComputedStyle(R).getPropertyValue('--bg').trim(); });
}
applyLook();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyLook);
function settings() {
  const n = dirty.size;
  openSheet(`<div class="sheethead"><h2>Settings</h2><button type="button" class="ghost" data-act="close">Done</button></div>
    <p class="muted">Signed in as <b style="color:var(--ink)">${esc(user && user.email)}</b></p>
    <div class="note">${syncState === 'idle' ? 'Everything is synced.' : `${n} change${n === 1 ? '' : 's'} saved on this phone, waiting to upload.`}
      ${syncErr ? `<br><span class="dn">${syncErr.auth ? 'Your sign-in expired. Sign out and back in; nothing on this phone is lost.' : esc(syncErr.msg)}</span>` : pushing ? `<br><span class="muted">Uploading now (${Math.round((Date.now() - pushStart) / 1000)}s)…</span>` : ''}
      ${lastSynced ? `<br><span class="muted">Last synced ${esc(new Date(lastSynced).toLocaleString('en-PH', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}))}</span>` : ''}</div>
    ${syncErr && syncErr.auth ? '<button class="go" data-act="signout">Sign in again</button>' : ''}
    <button class="go" data-act="sync-now">Sync now</button>
    <button class="ghost wide" data-act="change-pw">Change password</button>
    ${aiSettingsHTML()}
    <h2>Look</h2>
    <label>Theme</label>
    <div class="seg lookseg">${[['system', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-act="look" data-k="theme" data-v="${k}" aria-pressed="${look().theme === k}">${l}</button>`).join('')}</div>
    <label>Colour</label>
    <div class="swatches">${ACCENTS.map(([k, l, c]) => `<button class="swatch" style="background:${c}" data-act="look" data-k="accent" data-v="${k}" aria-pressed="${look().accent === k}" aria-label="${l}" title="${l}"></button>`).join('')}</div>
    <div class="switchrow"><span><b>Colourful</b><br><span class="muted">Tints cards and the top of the screen with your colour.</span></span>
      <button class="switch" role="switch" aria-checked="${look().style === 'colorful'}" data-act="look" data-k="style" data-v="${look().style === 'colorful' ? 'plain' : 'colorful'}" aria-label="Colourful"></button></div>
    <h2>App lock</h2>
    <div class="switchrow"><span><b>Lock with fingerprint</b><br><span class="muted">Asks for your fingerprint or face when you open Pera and after a minute away. This device only.</span></span>
      <button class="switch" role="switch" aria-checked="${!!lockState}" data-act="lock-toggle" aria-label="Lock with fingerprint"></button></div>
    <h2>Bills</h2>
    <label for="payCut">Which month a bill counts in</label>
    <select id="payCut">${[[15, 'Paid 15th & 30th: due on the 15th or later counts that month'], ...[5, 10, 20, 25].map(d => [d, `Due on the ${ord(d)} or later counts that month`]), [0, 'Always the month before it’s due']].map(([v, l]) => `<option value="${v}" ${payCut() === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <p class="muted" id="payCutEx"></p>
    <h2>Bank statements</h2>
    <button class="go" data-act="statement">Import a bank statement</button>
    <p class="muted">Excel, PDF or CSV from your bank, GCash or Maya, including password-locked ones.</p>
    <h2>Recycle bin</h2>
    ${binHTML()}
    <h2>Copies on this device</h2>
    ${(() => { const sn = store.get(kSnaps()) || []; return sn.length ? `<p class="muted">Pera keeps a copy here before syncing replaces anything. Restoring brings that copy back and syncs it to your other devices.</p><ul class="list">${sn.map((x, i) => { const sv = (x.data.meta.savings || []).map(p => p.name).join(', '); return `<li><span class="rowbtn" style="cursor:default"><span class="t">${esc(new Date(x.at).toLocaleString('en-PH', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}))}<small>${Object.keys(x.data.years).sort().join(', ') || 'no years'}${sv ? ' · savings: ' + esc(sv) : ' · no savings'} · ${(x.data.meta.bills || []).length} bills</small></span></span><button class="ghost" data-act="snap-restore" data-k="${i}">Restore</button></li>`; }).join('')}</ul>` : '<p class="muted">None yet. Pera saves one here before syncing replaces anything.</p>'; })()}
    <h2>Backup</h2>
    <label class="go filebtn" style="color:var(--on-blue);margin:0">Import or restore from backup (.json)<input type="file" id="importFile" accept=".json,application/json"></label>
    <button class="plain" data-act="export">Export backup</button>
    <h2>Install on your phone</h2>
    <p class="muted"><b>iPhone:</b> in Safari tap Share → Add to Home Screen.<br><b>Android:</b> in Chrome tap ⋮ → Install app (or Add to Home screen).</p>
    <button class="danger" data-act="signout">Sign out</button>`, () => {
    const ex = () => { const c = payCut(); $('payCutEx').textContent = c ? `A bill due Jan ${c} counts in January; one due Jan ${Math.max(1, c - 10)} counts in December, paid from the 30th.` : 'A bill due Jan 16 counts in December.'; };
    ex();
    $('payCut').addEventListener('change', () => {
      const old = S.meta.payCut; S.meta.payCut = +$('payCut').value;
      const keys = new Set(['meta']); (S.meta.bills || []).forEach(b => { if (b.due) { const m = billMonth(b.due); if (!S.years[m.y]) { ensureYear(m.y); keys.add('y' + m.y); } } });
      commit(...keys); ex(); toast('Bills moved to their new months', () => { S.meta.payCut = old; commit('meta'); settings(); });
    });
    $('importFile').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { importData(JSON.parse(await f.text())); }
      catch (err) { toast('That file isn’t a Pera backup'); }
    });
  });
}
let pendingImport = null;
function importData(d) {
  if (d && d.pera === 'savings') return importSavingsFile(d);
  if (!d || typeof d !== 'object' || !d.meta || !d.years) throw new Error('bad');
  for (const [y, ms] of Object.entries(d.years)) if (!/^\d{4}$/.test(y) || !Array.isArray(ms) || ms.length !== 12 || !ms.every(m => Array.isArray(m.inc) && Array.isArray(m.exp))) throw new Error('bad');
  pendingImport = d;
  if (!Object.keys(S.years).length) return importApply('all');
  const missing = Object.keys(d.years).filter(y => !S.years[y]).sort();
  openSheet(`<div class="sheethead"><h2>Import backup</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <p class="muted">The file has ${esc(Object.keys(d.years).sort().join(', '))}. You have ${esc(Object.keys(S.years).sort().join(', '))}.</p>
    ${missing.length ? `<button class="go" data-act="imp-missing">Add missing years only: ${esc(missing.join(', '))}</button><p class="muted">Keeps everything you have now, including bills and edits.</p>` : '<p class="note">You already have every year in this file.</p>'}
    <button class="danger" data-act="imp-all">Replace everything with this file</button>`);
}
function importApply(mode) {
  const d = pendingImport; if (!d) return; pendingImport = null; closeSheet();
  const before = JSON.parse(JSON.stringify(S));
  if (mode === 'missing') {
    const add = Object.keys(d.years).filter(y => !S.years[y]);
    add.forEach(y => { S.years[y] = d.years[y]; });
    S.meta.trash = (S.meta.trash || []).filter(t => !add.includes(t.y));
    S.meta.years = Object.keys(S.years).sort();
    commit('meta', ...add.map(y => 'y' + y));
    toast(`Restored ${add.join(', ')}`, () => { add.forEach(y => delete S.years[y]); S.meta = before.meta; commit('meta', ...add.map(y => 'y' + y)); });
    return;
  }
  const gone = Object.keys(S.years).filter(y => !d.years[y]);
  S = {meta: Object.assign(blank().meta, d.meta), years: d.years};
  S.meta.years = Object.keys(S.years).sort();
  migrateSavings();
  commit('meta', ...S.meta.years.map(y => 'y' + y), ...gone.map(y => 'y' + y));
  toast(`Imported ${S.meta.years.join(', ')}`, () => { S = before; commit('meta', ...Object.keys(S.years).map(y => 'y' + y), ...Object.keys(d.years).map(y => 'y' + y)); });
}
/* ---------- recycle bin for deleted years ---------- */
function purgeTrash() {
  const cut = Date.now() - TRASH_DAYS * 864e5, t = S.meta.trash || [];
  const keep = t.filter(x => Date.parse(x.at) > cut);
  if (keep.length !== t.length) { S.meta.trash = keep; dirty.add('meta'); saveLocal(); }
}
function binHTML() {
  const t = S.meta.trash || [], left = at => Math.max(0, Math.ceil((Date.parse(at) + TRASH_DAYS * 864e5 - Date.now()) / 864e5));
  const cyc = (S.meta.savings || []).flatMap(p => (p.trash || []).map((x, i) => ({p, x, i})));
  if (!t.length && !cyc.length) return '<p class="muted">Empty. Deleted years and savings cycles stay here for ' + TRASH_DAYS + ' days.</p>';
  const days = at => `${left(at)} day${left(at) === 1 ? '' : 's'} left`;
  return '<ul class="list">' + t.map(x => {
    const n = x.months.reduce((a, m) => a + m.inc.length + m.exp.length, 0);
    return `<li><span class="rowbtn" style="cursor:default"><span class="dot s">${esc(x.y.slice(2))}</span><span class="t">Year ${esc(x.y)}<small>${n} entries · deleted ${esc(fmtDate(x.at.slice(0, 10)))} · ${days(x.at)}</small></span></span>
      <button class="ghost" data-act="bin-restore" data-y="${esc(x.y)}">Restore</button><button class="x" data-act="bin-forever" data-y="${esc(x.y)}" aria-label="Delete ${esc(x.y)} forever">×</button></li>`;
  }).join('') + cyc.map(({p, x, i}) => {
    const c = tdCycle(p, x.cycle);
    return `<li><span class="rowbtn" style="cursor:default"><span class="dot s">₱</span><span class="t">${esc(p.name)} · ${esc(fmtDate(x.cycle.start, {month: 'short', year: 'numeric'}))} cycle<small>${esc(peso(c.closing))} at maturity · ${days(x.at)}</small></span></span>
      <button class="ghost" data-act="cyc-restore" data-p="${esc(p.id)}" data-k="${i}">Restore</button><button class="x" data-act="cyc-forever" data-p="${esc(p.id)}" data-k="${i}" aria-label="Delete cycle for good">×</button></li>`;
  }).join('') + '</ul>';
}
function restoreYear(y, quiet) {
  const it = (S.meta.trash || []).find(t => t.y === y); if (!it) return;
  if (S.years[y]) { toast(`${y} already exists. Delete it first to restore the old one.`); return; }
  S.years[y] = it.months;
  S.meta.trash = S.meta.trash.filter(t => t !== it);
  S.meta.years = Object.keys(S.years).sort();
  if (sheetOpen) closeSheet();
  selYear = y;
  commit('meta', 'y' + y);
  if (!quiet) toast(`${y} restored`);
}
function forgetYear(y) {
  const t = S.meta.trash || [], k = t.findIndex(x => x.y === y); if (k < 0) return;
  const [it] = t.splice(k, 1); commit('meta');
  settings();
  toast(`${y} deleted forever`, () => { S.meta.trash.splice(k, 0, it); commit('meta'); settings(); });
}
function exportData() {
  const blob = new Blob([JSON.stringify(S, null, 1)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pera-backup-${today().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---- Excel (.xlsx), including password-locked files — no libraries, all in the browser ---- */
const u8 = b => b instanceof Uint8Array ? b : new Uint8Array(b);
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}
async function readZip(buf) {
  const b = u8(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), files = {};
  let e = b.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This Excel file looks damaged.');
  let p = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true);
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const data = b.subarray(start, start + csize);
    files[name] = () => method === 0 ? Promise.resolve(data) : inflateRaw(data);
    p += 46 + nl + xl + cl;
  }
  return files;
}
async function xlsxToTable(buf) {
  const z = await readZip(buf), txt = async n => z[n] ? new TextDecoder().decode(await z[n]()) : '';
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const shared = [...xml(await txt('xl/sharedStrings.xml')).getElementsByTagName('si')].map(si => [...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  // first sheet in the workbook
  const wb = xml(await txt('xl/workbook.xml')), first = wb.getElementsByTagName('sheet')[0];
  let target = 'xl/worksheets/sheet1.xml';
  if (first) {
    const rid = first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rel = [...xml(await txt('xl/_rels/workbook.xml.rels')).getElementsByTagName('Relationship')].find(r => r.getAttribute('Id') === rid);
    if (rel) { const t = rel.getAttribute('Target'); target = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''); }
  }
  const col = ref => { let c = 0; for (const ch of ref.replace(/\d+/g, '')) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; };
  return [...xml(await txt(target)).getElementsByTagName('row')].map(r => {
    const out = [];
    for (const c of r.getElementsByTagName('c')) {
      const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0];
      out[col(c.getAttribute('r') || 'A')] = t === 's' ? shared[+(v && v.textContent)] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map(x => x.textContent).join('') : v ? v.textContent : '';
    }
    return Array.from(out, x => x ?? '');
  });
}
// Locked Excel files are an encrypted package inside an OLE "compound file" (MS-OFFCRYPTO agile encryption)
function readCfb(buf) {
  const b = u8(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ss = 1 << dv.getUint16(0x1E, true), mss = 1 << dv.getUint16(0x20, true), cutoff = dv.getUint32(0x38, true);
  const sec = n => b.subarray((n + 1) * ss, (n + 2) * ss), u32 = (a, i) => new DataView(a.buffer, a.byteOffset).getUint32(i * 4, true);
  const fatSecs = [];
  for (let i = 0; i < 109; i++) { const s = dv.getUint32(0x4C + i * 4, true); if (s < 0xFFFFFFFA) fatSecs.push(s); }
  for (let d = dv.getUint32(0x44, true), k = dv.getUint32(0x48, true); k-- > 0 && d < 0xFFFFFFFA;) { const s = sec(d); for (let i = 0; i < ss / 4 - 1; i++) { const x = u32(s, i); if (x < 0xFFFFFFFA) fatSecs.push(x); } d = u32(s, ss / 4 - 1); }
  const fat = []; fatSecs.forEach(f => { const s = sec(f); for (let i = 0; i < ss / 4; i++) fat.push(u32(s, i)); });
  const chain = (start, table) => { const out = []; for (let x = start, g = 0; x < 0xFFFFFFFA && g < 1e6; x = table[x], g++) out.push(x); return out; };
  const join = parts => { const o = new Uint8Array(parts.reduce((t, p) => t + p.length, 0)); let k = 0; parts.forEach(p => { o.set(p, k); k += p.length; }); return o; };
  const dir = join(chain(dv.getUint32(0x30, true), fat).map(sec)), entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const d = new DataView(dir.buffer, dir.byteOffset + o, 128), nl = d.getUint16(0x40, true);
    entries.push({name: new TextDecoder('utf-16le').decode(dir.subarray(o, o + Math.max(0, nl - 2))), type: dir[o + 0x42], start: d.getUint32(0x74, true), size: d.getUint32(0x78, true)});
  }
  const root = entries.find(e => e.type === 5), miniFat = [];
  chain(dv.getUint32(0x3C, true), fat).forEach(f => { const s = sec(f); for (let i = 0; i < ss / 4; i++) miniFat.push(u32(s, i)); });
  const mini = root ? join(chain(root.start, fat).map(sec)) : new Uint8Array();
  const read = name => {
    const e = entries.find(x => x.name === name && x.type === 2); if (!e) return null;
    if (e.size < cutoff) return join(chain(e.start, miniFat).map(n => mini.subarray(n * mss, (n + 1) * mss))).subarray(0, e.size);
    return join(chain(e.start, fat).map(sec)).subarray(0, e.size);
  };
  return {read};
}
const HASHES = {SHA1: 'SHA-1', 'SHA-1': 'SHA-1', SHA256: 'SHA-256', 'SHA-256': 'SHA-256', SHA384: 'SHA-384', 'SHA-384': 'SHA-384', SHA512: 'SHA-512', 'SHA-512': 'SHA-512'};
const cat = (...a) => { const o = new Uint8Array(a.reduce((t, x) => t + x.length, 0)); let k = 0; a.forEach(x => { o.set(x, k); k += x.length; }); return o; };
const le32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function aesCbcNoPad(keyBytes, iv, data) {
  // WebCrypto insists on PKCS#7 padding, so append one block that decrypts to a full padding block
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const tail = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-CBC', iv: data.slice(data.length - 16)}, key, new Uint8Array(16).fill(16))).slice(0, 16);
  return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-CBC', iv}, key, cat(data, tail)));
}
async function decryptXlsx(buf, password, onStatus) {
  const cfb = readCfb(buf), info = cfb.read('EncryptionInfo'), pkg = cfb.read('EncryptedPackage');
  if (!info || !pkg) throw new Error('This is an old-style .xls file. Open it in Excel or Google Sheets and save it as .xlsx or CSV.');
  const ver = new DataView(info.buffer, info.byteOffset).getUint16(0, true);
  if (ver !== 4) throw new Error('This Excel file uses an older lock. Open it in Excel, then save a copy without a password or as CSV.');
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(info.subarray(8)), 'application/xml');
  const kd = doc.getElementsByTagName('keyData')[0], ek = [...doc.getElementsByTagName('*')].find(e => e.localName === 'encryptedKey');
  if (!kd || !ek) throw new Error('This Excel lock type isn’t supported. Save it as CSV and import that.');
  const hashName = HASHES[ek.getAttribute('hashAlgorithm')] || 'SHA-512', H = d => crypto.subtle.digest(hashName, d).then(r => new Uint8Array(r));
  const pw = new Uint8Array(password.length * 2); for (let i = 0; i < password.length; i++) { const c = password.charCodeAt(i); pw[i * 2] = c & 255; pw[i * 2 + 1] = c >> 8; }
  const spin = +ek.getAttribute('spinCount') || 100000, keyBits = +ek.getAttribute('keyBits') || 256;
  let h = await H(cat(b64(ek.getAttribute('saltValue')), pw));
  for (let i = 0; i < spin; i++) { h = await H(cat(le32(i), h)); if (onStatus && i % 20000 === 0) onStatus(Math.round(i / spin * 100)); }
  const fit = (x, n) => x.length >= n ? x.slice(0, n) : cat(x, new Uint8Array(n - x.length).fill(0x36));
  const keyKey = fit(await H(cat(h, new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]))), keyBits / 8);
  let secret;
  try { secret = (await aesCbcNoPad(keyKey, b64(ek.getAttribute('saltValue')), b64(ek.getAttribute('encryptedKeyValue')))).slice(0, (+kd.getAttribute('keyBits') || 256) / 8); }
  catch { throw Object.assign(new Error('That password didn’t work.'), {name: 'PasswordException'}); }
  const size = new DataView(pkg.buffer, pkg.byteOffset).getUint32(0, true), data = pkg.subarray(8), salt = b64(kd.getAttribute('saltValue')), bs = +kd.getAttribute('blockSize') || 16;
  const kdHash = HASHES[kd.getAttribute('hashAlgorithm')] || 'SHA-512', parts = [];
  for (let i = 0, o = 0; o < data.length; i++, o += 4096) {
    const iv = new Uint8Array(await crypto.subtle.digest(kdHash, cat(salt, le32(i)))).slice(0, bs);
    let seg = data.subarray(o, Math.min(o + 4096, data.length)); if (seg.length % 16) seg = cat(seg, new Uint8Array(16 - seg.length % 16));
    parts.push(await aesCbcNoPad(secret, iv, seg));
  }
  const out = cat(...parts).subarray(0, size);
  if (out[0] !== 0x50 || out[1] !== 0x4B) throw Object.assign(new Error('That password didn’t work.'), {name: 'PasswordException'});
  return out;
}

/* ================= statement import: CSV, PDF, pasted text ================= */
// Everything runs in the browser. The statement file is never uploaded; only the rows you import are saved.
const MONTHS3 = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const AMT_RE = /(?:₱|PHP|Php|P)?\s?-?\(?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?![\d-])|(?:₱|PHP|Php)\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?(?![\d-])|P(?=\d)-?\d+(?:\.\d{1,2})?(?![\d-])/g;
const OUT_WORDS = /\b(debit|dr|sent|send|you sent|payment|paid|pay|purchase|pos|bought|buy|withdraw(?:al)?|cash ?out|transfer(?:red)? to|to account|fee|charge|bills?|load|deduct|atm|instapay to|pesonet to|qr ph payment|scan to pay|visa|mastercard|mc|card purchase|online purchase)\b/i;
const IN_WORDS = /\b(credit|cr|received|receive|you received|deposit|cash ?in|refund|interest|salary|payroll|transfer(?:red)? from|from account|incoming|reversal|cashback|rebate|instapay from|pesonet from)\b/i;

function toNum(s) {
  if (s == null) return NaN;
  s = String(s).trim(); if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /-/.test(s.replace(/^[^\d-]*/, '').slice(0, 1)) || /^-/.test(s.replace(/[₱P\s]|PHP|Php/g, ''));
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  return isNaN(n) ? NaN : (neg ? -n : n);
}
// dates: 2026-11-05 · 11/05/2026 · 05 Nov 2026 · Nov 05, 2026 · Nov 5 · 05-Nov-26
function parseDateStr(s, fallbackYear) {
  s = String(s || '').trim(); let m;
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 30000 && +s < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5); return iso(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
  const Y = y => !y ? fallbackYear : +y < 100 ? 2000 + +y : +y;
  const ok = (y, mo, d) => (mo >= 0 && mo < 12 && d >= 1 && d <= 31) ? iso(mkDate(y, mo, d)) : null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return ok(+m[1], +m[2] - 1, +m[3]);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s))) return ok(Y(m[3]), +m[1] - 1, +m[2]);       // PH banks use MM/DD/YYYY
  if ((m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{2,4})?/.exec(s)) && MONTHS3.includes(m[2].slice(0, 3).toLowerCase())) return ok(Y(m[3]), MONTHS3.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1]);
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/.exec(s)) && MONTHS3.includes(m[1].slice(0, 3).toLowerCase())) return ok(Y(m[3]), MONTHS3.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]);
  return null;
}
const DATE_AT_START = /^\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}[\s-]+[A-Za-z]{3,9}\.?(?:[\s,-]+\d{2,4})?|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)?/i;

/* ---- text lines (PDF / paste) → rows ---- */
// lines are plain strings (paste) or {text, items:[{x, w, s}]} from a PDF, which lets us use Debit/Credit column positions
const OUT_HEAD = /^(debit|debits|withdrawals?|money out|outflow|paid out|amount out|sent|dr)$/i, IN_HEAD = /^(credit|credits|deposits?|money in|inflow|amount in|received|cr)$/i, BAL_HEAD = /^(running )?balance$/i;
const DRCR = /^\s*(DR|CR|D|C)\b/;
const NOT_DESC = /page \d|for billing|customer service|transaction history|account (number|name)|statement|print|^date\b|balance$|unionbank/i;
function rowsFromLines(lines) {
  lines = lines.map(l => typeof l === 'string' ? {text: l, items: null} : l);
  // a transaction can wrap over several lines (date + ref, description, then amount + balance):
  // keep adding lines to it until one of them carries an amount
  const merged = []; let cur = null;
  for (const L of lines) {
    const t = L.text.replace(/\s+/g, ' ').trim(); if (!t) continue;
    if (DATE_AT_START.test(t) && parseDateStr(DATE_AT_START.exec(t)[1], 2000)) { cur = {text: t, items: L.items ? [...L.items] : null, open: !(t.match(AMT_RE) || []).length}; merged.push(cur); continue; }
    if (cur && cur.open) { cur.text += ' ' + t; if (cur.items && L.items) cur.items.push(...L.items); if ((t.match(AMT_RE) || []).length) cur.open = false; continue; }
    // a short line with no amount right after a transaction is the rest of its description ("CITY PH", "246229")
    if (cur && !cur.open && !(t.match(AMT_RE) || []).length && t.length <= 48 && !NOT_DESC.test(t) && (cur.extra = (cur.extra || 0) + 1) <= 2) { cur.tail = ((cur.tail || '') + ' ' + t).trim(); continue; }
    cur = null; merged.push({text: t, items: L.items});
  }
  merged.forEach(m => { if (m.tail) m.tailText = m.tail; });
  lines = merged;
  const yearHint = (lines.map(l => l.text).join(' ').match(/\b20\d{2}\b/) || [String(today().getFullYear())])[0];
  const raw = []; let cols = null;
  for (const L of lines) {
    const line = L.text.replace(/\s+/g, ' ').trim();
    if (L.items) {   // remember where the Debit / Credit / Balance headings sit on the page
      const c = x => x.x + (x.w || 0) / 2, o = L.items.find(i => OUT_HEAD.test(i.s.trim())), n = L.items.find(i => IN_HEAD.test(i.s.trim())), b = L.items.find(i => BAL_HEAD.test(i.s.trim()));
      if (o && n) { cols = {out: c(o), inn: c(n), bal: b ? c(b) : null}; continue; }
    }
    const dm = DATE_AT_START.exec(line); if (!dm) continue;
    const date = parseDateStr(dm[1], +yearHint); if (!date) continue;
    let rest = line.slice(dm[0].length);
    const found = [...rest.matchAll(AMT_RE)].map(x => ({s: x[0], end: x.index + x[0].length}));
    if (!found.length) continue;
    const hasBal = found.length >= 2, am = hasBal ? found[found.length - 2] : found[0];
    const a = toNum(am.s), bal = hasBal ? toNum(found[found.length - 1].s) : null;
    if (isNaN(a) || a === 0) continue;
    let hint = null;
    if (a < 0 || /^\s*-/.test(am.s) || /^\(/.test(am.s.trim())) hint = 'exp';
    const suf = DRCR.exec(rest.slice(am.end)); if (!hint && suf) hint = /^D/i.test(suf[1]) ? 'exp' : 'inc';
    if (!hint && /^\s*\+/.test(am.s)) hint = 'inc';
    if (!hint && cols && L.items) {   // which column is the amount printed under?
      const num = am.s.replace(/[^\d.,]/g, ''), cands = L.items.filter(i => i.s.replace(/[^\d.,]/g, '').endsWith(num) && /\d/.test(i.s));
      const item = cands.length > 1 && cols.bal != null ? cands.reduce((p, q) => Math.abs(q.x - cols.bal) > Math.abs(p.x - cols.bal) ? q : p) : cands[0];
      if (item) { const x = item.x + (item.w || 0) / 2; hint = Math.abs(x - cols.out) < Math.abs(x - cols.inn) ? 'exp' : 'inc'; }
    }
    found.forEach(x => { rest = rest.replace(x.s, ' '); });
    let desc = rest.replace(/\b(PHP|Php)\b/g, '').replace(/\b(DR|CR)\b/g, '').replace(/\s+/g, ' ').replace(/^[\s|:-]+|[\s|:-]+$/g, '');
    desc = desc.split(' ').filter(w => !/^[A-Za-z]{0,4}\d[\w-]{4,}$/.test(w) || !/\d{4,}/.test(w.replace(/-/g, ''))).join(' ').replace(/\s+/g, ' ').trim();
    if (L.tailText) desc = (desc + ' ' + L.tailText.split(' ').filter(w => !/\d{4,}/.test(w.replace(/[-_]/g, ''))).join(' ')).replace(/\s+/g, ' ').trim();
    desc = desc.slice(0, 80);
    const isBalLine = /\b(starting|beginning|opening|ending|closing|available|running|previous)\s+balance\b|^balance\b|^total\b|balance (brought|carried) forward/i.test(desc);
    raw.push({date, desc, a: Math.abs(a), bal: isNaN(bal) ? null : bal, hint, isBalLine});
  }
  // running balances: figure out whether the statement is oldest-first or newest-first, then read direction from the change
  const fits = (prev, r) => prev == null || r.bal == null ? null : Math.abs(prev + r.a - r.bal) < 0.02 ? 'inc' : Math.abs(prev - r.a - r.bal) < 0.02 ? 'exp' : null;
  const score = list => { let p = null, n = 0; for (const r of list) { if (!r.isBalLine && fits(p, r)) n++; if (r.bal != null) p = r.bal; } return n; };
  const fwd = score(raw), rev = score([...raw].reverse()), order = rev > fwd ? [...raw].reverse() : raw;
  let prev = null;
  for (const r of order) { if (!r.isBalLine && !r.hint) r.byBal = fits(prev, r); if (r.bal != null) prev = r.bal; }
  return raw.filter(r => !r.isBalLine).map(r => {
    const dir = r.hint || r.byBal || (IN_WORDS.test(r.desc) && !OUT_WORDS.test(r.desc) ? 'inc' : OUT_WORDS.test(r.desc) ? 'exp' : 'exp');
    return {date: r.date, desc: r.desc || (dir === 'inc' ? 'Money in' : 'Money out'), a: r.a, dir};
  });
}

/* ---- CSV ---- */
function parseCSV(text) {
  const out = []; let row = [], cell = '', q = false;
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out.filter(r => r.some(x => x.trim()));
}
function guessColumns(header) {
  const h = header.map(x => x.toLowerCase().trim()), find = (re, skip = []) => h.findIndex((x, k) => re.test(x) && !skip.includes(k));
  const date = find(/date|posted|time/);
  const desc = [/desc|detail|particular|narrat|remark|memo/, /merchant|payee|name|transaction/, /reference/].map(re => find(re, [date])).find(k => k >= 0) ?? -1;
  return {
    date,
    desc,
    out: find(/debit|withdraw|money out|amount out|paid out|outflow|sent/),
    inn: find(/credit|deposit|money in|amount in|inflow|received/),
    amt: find(/^amount|amount \(|amt|value|total/),
    type: find(/^type$|dr\/cr|cr\/dr|direction|txn type|transaction type/),
  };
}
function rowsFromTable(table, cols) {
  const fy = today().getFullYear(), rows = [];
  for (const r of table) {
    const date = parseDateStr(r[cols.date], fy); if (!date) continue;
    let a = NaN, dir = null;
    if (cols.out >= 0 || cols.inn >= 0) {
      const o = cols.out >= 0 ? toNum(r[cols.out]) : NaN, i = cols.inn >= 0 ? toNum(r[cols.inn]) : NaN;
      if (!isNaN(o) && o !== 0) { a = Math.abs(o); dir = 'exp'; } else if (!isNaN(i) && i !== 0) { a = Math.abs(i); dir = 'inc'; }
    }
    if (isNaN(a) && cols.amt >= 0) {
      const cell = String(r[cols.amt]), v = toNum(cell);
      if (!isNaN(v) && v !== 0) { a = Math.abs(v); dir = v < 0 || /\bD(R|EBIT)?\b/i.test(cell) ? 'exp' : /\bC(R|REDIT)?\b/i.test(cell) || /^\s*\+/.test(cell) ? 'inc' : null; }
    }
    if (isNaN(a)) continue;
    const desc = (cols.desc >= 0 ? r[cols.desc] : '').trim().slice(0, 80);
    if (!dir && cols.type >= 0) { const t = String(r[cols.type]).toLowerCase(); dir = /\b(dr|d|debit|out|outgoing|sent|send|payment|withdraw|purchase|transfer to)/.test(t) ? 'exp' : /\b(cr|c|credit|in|incoming|received|receive|deposit|cash in|refund)/.test(t) ? 'inc' : null; }
    if (!dir) dir = IN_WORDS.test(desc) && !OUT_WORDS.test(desc) ? 'inc' : 'exp';
    rows.push({date, desc: desc || (dir === 'inc' ? 'Money in' : 'Money out'), a, dir, guessed: true});
  }
  return rows;
}

/* ---- PDF (pdf.js, loaded only when needed) ---- */
let pdfLib = null;
function loadPdfJs() {
  if (pdfLib) return pdfLib;
  pdfLib = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/pdfjs/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = () => { pdfLib = null; rej(new Error('Couldn’t load the PDF reader. Check your connection.')); };
    document.head.appendChild(s);
  });
  return pdfLib;
}
async function pdfLines(buf, password) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({data: buf, password, isEvalSupported: false, disableFontFace: true}).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent(), rows = new Map();
    for (const it of tc.items) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;                     // group items on the same line
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({x: it.transform[4], w: it.width || 0, s: it.str});
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => { items.sort((a, b) => a.x - b.x); lines.push({text: items.map(i => i.s).join(' '), items}); });
  }
  return lines;
}

/* ---- the import sheet ---- */
let imp = null;   // {rows, source}
/* ================= screenshots: read the text on this device, then turn it into bills or expenses ================= */
let tessP = null;
function loadTess() {
  if (window.Tesseract) return Promise.resolve();
  return tessP = tessP || new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/tess/tesseract.min.js'; sc.onload = res; sc.onerror = () => { tessP = null; rej(new Error('Couldn’t load the screenshot reader. Check your connection and try again.')); }; document.head.appendChild(sc); });
}
async function ocrImages(files, progress) {
  await loadTess();
  const base = new URL('vendor/tess/', location.href).href;
  const w = await Tesseract.createWorker('eng', 1, {workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true, workerBlobURL: false,
    logger: m => { if (m.status === 'recognizing text') progress(Math.round(m.progress * 100)); }});
  const out = [];
  try { for (const f of files) { const r = await w.recognize(f); out.push(r.data.text || ''); } } finally { w.terminate(); }
  return out;
}
// amounts need centavos (₱1,570.90) so times and dates aren't mistaken for money; the ₱ is often read as P, $, £, # or r
const SHOT_AMT = /(?:^|[\s(:])(?:[₱P$£#rRF€]\s?|PHP\s?)?(-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d+\.\d{2})(?![\d%])/g;
const shotAmts = l => [...l.matchAll(SHOT_AMT)].map(m => parseFloat(m[1].replace(/,/g, '')));
function shotDate(l) {
  let m;
  if ((m = new RegExp(`(${MRE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`, 'i').exec(l))) return iso(mkDate(+m[3], MON.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]));
  if ((m = new RegExp(`(\\d{1,2})\\s+(${MRE})\\.?,?\\s+(20\\d{2})`, 'i').exec(l))) return iso(mkDate(+m[3], MON.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1]));
  if ((m = /(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(l))) return iso(mkDate(+m[1], +m[2] - 1, +m[3]));
  if ((m = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(l))) return iso(mkDate(+m[3], +m[1] - 1, +m[2]));
  return null;
}
const SKIP_AMT = /total|payable|balance|limit|available|minimum|credit line|outstanding|savings|cashback|points|voucher/i;
function shotBills(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean), used = new Set(), out = [];
  lines.forEach((l, k) => {
    if (!/\bdue\b/i.test(l)) return; const due = shotDate(l); if (!due) return;
    let a = null;
    const take = j => { if (j < 0 || j >= lines.length || used.has(j) || SKIP_AMT.test(lines[j])) return false; const v = shotAmts(lines[j]).filter(x => x > 0); if (!v.length) return false; if (j !== k && /\bdue\b/i.test(lines[j]) && shotDate(lines[j])) return false; a = v[v.length - 1]; used.add(j); return true; };
    take(k) || take(k - 1) || take(k - 2) || take(k + 1);
    if (a != null) out.push({due, a});
  });
  return out;
}
// a single payment / receipt screenshot (GCash, Maya, bank app)
function shotReceipt(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const amtLine = lines.find(l => /amount|total|paid|sent|you (paid|sent)/i.test(l) && shotAmts(l).length && !SKIP_AMT.test(l.replace(/total amount/i, ''))) || null;
  const all = lines.filter(l => !SKIP_AMT.test(l) || /total amount|amount paid/i.test(l)).flatMap(shotAmts).filter(x => x > 0);
  const a = amtLine ? shotAmts(amtLine).pop() : all.length ? Math.max(...all) : NaN;
  if (!(a > 0)) return null;
  const date = lines.map(shotDate).find(Boolean) || todayIso();
  let desc = '';
  for (const l of lines) { const m = /(?:paid to|sent to|send to|transfer to|merchant|pay to|to)\s*[:\-]?\s*(.{3,40})/i.exec(l); if (m && !/\d{4,}/.test(m[1])) { desc = m[1].replace(/[>›]+$/, '').trim(); break; } }
  const inc = /received|you got|cash ?in|refund/i.test(text) && !/paid|sent|payment/i.test(text);
  return {date, a, desc: desc || 'Screenshot', dir: inc ? 'inc' : 'exp'};
}
// which bill is this? a name in the text, else the bill that's usually due on that day of the month
function guessBillName(text, rows) {
  const names = uniqNames([...(S.meta.bills || []).map(b => b.name), ...PRESETS]), lo = text.toLowerCase().replace(/\s+/g, '');
  const hit = names.find(n => lo.includes(n.toLowerCase().replace(/\s+/g, ''))); if (hit) return hit;
  if (/shopee|spaylater/i.test(text)) return 'SPayLater'; if (/lazada/i.test(text)) return 'Lazada PayLater'; if (/maya/i.test(text)) return 'Maya Black';
  const day = rows.length ? new Date(dnum(rows[0].due)).getDate() : null, by = {};
  (S.meta.bills || []).forEach(b => { if (b.due && new Date(dnum(b.due)).getDate() === day) by[b.name] = (by[b.name] || 0) + (b.due > rows[0].due.slice(0, 4) - 1 + '' ? 2 : 1); });
  return Object.entries(by).sort((p, q) => q[1] - p[1]).map(x => x[0])[0] || '';
}
async function readShots(files, fail, busy) {
  try {
    busy('Reading screenshot… 0%');
    const texts = await ocrImages(files, pct => busy(`Reading screenshot${files.length > 1 ? 's' : ''}… ${pct}%`));
    busy('');
    const bills = texts.flatMap(t => shotBills(t).map(r => ({...r, text: t})));
    if (bills.length) return billShotReview(bills);
    const rows = texts.flatMap(t => { const r = rowsFromLines(t.split(/\r?\n/)); if (r.length) return r; const one = shotReceipt(t); return one ? [one] : []; });
    if (rows.length) return reviewRows(rows, 'screenshot');
    fail('Couldn’t find amounts with dates in this screenshot. Make sure the amounts and dates are visible, or type it instead.');
  } catch (e) { busy(''); fail(e.message || 'Couldn’t read this screenshot.'); }
}
let shot = null;   // {rows, name}
function billShotReview(rows) {
  const byText = {}; rows.forEach(r => { (byText[r.text] = byText[r.text] || []).push(r); });
  const name = guessBillName(Object.keys(byText)[0], rows);
  const seen = new Set(); rows = rows.filter(r => { const k = r.due + '|' + r.a; if (seen.has(k)) return false; seen.add(k); return true; }).sort((p, q) => p.due.localeCompare(q.due));
  shot = {rows: rows.map(r => ({due: r.due, a: r.a, on: true})), name};
  const names = uniqNames([...(S.meta.bills || []).slice().reverse().map(x => x.name), ...PRESETS]);
  openSheet(`<div class="sheethead"><h2>Bills from screenshot</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <label for="shName">Which bill is this?</label>
    <select id="shName">${name ? '' : '<option value="">Choose…</option>'}${names.map(n => `<option ${sameName(n, name) ? 'selected' : ''}>${esc(n)}</option>`).join('')}<option value="__other">Other…</option></select>
    <input id="shOther" maxlength="40" placeholder="Name of the bill" hidden style="margin-top:8px">
    <p class="muted" id="shHint">${name ? 'Guessed from the due dates. Change it if it’s wrong.' : ''}</p>
    <ul class="list implist" id="shList"></ul><p class="muted" id="shSum"></p>
    <button class="go" id="shGo" data-act="shot-go"></button>`, () => {
    $('shName').addEventListener('change', () => { $('shOther').hidden = $('shName').value !== '__other'; $('shHint').textContent = ''; renderShot(); });
    $('shOther').addEventListener('input', renderShot);
    renderShot();
  });
}
const shotName = () => $('shName').value === '__other' ? $('shOther').value.trim() : $('shName').value;
function renderShot() {
  const nm = shotName(), bills = S.meta.bills || [];
  const taken = new Set();
  shot.rows.forEach(r => { const ex = nm ? findBill(nm, r.due, taken) : null; if (ex) taken.add(ex); r.ex = ex || null; r.st = !ex ? 'new' : Math.abs(+ex.a - r.a) < 0.005 && ex.due === r.due ? 'same' : 'update'; if (r.touched == null) r.on = r.st !== 'same'; });
  $('shList').innerHTML = shot.rows.map((r, k) => `<li class="${r.on ? '' : 'off'}"><button class="chk ${r.on ? 'on' : ''}" data-act="shot-tog" data-k="${k}" aria-label="${r.on ? 'Skip' : 'Include'} bill due ${esc(fmtDate(r.due))}"><span>${r.on ? '✓' : ''}</span></button>
    <span class="t">Due ${esc(fmtDate(r.due))}<small>${r.st === 'same' ? 'Already in Pera' : r.st === 'update' ? `Updates ${Math.abs(+r.ex.a - r.a) >= 0.005 ? `${esc(peso(+r.ex.a, 2))} → ${esc(peso(r.a, 2))}` : 'amount'}${r.ex.due !== r.due ? ` · due ${esc(fmtDate(r.ex.due, {month: 'short', day: 'numeric'}))} → ${esc(fmtDate(r.due, {month: 'short', day: 'numeric'}))}` : ''}${r.ex.paid ? ' · marked paid' : ''}` : (() => { const m = billMonth(r.due); return `New · counted in ${M[m.i].slice(0, 3)} ${m.y}`; })()}</small></span>
    <span class="amt">${esc(peso(r.a, 2))}</span></li>`).join('');
  const on = shot.rows.filter(r => r.on);
  $('shSum').textContent = on.length ? `${on.length} bill${on.length === 1 ? '' : 's'} · ${peso(on.reduce((t, r) => t + r.a, 0), 2)}` : 'Nothing selected.';
  $('shGo').textContent = !nm ? 'Choose which bill first' : !on.length && shot.rows.every(r => r.st === 'same') ? 'All already in Pera' : on.length ? `Save ${on.length} ${nm} bill${on.length === 1 ? '' : 's'}` : 'Save';
  $('shGo').disabled = !nm || !on.length;
}
function saveShot() {
  const nm = shotName(); if (!nm || !shot) return;
  const r = putBills(nm, shot.rows.filter(x => x.on).map(x => ({a: x.a, due: x.due})));
  shot = null; closeSheet(); commit(...r.keys); toast(r.msg, r.undo);
}
function scanPicker() {   // straight to the photo picker (Bills tab, Add sheet)
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
  inp.addEventListener('change', () => {
    const files = [...inp.files]; if (!files.length) return;
    openSheet(`<div class="sheethead"><h2>Reading screenshot</h2><button type="button" class="ghost" data-act="close">Cancel</button></div><p class="muted" id="scBusy">Starting…</p><div class="err" id="stErr"></div>`);
    readShots(files, m => { const e = $('stErr'); if (e) e.textContent = m; const b = $('scBusy'); if (b) b.textContent = ''; }, m => { const b = $('scBusy'); if (b && m) b.textContent = m; });
  });
  inp.click();
}
function statementSheet() {
  openSheet(`<div class="sheethead"><h2>Import a statement</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <p class="muted">Works with Excel, PDF or CSV statements from your bank, GCash or Maya, including password-locked ones, or text you paste from transaction emails and texts. The file stays on this device; only rows you import are saved.</p>
    <label class="go filebtn" style="color:var(--on-blue);margin-top:8px">Choose Excel, PDF or CSV file<input type="file" id="stFile" accept=".csv,.pdf,.xlsx,.xls,.txt,text/csv,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"></label>
    <label class="ghost filebtn shotbtn">Scan screenshots<input type="file" id="stShot" accept="image/*" multiple></label>
    <p class="muted">Bill schedules (SPayLater, Lazada PayLater…), GCash or Maya receipts, transaction lists. Read on this device; the picture isn’t saved.</p>
    <div id="stPw" hidden><label for="stPass" id="stPwL">This file is locked. Enter its password</label><input id="stPass" type="password" autocomplete="off"><button class="go" type="button" id="stPwGo">Open</button>
      <p class="muted">Banks and e-wallets usually say what the password is in the email that came with the statement. It’s only used to open the file on this device and is never saved.</p></div>
    <label for="stPaste">Or paste transactions</label>
    <textarea id="stPaste" rows="4" placeholder="Nov 5, 2026  Sent to Juan  500.00&#10;11/06/2026  Salary  28,910.88"></textarea>
    <button class="plain" type="button" id="stPasteGo">Read pasted text</button>
    <div class="err" id="stErr"></div>`, () => {
    let pending = null;   // {kind, buf} waiting for a password
    const fail = m => { $('stErr').textContent = m; };
    const busy = m => { $('stErr').innerHTML = m ? `<span class="muted">${esc(m)}</span>` : ''; };
    const askPw = (kind, buf, wrong) => { pending = {kind, buf}; $('stPw').hidden = false; $('stPwL').textContent = `This ${kind === 'pdf' ? 'PDF' : 'Excel file'} is locked. Enter its password`; $('stPass').value = ''; $('stPass').focus(); if (wrong) fail('That password didn’t work. Try again.'); else busy(''); };
    const readPdf = async (buf, pw) => {
      busy('Reading PDF…');
      try { const rows = rowsFromLines(await pdfLines(buf.slice(0), pw)); busy(''); rows.length ? reviewRows(rows, 'PDF') : fail('No transactions found in this PDF. Try the Excel or CSV version, or paste the rows.'); }
      catch (e) { if (e && e.name === 'PasswordException') askPw('pdf', buf, !!pw); else fail(e.message || 'Couldn’t read this PDF.'); }
    };
    const readXlsx = async (buf, pw) => {
      try {
        let bytes = u8(buf);
        if (bytes[0] === 0xD0 && bytes[1] === 0xCF) {              // locked (or old .xls)
          if (pw == null) {
            const c = readCfb(buf);
            if (!c.read('EncryptionInfo')) throw new Error('This is an old-style .xls file. Open it in Excel or Google Sheets and save it as .xlsx or CSV.');
            return askPw('xlsx', buf);
          }
          busy('Unlocking… 0%');
          bytes = await decryptXlsx(buf, pw, pct => busy(`Unlocking… ${pct}%`));
        }
        busy('Reading spreadsheet…');
        const table = (await xlsxToTable(bytes)).map(r => r.map(c => String(c)));
        busy(''); mapCsv(table);
      } catch (e) { if (e && e.name === 'PasswordException') askPw('xlsx', buf, true); else fail(e.message || 'Couldn’t read this Excel file.'); }
    };
    $('stFile').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return; fail('');
      const buf = new Uint8Array(await f.arrayBuffer());
      if (/^image\//.test(f.type) || (buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xFF && buf[1] === 0xD8)) return readShots([f], fail, busy);
      if (buf[0] === 0x25 && buf[1] === 0x50) return readPdf(buf);                               // %PDF
      if ((buf[0] === 0x50 && buf[1] === 0x4B) || (buf[0] === 0xD0 && buf[1] === 0xCF)) return readXlsx(buf);   // xlsx zip / locked
      const text = new TextDecoder().decode(buf);
      if (/\.csv$/i.test(f.name) || text.split('\n').slice(0, 8).some(l => (l.match(/[,;]/g) || []).length >= 2)) return mapCsv(parseCSV(text));
      const rows = rowsFromLines(text.split(/\r?\n/)); rows.length ? reviewRows(rows, 'file') : fail('No transactions found in this file.');
    });
    $('stShot').addEventListener('change', e => { const f = [...e.target.files]; if (f.length) { fail(''); readShots(f, fail, busy); } });
    $('stPwGo').addEventListener('click', () => { if (!pending) return; const {kind, buf} = pending; kind === 'pdf' ? readPdf(buf, $('stPass').value) : readXlsx(buf, $('stPass').value); });
    $('stPass').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('stPwGo').click(); } });
    $('stPasteGo').addEventListener('click', () => {
      const rows = rowsFromLines($('stPaste').value.split(/\r?\n/));
      rows.length ? reviewRows(rows, 'pasted text') : fail('Each line needs a date and an amount, like “Nov 5 Sent to Juan 500.00”.');
    });
  });
}
function mapCsv(table) {
  const hi = table.findIndex(r => r.filter(c => /date|amount|debit|credit|desc|detail|particular/i.test(c)).length >= 2);
  if (hi < 0) { const rows = rowsFromLines(table.map(r => r.join(' '))); return rows.length ? reviewRows(rows, 'CSV') : ($('stErr').textContent = 'Couldn’t find a date or amount column in this CSV.'); }
  const header = table[hi], body = table.slice(hi + 1), g = guessColumns(header);
  const opt = (sel, none) => `${none ? '<option value="-1">—</option>' : ''}${header.map((h, k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(h || 'Column ' + (k + 1))}</option>`).join('')}`;
  openSheet(`<div class="sheethead"><h2>Match the columns</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <p class="muted">Pera guessed these from the file’s headings. Fix any that are wrong.</p>
    <div class="two"><div><label for="cDate">Date</label><select id="cDate">${opt(g.date)}</select></div><div><label for="cDesc">Description</label><select id="cDesc">${opt(g.desc, 1)}</select></div></div>
    <div class="two"><div><label for="cOut">Money out (debit)</label><select id="cOut">${opt(g.out, 1)}</select></div><div><label for="cIn">Money in (credit)</label><select id="cIn">${opt(g.inn, 1)}</select></div></div>
    <div class="two"><div><label for="cAmt">Single amount column</label><select id="cAmt">${opt(g.out < 0 && g.inn < 0 ? g.amt : -1, 1)}</select></div><div><label for="cType">Debit / credit type</label><select id="cType">${opt(g.type, 1)}</select></div></div>
    <p class="muted" id="cPrev"></p>
    <button class="go" id="cGo" type="button">Continue</button>`, () => {
    const cols = () => ({date: +$('cDate').value, desc: +$('cDesc').value, out: +$('cOut').value, inn: +$('cIn').value, amt: +$('cAmt').value, type: +$('cType').value});
    const prev = () => { const n = rowsFromTable(body, cols()).length; $('cPrev').textContent = `${n} of ${body.length} rows have a date and an amount.`; $('cGo').disabled = !n; };
    ['cDate', 'cDesc', 'cOut', 'cIn', 'cAmt', 'cType'].forEach(id => $(id).addEventListener('change', prev)); prev();
    $('cGo').addEventListener('click', () => reviewRows(rowsFromTable(body, cols()), 'CSV'));
  });
}
/* duplicates: each existing entry can only match one statement row
   same   — same amount, same day and same description (or imported before with that description) → unticked
   likely — same amount within 3 days and the same shop as something you typed → unticked
   maybe  — same amount within 1 day, different note → stays ticked, flagged */
const words = n => new Set(String(n || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(' ').filter(w => w.length > 2 && !/^(pos|purchase|payment|visa|online|inc|corp|the|and|for|from|with)$/.test(w)));
function markDups(rows) {
  const used = new Set();
  const near = r => { const out = [], d0 = new Date(dnum(r.date));
    for (const k of [-1, 0, 1]) { const d = new Date(d0.getFullYear(), d0.getMonth() + k, 1), y = String(d.getFullYear()), m = S.years[y] && S.years[y][d.getMonth()];
      if (m) m[r.dir].forEach(x => out.push({x, y, i: d.getMonth(), dd: Math.abs(Math.round((dnum(x.d || `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-15`) - dnum(r.date)) / 864e5)), dated: !!x.d})); }
    return out.filter(c => Math.abs(+c.x.a - r.a) < 0.005); };
  const level = (r, c) => {
    if (c.x.n && c.x.n === r.desc && (c.dd === 0 || (c.x.src === 'import' && c.dd <= 3))) return 'same';
    if (!c.dated) return null;
    const a = words(c.x.n), b = words(r.desc), mr = merchantOf(r.desc), mx = merchantOf(c.x.n || '');
    const shop = (mr && mx && mr === mx) || [...a].some(w => b.has(w)) || (c.x.n && r.desc.toLowerCase().includes(c.x.n.toLowerCase()));
    if (shop && c.dd <= 3) return 'likely';
    if (c.dd <= 1 && c.x.src !== 'import') return 'maybe';
    return null;
  };
  rows.forEach(r => { r.dup = null; r.dupOf = null; });
  for (const lv of ['same', 'likely', 'maybe']) for (const r of rows) {
    if (r.dup) continue;
    const c = near(r).filter(c => !used.has(c.x.id) && level(r, c) === lv).sort((p, q) => p.dd - q.dd)[0];
    if (c) { used.add(c.x.id); r.dup = lv; r.dupOf = `${c.x.n || 'No note'} · ${fmtDate(c.x.d || `${c.y}-${String(c.i + 1).padStart(2, '0')}-01`, c.x.d ? {month: 'short', day: 'numeric'} : {month: 'long'})}`; }
  }
}
function reviewRows(rows, source) {
  rows.sort((p, q) => p.date.localeCompare(q.date));
  markDups(rows); rows.forEach(r => { r.on = !r.dup || r.dup === 'maybe'; });
  imp = {rows, source};
  openSheet(`<div class="sheethead"><h2>Review ${rows.length} transactions</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <p class="muted">Tap ↓ / ↑ to switch money in or out. Untick anything you don’t want. Rows already in Pera are unticked.</p><p class="dupsum" id="impDup"></p>
    <div class="imptools"><button class="ghost" data-act="imp-all-on">Select all</button><button class="ghost" data-act="imp-all-off">Select none</button><button class="ghost" data-act="imp-flip" style="margin-left:auto">⇅ Flip all</button></div>
    <ul class="list implist" id="impList"></ul>
    <p class="muted" id="impSum"></p>
    <button class="go" id="impGo" data-act="imp-go"></button>`, () => renderReview());
}
function renderReview() {
  if (!imp) return;
  $('impList').innerHTML = imp.rows.map((r, k) => `<li class="${r.on ? '' : 'off'}">
    <button class="chk ${r.on ? 'on' : ''}" data-act="imp-tog" data-k="${k}" aria-label="${r.on ? 'Skip' : 'Include'} ${esc(r.desc)}"><span>${r.on ? '✓' : ''}</span></button>
    <span class="t">${esc(r.desc)}<small>${esc(fmtDate(r.date))}</small>${r.dup ? `<small class="dupnote ${r.dup}">${r.dup === 'same' ? 'Already in Pera' : r.dup === 'likely' ? 'Looks like what you added' : 'Maybe already added'}: ${esc(r.dupOf)}</small>` : ''}</span>
    <button class="dirbtn ${r.dir}" data-act="imp-dir" data-k="${k}" aria-label="Switch to ${r.dir === 'inc' ? 'money out' : 'money in'}">${r.dir === 'inc' ? '↓ +' : '↑ −'}${esc(peso(r.a, 2))}</button></li>`).join('');
  const on = imp.rows.filter(r => r.on), inc = on.filter(r => r.dir === 'inc').reduce((t, r) => t + r.a, 0), exp = on.filter(r => r.dir === 'exp').reduce((t, r) => t + r.a, 0);
  const months = [...new Set(on.map(r => r.date.slice(0, 7)))].sort().map(k => `${M[+k.slice(5) - 1].slice(0, 3)} ${k.slice(0, 4)}`);
  $('impSum').textContent = on.length ? `Money in ${peso(inc, 2)} · money out ${peso(exp, 2)} · ${months.join(', ')}` : 'Nothing selected.';
  $('impGo').textContent = on.length ? `Import ${on.length} transaction${on.length === 1 ? '' : 's'}` : 'Import';
  $('impGo').disabled = !on.length;
  const ds = imp.rows.filter(r => r.dup === 'same').length, dl = imp.rows.filter(r => r.dup === 'likely').length, dm = imp.rows.filter(r => r.dup === 'maybe').length;
  $('impDup').innerHTML = ds + dl + dm ? [ds && `<b>${ds}</b> already in Pera`, dl && `<b>${dl}</b> look like entries you added by hand`, dm && `<b>${dm}</b> might be (still ticked, check them)`].filter(Boolean).join(' · ') : '';
}
function importRows() {
  const on = imp.rows.filter(r => r.on); if (!on.length) return;
  const keys = new Set(['meta']), made = [];
  for (const r of on) {
    const [y, mo] = r.date.split('-');
    if (!S.years[y]) ensureYear(y);
    const it = {id: uid(), a: Math.round(r.a * 100) / 100, n: r.desc, d: r.date, src: 'import'};
    S.years[y][+mo - 1][r.dir].push(it); made.push([y, +mo - 1, r.dir, it.id]); keys.add('y' + y);
  }
  imp = null; closeSheet(); commit(...keys);
  toast(`Imported ${made.length} transaction${made.length === 1 ? '' : 's'}`, () => {
    made.forEach(([y, i, t, id]) => { const m = S.years[y] && S.years[y][i]; if (m) m[t] = m[t].filter(x => x.id !== id); });
    commit(...keys);
  });
}

/* ================= one click handler for everything ================= */
function showView(v) {
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  document.querySelectorAll('.tab[data-v]').forEach(x => x.dataset.v === v ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current'));
  window.scrollTo(0, 0);
  if (v === 'home') drawChart();
  store.set('pera:tab', v);
  enterView(v);
}
document.addEventListener('click', e => {
  const tab = e.target.closest('.tab[data-v]'); if (tab) return showView(tab.dataset.v);
  const el = e.target.closest('[data-act]'); if (!el) return;
  const d = el.dataset, j = d.j;
  switch (d.act) {
    case 'close': return closeSheet();
    case 'look': {
      store.set('pera:look', {...look(), [d.k]: d.v}); applyLook();
      if (d.k === 'style') { el.setAttribute('aria-checked', d.v === 'colorful'); el.dataset.v = d.v === 'colorful' ? 'plain' : 'colorful'; }
      else document.querySelectorAll(`[data-act=look][data-k=${d.k}]`).forEach(b => b.setAttribute('aria-pressed', b.dataset.v === d.v));
      drawChart(); return;
    }
    case 'snap-restore': {
      const sn = (store.get(kSnaps()) || [])[+d.k]; if (!sn) return;
      snapshot('force');                                   // keep what we have now too
      const before = JSON.parse(JSON.stringify(S)), oldYears = Object.keys(S.years);
      S = JSON.parse(JSON.stringify(sn.data));
      closeSheet(); commit('meta', ...Object.keys(S.years).map(y => 'y' + y), ...oldYears.filter(y => !S.years[y]).map(y => 'y' + y));
      toast('Copy restored', () => { S = before; commit('meta', ...Object.keys(S.years).map(y => 'y' + y)); }); return;
    }
    case 'ins-p': insP = d.k; store.set('pera:insP', insP); return renderInsights(series());
    case 'ins-y': insYear = d.y; return renderInsights(series());
    case 'ins-tr': insTr = !insTr; store.set('pera:insTr', insTr); return renderInsights(series());
    case 'ins-cat': return catSheet(d.c);
    case 'nudge-cat': insP = 'month'; render(); return catSheet(d.c);
    case 'go-view': showView(d.v); render(); return;
    case 'goal-new': return goalNew();
    case 'report': return reportSheet(d.r);
    case 'search': return searchSheet();
    case 'ask': return askSheet();
    case 'ask-q': return askPera(d.q);
    case 'ask-goal': return goalNew(+d.a);
    case 'ask-fresh': { const m = chat[chat.length - 1]; if (m && m.cached) chat.pop(); const last = [...chat].reverse().find(x => x.role === 'user'); if (last) askPera(last.text, true, true); return; }
    case 'ask-retry': { const last = [...chat].reverse().find(m => m.role === 'user'); if (chat.length && chat[chat.length - 1].err) chat.pop(); if (last) askPera(last.text, true); return; }
    case 'sort-spend': return sortSpending();
    case 'sort-tog': { const r = sortSug && sortSug[+d.k]; if (r) { r.on = !r.on; renderSort(); } return; }
    case 'sort-apply': return applySort();
    case 'ai-card': return writeAiCard(d.id);
    case 'talk': return talkSheet($('fq') ? $('fq').value : '');
    case 'talk-go': return talkRead();
    case 'talk-tog': { const r = talk && talk[+d.k]; if (r) { r.on = !r.on; renderTalk(); } return; }
    case 'talk-add': return talkAdd();
    case 'ai-check': return aiCheck();
    case 'change-pw': return newPasswordSheet(false);
    case 'sr-f': srch.f = d.k; document.querySelectorAll('[data-act=sr-f]').forEach(b => b.setAttribute('aria-pressed', b.dataset.k === d.k)); return runSearch();
    case 'rep-months': repState.months = +d.n; return reportSheet('trend');
    case 'rep-flow': repState.months = +d.n; return reportSheet('flow');
    case 'cal-mv': { const c = repState.cal; const nd = new Date(c.y, c.i + +d.d, 1); repState.cal = {y: nd.getFullYear(), i: nd.getMonth()}; return reportSheet('cal'); }
    case 'goal-open': return goalSheet(d.g, false);
    case 'goal-edit': return goalSheet(d.g, true);
    case 'goal-del': {
      const k = goals().findIndex(x => x.id === d.g); if (k < 0) return;
      const [x] = goals().splice(k, 1); closeSheet(); commit('meta');
      toast(`${x.name} deleted`, () => { goals().splice(k, 0, x); commit('meta'); }); return;
    }
    case 'cat-pick': return catPick(d.m, d.c);
    case 'cat-set': {
      const rules = S.meta.catRules = {...(S.meta.catRules || {})}, old = rules[d.m];
      if (d.c) rules[d.m] = d.c; else delete rules[d.m];
      commit('meta'); closeSheet();
      toast(d.c ? `${d.m} → ${d.c}` : `${d.m} sorted automatically`, () => { if (old) rules[d.m] = old; else delete rules[d.m]; commit('meta'); }); return;
    }
    case 'lock-toggle': { if (lockState) { disableLock(); settings(); } else enableLock().then(() => settings()); return; }
    case 'eye': hideTotal = !hideTotal; store.set('pera:hideTotal', hideTotal); render(); return;
    case 'fab': closeSheet(); return entryForm({});
    case 'settings': return settings();
    case 'edit-entry': { const x = S.years[d.y][+d.i][d.t].find(z => z.id === d.id); if (x) entryForm({t: d.t, y: d.y, i: +d.i, id: d.id, a: x.a, n: x.n, d: x.d, c: x.c, edit: true}); return; }
    case 'edit-sav': return entryForm({t: 'sav', y: d.y, i: +d.i, a: S.years[d.y][+d.i].sav || '', edit: true});
    case 'goto-month': { showView('months'); selYear = d.y; render(); return monthSheet(d.y, +d.i); }
    case 'add-in-month': return entryForm({y: d.y, i: +d.i});
    case 'add-dep-month': return entryForm({t: 'dep', y: d.y, i: +d.i});
    case 'entry-del': {
      const m = S.years[d.y][+d.i], list = m[d.t], k = list.findIndex(z => z.id === d.id); if (k < 0) return;
      const [x] = list.splice(k, 1); commit('y' + d.y);
      toast(`${x.n || (d.t === 'inc' ? 'Income' : 'Expense')} deleted`, () => { list.splice(k, 0, x); commit('y' + d.y); }); return;
    }
    case 'sav-del': { const m = S.years[d.y][+d.i], old = m.sav; m.sav = 0; commit('y' + d.y); toast(`Savings for ${M[+d.i]} removed`, () => { m.sav = old; commit('y' + d.y); }); return; }
    case 'month-clear': {
      const y = d.y, i = +d.i, old = S.years[y][i];
      S.years[y][i] = {inc: [], exp: [], sav: 0}; commit('y' + y);
      toast(`${M[i]} ${y} cleared`, () => { S.years[y][i] = old; commit('y' + y); }); return;
    }
    case 'month': return monthSheet(selYear, +d.i);
    case 'year':
      if (d.y === '+' || d.y === '-') {
        const ys = Object.keys(S.years).map(Number), cy = today().getFullYear();
        const y = String(!ys.length ? cy : d.y === '-' ? Math.min(...ys) - 1 : Math.max(...ys) + 1);
        return (S.meta.trash || []).some(t => t.y === y) ? restoreYear(y) : addYear(y);
      }
      else { selYear = d.y; if (desk.matches) detail = {y: d.y, i: detail && detail.y === d.y ? detail.i : 0}; render(); }
      return;
    case 'year-del': return confirmDeleteYear(d.y);
    case 'year-del-yes': return deleteYear(d.y);
    case 'bin-restore': return restoreYear(d.y);
    case 'bin-forever': return forgetYear(d.y);
    case 'imp-missing': return importApply('missing');
    case 'statement': return statementSheet();
    case 'imp-tog': { const r = imp && imp.rows[+d.k]; if (r) { r.on = !r.on; renderReview(); } return; }
    case 'imp-dir': { const r = imp && imp.rows[+d.k]; if (r) { r.dir = r.dir === 'inc' ? 'exp' : 'inc'; markDups(imp.rows); r.on = !r.dup || r.dup === 'maybe'; renderReview(); } return; }
    case 'imp-all-on': if (imp) { imp.rows.forEach(r => { r.on = true; }); renderReview(); } return;
    case 'imp-all-off': if (imp) { imp.rows.forEach(r => { r.on = false; }); renderReview(); } return;
    case 'imp-go': return importRows();
    case 'shot-go': return saveShot();
    case 'shot-tog': { const r = shot && shot.rows[+d.k]; if (r) { r.on = !r.on; r.touched = true; renderShot(); } return; }
    case 'scan': return scanPicker();
    case 'imp-flip': if (imp) { imp.rows.forEach(r => { r.dir = r.dir === 'inc' ? 'exp' : 'inc'; }); markDups(imp.rows); imp.rows.forEach(r => { r.on = !r.dup || r.dup === 'maybe'; }); renderReview(); } return;
    case 'imp-all': return importApply('all');
    case 'year-add': return addYear(d.y);
    case 'pot-open': case 'pot-new': case 'pot-edit': case 'pot-cycle': case 'cycle-new': case 'cycle-next': case 'dep-del': case 'dep-edit': case 'dep-cancel': case 'cyc-edit': case 'cyc-cancel': case 'cyc-del': case 'cyc-restore': case 'cyc-forever': case 'plan-edit': case 'plan-cancel': case 'fc-rate': case 'fc-rate-cancel': case 'fc-rate-reset': return savingsAct(d);
    case 'fc-years': fcYears = +d.n; store.set('pera:fcYears', fcYears); renderSavings(); return;
    case 'acct': return acctForm(j);
    case 'bill-pay': {
      const b = S.meta.bills[+j]; b.paid = !b.paid; commit('meta');
      if (b.count !== false && b.due) { const m = billMonth(b.due); toast(b.paid ? `${b.name} paid · no longer counted in ${M[m.i].slice(0, 3)} ${m.y}` : `${b.name} unpaid · counted in ${M[m.i].slice(0, 3)} ${m.y} again`); }
      return;
    }
    case 'bills-late-paid': {
      const t = todayIso(), late = (S.meta.bills || []).filter(x => !x.paid && x.due && x.due < t); if (!late.length) return;
      late.forEach(x => { x.paid = true; }); commit('meta');
      toast(`${late.length} past-due bill${late.length === 1 ? '' : 's'} marked paid`, () => { late.forEach(x => { x.paid = false; }); commit('meta'); }); return;
    }
    case 'bill-group': return billGroupSheet(d.n);
    case 'bill-group-del': {
      const before = S.meta.bills.slice(), gone = S.meta.bills.filter(x => sameName(x.name, d.n)); if (!gone.length) return;
      S.meta.bills = S.meta.bills.filter(x => !sameName(x.name, d.n)); closeSheet(); commit('meta');
      toast(`${gone.length} ${d.n} payment${gone.length === 1 ? '' : 's'} deleted`, () => { S.meta.bills = before; commit('meta'); }); return;
    }
    case 'bill-edit': return billForm(+j);
    case 'bill-del': return removeBill(+j);
    case 'bill-add': return billForm(null);
    case 'qb-name': { const q = $('qb'); q.value = d.n + ' '; q.focus(); quickPreview(); return; }
    case 'sync-now': pull().then(() => push()).then(() => { closeSheet(); toast(!dirty.size && !syncErr ? 'Synced' : !navigator.onLine ? 'Offline — will sync when you’re back online' : syncErr ? (syncErr.auth ? 'Couldn’t sync: sign-in expired. Sign in again in Settings' : `Couldn’t sync: ${syncErr.msg}`) : 'Couldn’t sync yet — will retry'); }); return;
    case 'export': return exportData();
    case 'signout': closeSheet(); return sb.auth.signOut();
  }
});
$('fab').dataset.act = 'fab';
$('addBill').dataset.act = 'bill-add';
$('qb').addEventListener('input', quickPreview);
$('pkName').addEventListener('change', onPickName);
['pkAmt', 'pkOther'].forEach(id => $(id).addEventListener('input', quickPreview));
['pkMon', 'pkDay', 'pkN'].forEach(id => $(id).addEventListener('change', quickPreview));
$('qbMode').addEventListener('click', () => setQbMode(qbMode === 'pick' ? 'type' : 'pick'));
$('qbForm').addEventListener('submit', e => { e.preventDefault(); quickAdd(); });
fillPicker(); setQbMode(qbMode);
$('settingsBtn').dataset.act = 'settings';
addEventListener('scroll', () => { const h = document.querySelector('header.top'); if (h) h.classList.toggle('scrolled', scrollY > 4); }, {passive: true});

document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey || sheetOpen || !user) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  e.preventDefault(); entryForm({});
});
desk.addEventListener('change', () => { closeSheet(); if (user) render(); });


/* ================= app lock: fingerprint / face unlock via a passkey on this device ================= */
// Locks the screen on open and after a minute in the background. It hides the app; it doesn't encrypt stored data.
const LOCK_KEY = 'pera:lock', LOCK_AFTER = 60 * 1000;
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
let lockState = store.get(LOCK_KEY), locked = false, hiddenAt = 0, unlocking = false;
async function lockSupported() {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
}
async function enableLock() {
  if (!(await lockSupported())) { toast('This device or browser can’t use fingerprint unlock'); return false; }
  try {
    const cred = await navigator.credentials.create({publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: {name: 'Pera', id: location.hostname},
      user: {id: new TextEncoder().encode((user && user.id) || 'pera').slice(0, 64), name: (user && user.email) || 'Pera', displayName: 'Pera app lock'},
      pubKeyCredParams: [{type: 'public-key', alg: -7}, {type: 'public-key', alg: -257}],
      authenticatorSelection: {authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged'},
      timeout: 60000, attestation: 'none'}});
    lockState = {id: b64u(cred.rawId), at: Date.now()}; store.set(LOCK_KEY, lockState);
    toast('App lock is on'); return true;
  } catch (e) { if (e && e.name !== 'NotAllowedError') toast('Couldn’t set up fingerprint unlock'); return false; }
}
function disableLock() { lockState = null; store.del(LOCK_KEY); document.documentElement.classList.remove('applock'); toast('App lock is off'); }
function showLock() {
  if (!lockState || !user) return;
  locked = true; closeSheet(); hideToast();
  document.documentElement.classList.add('applock');
  $('lockScreen').hidden = false; $('lockErr').textContent = ''; $('lockPwF').hidden = true; $('lockAlt').hidden = false; $('lockGo').hidden = false;
  tryUnlock();
}
function unlockNow() { locked = false; $('lockScreen').hidden = true; document.documentElement.classList.remove('applock'); drawChart(); }
async function tryUnlock() {
  if (unlocking || !lockState) return; unlocking = true; $('lockErr').textContent = '';
  try {
    await navigator.credentials.get({publicKey: {challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
      allowCredentials: [{type: 'public-key', id: unb64u(lockState.id), transports: ['internal']}], userVerification: 'required', timeout: 60000}});
    unlockNow();
  } catch (e) { $('lockErr').textContent = e && e.name === 'NotAllowedError' ? 'Not unlocked. Tap Unlock to try again.' : 'Fingerprint unlock isn’t available right now. Use your password.'; }
  finally { unlocking = false; }
}
$('lockGo').addEventListener('click', tryUnlock);
$('lockAlt').addEventListener('click', () => { $('lockPwF').hidden = false; $('lockAlt').hidden = true; $('lockPw').focus(); });
$('lockPwF').addEventListener('submit', async e => {
  e.preventDefault(); if (!sb || !user) return;
  const {error} = await sb.auth.signInWithPassword({email: user.email, password: $('lockPw').value});
  if (error) { $('lockErr').textContent = 'Wrong password.'; return; }
  $('lockPw').value = ''; unlockNow();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (lockState && user && !locked && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER) showLock();
});
/* ================= auth ================= */
let signUpMode = false;
function showAuth(msg) {
  $('mainView').hidden = true; $('authView').hidden = false;
  if (msg) $('authMsg').textContent = msg;
}
function showMain() {
  $('authView').hidden = true; $('mainView').hidden = false;
  const v = store.get('pera:tab'); showView(['home', 'months', 'savings', 'bills'].includes(v) ? v : 'home');
}
$('authSwitch').addEventListener('click', () => {
  signUpMode = !signUpMode;
  $('authGo').textContent = signUpMode ? 'Create account' : 'Sign in';
  $('authSwitch').textContent = signUpMode ? 'Have an account? Sign in' : 'New here? Create an account';
  $('pw').autocomplete = signUpMode ? 'new-password' : 'current-password';
  $('authErr').textContent = '';
});
$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('email').value.trim(), password = $('pw').value;
  if (!email || password.length < 6) { $('authErr').textContent = 'Enter your email and a password of at least 6 characters.'; return; }
  $('authGo').disabled = true; $('authErr').textContent = '';
  try {
    const r = signUpMode ? await sb.auth.signUp({email, password, options: {emailRedirectTo: location.origin + location.pathname}}) : await sb.auth.signInWithPassword({email, password});
    if (r.error) throw r.error;
    if (signUpMode && !r.data.session) $('authErr').textContent = 'Check your email to confirm, then come back and sign in.';
  } catch (err) { $('authErr').textContent = err.message || 'Something went wrong.'; }
  finally { $('authGo').disabled = false; }
});

$('authForgot').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { $('authErr').textContent = 'Type your email above first, then tap “Forgot password?” again.'; $('email').focus(); return; }
  $('authForgot').disabled = true; $('authErr').textContent = '';
  try {
    const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
    if (error) throw error;
    $('authMsg').textContent = `If ${email} has a Pera account, a reset link is on its way. Open it on this device to set a new password.`;
  } catch (err) { $('authErr').textContent = /rate|seconds/i.test(err.message || '') ? 'Too many tries. Wait a minute, then try again.' : (err.message || 'Couldn’t send the email.'); }
  finally { $('authForgot').disabled = false; }
});
function newPasswordSheet(fromLink) {
  openSheet(`<div class="sheethead"><h2>${fromLink ? 'Set a new password' : 'Change password'}</h2><button type="button" class="ghost" data-act="close">${fromLink ? 'Later' : 'Cancel'}</button></div>
    ${fromLink ? '<p class="muted">You opened a password reset link. Choose a new password for your account.</p>' : ''}
    <form id="npF" novalidate><label for="npw">New password</label><input id="npw" type="password" autocomplete="new-password" minlength="6" required>
    <p class="muted">At least 6 characters. Tap the eye to check what you typed.</p><div class="err" id="npErr" role="alert"></div>
    <button class="go" type="submit">Save new password</button></form>`);
  setTimeout(() => $('npw') && $('npw').focus(), 80);
  $('npF').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = $('npw').value; if (pw.length < 6) { $('npErr').textContent = 'Use at least 6 characters.'; return; }
    const b = $('npF').querySelector('.go'); b.disabled = true; $('npErr').textContent = '';
    try { const {error} = await sb.auth.updateUser({password: pw}); if (error) throw error; closeSheet(); toast('Password changed'); }
    catch (err) { $('npErr').textContent = /different/i.test(err.message || '') ? 'Pick a password different from your old one.' : (err.message || 'Couldn’t change the password.'); }
    finally { b.disabled = false; }
  });
}
const recoveryLink = /type=recovery/.test(location.hash + location.search);

async function start(u) {
  if (user && user.id === u.id) return;
  user = u; if (lockState) showLock(); loadLocal(); showMain(); render(); setSync(dirty.size ? 'saving' : 'idle');
  // download first; tidy-ups only run on fresh data, so an old copy can never overwrite newer changes
  const fresh = await pull();
  if (fresh) { purgeTrash(); purgeCycleTrash(); if (unifyBillNames()) dirty.add('meta'); if (migrateSavings()) dirty.add('meta'); saveLocal(); render(); }
  await push();
  setTimeout(resumeAiCards, 1500);   // write-ups asked for before the app was closed
}
function stop(msg) { hideToast(); locked = false; $('lockScreen').hidden = true; document.documentElement.classList.remove('applock'); closeSheet(); user = null; S = blank(); dirty = new Set(); showAuth(msg); }

if (!sb) {
  showAuth('Setup needed: add your Supabase URL and anon key to config.js.');
  $('authForm').hidden = true;
} else {
  sb.auth.onAuthStateChange((ev, session) => {
    // defer: calling Supabase inside this callback can deadlock supabase-js
    setTimeout(() => {
      if (session && session.user) start(session.user);
      else if (ev === 'SIGNED_OUT') stop('Signed out. Sign in to see your money.');
      else if (ev === 'INITIAL_SESSION') stop();
      if (ev === 'PASSWORD_RECOVERY' || (recoveryLink && session && ev !== 'SIGNED_OUT' && !window.__recShown)) { window.__recShown = true; history.replaceState(null, '', location.pathname); setTimeout(() => newPasswordSheet(true), 400); }
    }, 0);
  });
}

/* ================= offline app shell ================= */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // when an updated worker takes over, reload once so page, styles and script all match
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && !sheetOpen) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(reg => reg.update()).catch(() => {});
}
})();
