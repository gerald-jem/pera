import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time, json
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8812','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
base=open(os.path.join(HERE,'mock_supabase.js')).read().replace("signInWithPassword:","resetPasswordForEmail: async (e, o) => { window.__reset = [e, o.redirectTo]; return {error: null}; }, updateUser: async u => { window.__newpw = u.password; return {error: null}; }, signInWithPassword:")
AXE=open(AXE_JS).read(); DB={}
async def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
async def ctxp(b, mock, url='http://localhost:8812/'):
    ctx=await b.new_context(viewport={'width':390,'height':844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ext=[]; ctx.on('request', lambda r: ext.append(r.url) if 'localhost' not in r.url else None)
    ph=await ctx.new_page(); ph.errs=[]; ph.ext=ext; ph.on('pageerror',lambda e:ph.errs.append(str(e)))
    await ph.goto(url); await ph.wait_for_timeout(900); return ph
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    # signed out: forgot password
    out=await ctxp(b, base.replace("setTimeout(() => f('INITIAL_SESSION', session), 30)","setTimeout(() => f('INITIAL_SESSION', null), 30)"))
    await out.click('#authForgot'); print('no email:', await out.inner_text('#authErr'))
    await out.fill('#email','user@example.com'); await out.click('#authForgot'); await out.wait_for_timeout(300)
    print('sent:', await out.inner_text('#authMsg'), '|', await out.evaluate('window.__reset'))
    await out.screenshot(path=OUT+'/forgot.png')
    # returning from the email link
    rec=await ctxp(b, base.replace("setTimeout(() => f('INITIAL_SESSION', session), 30)","setTimeout(() => f('PASSWORD_RECOVERY', session), 30)"), 'http://localhost:8812/#access_token=x&type=recovery')
    await rec.wait_for_timeout(600); print('recovery sheet:', await rec.inner_text('#sheetBody h2'), '| url cleaned:', rec.url)
    await rec.fill('#npw','abc'); await rec.click('#npF .go'); print('short:', await rec.inner_text('#npErr'))
    await rec.fill('#npw','newsecret1'); await rec.click('#npF .go'); await rec.wait_for_timeout(300); print('saved:', await rec.evaluate('window.__newpw'), '|', await rec.inner_text('#toastMsg'))
    await rec.click('#settingsBtn'); await rec.wait_for_timeout(300); await rec.click('[data-act=change-pw]'); await rec.wait_for_timeout(300); print('settings change pw:', await rec.inner_text('#sheetBody h2'), '| eye button:', await rec.locator('#sheetBody .pweye').count())
    # fonts + external requests + a11y
    print('fonts loaded:', await rec.evaluate("[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family+' '+f.weight).join(', ')"))
    print('requests to other sites:', [u for u in rec.ext if 'fonts.g' in u] or 'none to Google')
    await rec.keyboard.press('Escape'); await rec.wait_for_timeout(300)
    await rec.add_script_tag(content=AXE); viol={}
    for v in ['home','months','savings','bills','sheet']:
        if v=='sheet': await rec.click('#settingsBtn'); await rec.wait_for_timeout(300)
        else: await rec.click(f'.tab[data-v={v}]'); await rec.wait_for_timeout(600)
        r=json.loads(await rec.evaluate("async()=>JSON.stringify((await axe.run(document,{runOnly:['wcag2a','wcag2aa','best-practice']})).violations.map(v=>[v.id,v.impact,v.nodes.length,v.nodes[0].target.join(' ')]))"))
        for x in r: viol.setdefault(x[0],[x[1],0,x[3]]); viol[x[0]][1]+=x[2]
    print('a11y remaining:', viol or 'none')
    print('viewport:', await rec.get_attribute('meta[name=viewport]','content'))
    print('errors', out.errs, rec.errs)
    await b.close()
asyncio.run(main()); srv.kill()
