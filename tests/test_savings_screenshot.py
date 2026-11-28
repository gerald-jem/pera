# Savings from screenshots: an invented Pag-IBIG-style contribution table is rendered, photographed and read back.
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8862','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock = open(os.path.join(HERE,'mock_supabase.js')).read() + '\n' + open(os.path.join(HERE,'mock_ai.js')).read(); DB={}
async def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
# invented sample: 3 contributions (two share one reference), a dividend, and the totals box
ROWS=[('12/31/2025','DIV','/','55.20'),('12/20/2025','900000000000001','12/2025','500.00'),('11/18/2025','900000000000002','11/2025','500.00'),('11/18/2025','900000000000002','10/2025','500.00')]
TABLE='''<body style="font:22px Arial;padding:20px;width:520px"><p>Total Contribution</p><p>PHP 1,500.00</p><p>Total Dividends</p><p>PHP 55.20</p><p>Total Savings</p><p>PHP 1,555.20</p>
<h3>Contributions</h3><table cellpadding="10" style="border-collapse:collapse"><tr><th>Transaction Date</th><th>Reference/PFR No.</th><th>Period Covered</th><th>Amount</th></tr>'''+''.join(f'<tr><td>{a}</td><td>{b}</td><td>{c}</td><td>{d}</td></tr>' for a,b,c,d in ROWS)+'</table></body>'
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    pg=await b.new_page(viewport={'width':560,'height':760}); await pg.set_content(TABLE); await pg.screenshot(path=OUT+'/fake_mp2.png'); await pg.close()
    ctx=await b.new_context(viewport={'width':390,'height':844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ph=await ctx.new_page(); errs=[]; ph.on('pageerror',lambda e:errs.append(str(e)))
    await ph.goto('http://localhost:8862/'); await ph.wait_for_timeout(800)
    await ph.evaluate("""()=>{const d={years:{},meta:{savings:[{id:'m1',name:'Sample MP2',kind:'mp2',rate:0.07,rates:{},payout:'compound',deposits:[{id:'a',date:'2025-10-05',a:500}]}]}};
      localStorage.setItem('pera:data:u1',JSON.stringify(d)); localStorage.setItem('pera:dirty:u1',JSON.stringify(['meta']));}"""); await ph.reload(); await ph.wait_for_timeout(1200)
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(400); await ph.click('[data-act=pot-open]'); await ph.wait_for_timeout(500)
    await ph.set_input_files('#potShot', OUT+'/fake_mp2.png'); await ph.wait_for_selector('#psBody', timeout=120000); await ph.wait_for_timeout(300)
    rows=[(await li.inner_text()).replace('\n',' ') for li in await ph.locator('#psBody .implist li').all()]
    for r in rows: print(' ', r)
    print('ticked:', await ph.locator('#psBody .chk.on').count(), '| statement line:', 'PHP' not in (await ph.inner_text('#psBody .stalenote')))
    await ph.click('[data-act=pshot-go]'); await ph.wait_for_timeout(800)
    print('toast:', await ph.inner_text('#toastMsg'))
    deps=await ph.evaluate("JSON.parse(localStorage.getItem('pera:data:u1')).meta.savings[0]")
    print('deposits:', len(deps['deposits']), '| dividend 2025:', deps.get('divActual'))
    await ph.click('#toastBtn'); await ph.wait_for_timeout(500)
    deps=await ph.evaluate("JSON.parse(localStorage.getItem('pera:data:u1')).meta.savings[0]"); print('after undo:', len(deps['deposits']), deps.get('divActual'))
    print('errors', errs); await b.close()
asyncio.run(main()); srv.kill()
