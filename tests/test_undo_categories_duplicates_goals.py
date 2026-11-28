import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time, json
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8797','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read(); DB={}
async def op(source, kind, payload):
    await asyncio.sleep(0.05)
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
    if kind=='delete':
        for k in payload: DB.pop(k,None)
async def dev(b, w=390, h=844):
    ctx=await b.new_context(viewport={'width':w,'height':h}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    pg=await ctx.new_page(); pg.errs=[]; pg.on('pageerror',lambda e:pg.errs.append(str(e)))
    await pg.goto('http://localhost:8797/'); await pg.wait_for_timeout(700); return pg
LS="JSON.parse(localStorage.getItem('pera:data:u1'))"
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    ph=await dev(b)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(700)
    await ph.keyboard.press('Escape'); await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-savings.json')); await ph.wait_for_timeout(900)
    await ph.keyboard.press('Escape'); await ph.wait_for_timeout(300)
    # --- deposit delete + undo
    await ph.click('.tab[data-v=savings]'); await ph.click('.potcard:has-text("Maya")'); await ph.wait_for_timeout(400)
    cnt=lambda: ph.evaluate(f"{LS}.meta.savings.find(p=>p.kind==='td').cycles.reduce((s,c)=>s+c.deposits.length,0)")
    n0=await cnt(); await ph.locator('[data-act=dep-del]').first.click(); await ph.wait_for_timeout(900)
    n1=await cnt(); await ph.click('#toastBtn'); await ph.wait_for_timeout(900); n2=await cnt()
    srv_n=sum(len(c['deposits']) for c in [p for p in DB['meta']['savings'] if p['kind']=='td'][0]['cycles'])
    print('deposit undo:', n0, '->', n1, '-> undo', n2, '| server', srv_n)
    await ph.keyboard.press('Escape'); await ph.wait_for_timeout(300)
    # --- quick line + category
    await ph.click('.tab[data-v=months]'); await ph.click('#fab'); await ph.wait_for_timeout(400)
    await ph.fill('#fq','2 burgers 150 jollibee yesterday'); await ph.wait_for_timeout(100)
    print('quick:', await ph.input_value('#fa'), '|', await ph.input_value('#fn'), '|', await ph.input_value('#fdt'), '| cat', await ph.locator('#fc [aria-pressed=true]').all_inner_texts(), await ph.inner_text('#fcHint'))
    await ph.click('#fc [data-cat=Groceries]'); await ph.press('#fq','Enter'); await ph.wait_for_timeout(500)
    print('saved cat:', await ph.evaluate(f"(()=>{{const d={LS};for(const y in d.years)for(const m of d.years[y])for(const x of m.exp)if(x.n==='2 burgers jollibee')return [x.a,x.c,x.d]}})()"), '| rule', await ph.evaluate(f"{LS}.meta.catRules"))
    await ph.click('#fab'); await ph.wait_for_timeout(300); await ph.fill('#fq','+25k salary'); await ph.wait_for_timeout(100)
    print('income parse:', await ph.locator('[data-type][aria-pressed=true]').inner_text(), await ph.input_value('#fa'), await ph.input_value('#fn'))
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    # add jollibee twice more → shortcut
    for q in ['180 jollibee','95 grab']:
        await ph.click('#fab'); await ph.wait_for_timeout(300); await ph.fill('#fq',q); await ph.press('#fq','Enter'); await ph.wait_for_timeout(400)
    await ph.click('#fab'); await ph.wait_for_timeout(300)
    print('shortcuts:', await ph.locator('.shortcuts[data-for=exp] .chip').all_inner_texts())
    await ph.screenshot(path=OUT+'/add_form.png')
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    # --- duplicates
    t=time.strftime('%Y-%m-%d'); y=time.strftime('%Y-%m-%d', time.localtime(time.time()-86400))
    csv=f"Date,Description,Debit,Credit\n{y},POS JOLLIBEE FOODS 123,150.00,\n{t},POS JOLLIBEE QC,180.00,\n{t},STARBUCKS,180.00,\n{t},STARBUCKS,250.00,\n"
    open(OUT+'/dup.csv','w').write(csv)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300)
    await ph.click('#sheetBody [data-act=statement]'); await ph.wait_for_timeout(300)
    await ph.set_input_files('#stFile',OUT+'/dup.csv'); await ph.wait_for_timeout(800)
    if await ph.locator('#cGo').count(): await ph.click('#cGo'); await ph.wait_for_timeout(500)
    print('dup summary:', await ph.inner_text('#impDup'))
    for li in await ph.locator('#impList li').all(): print('   ', (await li.inner_text()).replace('\n',' | '), '| on' if 'off' not in (await li.get_attribute('class') or '') else '| off')
    await ph.screenshot(path=OUT+'/dups.png')
    # import, then import again: all 'same'
    await ph.click('#impGo'); await ph.wait_for_timeout(600)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.click('#sheetBody [data-act=statement]'); await ph.wait_for_timeout(300)
    await ph.set_input_files('#stFile',OUT+'/dup.csv'); await ph.wait_for_timeout(800)
    if await ph.locator('#cGo').count(): await ph.click('#cGo'); await ph.wait_for_timeout(500)
    print('re-import summary:', await ph.inner_text('#impDup'))
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    # --- goals
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(300)
    await ph.click('[data-act=goal-new] >> nth=0'); await ph.wait_for_timeout(300)
    await ph.fill('#gN','Emergency fund'); await ph.fill('#gT','500k'); await ph.fill('#gB','2027-12'); await ph.click('#gf .go'); await ph.wait_for_timeout(600)
    print('goal sheet:', (await ph.inner_text('#sheetBody'))[:700].replace('\n',' | '))
    await ph.screenshot(path=OUT+'/goal.png', full_page=False)
    await ph.click('[data-act=goal-edit]'); await ph.wait_for_timeout(300); await ph.fill('#gB',''); await ph.fill('#gM','20k'); await ph.click('#gf .go'); await ph.wait_for_timeout(500)
    print('goal monthly:', (await ph.locator('.gplan').all_inner_texts()))
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    print('goal card:', (await ph.locator('.goalcard').inner_text()).replace('\n',' | '))
    await ph.screenshot(path=OUT+'/sav.png')
    print('server goals:', [g['name'] for g in DB['meta'].get('goals',[])])
    print('errors', ph.errs)
    await b.close()
asyncio.run(main()); srv.kill()
