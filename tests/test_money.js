// Direct tests for money.js (no browser): node tests/test_money.js
// Invented numbers only. Prints "errors []" when everything passes (run_all.sh reads that line).
const M = require('../money.js');
const errors = [];
const eq = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) errors.push(`${name}: got ${g}, want ${w}`); else console.log('  ok', name); };
const near = (name, got, want, tol = 0.005) => { if (Math.abs(got - want) > tol) errors.push(`${name}: got ${got}, want ${want}`); else console.log('  ok', name); };

/* dates */
eq('addDays across a month', M.addDays('2026-01-30', 3), '2026-02-02');
eq('daysBetween', M.daysBetween('2026-08-26', '2027-02-23'), 181);
eq('mkDate clamps the 31st', M.iso(M.mkDate(2026, 1, 31)), '2026-02-28');

/* bills: paid on the 15th and 30th */
eq('due on the 16th counts in its own month', M.billMonth('2026-12-16', 15), {y: '2026', i: 11});
eq('due on the 15th counts in its own month', M.billMonth('2026-12-15', 15), {y: '2026', i: 11});
eq('due on the 5th counts in the month before', M.billMonth('2027-01-05', 15), {y: '2026', i: 11});
eq('no cut-off: always the month before', M.billMonth('2026-12-20', 0), {y: '2026', i: 10});

/* monthly-interest time deposit: daily balance × rate × (1 − tax) ÷ 365, paid on the 1st, compounding */
const c = {start: '2026-08-26', carry: 100000, deposits: [{date: '2026-09-16', a: 20000}], credits: []};
let pays = M.tdPayouts(c, 0.06, 0.2, '2027-02-23', '2026-11-28');
near('first partial month (Aug 26–31)', pays[0].a, 78.90);                                   // 100,000 × .048 / 365 × 6
near('September with a mid-month deposit', pays[1].a, Math.round(((100078.90 * 15) + (120078.90 * 15)) * .048 / 365 * 100) / 100);
eq('paid on the 1st', pays.map(x => x.date).slice(0, 3), ['2026-09-01', '2026-10-01', '2026-11-01']);
eq('last payout at maturity', pays[pays.length - 1].date, '2027-02-23');
eq('paid flags follow today', pays.map(x => x.paid).slice(0, 4), [true, true, true, false]);
pays = M.tdPayouts({...c, credits: [{date: '2026-10-01', a: 300}]}, 0.06, 0.2, '2027-02-23', '2026-11-28');
eq('statement amount replaces the prediction', [pays[1].a, pays[1].actual], [300, true]);
near('and later months build on it', pays[2].a, Math.round(120378.90 * .048 / 365 * 31 * 100) / 100);

/* money moved to savings is saved, not spent */
const years = {'2026': Array.from({length: 12}, () => ({exp: []}))};
years['2026'][9].exp.push({a: 29000, d: '2026-10-15', n: 'Sent to own'});
years['2026'][9].exp.push({a: 15000, d: '2026-10-30', n: 'Sent to own'});
years['2026'][9].exp.push({a: 800, d: '2026-10-11', n: 'Grab'});
const isT = x => /sent to/i.test(x.n);
eq('deposit within the month is carved from transfers', M.carvePlan(years, [{date: '2026-10-15', a: 10000}], isT), {'2026-9': 10000});
eq('never more than the transfers', M.carvePlan(years, [{date: '2026-10-20', a: 90000}], isT), {'2026-9': 44000});
eq('deposit on the 1st matches a transfer on the 30th', M.carvePlan(years, [{date: '2026-11-01', a: 15000}], isT), {'2026-9': 15000});
eq('…but not a transfer earlier in the month', M.carvePlan(years, [{date: '2026-11-01', a: 20000}], isT), {'2026-10': 0});

/* sync: the same month changed on two phones keeps both sides */
const e = (id, a) => ({id, a, n: 'x' + id});
const base = {months: [{inc: [], exp: [e(1, 100), e(2, 200)], sav: 0}]};
const phone = {months: [{inc: [], exp: [e(1, 100), e(2, 200), e(3, 300)], sav: 0}]};        // added 3
const laptop = {months: [{inc: [], exp: [e(1, 100), e(2, 250), e(4, 400)], sav: 0}]};       // changed 2, added 4
let m = M.merge3('y2026', base, phone, laptop).months[0];
eq('both new entries kept, the other side’s edit kept', m.exp.map(x => [x.id, x.a]).sort(), [[1, 100], [2, 250], [3, 300], [4, 400]]);
m = M.merge3('y2026', base, {months: [{inc: [], exp: [e(2, 200)], sav: 0}]}, laptop).months[0];
eq('deleted here stays deleted', m.exp.map(x => x.id).sort(), [2, 4]);
m = M.merge3('y2026', base, {months: [{inc: [], exp: [e(1, 100), e(2, 222)], sav: 0}]}, laptop).months[0];
eq('changed on both sides: this device wins', m.exp.find(x => x.id === 2).a, 222);
eq('no server copy: keep ours', M.merge3('y2026', null, phone, undefined), phone);
eq('12 months always', M.merge3('y2026', base, phone, laptop).months.length, 12);
const meta = M.merge3('meta', {goals: [{id: 'g1', name: 'A'}], payCut: 15}, {goals: [{id: 'g1', name: 'A'}, {id: 'g2', name: 'B'}], payCut: 15}, {goals: [{id: 'g1', name: 'A'}, {id: 'g3', name: 'C'}], payCut: 16});
eq('goals merged item by item', meta.goals.map(g => g.id).sort(), ['g1', 'g2', 'g3']);
eq('plain settings: the changed side wins', meta.payCut, 16);

