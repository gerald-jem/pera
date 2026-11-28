"""Make the sample data the tests use. Invented numbers only — never put real finance files here (this repo is public).
Run:  python3 tests/make_fixtures.py"""
import json, os, random
from datetime import date, timedelta
random.seed(7)
HERE = os.path.dirname(os.path.abspath(__file__)); FIX = os.path.join(HERE, 'fixtures'); os.makedirs(FIX, exist_ok=True)
uid = iter(range(1, 10**6)); nid = lambda p='x': f'{p}{next(uid)}'
def month(inc_n, exp_n, sav):
    return {'inc': [{'id': nid(), 'a': round(random.uniform(24000, 31000), 2), 'n': ''} for _ in range(inc_n)],
            'exp': [{'id': nid(), 'a': round(random.uniform(80, 4000), 2), 'n': ''} for _ in range(exp_n)], 'sav': sav}
years = {'2025': [month(0, 0, 0) for _ in range(12)], '2026': [month(2, random.randint(6, 15), 30000 if k < 8 else 36000) for k in range(12)], '2027': [month(2, 1, 0) for _ in range(12)]}
for k in range(7, 12): years['2025'][k] = month(2, random.randint(5, 12), 20000)
bills = [{'name': 'Lazada PayLater', 'a': 9876.54, 'due': d, 'paid': False} for d in ('2026-04-16', '2026-05-16', '2026-06-16')]
bills += [{'name': 'SPaylater' if k == 0 else 'SPayLater', 'a': 10500.0 + 100 * k, 'due': d, 'paid': False} for k, d in enumerate(('2026-11-05', '2026-12-05', '2027-01-05'))]
backup = {'meta': {'years': ['2025', '2026', '2027'], 'maya': {'cycles': []}, 'phone': {'start': '', 'end': '', 'end_bal': 0},
                   'accounts': [{'name': 'Seabank', 'bal': 12000.0, 'asof': '2026-10-01'}], 'bills': bills}, 'years': years}
def cycle(start, days, rate, carry, amt):
    s = date.fromisoformat(start); e = s + timedelta(days=days); deps = []; d = s + timedelta(days=1)
    while d < e - timedelta(days=5): deps.append({'id': nid('m'), 'date': d.isoformat(), 'a': amt}); d += timedelta(days=15)
    return {'start': s.isoformat(), 'end': e.isoformat(), 'rate': rate, 'carry': carry, 'deposits': deps}
c1 = cycle('2025-08-07', 181, 0.06, 0, 10000.0); c2 = cycle('2026-02-06', 182, 0.055, 0, 12000.0); c3 = cycle('2026-08-07', 182, 0.055, 0, 15000.0)
savings = {'pera': 'savings', 'savings': [{'id': 'maya', 'name': 'Maya time deposit', 'kind': 'td', 'rate': 0.055, 'tax': 0.2, 'cycleDays': 182,
           'cycles': [c1, c2, c3], 'plan': {'amount': 15000, 'step': 15, 'cycleDays': 182, 'rate': 0.055, 'cycles': 6, 'rates': {'5': 0.06}}}]}
json.dump(backup, open(os.path.join(FIX, 'sample-backup.json'), 'w'), indent=1)
json.dump(savings, open(os.path.join(FIX, 'sample-savings.json'), 'w'), indent=1)
print('wrote', os.listdir(FIX))
