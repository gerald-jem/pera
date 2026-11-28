import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
import asyncio, subprocess, time, json
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8815','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock = open(os.path.join(HERE,'mock_supabase.js')).read() + '\n' + open(os.path.join(HERE,'mock_ai.js')).read(); DB={}
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
    AI={'mode':'ok','calls':[]}
    async def ai_route(route):
        body=json.loads(route.request.post_data or '{}'); AI['calls'].append(body)
        if AI['mode']=='missing': return await route.fulfill(status=404, content_type='application/json', body=json.dumps({'code':'NOT_FOUND','message':'Requested function was not found'}))
        if AI['mode']=='busy': return await route.fulfill(status=502, content_type='application/json', body=json.dumps({'error':'Gemini: Resource has been exhausted (e.g. check quota).'}))
        txt={'ask':'You spent **₱3,250** on food last month.\n- Jollibee: ₱1,200\n- Food Panda: ₱900\nThat’s about the same as your usual month. <img src=x onerror=alert(1)>',
             'card':'Your savings grew to **₱281,500**.\n- Emergency fund: on pace for Dec 2027\nMove ₱7,500 on each payday.',
             'summary':'November went well: you kept **₱18,400** of ₱54,600.\n- Food was ₱1,100 above usual\n- Transport dropped ₱600\nTry setting a ₱5,000 food limit for December.'}.get(body.get('task'),'?')
        if body.get('task')=='card': await asyncio.sleep(1.2)   # slow enough to see the writing state
        await route.fulfill(status=200, content_type='text/plain; charset=utf-8', body=txt)
    await ctx.route('**/functions/v1/pera-ai', ai_route)
    ph=await ctx.new_page(); errs=[]; ph.on('pageerror',lambda e:errs.append(str(e))); ph.on('dialog', lambda d: errs.append('ALERT ran: '+d.message))
    await ph.goto('http://localhost:8815/'); await ph.wait_for_timeout(700)
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900)
    await ph.evaluate("""() => { const d = JSON.parse(localStorage.getItem('pera:data:u1')), m = d.years['2026'][10];
      [['VISA-GRAB MAKATI PH',550,'2026-11-03'],['VISA-fp*Food Panda',440,'2026-11-04'],['VISA-WL *Steam Purchase',600,'2026-11-05'],['ZZQ TRADING 0042',999,'2026-11-06']].forEach(([n,a,dd]) => m.exp.push({id: Math.random().toString(36).slice(2), n, a, d: dd}));
      localStorage.setItem('pera:data:u1', JSON.stringify(d)); localStorage.setItem('pera:dirty:u1', JSON.stringify(['y2026'])); }""")
    await ph.reload(); await ph.wait_for_timeout(1200)
    # not set up yet
    await ph.evaluate("window.__aiMode='missing'"); AI['mode']='missing'; await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300)
    await ph.click('[data-act=ask-q] >> nth=0'); await ph.wait_for_timeout(600); print('not deployed:', await ph.inner_text('#chatLog .msg.err'))
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    # ask
    await ph.evaluate("window.__aiMode='ok'; window.__aiCalls=[]"); AI['mode']='ok'; await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300)
    await ph.fill('#chatQ','How much did I spend on food last month?'); await ph.press('#chatQ','Enter'); await ph.wait_for_timeout(700)
    print('answer:', (await ph.inner_text('#chatLog .msg.ai >> nth=-1')).replace('\n',' | '), '| bold+list rendered:', await ph.locator('#chatLog .msg.ai b').count(), await ph.locator('#chatLog .msg.ai li').count(), '| raw img tag shown as text:', await ph.locator('#chatLog img').count()==0)
    call=AI['calls'][-1]; print('streamed request:', call.get('stream'), call.get('think'), '| sent:', len(call['system']), 'chars of context | has entries:', 'Individual entries' in call['system'], '| has bills:', 'Unpaid upcoming bills' in call['system'])
    await ph.screenshot(path=OUT+'/ai_chat.png')
    await ph.click('[data-act=close]'); await ph.wait_for_timeout(300)
    # summary on Home
    await ph.click('.tab[data-v=home]'); await ph.wait_for_timeout(600); await ph.click('#hSum [data-act=ai-card]'); await ph.wait_for_timeout(300)
    print('while writing:', (await ph.inner_text('#hSum .hhead')).replace('\n',' | '), '| busy:', await ph.get_attribute('#hSum','aria-busy'))
    await ph.wait_for_timeout(1500)
    await ph.click('#hSum [data-act=ai-card]'); await ph.wait_for_timeout(300)
    print('rewrite feedback:', (await ph.inner_text('#hSum .hhead')).replace('\n',' | '), '| old text faded:', await ph.locator('#hSum .aitext.faded').count(), '| foot:', await ph.inner_text('#hSum .aifoot'))
    await ph.locator('#hSum').screenshot(path=OUT+'/ai_rewriting.png'); await ph.wait_for_timeout(1500); print('rewritten toast:', await ph.inner_text('#toastMsg'))
    print('summary:', (await ph.inner_text('#hSum')).replace('\n',' | ')[:200]); await ph.locator('#hSum').screenshot(path=OUT+'/ai_summary.png')
    # cards on other tabs
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(500); print('savings card:', await ph.locator('#v-savings .aicard h3').all_inner_texts())
    await ph.click('#v-savings [data-act=ai-card]'); await ph.wait_for_timeout(1800); print('savings written:', (await ph.inner_text('#v-savings .aicard .aitext')).replace('\n',' | '))
    await ph.click('.tab[data-v=bills]'); await ph.wait_for_timeout(500); print('bills card:', await ph.locator('#billAI .aicard h3').all_inner_texts())
    await ph.click('.tab[data-v=months]'); await ph.wait_for_timeout(400); await ph.locator('#monthList li:has-text("October") button').first.click(); await ph.wait_for_timeout(500)
    print('month card:', await ph.locator('#sheetBody .aicard h3').all_inner_texts()); await ph.screenshot(path=OUT+'/ai_monthcard.png'); await ph.keyboard.press('Escape'); await ph.wait_for_timeout(300)
    await ph.click('.tab[data-v=home]'); await ph.wait_for_timeout(500)
    # sort my spending
    await ph.click('[data-act=sort-spend]'); await ph.wait_for_timeout(900)
    rows=[(await r.locator('.t').inner_text()).replace('\n',' / ')+' -> '+await r.locator('select').input_value() for r in await ph.locator('.sortlist li').all()]; print('sort suggestions:', rows)
    await ph.screenshot(path=OUT+'/ai_sort.png')
    await ph.select_option('.sortlist select >> nth=0', 'Shopping'); await ph.wait_for_timeout(200)
    await ph.click('[data-act=sort-apply]'); await ph.wait_for_timeout(400); print('applied:', await ph.inner_text('#toastMsg'), '| rules:', await ph.evaluate("JSON.parse(localStorage.getItem('pera:data:u1')).meta.catRules"))
    await ph.click('#toastBtn'); await ph.wait_for_timeout(300); print('undo rules:', await ph.evaluate("JSON.parse(localStorage.getItem('pera:data:u1')).meta.catRules"))
    # add by talking
    await ph.click('.tab[data-v=months]'); await ph.click('#fab'); await ph.wait_for_timeout(400); await ph.click('[data-act=talk]'); await ph.wait_for_timeout(300)
    await ph.fill('#talkQ','grab 550 and jollibee 180 today, salary 25k on the 30th, meralco 2,340 due dec 20'); await ph.click('[data-act=talk-go]'); await ph.wait_for_timeout(700)
    print('talk rows:', [(await r.inner_text()).replace('\n',' / ') for r in await ph.locator('#talkOut li').all()])
    await ph.screenshot(path=OUT+'/ai_talk.png')
    await ph.click('[data-act=talk-add]'); await ph.wait_for_timeout(400); print('added:', await ph.inner_text('#toastMsg'))
    st=await ph.evaluate("(()=>{const d=JSON.parse(localStorage.getItem('pera:data:u1'));return {exp:d.years['2026'][10].exp.filter(x=>['Grab','Jollibee'].includes(x.n)).map(x=>x.n+' '+x.a+' '+(x.c||'')), inc:d.years['2026'][10].inc.filter(x=>x.n==='Salary').length, bill:d.meta.bills.filter(b=>b.name==='Meralco').map(b=>b.due)}})()"); print('saved:', st)
    await ph.click('#toastBtn'); await ph.wait_for_timeout(300); print('undo talk:', await ph.evaluate("JSON.parse(localStorage.getItem('pera:data:u1')).years['2026'][10].exp.filter(x=>x.n==='Grab').length"), await ph.evaluate("JSON.parse(localStorage.getItem('pera:data:u1')).meta.bills.filter(b=>b.name==='Meralco').length"))
    # settings + busy quota
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.click('[data-act=ai-check]'); await ph.wait_for_timeout(500); print('check:', await ph.inner_text('#aiStat'))
    await ph.evaluate("window.__aiMode='busy'"); AI['mode']='busy'; await ph.click('[data-act=ai-check]'); await ph.wait_for_timeout(500); print('busy:', await ph.inner_text('#aiStat'))
    print('errors', errs)
    await b.close()
asyncio.run(main()); srv.kill()