/* uneven paydays */
const sal = n => /payroll/i.test(n), T = new Date(2026, 10, 28);   // Nov 28, 2026
const payE = []; for (let m = 4; m <= 9; m++) {                     // May–Oct
  payE.push({d: M.iso(new Date(2026, m, 15)), a: 20000, n: 'INREM PAYROLL'});
  payE.push(m % 2 ? {d: M.iso(new Date(2026, m + 1, 1)), a: 44000, n: 'INREM PAYROLL'} : {d: M.iso(new Date(2026, m, 30)), a: 44000, n: 'INREM PAYROLL'}); }   // the 30th's pay sometimes lands on the 1st
eq('15th vs 30th, even when the 30th pay lands on the 1st', M.paySlots(payE, T, sal), {mid: 20000, end: 44000});
eq('not salary: ignored', M.paySlots([...payE, {d: '2026-10-16', a: 999, n: 'Refund'}], T, sal), {mid: 20000, end: 44000});
eq('too little history: no split', M.paySlots(payE.slice(-2), T, sal), null);

/* paydays until a month */
eq('paydays from Nov 28 until December', M.paydaysUntil('2026-12', T), 1);          // Nov 30
eq('…until March (Nov 30, Dec 15, Dec 30, Jan 15, Jan 30, Feb 15, Feb 28)', M.paydaysUntil('2027-03', T), 7);

/* home loan */
near('₱2.5M at 4.5% for 30 years ≈ ₱12,667 (Pag-IBIG’s own example)', M.amort(2500000, 4.5, 30), 12667, 1);
near('balance after all payments is zero', M.loanLeft(1000000, 6, 10, 120), 0, 0.01);
near('zero interest: straight split', M.amort(120000, 0, 1), 10000, 0.001);

/* subscriptions */
const nameOf = n => /netflix/i.test(n) ? 'Netflix' : /spotify/i.test(n) ? 'Spotify' : /grab/i.test(n) ? 'Grab' : /shop/i.test(n) ? 'Shop' : null, known = n => /netflix|spotify/i.test(n);
const subRows = [];
[5, 6, 7, 8, 9, 10].forEach(i => { const d = `2026-${String(i + 1).padStart(2, '0')}`;
  subRows.push({n: 'NETFLIX.COM', a: i < 10 ? 549 : 619, y: '2026', i, d: d + '-07'}, {n: 'SPOTIFY', a: 149, y: '2026', i, d: d + '-12'});
  for (let k = 0; k < 6; k++) subRows.push({n: 'GRAB ' + k, a: 100 + k * 37, y: '2026', i, d: d + '-0' + (k + 1)});      // many rides: not a subscription
  subRows.push({n: 'SHOP X', a: 300 + i * 200, y: '2026', i, d: d + '-20'}); });                                            // monthly but the price swings
const subs = M.detectSubs(subRows, nameOf, known);
eq('finds the subscriptions only', subs.map(x => x.name), ['Netflix', 'Spotify']);
eq('flags Netflix going up by ₱70', [subs[0].up, subs[0].before, subs[0].next], [70, 549, '2026-12-07']);

/* bills: ids from name + due date, the same on every phone */
const phoneA = [{name: 'SPayLater', a: 100, due: '2026-12-05'}, {name: 'Lazada PayLater', a: 50, due: '2026-12-16'}];
const phoneB = JSON.parse(JSON.stringify(phoneA));
M.ensureBillIds(phoneA); M.ensureBillIds(phoneB);
eq('two phones give the same ids', phoneA.map(b => b.id), phoneB.map(b => b.id));
const twins = [{name: 'X', due: '2026-01-01'}, {name: 'X', due: '2026-01-01'}]; M.ensureBillIds(twins);
eq('identical bills still get different ids', twins[0].id !== twins[1].id, true);
// first sync after ids: the old copy has no ids → whole-list rule, nothing duplicated
const baseNoIds = [{name: 'SPayLater', a: 100, due: '2026-12-05'}];
eq('first sync after ids: no duplicates', M.merge3('meta', {bills: baseNoIds}, {bills: phoneA}, {bills: phoneB}).bills.length, 2);
// afterwards: paid on one phone, a new bill on the other → both kept
const base2 = JSON.parse(JSON.stringify(phoneA)), l2 = JSON.parse(JSON.stringify(phoneA)), r2 = JSON.parse(JSON.stringify(phoneA));
l2[0].paid = true; r2.push({id: 'bnew', name: 'Meralco', a: 2000, due: '2026-12-20'});
const m2 = M.merge3('meta', {bills: base2}, {bills: l2}, {bills: r2}).bills;
eq('paid here + added there: both kept', [m2.length, m2.find(b => b.name === 'SPayLater').paid], [3, true]);

console.log('errors', JSON.stringify(errors));
process.exit(errors.length ? 1 : 0);
