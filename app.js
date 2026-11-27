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
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const today = () => new Date();
// a bill is repaid from the month BEFORE its due date (due Jan 5, 2027 → December 2026)
const billMonth = due => { const d = new Date(due + 'T00:00:00'); d.setDate(1); d.setMonth(d.getMonth() - 1); return {y: String(d.getFullYear()), i: d.getMonth()}; };
const billsIn = (y, i) => (S.meta.bills || []).map((b, j) => ({...b, j})).filter(b => b.count !== false && b.due && (m => m.y === y && m.i === i)(billMonth(b.due)));

/* ================= state ================= */
const cfg = window.PERA_CONFIG || {};
const sb = (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase)
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {auth: {persistSession: true, autoRefreshToken: true}})
  : null;

let user = null;          // supabase user
let S = blank();          // {meta, years}
let dirty = new Set();    // doc keys waiting to upload
let syncState = 'idle';   // idle | saving | offline | error
let pushing = false;
let selYear = String(today().getFullYear());
let detail = null;        // {y,i} month shown in the desktop side panel
const desk = matchMedia('(min-width:900px)');

function blank() { return {meta: {years: [], bills: [], accounts: [], maya: null, phone: null, trash: []}, years: {}}; }
const TRASH_DAYS = 30;
const kData = () => 'pera:data:' + user.id;
const kDirty = () => 'pera:dirty:' + user.id;
function saveLocal() { store.set(kData(), S); store.set(kDirty(), [...dirty]); }
function loadLocal() {
  const d = store.get(kData()); S = d && d.meta ? d : blank();
  dirty = new Set(store.get(kDirty()) || []);
}
function docOf(key) { return key === 'meta' ? S.meta : {months: S.years[key.slice(1)]}; }
function applyDoc(key, data) {
  if (!data) return;
  if (key === 'meta') S.meta = Object.assign(blank().meta, data);
  else if (/^y\d{4}$/.test(key) && Array.isArray(data.months)) S.years[key.slice(1)] = data.months;
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
  if (!sb || !user) return;
  const {data, error} = await sb.from('pera_docs').select('key,data');
  if (error) { setSync(navigator.onLine ? 'error' : 'offline'); return; }
  for (const row of data) if (!dirty.has(row.key)) applyDoc(row.key, row.data);
  // a year that is no longer on the server (deleted on another device) goes here too
  if (data.length) {
    const remote = new Set(data.map(r => r.key));
    for (const y of Object.keys(S.years)) if (!remote.has('y' + y) && !dirty.has('y' + y)) delete S.years[y];
  }
  S.meta.years = Object.keys(S.years).sort();
  saveLocal(); render();
}
async function push() {
  if (!sb || !user || pushing) return;
  if (!dirty.size) { setSync('idle'); return; }
  pushing = true; setSync('saving');
  try {
    while (dirty.size) {
      const keys = [...dirty];
      const gone = keys.filter(k => k !== 'meta' && !S.years[k.slice(1)]);   // deleted years
      const live = keys.filter(k => !gone.includes(k));
      const snapshot = keys.map(k => JSON.stringify(gone.includes(k) ? null : docOf(k)));
      if (gone.length) {
        const {error} = await sb.from('pera_docs').delete().eq('user_id', user.id).in('key', gone);
        if (error) throw error;
      }
      if (live.length) {
        const rows = live.map(key => ({user_id: user.id, key, data: docOf(key), updated_at: new Date().toISOString()}));
        const {error} = await sb.from('pera_docs').upsert(rows, {onConflict: 'user_id,key'});
        if (error) throw error;
      }
      // only clear keys that did not change again while uploading
      keys.forEach((k, i) => { const now = k !== 'meta' && !S.years[k.slice(1)] ? null : docOf(k); if (JSON.stringify(now) === snapshot[i]) dirty.delete(k); });
      store.set(kDirty(), [...dirty]);
    }
    setSync('idle');
  } catch (e) {
    console.warn('sync failed', e);
    setSync(navigator.onLine ? 'error' : 'offline');
  } finally { pushing = false; }
}
function setSync(s) {
  syncState = s;
  const el = $('sync'), n = dirty.size;
  el.className = 'sync ' + (s === 'idle' ? 'ok' : 'wait');
  $('syncTxt').textContent = s === 'idle' ? 'Synced' : s === 'saving' ? 'Saving…'
    : s === 'offline' ? `Offline · ${n} change${n === 1 ? '' : 's'} waiting` : 'Not synced · tap Settings';
}
addEventListener('online', () => push());
document.addEventListener('visibilitychange', () => { if (!document.hidden && user) { push().then(pull); } });
setInterval(() => { if (dirty.size && navigator.onLine) push(); }, 30000);

