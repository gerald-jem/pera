import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8806','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
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
    await ph.goto('http://localhost:8806/'); await ph.wait_for_timeout(700)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-savings.json')); await ph.wait_for_timeout(900)
    await ph.evaluate("localStorage.setItem('pera:look', JSON.stringify({accent:'teal'}))"); await ph.evaluate("localStorage.setItem('pera:fcYears','5')")
    await ph.reload(); await ph.wait_for_timeout(900)
    # keep only the Maya account like his phone
    await ph.evaluate("()=>{}")
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(1500)
    await ph.locator('.fccard').scroll_into_view_if_needed(); await ph.wait_for_timeout(600)
    print((await ph.inner_text('.fccard')).replace('\n',' | '))
    await ph.locator('.fccard').screenshot(path=OUT+'/fc.png')
    print('errors', errs)
    await b.close()
asyncio.run(main()); srv.kill()
