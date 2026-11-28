import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8804','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read(); DB={}
async def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    ctx=await b.new_context(viewport={'width':390,'height':844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ph=await ctx.new_page(); errs=[]; ph.on('pageerror',lambda e:errs.append(str(e)))
    await ph.goto('http://localhost:8804/'); await ph.wait_for_timeout(700)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900)
    await ph.evaluate("localStorage.setItem('pera:look', JSON.stringify({style:'colorful'}))")
    await ph.reload(); await ph.wait_for_timeout(1500)
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(120); await ph.screenshot(path=OUT+'/anim_mid.png')
    mid = await ph.inner_text('[data-count=sav]'); await ph.wait_for_timeout(1000); end = await ph.inner_text('[data-count=sav]')
    print('savings count:', mid, '->', end)
    await ph.screenshot(path=OUT+'/anim_sav.png')
    await ph.click('.tab[data-v=home]'); await ph.wait_for_timeout(200)
    print('home mid:', await ph.inner_text('#homeTotal'), '| left mid:', await ph.inner_text('[data-count=left]'), '| chart drawing:', await ph.evaluate("document.getElementById('chart').classList.contains('drawn')"))
    await ph.wait_for_timeout(1500); print('home end:', await ph.inner_text('#homeTotal'), '| left:', await ph.inner_text('[data-count=left]'), '| drawn class removed:', not await ph.evaluate("document.getElementById('chart').classList.contains('drawn')"))
    # a change animates from old to new, no replay of chart
    await ph.click('.tab[data-v=bills]'); await ph.wait_for_timeout(1000)
    before = await ph.inner_text('[data-count=bills]')
    await ph.locator('#billList .chk').first.click(); await ph.wait_for_timeout(80); mid=await ph.inner_text('[data-count=bills]'); await ph.wait_for_timeout(700)
    print('bills change:', before, '->', mid, '->', await ph.inner_text('[data-count=bills]'))
    # reduced motion: no counting
    ctx2=await b.new_context(viewport={'width':390,'height':844}, reduced_motion='reduce'); await ctx2.expose_binding('dbOp', op)
    await ctx2.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx2.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    p2=await ctx2.new_page(); await p2.goto('http://localhost:8804/'); await p2.wait_for_timeout(1200)
    await p2.click('.tab[data-v=savings]'); await p2.wait_for_timeout(60); print('reduced motion shows final at once:', await p2.inner_text('[data-count=sav]'))
    print('errors', errs)
    await b.close()
asyncio.run(main()); srv.kill()
