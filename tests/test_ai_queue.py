import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
import asyncio, subprocess, time, json
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8816','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock = open(os.path.join(HERE,'mock_supabase.js')).read() + '\n' + open(os.path.join(HERE,'mock_ai.js')).read(); DB={}
async def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
AI={'fail':0,'calls':0,'delay':0.6}
async def ai_route(route):
    body=json.loads(route.request.post_data or '{}'); AI['calls']+=1
    if AI['fail']>0:
        AI['fail']-=1; return await route.fulfill(status=502, content_type='application/json', body=json.dumps({'error':'Gemini: The model is overloaded. Please try again later. (503 UNAVAILABLE)'}))
    await asyncio.sleep(AI['delay'])
    await route.fulfill(status=200, content_type='text/plain; charset=utf-8', body={'ask':'Bills coming up: **₱12,021** in December.','card':'A recap with **₱18,400** kept.'}.get(body.get('task'),'OK'))
async def newpage(ctx):
    ph=await ctx.new_page(); ph.errs=[]; ph.on('pageerror',lambda e:ph.errs.append(str(e))); await ph.goto('http://localhost:8816/'); await ph.wait_for_timeout(900); return ph
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    ctx=await b.new_context(viewport={'width':390,'height':844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    await ctx.route('**/functions/v1/pera-ai', ai_route)
    ph=await newpage(ctx)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900)
    await ph.set_input_files('#importFile',os.path.join(FIX,'sample-savings.json')); await ph.wait_for_timeout(900); await ph.keyboard.press('Escape'); await ph.wait_for_timeout(300)
    # 1. busy → waits and retries by itself
    AI['fail']=1; await ph.click('.tab[data-v=home]'); await ph.wait_for_timeout(400); await ph.click('#hSum [data-act=ai-card]'); await ph.wait_for_timeout(1200)
    print('busy:', await ph.inner_text('#hSum .aifoot'), '|', await ph.inner_text('#hSum .hhead .aiwriting'))
    await ph.wait_for_timeout(6000); print('after retry:', (await ph.inner_text('#hSum .aitext'))[:40], '| toast:', await ph.inner_text('#toastMsg'))
    # 2. synced with data
    print('synced to server:', list((DB['meta'].get('aiNotes') or {}).keys()))
    # 3. queue: two cards at once
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(400); await ph.click('#v-savings [data-act=ai-card]')
    await ph.click('.tab[data-v=bills]'); await ph.wait_for_timeout(200); await ph.click('#billAI [data-act=ai-card]'); await ph.wait_for_timeout(150)
    print('second card while first runs:', await ph.inner_text('#billAI .aifoot'))
    await ph.wait_for_timeout(3500); print('both written:', sorted((DB['meta'].get('aiNotes') or {}).keys()))
    # 4. outdated note after a change
    await ph.click('.tab[data-v=home]'); await ph.wait_for_timeout(300); print('stale before change:', await ph.locator('#hSum .stalenote').count())
    await ph.click('#fab'); await ph.wait_for_timeout(300); await ph.fill('#fq','4500 shopee'); await ph.press('#fq','Enter'); await ph.wait_for_timeout(500)
    print('stale after change:', await ph.locator('#hSum .stalenote').count(), '|', (await ph.inner_text('#hSum .stalenote')) if await ph.locator('#hSum .stalenote').count() else '')
    await ph.locator('#hSum').screenshot(path=OUT+'/ai_stale.png')
    # 5. chat cache
    n0=AI['calls']; await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300); await ph.click('[data-act=ask-q] >> nth=4'); await ph.wait_for_timeout(1200)
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    await ph.evaluate("()=>{}"); await ph.reload(); await ph.wait_for_timeout(1200)
    await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300); t0=time.time(); await ph.click('[data-act=ask-q] >> nth=4'); await ph.wait_for_timeout(150)
    print('repeat question: instant =', await ph.locator('.cachednote').count()==1, '| calls made for both asks:', AI['calls']-n0, '|', await ph.inner_text('.cachednote'))
    await ph.click('[data-act=ask-fresh]'); await ph.wait_for_timeout(1200); print('ask again → new call:', AI['calls']-n0, '| note gone:', await ph.locator('.cachednote').count()==0)
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    # 6. offline → waits, then continues
    await ctx.set_offline(True); await ph.click('#hSum [data-act=ai-card] >> nth=0'); await ph.wait_for_timeout(800)
    print('offline:', await ph.inner_text('#hSum .aifoot'))
    await ctx.set_offline(False); await ph.wait_for_timeout(2500); print('back online, written:', await ph.locator('#hSum .aiwriting').count()==0, '| toast:', await ph.inner_text('#toastMsg'))
    # 7. closed mid-wait → resumes next time
    AI['fail']=5; await ph.click('.tab[data-v=months]'); await ph.wait_for_timeout(300); await ph.locator('#monthList li:has-text("October") button').first.click(); await ph.wait_for_timeout(400)
    await ph.click('#sheetBody [data-act=ai-card]'); await ph.wait_for_timeout(1000); print('pending saved:', await ph.evaluate("localStorage.getItem('pera:aiPending')"))
    AI['fail']=0; await ph.reload(); await ph.wait_for_timeout(5000)
    print('resumed after reopen:', 'sum:2026-9' in (DB['meta'].get('aiNotes') or {}), '| pending now:', await ph.evaluate("localStorage.getItem('pera:aiPending')"))
    print('errors', ph.errs)
    await b.close()
asyncio.run(main()); srv.kill()
