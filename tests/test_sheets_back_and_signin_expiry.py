import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8801','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read().replace("signInWithPassword:", "refreshSession: async () => ({error: {message: 'Invalid Refresh Token: Already Used'}}), signInWithPassword:")
DB={}; FAIL={'on':False}
async def op(source, kind, payload):
    if FAIL['on'] and kind!='select': raise Exception('x')
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
SWIPE="""async ([sel, dy]) => { const el = document.querySelector(sel), r = el.getBoundingClientRect(), x = r.left + r.width/2, y = r.top + r.height/2;
  const t = (yy) => new Touch({identifier: 1, target: el, clientX: x, clientY: yy});
  el.dispatchEvent(new TouchEvent('touchstart', {touches: [t(y)], bubbles: true, cancelable: true}));
  for (let k = 1; k <= 10; k++) { el.dispatchEvent(new TouchEvent('touchmove', {touches: [t(y + dy*k/10)], bubbles: true, cancelable: true})); await new Promise(r => setTimeout(r, 30)); }
  el.dispatchEvent(new TouchEvent('touchend', {touches: [], bubbles: true, cancelable: true})); }"""
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    ctx=await b.new_context(viewport={'width':390,'height':844}, has_touch=True); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ph=await ctx.new_page(); errs=[]; ph.on('pageerror',lambda e:errs.append(str(e)))
    await ph.goto('http://localhost:8801/'); await ph.wait_for_timeout(700)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(700)
    on=lambda: ph.evaluate("document.getElementById('sheet').classList.contains('on')")
    await ph.click('.tab[data-v=bills]'); await ph.click('.pbrow >> nth=0'); await ph.wait_for_timeout(300)
    await ph.evaluate(SWIPE, ['#sheet .grab', 40]); await ph.wait_for_timeout(300); print('small swipe keeps open:', await on())
    await ph.evaluate(SWIPE, ['#sheet .sheethead h2', 260]); await ph.wait_for_timeout(400); print('big swipe closes:', not await on())
    await ph.click('.pbrow >> nth=0'); await ph.wait_for_timeout(300)
    await ph.evaluate(SWIPE, ['#sheet li .t', 260]); await ph.wait_for_timeout(400); print('swipe from list (at top) closes:', not await on())
    await ph.click('.pbrow >> nth=0'); await ph.wait_for_timeout(300); await ph.go_back(); await ph.wait_for_timeout(400)
    print('back closes:', not await on(), '| still in app:', ph.url)
    # sheet -> edit payment (sheet swap) -> done; history stays sane
    await ph.click('.pbrow >> nth=0'); await ph.wait_for_timeout(300); await ph.click('#sheetBody [data-act=bill-edit] >> nth=0'); await ph.wait_for_timeout(300)
    print('swap ok:', await on(), await ph.inner_text('#sheetBody h2')); await ph.click('#sheetBody [data-act=close]'); await ph.wait_for_timeout(400); print('closed:', not await on(), '| history len', await ph.evaluate('history.length'))
    # expired sign-in
    await ph.route('**/*', lambda r: r.continue_())
    await ph.evaluate("""() => { const c = window.supabase.createClient; }""")
    await ph.evaluate("""() => { window.__orig = window.dbOp; window.dbOp = (k, p) => k === 'select' ? window.__orig(k, p) : Promise.reject({message: 'JWT expired', code: 'PGRST301'}); }""")
    await ph.fill('#qb','Meralco 2000 Dec 20 2026') if await ph.inner_text('#qbMode') != 'Type it instead' else None
    await ph.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    if await ph.inner_text('#qbMode') == 'Type it instead': await ph.click('#qbMode')
    await ph.fill('#qb','Meralco 2000 Dec 20 2026'); await ph.wait_for_timeout(150); await ph.click('#qbGo'); await ph.wait_for_timeout(1200)
    print('status:', await ph.inner_text('#syncTxt'))
    await ph.click('#sync'); await ph.wait_for_timeout(300); print('settings note:', (await ph.inner_text('#sheetBody .note')).replace('\n',' | '), '| button:', await ph.locator('#sheetBody [data-act=signout].go').count())
    print('errors', errs)
    await b.close()
asyncio.run(main()); srv.kill()
