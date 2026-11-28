import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time, json
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8795','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read(); DB={}
def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':json.loads(json.dumps(v))} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
    if kind=='delete':
        for k in payload: DB.pop(k,None)
    return None
async def newdev(b, name):
    ctx=await b.new_context(viewport={'width':390,'height':844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    pg=await ctx.new_page(); pg.errs=[]; pg.on('pageerror',lambda e:pg.errs.append(str(e)))
    await pg.goto('http://localhost:8795/'); await pg.wait_for_timeout(700); return pg
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    phone=await newdev(b,'phone')
    await phone.click('#settingsBtn'); await phone.wait_for_timeout(300); await phone.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await phone.wait_for_timeout(800)
    # computer opens now and caches the data WITHOUT savings, then goes away
    pc=await newdev(b,'pc'); await pc.wait_for_timeout(500)
    print('pc cached years:', await pc.evaluate("Object.keys(JSON.parse(localStorage.getItem('pera:data:u1')).years)"))
    await pc.close()
    # phone adds savings + edits
    await phone.keyboard.press('Escape'); await phone.click('#settingsBtn'); await phone.wait_for_timeout(300); await phone.set_input_files('#importFile',os.path.join(FIX,'sample-savings.json')); await phone.wait_for_timeout(800)
    print('server savings after phone import:', [x['name'] for x in DB['meta'].get('savings',[])])
    # stale computer comes back with an old copy that has 'SPaylater' spellings → used to trigger the overwrite
    ctx=b.contexts[0]
    pc2=await newdev(b,'pc2')
    # give pc2 the OLD cache (no savings, mixed bill spellings) + an old base, like a device that was away
    old=json.loads(json.dumps(DB)); 
    stale={'meta':{**old['meta']}, 'years':{k[1:]:v['months'] for k,v in old.items() if k!='meta'}}
    stale['meta'].pop('savings',None); stale['meta']['savingsMigrated']=False
    stale['meta']['bills']=[{**x,'name':'SPaylater'} if x['name']=='SPayLater' else x for x in stale['meta']['bills']]
    await pc2.evaluate("([d,b])=>{localStorage.setItem('pera:data:u1',JSON.stringify(d));localStorage.setItem('pera:base:u1',JSON.stringify(b));localStorage.setItem('pera:dirty:u1','[]')}", [stale, {'meta':stale['meta']}])
    await pc2.reload(); await pc2.wait_for_timeout(1500)
    print('server savings after stale pc opens:', [x['name'] for x in DB['meta'].get('savings',[])], '| pc2 shows savings:', await pc2.evaluate("(JSON.parse(localStorage.getItem('pera:data:u1')).meta.savings||[]).map(p=>p.name)"))
    # concurrent edits: pc2 adds a bill, phone adds a deposit — both must survive
    await pc2.click('.tab[data-v=bills]'); await pc2.click('#fab'); await pc2.wait_for_timeout(300); print('form:', (await pc2.locator('.sheet').inner_text())[:300].replace('\n',' | ')); await pc2.select_option('#fbn','__other'); await pc2.fill('#fbo','Atome'); await pc2.fill('#fa','999'); await pc2.click('#ef .go'); await pc2.wait_for_timeout(800); print('after add local:', await pc2.evaluate("JSON.parse(localStorage.getItem('pera:data:u1')).meta.bills.map(b=>b.name+'@'+b.due)"), 'server:', [b['name'] for b in DB['meta']['bills']])
    await phone.click('.tab[data-v=savings]'); await phone.click('#fab'); await phone.wait_for_timeout(300); await phone.select_option('#fp', label='Maya time deposit'); await phone.fill('#fa','7777'); await phone.fill('#fdt','2026-11-27'); await phone.click('#ef .go'); await phone.wait_for_timeout(800)
    print("pc2 local bills:", await pc2.evaluate("JSON.parse(localStorage.getItem('pera:data:u1')).meta.bills.map(b=>b.name)"), "dirty", await pc2.evaluate("localStorage.getItem('pera:dirty:u1')"))
    maya=[x for x in DB['meta']['savings'] if x['name']=='Maya time deposit'][0]
    print('server has Atome bill:', any(x['name']=='Atome' for x in DB['meta']['bills']), '| server has 7777 deposit:', any(d['a']==7777 for c in maya['cycles'] for d in c['deposits']))
    # snapshots exist + restore works
    await pc2.click('#settingsBtn'); await pc2.wait_for_timeout(300)
    print('pc2 copies:', [t.replace('\n',' | ') for t in await pc2.locator('h2:has-text("Copies on this device") + p + ul li').all_inner_texts()])
    # offline edits on both, then reconnect
    await pc2.keyboard.press('Escape'); await pc2.wait_for_timeout(200)
    await pc2.evaluate("()=>{window.__dbOp=window.dbOp; window.dbOp=()=>Promise.reject(new Error('offline'))}")
    await phone.evaluate("()=>{window.__dbOp=window.dbOp; window.dbOp=()=>Promise.reject(new Error('offline'))}")
    await pc2.click('.tab[data-v=bills]'); await pc2.click('#fab'); await pc2.wait_for_timeout(300); await pc2.select_option('#fbn','__other'); await pc2.fill('#fbo','Meralco'); await pc2.fill('#fa','2500'); await pc2.click('#ef .go'); await pc2.wait_for_timeout(500)
    await phone.click('.tab[data-v=savings]'); await phone.click('#fab'); await phone.wait_for_timeout(300); await phone.select_option('#fp', label='Maya time deposit'); await phone.fill('#fa','1234'); await phone.fill('#fdt','2026-11-27'); await phone.click('#ef .go'); await phone.wait_for_timeout(500)
    for pg in (pc2, phone): await pg.evaluate("()=>{window.dbOp=window.__dbOp}")
    await pc2.evaluate("()=>document.dispatchEvent(new Event('visibilitychange'))"); await pc2.wait_for_timeout(800)
    await phone.evaluate("()=>document.dispatchEvent(new Event('visibilitychange'))"); await phone.wait_for_timeout(800)
    await pc2.evaluate("()=>document.dispatchEvent(new Event('visibilitychange'))"); await pc2.wait_for_timeout(800)
    maya=[x for x in DB['meta']['savings'] if x['name']=='Maya time deposit'][0]
    print('offline both kept: Meralco', any(x['name']=='Meralco' for x in DB['meta']['bills']), '| 1234', any(d['a']==1234 for c in maya['cycles'] for d in c['deposits']), '| 7777', any(d['a']==7777 for c in maya['cycles'] for d in c['deposits']))
    print('pc2 sees 1234:', await pc2.evaluate("JSON.stringify(JSON.parse(localStorage.getItem('pera:data:u1')).meta.savings).includes('1234')"))
    # restore copy
    await pc2.click('#settingsBtn'); await pc2.wait_for_timeout(300); await pc2.click('[data-act=snap-restore][data-k="0"]'); await pc2.wait_for_timeout(1000)
    print('after restore server savings:', len(DB['meta'].get('savings',[])), 'toast:', (await pc2.locator('#toast').inner_text()).replace('\n',' '))
    print('errors', phone.errs, pc2.errs)
    await b.close()
asyncio.run(main()); srv.kill()
