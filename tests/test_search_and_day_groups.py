import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8810','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read(); DB={}
async def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
async def setup(b, w, h):
    ctx=await b.new_context(viewport={'width':w,'height':h}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ph=await ctx.new_page(); ph.errs=[]; ph.on('pageerror',lambda e:ph.errs.append(str(e)))
    await ph.goto('http://localhost:8810/'); await ph.wait_for_timeout(700); return ph
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    ph=await setup(b,390,844)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900)
    await ph.evaluate("""() => { const d = JSON.parse(localStorage.getItem('pera:data:u1')), m = d.years['2026'][10];
      [['VISA-GRAB MAKATI PH',550,'2026-11-03'],['Jollibee',180,'2026-11-03'],['VISA-GRAB PASIG CITY PH',310,'2026-11-12'],['Puregold',2400,'2026-11-12'],['Netflix',549,'2026-11-14']].forEach(([n,a,dd]) => m.exp.push({id: Math.random().toString(36).slice(2), n, a, d: dd}));
      m.inc.push({id:'s1', n:'INREM VIA PCHC', a:47800, d:'2026-11-15'});
      localStorage.setItem('pera:data:u1', JSON.stringify(d)); localStorage.setItem('pera:dirty:u1', JSON.stringify(['y2026'])); }""")
    await ph.reload(); await ph.wait_for_timeout(1200)
    await ph.click('.tab[data-v=months]'); await ph.wait_for_timeout(300)
    await ph.locator('#monthList li:has-text("November") button').first.click(); await ph.wait_for_timeout(500)
    print('day headers:', await ph.locator('#sheetBody .dayh').all_inner_texts())
    await ph.evaluate("document.getElementById('sheet').scrollTop = 400"); await ph.wait_for_timeout(200)
    await ph.screenshot(path=OUT+'/ux_month.png')
    print('Done/+Add still visible after scroll:', await ph.locator('#sheetBody .sheethead button').is_visible())
    await ph.keyboard.press('Escape'); await ph.click('[data-act=close]') if await ph.locator('#sheet.on').count() else None; await ph.wait_for_timeout(300)
    await ph.click('[data-act=search]'); await ph.wait_for_timeout(300)
    await ph.fill('#srQ','grab'); await ph.wait_for_timeout(200); print('grab:', await ph.inner_text('#srSum'))
    await ph.fill('#srQ','550'); await ph.wait_for_timeout(200); print('550:', await ph.inner_text('#srSum'))
    await ph.fill('#srQ','groceries'); await ph.wait_for_timeout(200); print('groceries:', await ph.inner_text('#srSum'))
    await ph.fill('#srQ',''); await ph.click('[data-act=sr-f][data-k=in]'); await ph.wait_for_timeout(200); print('money in:', await ph.inner_text('#srSum'))
    await ph.fill('#srQ','lazada'); await ph.click('[data-act=sr-f][data-k=bill]'); await ph.wait_for_timeout(200); print('bills lazada:', await ph.inner_text('#srSum'))
    await ph.click('[data-act=sr-f][data-k=all]'); await ph.fill('#srQ','grab'); await ph.wait_for_timeout(200); await ph.screenshot(path=OUT+'/ux_search.png')
    await ph.locator('#srList .rowbtn').first.click(); await ph.wait_for_timeout(300); print('tap result opens:', await ph.inner_text('#sheetBody h2'))
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    await ph.click('.tab[data-v=months]'); await ph.click('#fab'); await ph.wait_for_timeout(300)
    print('note suggestions:', await ph.evaluate("[...document.querySelectorAll('#fnList option')].slice(0,5).map(o=>o.value)"), await ph.get_attribute('#fn','autocorrect'))
    dk=await setup(b,1440,900); await dk.wait_for_timeout(600); await dk.click('.tab[data-v=months]'); await dk.wait_for_timeout(400); await dk.screenshot(path=OUT+'/ux_desk.png')
    await dk.click('[data-act=search]'); await dk.wait_for_timeout(300); await dk.fill('#srQ','jollibee'); await dk.wait_for_timeout(200); await dk.screenshot(path=OUT+'/ux_desk_search.png')
    print('errors', ph.errs, dk.errs)
    await b.close()
asyncio.run(main()); srv.kill()
