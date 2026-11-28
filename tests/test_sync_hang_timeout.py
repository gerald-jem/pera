import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8802','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read(); DB={}; HANG={'on':False}
async def op(source, kind, payload):
    if HANG['on'] and kind=='upsert': await asyncio.sleep(3600)
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
    await ph.goto('http://localhost:8802/'); await ph.wait_for_timeout(700)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900)
    print('after import:', await ph.inner_text('#syncTxt'), '| dirty', await ph.evaluate("localStorage.getItem('pera:dirty:u1')"))
    HANG['on']=True
    await ph.click('.tab[data-v=bills]')
    if await ph.inner_text('#qbMode') == 'Type it instead': await ph.click('#qbMode')
    await ph.fill('#qb','Meralco 2000 Dec 20 2026'); await ph.wait_for_timeout(150); await ph.click('#qbGo'); await ph.wait_for_timeout(3000)
    await ph.click('#sync'); await ph.wait_for_timeout(300); print('while stuck:', (await ph.inner_text('#sheetBody .note')).replace('\n',' | '))
    await ph.click('#sheetBody [data-act=close]'); await ph.wait_for_timeout(19000)
    print('after limit:', await ph.inner_text('#syncTxt'))
    await ph.click('#sync'); await ph.wait_for_timeout(300); print('details:', (await ph.inner_text('#sheetBody .note')).replace('\n',' | '))
    HANG['on']=False
    await ph.click('#sheetBody [data-act=sync-now]'); await ph.wait_for_timeout(1500)
    print('retry:', await ph.inner_text('#syncTxt'), '|', await ph.inner_text('#toastMsg'), '| server has Meralco:', any(x['name']=='Meralco' for x in DB['meta']['bills']))
    print('errors', errs)
    await b.close()
asyncio.run(main()); srv.kill()
