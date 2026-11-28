# Monthly-interest time deposits: payout = daily balance × rate × (1 − tax) ÷ 365, paid on the 1st and compounding. Invented sample.
import os
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8881','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock = open(os.path.join(HERE,'mock_supabase.js')).read() + '\n' + open(os.path.join(HERE,'mock_ai.js')).read()
async def op(source, kind, payload): return [] if kind=='select' else None
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME); ctx=await b.new_context(viewport={'width':390,'height':844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ph=await ctx.new_page(); errs=[]; ph.on('pageerror',lambda e:errs.append(str(e))); await ph.goto('http://localhost:8881/'); await ph.wait_for_timeout(800)
    await ph.evaluate("""()=>{const d={years:{},meta:{savings:[{id:'t1',name:'Sample TD',kind:'td',monthly:true,rate:0.06,tax:0.2,cycleDays:181,
      cycles:[{start:'2026-08-26',end:'2027-02-23',rate:0.06,carry:100000,deposits:[{id:'d1',date:'2026-09-16',a:20000}],credits:[{id:'c1',date:'2026-10-01',a:300}]}]}]}};
      localStorage.setItem('pera:data:u1',JSON.stringify(d)); localStorage.setItem('pera:dirty:u1',JSON.stringify(['meta']));}"""); await ph.reload(); await ph.wait_for_timeout(1200)
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(400); await ph.click('[data-act=pot-open]'); await ph.wait_for_timeout(500)
    rows=[r.split('\t') for r in (await ph.inner_text('.payouts tbody')).split('\n')]
    print('Sep 1 payout (expect 78.90):', rows[0][2]); print('Oct 1 uses the statement (expect 300.00 ✓):', rows[1][2])
    # Oct: balance 100,078.90 + 300 + 20,000 all month → 120,378.90 × .048 / 365 × 31
    print('Nov 1 predicted (expect 490.75):', rows[2][2]); print('last row is maturity:', rows[-1][0])
    print('errors', errs); await b.close()
asyncio.run(main()); srv.kill()
