# The four AI helpers, with invented data: exact totals, can I afford it, why this month is different, goal coach + Sunday check-in.
# Prints "errors [...]": page errors plus any failed check (run_all.sh fails on a non-empty list).
import os, sys, json, asyncio, subprocess, time, base64
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
from playwright.async_api import async_playwright
PORT = 8893
srv = subprocess.Popen(['python3', '-m', 'http.server', str(PORT), '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
mock = open(os.path.join(HERE, 'mock_supabase.js')).read() + '\n' + open(os.path.join(HERE, 'mock_ai.js')).read(); DB = {}
async def op(source, kind, payload):
    if kind == 'select': return [{'key': k, 'data': v} for k, v in DB.items() if payload is None or k in payload]
    if kind == 'upsert':
        for r in payload: DB[r['key']] = r['data']
fails = []
def check(name, ok, got=''):
    print(('  ok  ' if ok else '  FAIL ') + name + ('' if ok else f'  (got: {got})'), flush=True)
    if not ok: fails.append(name)

# invented data built relative to today, so the test keeps working: 8 past months of pay (₱20k on the 15th, ₱45k on the
# 30th, which lands on the 1st every other month), steady spending, a Netflix price rise, two bills, a time deposit
SETUP = """()=>{
  const t=new Date(), pad=n=>String(n).padStart(2,'0'), iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()), years={};
  const month=(y,i)=>{ const Y=String(y); years[Y]=years[Y]||Array.from({length:12},()=>({inc:[],exp:[],sav:0})); return years[Y][i]; };
  for(let k=8;k>=0;k--){ const d=new Date(t.getFullYear(),t.getMonth()-k,1), y=d.getFullYear(), i=d.getMonth(), m=month(y,i);
    if(k>0){ m.inc.push({id:'m'+k,n:'INREM PAYROLL',a:20000,d:iso(new Date(y,i,15))});
      const end = k%2 ? new Date(y,i+1,1) : new Date(y,i,Math.min(30,new Date(y,i+1,0).getDate())); month(end.getFullYear(),end.getMonth()).inc.push({id:'e'+k,n:'INREM PAYROLL',a:45000,d:iso(end)}); }
    for(let j=0;j<10;j++) m.exp.push({id:'x'+k+'_'+j,n:'JOLLIBEE '+j,a:900,d:iso(new Date(y,i,Math.min(28,1+j*2)))});
    if(k>0 && k<7) m.exp.push({id:'nf'+k,n:'VISA-NETFLIX.COM',a:k===1?619:549,d:iso(new Date(y,i,7))});
  }
  const lm=new Date(t.getFullYear(),t.getMonth()-1,1), last=month(lm.getFullYear(),lm.getMonth()); last.exp.push({id:'laz',n:'LAZADA ORDER',a:8000,d:iso(new Date(lm.getFullYear(),lm.getMonth(),12))});
  const sp=month(2026,8); sp.exp.push({id:'sh1',n:'SHOPEEPAY',a:1234.5,d:'2026-09-05'},{id:'sh2',n:'Shopee order',a:765.5,d:'2026-09-21'}); month(2026,9).exp.push({id:'sh3',n:'SHOPEEPAY',a:999,d:'2026-10-02'});
  const today=month(t.getFullYear(),t.getMonth()); today.exp.push({id:'big',n:'Sent to GCash 0917',a:30000,d:iso(t)});
  const bills=[{name:'SPayLater',a:10450.57,due:iso(new Date(t.getFullYear(),t.getMonth(),t.getDate()+1)),paid:false,count:true},{name:'Lazada PayLater',a:1570.9,due:iso(new Date(t.getFullYear(),t.getMonth()+1,16)),paid:false,count:true}];
  const savings=[{id:'td',name:'Maya time deposit',kind:'td',monthly:true,rate:.06,tax:.2,cycleDays:181,cycles:[{start:iso(new Date(t.getFullYear(),t.getMonth()-2,26)),end:iso(new Date(t.getFullYear(),t.getMonth()+4,23)),rate:.06,carry:150000,deposits:[]}]}];
  localStorage.setItem('pera:data:u1',JSON.stringify({years,meta:{bills,savings,goals:[{id:'g1',name:'Car',target:500000,from:'all'}]}}));
  localStorage.setItem('pera:dirty:u1',JSON.stringify(['meta',...Object.keys(years).map(y=>'y'+y)]));
}"""
async def main():
  async with async_playwright() as p:
    b = await p.chromium.launch(**CHROME)
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    sent = []
    async def ai(route):
        body = json.loads(route.request.post_data); sent.append(body)
        txt = 'Shopping jumped because of one ₱8,000 Lazada order, likely a one-off.\nTry a ₱3,000 shopping limit.' if 'What changed' in body['messages'][-1]['text'] else 'Cut Food by ₱1,800 a month: 3 months sooner.\nPack lunch twice a week.'
        await route.fulfill(status=200, content_type='text/plain', body=txt)
    await ctx.route('**/functions/v1/pera-ai', ai)
    ph = await ctx.new_page(); errs = []; ph.on('pageerror', lambda e: errs.append(str(e)))
    await ph.clock.install(time='2026-11-29T10:00:00+08:00')     # a Sunday
    await ph.goto(f'http://localhost:{PORT}/'); await ph.wait_for_timeout(800)
    await ph.evaluate(SETUP); await ph.reload(); await ph.wait_for_timeout(1800)
    async def close():
        await ph.evaluate("document.querySelector('#sheet [data-act=close]') && document.querySelector('#sheet [data-act=close]').click()"); await ph.wait_for_timeout(350)
        if await ph.locator('#sheet.on').count(): await ph.keyboard.press('Escape'); await ph.wait_for_timeout(350)
        await ph.click('.tab[data-v=home]'); await ph.wait_for_timeout(250)

    # 1. exact totals: the AI only reads the question; Pera adds up the entries
    await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300)
    await ph.fill('#chatQ', 'how much did I spend on Shopee in September?'); await ph.press('#chatQ', 'Enter'); await ph.wait_for_timeout(1500)
    t = await ph.inner_text('#chatLog')
    check('exact total from the entries (₱2,000.00, 2 entries, October one left out)', '₱2,000.00' in t and '2 entries' in t and '999' not in t, t[-400:])
    check('says Pera counted it', 'Counted by Pera' in t)
    await ph.fill('#chatQ', 'is my spending okay?'); await ph.press('#chatQ', 'Enter'); await ph.wait_for_timeout(1500)
    check('other questions still get a normal answer', sent and sent[-1].get('task') == 'ask', [x.get('task') for x in sent])
    await ph.screenshot(path=os.path.join(OUT, 'ai_exact_total.png')); await close()

    # 2. can I afford it (the ₱30k transfer switched off first, so the period isn't already over)
    await ph.click('.leftbox'); await ph.wait_for_timeout(300); await ph.click('[data-act=cap-cat][data-c=Transfers]'); await ph.wait_for_timeout(300); await close()
    await ph.click('[data-act=afford]'); await ph.wait_for_timeout(300)
    await ph.fill('#afAmt', '100'); await ph.wait_for_timeout(150); small = await ph.inner_text('#afOut')
    await ph.fill('#afAmt', '200000'); await ph.fill('#afWhat', 'Laptop'); await ph.wait_for_timeout(150); big = await ph.inner_text('#afOut')
    check('afford: ₱100 is fine, ₱200,000 needs saving up', ('Yes' in small) and 'Save up for it' in big and 'paydays' in big, (small[:120], big[:160]))
    await ph.screenshot(path=os.path.join(OUT, 'ai_afford.png'))
    await ph.click('[data-act=af-fund]'); await ph.wait_for_timeout(400)
    check('afford: turns into a Set aside fund', await ph.input_value('#fnName') == 'Laptop' and await ph.input_value('#fnTarget') == '200000')
    await close()
    n0 = len(sent); await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300)
    await ph.fill('#chatQ', 'can I afford a ₱6,000 game?'); await ph.press('#chatQ', 'Enter'); await ph.wait_for_timeout(1500)
    sysm = sent[-1]['system'] if len(sent) > n0 else ''
    check('chat gets Pera’s verdict for 6000', 'affordability check for 6000' in sysm, sysm[-300:])
    await close()

    # 3. why this month is different (last month: the Lazada order)
    await ph.click('.tab[data-v=months]'); await ph.wait_for_timeout(300); await ph.click('[data-act=month][data-i="9"]'); await ph.wait_for_timeout(500)
    t = await ph.inner_text('.whycard') if await ph.locator('.whycard').count() else ''
    check('why: Shopping +₱8,332 (Lazada ₱8,000 + Shopee ₱999 vs usual ₱667)', 'Shopping' in t and '+₱8,332' in t and 'LAZADA' in t.upper(), t[:300])
    if t:
        await ph.click('.whycard [data-act=ai-card]'); await ph.wait_for_timeout(2500); t = await ph.inner_text('.whycard')
        check('why: AI explains it in words', 'one-off' in t, t[-200:])
        last = sent[-1]['messages'][-1]['text']; check('why: AI was given the exact numbers', 'Shopping: 8999 vs usual 667 (+8332)' in last, last[:300])
        await ph.screenshot(path=os.path.join(OUT, 'ai_why.png'), full_page=True)
    await close()

    # 4a. goal coach
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(300); await ph.click('[data-act=goal-open][data-g=g1]'); await ph.wait_for_timeout(500)
    t = await ph.inner_text('#sheetBody'); check('coach: lists cuts with months sooner', 'Ways to get there sooner' in t and 'sooner' in t and 'Food' in t, t[:400])
    await ph.click('#sheetBody [data-aiid="coach|g1"] [data-act=ai-card]'); await ph.wait_for_timeout(2500)
    t = await ph.inner_text('[data-aiid="coach|g1"]'); check('coach: AI picks', 'Pack lunch' in t, t[-200:])
    await close()

    # 4b. Sunday check-in on Home + reminder
    t = await ph.inner_text('#hWeek') if await ph.locator('#hWeek:not([hidden])').count() else ''
    check('Sunday check-in shows the week and one thing to do', 'Your week' in t and 'This week:' in t and 'Nov 23' in t, t[:300])
    await ph.screenshot(path=os.path.join(OUT, 'ai_week.png'), full_page=True)
    await ph.click('[data-act=week-done]'); await ph.wait_for_timeout(300)
    check('Done hides it until next Sunday', await ph.locator('#hWeek:not([hidden])').count() == 0)

    print('errors', errs + fails); await b.close()
asyncio.run(main()); srv.kill()