/* ================= maths ================= */
function series() {
  const out = [], now = today(), CY = now.getFullYear(), CM = now.getMonth();
  let run = 0;
  for (const y of Object.keys(S.years).sort()) S.years[y].forEach((m, i) => {
    const inc = sum(m.inc), exp = sum(m.exp) + sum(billsIn(y, i)), sav = +m.sav || 0;
    run = run + inc - sav - exp;
    out.push({y, i, inc, exp, sav, total: run, past: +y < CY || (+y === CY && i <= CM), now: +y === CY && i === CM});
  });
  return out;
}

/* ================= render ================= */
function render() {
  const ser = series();
  renderHome(ser); renderMonths(ser); renderSavings(); renderBills();
  if (desk.matches) renderDetail(ser);
  else if (sheetOpen && sheetMonth && S.years[sheetMonth.y]) $('sheetBody').innerHTML = monthHTML(sheetMonth.y, sheetMonth.i, ser);
}
function renderHome(ser) {
  const cur = ser.find(p => p.now) || ser.filter(p => p.past).pop() || ser[0];
  if (!cur) {
    $('homeLbl').textContent = 'Total money';
    $('homeTotal').textContent = '₱0';
    $('homeChg').textContent = '';
    $('homeTrio').innerHTML = '';
    $('homeListH').textContent = 'Get started';
    $('homeList').innerHTML = `<li><button class="rowbtn" data-act="settings"><span class="dot s">⇪</span><span class="t">Import your backup<small>Load pera-backup.json from Settings</small></span></button></li>
      <li><button class="rowbtn" data-act="fab"><span class="dot i">+</span><span class="t">Or start fresh<small>Add your first income or expense</small></span></button></li>`;
    drawChart(); return;
  }
  $('homeLbl').textContent = `Total money · end of ${M[cur.i]} ${cur.y}`;
  $('homeTotal').textContent = peso(cur.total, 2);
  const prev = ser[ser.indexOf(cur) - 1];
  if (prev) { const d = cur.total - prev.total; $('homeChg').innerHTML = `<span class="${d >= 0 ? 'up' : 'dn'}">${d >= 0 ? '▲' : '▼'} ${esc(peso(Math.abs(d)))}</span> vs ${esc(M[prev.i])}`; }
  else $('homeChg').textContent = '';
  $('homeTrio').innerHTML = [['Income', cur.inc, 'up'], ['Spent', cur.exp, 'dn'], ['Saved', cur.sav, '']]
    .map(([l, v, c]) => `<div class="tile"><span>${l}</span><b class="${c}">${esc(peso(v))}</b></div>`).join('');
  $('homeListH').textContent = `${M[cur.i]} entries`;
  $('homeList').innerHTML = entryRows(cur.y, cur.i) || '<li class="empty">Nothing logged this month yet.</li>';
  drawChart();
}
function entryRows(y, i) {
  const m = S.years[y][i];
  const rows = [...m.inc.map(x => ['inc', x]), ...m.exp.map(x => ['exp', x])];
  let h = rows.map(([t, x]) => {
    const inc = t === 'inc';
    return `<li><button class="rowbtn" data-act="edit-entry" data-t="${t}" data-y="${esc(y)}" data-i="${i}" data-id="${esc(x.id)}">
      <span class="dot ${inc ? 'i' : 'e'}">${inc ? '↓' : '↑'}</span>
      <span class="t">${esc(x.n || (inc ? 'Income' : 'Expense'))}<small>${inc ? 'Received' : x.a < 0 ? 'Refund / adjustment' : 'Sent'}</small></span>
      <span class="amt ${inc ? 'up' : ''}">${inc ? '+' : x.a < 0 ? '+' : '−'}${esc(peso(Math.abs(x.a), 2))}</span></button>
      <button class="x" data-act="entry-del" data-t="${t}" data-y="${esc(y)}" data-i="${i}" data-id="${esc(x.id)}" aria-label="Delete ${esc(x.n || (inc ? 'income' : 'expense'))}">×</button></li>`;
  }).join('');
  h += billsIn(y, i).map(b => `<li><button class="rowbtn" data-act="bill-edit" data-j="${b.j}"><span class="dot e">↑</span><span class="t">${esc(b.name)}<small>Bill due ${esc(fmtDate(b.due))}${b.paid ? ' · paid' : ''}</small></span><span class="amt">−${esc(peso(+b.a, 2))}</span></button><span class="x" aria-hidden="true"></span></li>`).join('');
  if (+m.sav) h += `<li><button class="rowbtn" data-act="edit-sav" data-y="${esc(y)}" data-i="${i}"><span class="dot s">₱</span><span class="t">To savings<small>Moved out of total</small></span><span class="amt">${esc(peso(+m.sav, 2))}</span></button>
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
  <path d="${area}" fill="url(#g)"/><path d="${path(0, k)}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round"/>
  ${k < ser.length - 1 ? `<path d="${path(k, ser.length - 1)}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="4 5" opacity=".65"/>` : ''}
  <circle cx="${kx}" cy="${Y(ser[k].total)}" r="5" fill="var(--bg)" stroke="var(--blue)" stroke-width="2.5"/>
  <text x="${kx}" y="${Math.max(13, Y(ser[k].total) - 10)}" text-anchor="${anchor}" font-size="12" font-weight="600" fill="var(--ink)">Now</text>
  ${k < ser.length - 1 && W > 340 ? `<text x="${W - pr}" y="${Math.max(13, Y(last.total) - 9)}" text-anchor="end" font-size="11" fill="var(--mute)">${esc(M[last.i].slice(0, 3) + ' ' + last.y)} · ${esc(pesoS(last.total))}</text>` : ''}`;
}
const chartRO = new ResizeObserver(drawChart); chartRO.observe($('chart'));

function renderMonths(ser) {
  const ys = Object.keys(S.years).sort();
  if (!ys.includes(selYear) && ys.length) selYear = ys.includes(String(today().getFullYear())) ? String(today().getFullYear()) : ys[ys.length - 1];
  $('yearSeg').innerHTML = ys.map(y => `<button data-act="year" data-y="${esc(y)}" aria-pressed="${y === selYear}">${esc(y)}</button>`).join('')
    + `<button data-act="year" data-y="+" aria-label="Add a year">＋ Year</button>`;
  const rows = ser.filter(p => p.y === selYear);
  const sel = desk.matches && detail && detail.y === selYear ? detail.i : -1;
  $('monthList').innerHTML = rows.map(p => `<li class="${p.i === sel ? 'sel' : p.now ? 'now' : ''}"><button class="rowbtn" data-act="month" data-i="${p.i}">
    <span class="t"><b>${M[p.i]}</b><small><span class="up">+${esc(pesoS(p.inc))}</span> · <span class="dn">−${esc(pesoS(p.exp))}</span> · saved ${esc(pesoS(p.sav))}</small></span>
    <span class="mr">${p.past ? 'Total' : 'Planned'}<b>${esc(peso(p.total))}</b></span></button></li>`).join('')
    || '<li class="empty">No months yet. Tap ＋ Year.</li>';
  const binN = (S.meta.trash || []).length;
  $('yearActions').innerHTML = (rows.length ? `<button class="danger" data-act="year-del" data-y="${esc(selYear)}">Delete ${esc(selYear)}</button>` : '')
    + (binN ? `<button class="plain" data-act="settings">Recycle bin (${binN})</button>` : '');
  $('yearFoot').textContent = rows.length ? `${selYear}: income ${peso(rows.reduce((a, p) => a + p.inc, 0))}, spent ${peso(rows.reduce((a, p) => a + p.exp, 0))}, saved ${peso(rows.reduce((a, p) => a + p.sav, 0))}.` : '';
}

function renderSavings() {
  const w = $('savWrap'), m = S.meta, now = today().getTime();
  let h = '';
  const cyc = (m.maya && m.maya.cycles) || [];
  if (cyc.length) {
    const cur = cyc.find(c => now >= Date.parse(c.start) && now < Date.parse(c.end)) || cyc[cyc.length - 1];
    const prog = Math.min(1, Math.max(0, (now - Date.parse(cur.start)) / (Date.parse(cur.end) - Date.parse(cur.start))));
    const maxB = Math.max(...cyc.map(c => c.end_bal));
    h += `<div class="card"><div class="muted">Maya time deposit · ${esc((cur.rate * 100).toFixed(2))}% p.a.</div>
      <div class="big" style="font-size:36px">${esc(peso(cur.end_bal))}</div>
      <div class="muted">Projected at maturity, ${esc(fmtDate(cur.end, {month: 'long', day: 'numeric', year: 'numeric'}))}</div>
      <div class="bar"><i style="width:${(prog * 100).toFixed(1)}%"></i></div>
      <div class="muted">${Math.round(prog * 100)}% through this cycle · ${esc(peso(cur.deposits))} put in · ${esc(peso(cur.net_int, 2))} interest after tax</div></div>
      <h2>Maya ladder plan</h2><div class="ladder">${cyc.map(c => `<div class="r ${Date.parse(c.end) > now ? 'f' : ''}"><span>${esc(fmtDate(c.end, {month: 'short', year: 'numeric'}))}</span><i style="width:${(c.end_bal / maxB * 100).toFixed(1)}%"></i><span>${esc(pesoS(c.end_bal))}</span></div>`).join('')}</div>
      <p class="muted">Solid = matured, faded = planned.</p>`;
  }
  h = `<div class="savcols"><div>${h}</div><div><h2${cyc.length ? '' : ' style="margin-top:0"'}>Other pots</h2>`;
  if (m.phone) {
    const pp = Math.min(1, Math.max(0, (now - Date.parse(m.phone.start)) / (Date.parse(m.phone.end) - Date.parse(m.phone.start))));
    h += `<div class="card"><div class="muted">Phone upgrade fund · Maya</div><div class="serif" style="font-size:26px">${esc(peso(m.phone.end_bal))}</div><div class="bar"><i style="width:${(pp * 100).toFixed(1)}%"></i></div><div class="muted">Projected by ${esc(fmtDate(m.phone.end, {month: 'short', year: 'numeric'}))}</div></div>`;
  }
  h += (m.accounts || []).map((a, j) => `<button class="card" data-act="acct" data-j="${j}"><div class="muted">${esc(a.name)}</div><div class="serif" style="font-size:26px">${esc(peso(+a.bal, 2))}</div><div class="muted">As of ${esc(a.asof)} · tap to update</div></button>`).join('');
  h += `<button class="go" data-act="acct" data-j="new">Add an account</button></div></div>`;
  w.innerHTML = h;
}

function renderBills() {
  const now = today(); now.setHours(0, 0, 0, 0);
  const b = (S.meta.bills || []).map((x, j) => ({...x, j})).sort((p, q) => (p.paid - q.paid) || p.due.localeCompare(q.due));
  $('billList').innerHTML = b.map(x => {
    const late = !x.paid && Date.parse(x.due + 'T00:00:00') < now.getTime();
    return `<li><button class="chk ${x.paid ? 'on' : ''}" data-act="bill-pay" data-j="${x.j}" aria-label="${x.paid ? 'Mark unpaid' : 'Mark paid'}: ${esc(x.name)}"><span>${x.paid ? '✓' : ''}</span></button>
      <button class="rowbtn" data-act="bill-edit" data-j="${x.j}"><span class="t">${esc(x.name)}<small class="${late ? 'dn' : ''}">${x.paid ? 'Paid · ' : late ? 'Past due · ' : 'Due '}${esc(fmtDate(x.due))}${x.count !== false ? ` · expense in ${M[billMonth(x.due).i].slice(0, 3)} ${billMonth(x.due).y}` : ''}</small></span>
      <span class="amt" style="${x.paid ? 'opacity:.5;text-decoration:line-through' : ''}">${esc(peso(+x.a, 2))}</span></button>
      <button class="x" data-act="bill-del" data-j="${x.j}" aria-label="Delete ${esc(x.name)}">×</button></li>`;
  }).join('') || '<li class="empty">No bills yet. Type one above.</li>';
  fillPicker();
  // your own bills first, then the common ones
  const used = [...new Set((S.meta.bills || []).slice().reverse().map(x => x.name))];
  const names = [...used, ...PRESETS.filter(p => !used.some(u => u.toLowerCase() === p.toLowerCase()))];
  $('qbChips').innerHTML = names.map(n => `<button type="button" class="chip" data-act="qb-name" data-n="${esc(n)}" aria-pressed="false">${esc(n)}</button>`).join('');
  markChip();
}


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
  const used = [...new Set((S.meta.bills || []).slice().reverse().map(x => x.name))];
  const names = [...used, ...PRESETS.filter(p => !used.some(u => u.toLowerCase() === p.toLowerCase()))];
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
  const past = (S.meta.bills || []).filter(x => x.name === v).sort((p, q) => p.due.localeCompare(q.due));
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
  const nm = $('pkName').value === '__other' ? $('pkOther').value.trim() : $('pkName').value;
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
function quickAdd() {
  const p = quickPreview(); if (!p) return;
  const made = p.dates.map(due => ({name: p.name, a: p.a, due, paid: false, count: true}));
  const keys = ['meta'];
  made.forEach(b => { S.meta.bills.push(b); const m = billMonth(b.due); if (!S.years[m.y]) { ensureYear(m.y); keys.push('y' + m.y); } });
  commit(...keys);
  if (qbMode === 'type') $('qb').value = '';
  else { $('pkName').value = ''; $('pkAmt').value = ''; $('pkOther').value = ''; $('pkOther').hidden = true; $('pkN').value = '1'; }
  quickPreview();
  toast(made.length > 1 ? `${made.length} ${p.name} payments added` : `${p.name} added`, () => { S.meta.bills = S.meta.bills.filter(b => !made.includes(b)); commit('meta'); });
}
/* ================= sheet + toast ================= */
let sheetOpen = false;
function openSheet(html, onReady) {
  sheetMonth = null;
  $('sheetBody').innerHTML = html;
  $('scrim').classList.add('on'); $('sheet').classList.add('on'); document.body.classList.add('locked');
  sheetOpen = true;
  if (onReady) onReady($('sheetBody'));
}
function closeSheet() {
  $('scrim').classList.remove('on'); $('sheet').classList.remove('on'); document.body.classList.remove('locked');
  sheetOpen = false; sheetMonth = null;
}
$('scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen) closeSheet(); });

let toastTimer;
// toast(msg, undoFn?, buttonLabel?) — warnings are messages that start with "Couldn" / "Still" / "That" / contain "already"
function toast(msg, undo, label = 'Undo') {
  const t = $('toast'), b = $('toastBtn'), ms = undo ? 6000 : 3500;
  const warn = /^(Couldn|Still|That|Not)|already|offline/i.test(msg);
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

function entryForm(o) {
  // o: {t, y, i, id, a, n, edit}
  let t = o.t || 'exp';
  const now = today();
  openSheet(`<div class="sheethead"><h2 id="efTitle">${o.edit ? 'Edit' : 'Add'} ${title(t)}</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    ${o.edit ? '' : `<div class="seg">${[['exp', 'Expense'], ['inc', 'Income'], ['sav', 'Savings']].map(([k, l]) => `<button type="button" data-type="${k}" aria-pressed="${k === t}">${l}</button>`).join('')}</div>`}
    <form id="ef" novalidate>
      <label for="fa">Amount (sums like 1.84+329 work)</label>
      <input id="fa" class="amtin" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${o.a != null ? esc(o.a) : ''}">
      <div id="noteWrap" ${t === 'sav' ? 'hidden' : ''}><label for="fn">Note</label><input id="fn" maxlength="60" enterkeyhint="done" placeholder="Groceries, salary, bills…" value="${esc(o.n || '')}"></div>
      <div class="two"><div><label for="fm">Month</label><select id="fm" ${o.edit ? 'disabled' : ''}>${monOpts(o.i ?? now.getMonth())}</select></div>
      <div><label for="fy">Year</label><select id="fy" ${o.edit ? 'disabled' : ''}>${yearOpts(o.y ?? now.getFullYear())}</select></div></div>
      <p class="muted" id="savHint" ${t === 'sav' ? '' : 'hidden'}>Sets how much you moved to savings that month (replaces the old amount).</p>
      <button class="go" type="submit">${o.edit ? 'Save' : 'Add'}</button>
      ${o.edit && t !== 'sav' ? '<button type="button" class="danger" id="fdel">Delete entry</button>' : ''}
    </form>`, body => {
    body.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
      t = b.dataset.type;
      body.querySelectorAll('[data-type]').forEach(x => x.setAttribute('aria-pressed', x === b));
      $('efTitle').textContent = 'Add ' + title(t);
      $('noteWrap').hidden = t === 'sav'; $('savHint').hidden = t !== 'sav';
      if (t === 'sav' && !$('fa').value) { const m = (S.years[$('fy').value] || [])[+$('fm').value]; if (m && m.sav) $('fa').value = m.sav; }
    }));
    $('ef').addEventListener('submit', e => {
      e.preventDefault();
      const a = parseAmt($('fa').value);
      if (isNaN(a)) { $('fa').classList.add('bad'); $('fa').focus(); return; }
      const y = o.edit ? o.y : $('fy').value, i = o.edit ? o.i : +$('fm').value;
      const n = $('fn') ? $('fn').value.trim() : '';
      const m = ensureYear(y)[i];
      closeSheet();
      if (t === 'sav') { const old = m.sav; m.sav = a; commit('y' + y); toast(`Savings for ${M[i]} set`, () => { m.sav = old; commit('y' + y); }); return; }
      if (o.id) { const x = m[t].find(z => z.id === o.id); if (x) { x.a = a; x.n = n; } commit('y' + y); toast('Saved'); return; }
      const it = {id: uid(), a, n}; m[t].push(it); commit('y' + y);
      toast(`Added to ${M[i]}`, () => { m[t] = m[t].filter(z => z.id !== it.id); commit('y' + y); });
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

function monthHTML(y, i, ser) {
  const p = (ser || series()).find(q => q.y === y && q.i === i);
  if (!p) return '<p class="empty">Pick a month.</p>';
  return `<div class="sheethead"><h2>${M[i]} ${esc(y)}</h2><button class="ghost" data-act="add-in-month" data-y="${esc(y)}" data-i="${i}">+ Add</button></div>
    <div class="trio"><div class="tile"><span>Income</span><b class="up">${esc(peso(p.inc))}</b></div><div class="tile"><span>Spent</span><b class="dn">${esc(peso(p.exp))}</b></div><div class="tile"><span>Saved</span><b>${esc(peso(p.sav))}</b></div></div>
    <p class="muted">Total money at month end: <b style="color:var(--ink)">${esc(peso(p.total, 2))}</b></p>
    <ul class="list">${entryRows(y, i) || '<li class="empty">No entries.</li>'}</ul>
    <button class="plain" data-act="edit-sav" data-y="${esc(y)}" data-i="${i}">Set savings for ${M[i]}</button>
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
  const countLabel = due => { if (!due) return 'Count as an expense in the month before it’s due'; const m = billMonth(due); return `Count as an expense in ${M[m.i]} ${m.y}`; };
  openSheet(`<div class="sheethead"><h2>${j == null ? 'Add a bill' : 'Edit bill'}</h2><button type="button" class="ghost" data-act="close">Cancel</button></div>
    <form id="bf" novalidate><label for="bn">Name</label><input id="bn" maxlength="40" placeholder="SPayLater" value="${esc(b.name)}">
    <label for="ba">Amount</label><input id="ba" class="amtin" inputmode="decimal" value="${esc(b.a)}">
    <label for="bd">Due date</label><input id="bd" type="date" value="${esc(b.due)}">
    <label class="check"><input type="checkbox" id="bc" ${b.count !== false ? 'checked' : ''}><span id="bcl">${esc(countLabel(b.due))}</span></label>
    <button class="go" type="submit">${j == null ? 'Add' : 'Save'}</button>
    ${j == null ? '' : '<button type="button" class="danger" id="bdel">Delete bill</button>'}</form>`, () => {
    $('bd').addEventListener('input', () => { $('bcl').textContent = countLabel($('bd').value); });
    $('bf').addEventListener('submit', e => {
      e.preventDefault();
      const a = parseAmt($('ba').value), d = $('bd').value, n = $('bn').value.trim();
      $('ba').classList.toggle('bad', isNaN(a)); $('bd').classList.toggle('bad', !d); $('bn').classList.toggle('bad', !n);
      if (isNaN(a) || !d || !n) return;
      const v = {name: n, a, due: d, paid: !!b.paid, count: $('bc').checked};
      if (j == null) S.meta.bills.push(v); else S.meta.bills[j] = v;
      const keys = ['meta'];
      if (v.count) { const m = billMonth(d); if (!S.years[m.y]) { ensureYear(m.y); keys.push('y' + m.y); } }
      closeSheet(); commit(...keys);
      toast(v.count ? `${j == null ? 'Bill added' : 'Bill saved'} · expense in ${M[billMonth(d).i]} ${billMonth(d).y}` : (j == null ? 'Bill added' : 'Bill saved'));
    });
    const del = $('bdel'); if (del) del.addEventListener('click', () => { closeSheet(); removeBill(j); });
  });
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

function settings() {
  const n = dirty.size;
  openSheet(`<div class="sheethead"><h2>Settings</h2><button type="button" class="ghost" data-act="close">Done</button></div>
    <p class="muted">Signed in as <b style="color:var(--ink)">${esc(user && user.email)}</b></p>
    <div class="note">${syncState === 'idle' ? 'Everything is synced.' : `${n} change${n === 1 ? '' : 's'} saved on this phone, waiting to upload.`}</div>
    <button class="go" data-act="sync-now">Sync now</button>
    <h2>Recycle bin</h2>
    ${binHTML()}
    <h2>Backup</h2>
    <label class="go filebtn" style="color:var(--on-blue);margin:0">Import or restore from backup (.json)<input type="file" id="importFile" accept=".json,application/json"></label>
    <button class="plain" data-act="export">Export backup</button>
    <h2>Install on your phone</h2>
    <p class="muted"><b>iPhone:</b> in Safari tap Share → Add to Home Screen.<br><b>Android:</b> in Chrome tap ⋮ → Install app (or Add to Home screen).</p>
    <button class="danger" data-act="signout">Sign out</button>`, () => {
    $('importFile').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { importData(JSON.parse(await f.text())); }
      catch (err) { toast('That file isn’t a Pera backup'); }
    });
  });
}
let pendingImport = null;
function importData(d) {
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
  const t = S.meta.trash || [];
  if (!t.length) return '<p class="muted">Empty. Deleted years stay here for ' + TRASH_DAYS + ' days.</p>';
  return '<ul class="list">' + t.map(x => {
    const n = x.months.reduce((a, m) => a + m.inc.length + m.exp.length, 0);
    const left = Math.max(0, Math.ceil((Date.parse(x.at) + TRASH_DAYS * 864e5 - Date.now()) / 864e5));
    return `<li><span class="rowbtn" style="cursor:default"><span class="dot s">${esc(x.y.slice(2))}</span><span class="t">${esc(x.y)}<small>${n} entries · deleted ${esc(fmtDate(x.at.slice(0, 10)))} · ${left} day${left === 1 ? '' : 's'} left</small></span></span>
      <button class="ghost" data-act="bin-restore" data-y="${esc(x.y)}">Restore</button><button class="x" data-act="bin-forever" data-y="${esc(x.y)}" aria-label="Delete ${esc(x.y)} forever">×</button></li>`;
  }).join('') + '</ul>';
}
function restoreYear(y, quiet) {
  const it = (S.meta.trash || []).find(t => t.y === y); if (!it) return;
  if (S.years[y]) { toast(`${y} already exists. Delete it first to restore the old one.`); return; }
  S.years[y] = it.months;
  S.meta.trash = S.meta.trash.filter(t => t !== it);
  S.meta.years = Object.keys(S.years).sort();
  if (sheetOpen) closeSheet();
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

/* ================= one click handler for everything ================= */
function showView(v) {
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  document.querySelectorAll('.tab[data-v]').forEach(x => x.dataset.v === v ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current'));
  window.scrollTo(0, 0);
  if (v === 'home') drawChart();
  store.set('pera:tab', v);
}
document.addEventListener('click', e => {
  const tab = e.target.closest('.tab[data-v]'); if (tab) return showView(tab.dataset.v);
  const el = e.target.closest('[data-act]'); if (!el) return;
  const d = el.dataset, j = d.j;
  switch (d.act) {
    case 'close': return closeSheet();
    case 'fab': closeSheet(); return entryForm({});
    case 'settings': return settings();
    case 'edit-entry': { const x = S.years[d.y][+d.i][d.t].find(z => z.id === d.id); if (x) entryForm({t: d.t, y: d.y, i: +d.i, id: d.id, a: x.a, n: x.n, edit: true}); return; }
    case 'edit-sav': return entryForm({t: 'sav', y: d.y, i: +d.i, a: S.years[d.y][+d.i].sav || '', edit: true});
    case 'add-in-month': return entryForm({y: d.y, i: +d.i});
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
      if (d.y === '+') { const ys = Object.keys(S.years).map(Number); const n = String(ys.length ? Math.max(...ys) + 1 : today().getFullYear()); ensureYear(n); selYear = n; commit(); }
      else { selYear = d.y; if (desk.matches) detail = {y: d.y, i: detail && detail.y === d.y ? detail.i : 0}; render(); }
      return;
    case 'year-del': return confirmDeleteYear(d.y);
    case 'year-del-yes': return deleteYear(d.y);
    case 'bin-restore': return restoreYear(d.y);
    case 'bin-forever': return forgetYear(d.y);
    case 'imp-missing': return importApply('missing');
    case 'imp-all': return importApply('all');
    case 'acct': return acctForm(j);
    case 'bill-pay': { const b = S.meta.bills[+j]; b.paid = !b.paid; commit('meta'); return; }
    case 'bill-edit': return billForm(+j);
    case 'bill-del': return removeBill(+j);
    case 'bill-add': return billForm(null);
    case 'qb-name': { const q = $('qb'); q.value = d.n + ' '; q.focus(); quickPreview(); return; }
    case 'sync-now': push().then(pull).then(() => { closeSheet(); toast(dirty.size ? 'Still offline — will retry' : 'Synced'); }); return;
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

document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey || sheetOpen || !user) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  e.preventDefault(); entryForm({});
});
desk.addEventListener('change', () => { closeSheet(); if (user) render(); });

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

async function start(u) {
  if (user && user.id === u.id) return;
  user = u; loadLocal(); purgeTrash(); showMain(); render(); setSync(dirty.size ? 'saving' : 'idle');
  await push(); await pull();
}
function stop(msg) { hideToast(); closeSheet(); user = null; S = blank(); dirty = new Set(); showAuth(msg); }

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
