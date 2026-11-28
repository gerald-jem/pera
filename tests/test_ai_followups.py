import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
import asyncio, subprocess, time, json
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8817','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
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
    await route.fulfill(status=200, content_type='text/plain; charset=utf-8', body='At **₱19,522/month** you reach ₱500,000 in about 11 months.\n*(Interest helps a little.)*\n>> How much each payday? | What if I save ₱25,000 a month? | Can I cut food to save more?')
async def newpage(ctx):
    ph=await ctx.new_page(); ph.errs=[]; ph.on('pageerror',lambda e:ph.errs.append(str(e))); await ph.goto('http://localhost:8817/'); await ph.wait_for_timeout(900); return ph
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    ctx=await b.new_context(viewport={'width':390,'height':844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    await ctx.route('**/functions/v1/pera-ai', ai_route)
    ph=await newpage(ctx)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900); await ph.keyboard.press('Escape'); await ph.wait_for_timeout(300)
    await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300)
    print('starters:', await ph.locator('#chatSugg .chip').all_inner_texts())
    await ph.fill('#chatQ','I want to save 500k, how long?'); await ph.press('#chatQ','Enter'); await ph.wait_for_timeout(300)
    print('chips while thinking:', await ph.locator('#chatSugg .chip').count())
    await ph.wait_for_timeout(1500)
    print('answer:', repr(await ph.inner_text('.msg.ai >> nth=-1')))
    print('italic:', await ph.locator('.msg.ai i').count(), '| >> hidden:', '>>' not in await ph.inner_text('#chatLog'))
    print('follow-ups:', await ph.locator('#chatSugg .chip').all_inner_texts())
    await ph.screenshot(path=OUT+'/ai_followups.png')
    await ph.click('[data-act=ask-goal]'); await ph.wait_for_timeout(400); print('goal form amount:', await ph.input_value('#gT'))
    await ph.keyboard.press('Escape'); await ph.wait_for_timeout(300)
    await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300); await ph.click('#chatSugg .chip >> nth=1'); await ph.wait_for_timeout(1500)
    print('tapped follow-up, msgs:', await ph.locator('.msg').count())
    print('errors', ph.errs); await b.close()
asyncio.run(main()); srv.kill()
