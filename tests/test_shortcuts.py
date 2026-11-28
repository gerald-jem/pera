import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8805','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read(); DB={}
async def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    ctx=await b.new_context(viewport={'width':390,'height':844}, color_scheme='dark'); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ph=await ctx.new_page(); errs=[]; ph.on('pageerror',lambda e:errs.append(str(e)))
    await ph.goto('http://localhost:8805/'); await ph.wait_for_timeout(700)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900)
    # entries like his imported statement
    await ph.evaluate("""() => { const d = JSON.parse(localStorage.getItem('pera:data:u1')), m = d.years['2026'][10], add = (t, n, a, day) => m[t].push({id: Math.random().toString(36).slice(2), n, a, d: '2026-11-' + String(day).padStart(2,'0'), src: 'import'});
      [['VISA-GRAB PASIG CITY PH',550,3],['VISA-GRAB MAKATI PH',803,9],['VISA-GRAB MAKATI PH',210,12],['VISA-fp*Food Panda',440,4],['VISA-fp*Food Panda',380,14],['VISA-WL *Steam Purchase',600,5],['VISA-WL *Steam Purchase',600,20],['Sent to Juan Dela Cruz PPI',3000,6],['Sent to Juan Dela Cruz PPI',3000,21],['VISA-SHOPEE PH MANDALUYONG',28900,7],['VISA-SHOPEE PH MANDALUYONG',1200,17]].forEach(([n,a,dd]) => add('exp', n, a, dd));
      [['INREM VIA PCHC',47700,15],['INREM VIA PCHC',47800,30],['Interest to',3,25],['Interest to',2.5,26]].forEach(([n,a,dd]) => add('inc', n, a, dd));
      localStorage.setItem('pera:data:u1', JSON.stringify(d)); localStorage.setItem('pera:dirty:u1', JSON.stringify(['y2026'])); }""")
    await ph.reload(); await ph.wait_for_timeout(1000)
    await ph.click('.tab[data-v=months]'); await ph.click('#fab'); await ph.wait_for_timeout(400)
    vis = lambda: ph.evaluate("[...document.querySelectorAll('.shortcuts')].filter(x => x.offsetParent).flatMap(x => [...x.children].map(c => c.textContent.trim()))")
    print('expense shortcuts:', await vis())
    await ph.screenshot(path=OUT+'/sc_exp.png')
    await ph.click('[data-type=inc]'); await ph.wait_for_timeout(200); print('income shortcuts:', await vis())
    await ph.click('.shortcuts[data-for=inc] .chip >> nth=0'); await ph.wait_for_timeout(100); print('tap salary fills:', await ph.input_value('#fn'), await ph.input_value('#fa'))
    await ph.click('[data-type=exp]'); await ph.wait_for_timeout(200); await ph.click('.shortcuts[data-for=exp] .chip:has-text("Grab")'); await ph.wait_for_timeout(100)
    print('tap grab fills:', await ph.input_value('#fn'), await ph.input_value('#fa'), await ph.locator('#fc [aria-pressed=true]').all_inner_texts())
    print('errors', errs)
    await b.close()
asyncio.run(main()); srv.kill()
