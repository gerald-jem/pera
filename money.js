/* Pera money maths: pure functions with no screen or storage access, so they can be tested directly
   (node tests/test_money.js). app.js uses them through window.PeraMoney. */
(function (root) {
  'use strict';
  const DAYMS = 864e5;

  /* ---- dates (YYYY-MM-DD strings, local time) ---- */
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const mkDate = (y, m, day) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));   // clamps 31 → 28/30
  const dnum = s => Date.parse(s + 'T00:00:00');
  const addDays = (s, n) => iso(new Date(dnum(s) + n * DAYMS));
  const daysBetween = (a, b) => Math.round((dnum(b) - dnum(a)) / DAYMS);

  /* ---- bills: which month a due date belongs to, for someone paid on the 15th and 30th ----
     due on or after the cut-off day → that month; earlier → the month before (paid from the previous 30th) */
  function billMonth(due, cut) {
    const d = new Date(due + 'T00:00:00'), same = cut > 0 && d.getDate() >= cut;
    d.setDate(1); if (!same) d.setMonth(d.getMonth() - 1);
    return {y: String(d.getFullYear()), i: d.getMonth()};
  }

  /* ---- time deposits that pay interest in every month (Maya Time Deposit Plus) ----
     interest = daily balance × rate × (1 − tax) ÷ 365, paid on the 1st and at maturity, then earning interest itself.
     A payout the statement already shows (credits within 4 days of the 1st) replaces the prediction. */
  function tdPayouts(c, rate, tax, end, today) {
    const ev = {}; const add = (d, a) => { ev[d] = (ev[d] || 0) + a; };
    if (+c.carry) add(c.start, +c.carry); (c.deposits || []).forEach(d => add(d.date, +d.a));
    const actual = c.credits || [], out = [];
    let bal = 0, acc = 0, day = c.start, from = c.start;
    const payout = date => {
      const got = actual.filter(x => x.date >= date && daysBetween(date, x.date) <= 4), a = got.length ? got.reduce((s, x) => s + x.a, 0) : Math.round(acc * 100) / 100;
      const on = got.length ? got[0].date : date;
      if (a > 0 || got.length) out.push({date: on, from, a, actual: !!got.length, paid: on <= today});
      bal += a; acc = 0; from = date;
    };
    for (let n = 0; day < end && n < 800; n++, day = addDays(day, 1)) {
      if (day.endsWith('-01') && day !== c.start) payout(day);
      bal += ev[day] || 0;
      acc += bal * rate * (1 - tax) / 365;
    }
    payout(end);
    return out;
  }

  /* ---- money moved to savings: saved, not spent ----
     Each month, savings deposits are taken out of that month's transfers (₱29k sent, ₱10k deposited → ₱19k spent).
     A deposit on the 1st–3rd whose transfer left in the last 4 days of the month before counts in that month.
     years: {YYYY: [12 × {exp:[{a, d, n, c}]}]}, deposits: [{date, a}], isTransfer(entry) → bool. Returns {'YYYY-i': amount}. */
  function carvePlan(years, deposits, isTransfer) {
    const key = (y, i) => `${y}-${i}`, tr = {}, trDated = {};
    for (const y of Object.keys(years)) years[y].forEach((m, i) => (m.exp || []).forEach(x => {
      if (+x.a > 0 && isTransfer(x)) { const k = key(y, i); tr[k] = (tr[k] || 0) + +x.a; if (x.d) (trDated[k] = trDated[k] || []).push(x); }
    }));
    const dep = {};
    deposits.forEach(d => {
      const dt = new Date(dnum(d.date)); let y = dt.getFullYear(), i = dt.getMonth();
      if (dt.getDate() <= 3) {
        const pv = new Date(y, i, 0), pk = key(String(pv.getFullYear()), pv.getMonth());
        if ((trDated[pk] || []).some(x => +x.a >= d.a - 0.01 && new Date(dnum(x.d)).getDate() >= pv.getDate() - 3)) { y = pv.getFullYear(); i = pv.getMonth(); }
      }
      const k = key(String(y), i); dep[k] = (dep[k] || 0) + +d.a;
    });
    const out = {}; for (const k of Object.keys(dep)) out[k] = Math.min(dep[k], tr[k] || 0);
    return out;
  }

  /* ---- sync: three-way merge of this device (l), the server (r) and the last synced copy (b) ---- */
  const J = x => JSON.stringify(x === undefined ? null : x, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, key) => (o[key] = v[key], o), {}) : v);
  function pick(b, l, r, hasBase) {
    // changed here since the last sync → ours; otherwise the server's (fall back to ours if the server has nothing)
    if (hasBase && J(l) !== J(b)) return l;
    return r !== undefined ? r : l;
  }
  // lists of things with ids: keep additions from both sides, honour deletions, and for an item changed on
  // both sides keep this device's version
  function mergeById(b, l, r, hasBase) {
    if (!Array.isArray(l) || !Array.isArray(r)) return pick(b, l, r, hasBase);
    if (![...l, ...r].every(x => x && x.id != null)) return pick(b, l, r, hasBase);   // can't match items without ids
    const bm = new Map((b || []).map(x => [x.id, x])), lm = new Map(l.map(x => [x.id, x])), rm = new Map(r.map(x => [x.id, x])), out = [];
    // server order first, then anything only here, in this device's order
    const ids = [...new Set([...r.map(x => x.id), ...l.map(x => x.id)])];
    for (const id of ids) {
      const bx = bm.get(id), lx = lm.get(id), rx = rm.get(id);
      if (lx && rx) out.push(hasBase && J(lx) !== J(bx) ? lx : rx);
      else if (lx && !rx) { if (!hasBase || !bx || J(lx) !== J(bx)) out.push(lx); }      // new here, or server deleted something we didn't touch
      else if (rx && !lx) { if (!hasBase || !bx || J(rx) !== J(bx)) out.push(rx); }      // new on server, or we deleted it
    }
    return out;
  }
  const LISTS = ['savings', 'goals'];   // meta lists merged item by item (bills have no ids yet, so they're merged as a whole)
  function mergeMonth(b, l, r, hasBase) {
    if (!l) return r; if (!r) return l;
    const bb = hasBase ? b || {} : {};
    return {...l, ...r,
      inc: mergeById(bb.inc, l.inc || [], r.inc || [], hasBase && !!b),
      exp: mergeById(bb.exp, l.exp || [], r.exp || [], hasBase && !!b),
      sav: pick(bb.sav, l.sav, r.sav, hasBase && !!b)};
  }
  function merge3(key, b, l, r) {
    const hasBase = b !== undefined && b !== null;
    if (r === undefined || r === null) return l;
    if (key === 'meta') {
      const out = {};
      for (const f of new Set([...Object.keys(l || {}), ...Object.keys(r || {})])) {
        const bf = hasBase ? b[f] : undefined;
        out[f] = LISTS.includes(f) ? mergeById(bf, (l || {})[f], r[f], hasBase && bf !== undefined) : pick(bf, (l || {})[f], r[f], hasBase);
        if (out[f] === undefined) delete out[f];
      }
      return out;
    }
    // a year: each month's entries merged one by one, so adding on two phones keeps both
    const lm = (l && l.months) || [], rm = (r && r.months) || [], bm = hasBase ? (b.months || []) : [];
    return {months: Array.from({length: 12}, (_, i) => mergeMonth(bm[i], lm[i], rm[i], hasBase) || {inc: [], exp: [], sav: 0})};
  }

  const api = {DAYMS, iso, mkDate, dnum, addDays, daysBetween, billMonth, tdPayouts, carvePlan, J, pick, mergeById, merge3};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PeraMoney = api;
})(typeof window !== 'undefined' ? window : globalThis);
