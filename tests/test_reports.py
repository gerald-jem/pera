import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8807','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read(); DB={}
async def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
async def run(b, scheme):
    ctx=await b.new_context(viewport={'width':390,'height':844}, color_scheme=scheme); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ph=await ctx.new_page(); errs=[]; ph.on('pageerror',lambda e:errs.append(str(e)))
    await ph.goto('http://localhost:8807/'); await ph.wait_for_timeout(700)
    if scheme == 'light':
        await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900)
        print('A local', await ph.evaluate("Object.keys(JSON.parse(localStorage.getItem('pera:data:u1')).years)"), 'DB', list(DB))
        await ph.evaluate("""() => { const d = JSON.parse(localStorage.getItem('pera:data:u1'));
          const add = (mi, n, a, day, c) => d.years['2026'][mi].exp.push({id: Math.random().toString(36).slice(2), n, a, d: `2026-${String(mi+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`, ...(c?{c}:{})});
          for (const mi of [8,9,10]) { [['Jollibee',180,3],['Grab',250,5],['Puregold',2400,7],['Meralco',2100,12],['Netflix',549,14],['Shopee',1800,15],['Grab',310,19],['Food Panda',420,21],['Globe postpaid',1299,22],['Jollibee',220,26],['Steam',600,28]].forEach(([n,a,dd]) => add(mi, n, a + mi*10, dd)); }
          d.meta.bills.push({name:'Lazada PayLater',a:1570.9,due:'2026-12-16',paid:false,count:true}); for (const m of ['01','02','03','04','05','06']) d.meta.bills.push({name:'Lazada PayLater',a:199.29,due:`2027-${m}-16`,paid:false,count:true});
          d.meta.bills.push({name:'SPayLater',a:10450.57,due:'2027-01-05',paid:false,count:true}, {name:'SPayLater',a:295.63,due:'2027-02-05',paid:false,count:true});
          localStorage.setItem('pera:data:u1', JSON.stringify(d)); localStorage.setItem('pera:dirty:u1', JSON.stringify(['meta','y2026'])); }""")
        print('B local', await ph.evaluate("Object.keys(JSON.parse(localStorage.getItem('pera:data:u1')).years)"), await ph.evaluate("localStorage.getItem('pera:dirty:u1')"))
        await ph.reload(); await ph.wait_for_timeout(1200)
    await ph.screenshot(path=OUT+'/pre.png'); print('pre', await ph.evaluate("Object.keys(JSON.parse(localStorage.getItem('pera:data:u1')||'{}').years||{})"), errs, (await ph.evaluate("document.getElementById('insights').innerHTML.length")))
    await ph.locator('.reports').scroll_into_view_if_needed(); await ph.wait_for_timeout(300)
    if scheme=='light': await ph.locator('#insights').screenshot(path=OUT+'/rep_row.png')
    for r in ['trend','cal','rate','debt']:
        if not await ph.locator(f'[data-act=report][data-r={r}]').count(): await ph.click('[data-act=rep-more]'); await ph.wait_for_timeout(300)
        await ph.click(f'[data-act=report][data-r={r}]'); await ph.wait_for_timeout(500)
        hit = ph.locator('#sheetBody .hit, #sheetBody .calday.s3, #sheetBody .calday.s5')
        if await hit.count(): await hit.nth(min(3, await hit.count()-1)).click(); await ph.wait_for_timeout(200)
        if scheme=='light': print(r, '|', (await ph.inner_text('#sheetBody'))[:230].replace('\n',' | '))
        await ph.screenshot(path=OUT+f'/rep_{r}_{scheme}.png')
        await ph.click('#sheetBody [data-act=close]'); await ph.wait_for_timeout(300)
    print(scheme, 'errors', errs)
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    await run(b,'light'); await run(b,'dark')
    await b.close()
asyncio.run(main()); srv.kill()
