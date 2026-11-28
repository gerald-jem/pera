# Newer features, end to end with invented data: left to spend, spending cap, uneven paydays, 13th month plan,
# set-aside funds, subscriptions, net worth, home loan planner, year in review, Piso, reminders, Customise Home, Share → Pera.
# Prints "errors [...]": page errors plus any failed check (run_all.sh fails on a non-empty list).
import os, sys, json, asyncio, subprocess, time, base64
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
from playwright.async_api import async_playwright
PORT = 8890
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
        sent.append(json.loads(route.request.post_data)); await route.fulfill(status=200, content_type='text/plain', body='ok')
    await ctx.route('**/functions/v1/pera-ai', ai)
    ph = await ctx.new_page(); errs = []; ph.on('pageerror', lambda e: errs.append(str(e)))
    await ph.goto(f'http://localhost:{PORT}/'); await ph.wait_for_timeout(800)
    await ph.evaluate("navigator.serviceWorker.register('sw.js').then(()=>navigator.serviceWorker.ready).then(()=>1)")
    await ph.evaluate(SETUP); await ph.reload(); await ph.wait_for_timeout(1800)
    async def close():
        await ph.evaluate("document.querySelector('#sheet [data-act=close]') && document.querySelector('#sheet [data-act=close]').click()"); await ph.wait_for_timeout(350)
        await ph.click('.tab[data-v=home]'); await ph.wait_for_timeout(250)

    # left to spend, with the ₱30k transfer counted, then switched off
    left = await ph.inner_text('.leftbox'); check('left to spend shows until the next payday', 'Left to spend until' in left, left)
    over = await ph.locator('.leftbox.over').count()
    await ph.click('.leftbox'); await ph.wait_for_timeout(400); body = await ph.inner_text('#sheetBody')
    check('cap sheet lists what counted (Transfers, biggest item)', 'Transfers' in body and 'Sent to GCash' in body, body[:200])
    await ph.click('[data-act=cap-cat][data-c=Transfers]'); await ph.wait_for_timeout(400); await close()
    check('switching Transfers off takes it out', over == 1 and await ph.locator('.leftbox.over').count() == 0, (over, await ph.inner_text('.leftbox')))

    # Piso: bill due tomorrow comes first; tapping gives tips
    check('Piso warns about tomorrow’s bill', 'SPayLater' in await ph.inner_text('.pisotalk'), await ph.inner_text('.pisotalk'))
    await ph.click('.piso'); await ph.wait_for_timeout(200); check('Piso tip on tap', len(await ph.inner_text('.pisotalk')) > 10)

    # uneven paydays reach the AI
    await ph.click('[data-act=ask]'); await ph.wait_for_timeout(300); await ph.fill('#chatQ', 'how much to save each payday?'); await ph.press('#chatQ', 'Enter'); await ph.wait_for_timeout(1500)
    sysm = sent[-1]['system'] if sent else ''
    check('AI is told the uneven split (₱20,000 / ₱45,000)', 'about 20000 on the 15th and 45000 on the 30th' in sysm, sysm[sysm.find('uneven') - 20: sysm.find('uneven') + 120])
    await close()

    # reports
    for r, want in [('subs', 'Netflix'), ('worth', 'Net worth'), ('year', 'in review')]:
        await ph.evaluate(f"document.querySelector('[data-act=report][data-r={r}]').click()"); await ph.wait_for_timeout(600)
        t = await ph.inner_text('#sheetBody'); check(f'report {r} opens', want in t, t[:120])
        if r == 'subs': check('Netflix price rise flagged', 'up ₱70.00' in t, t[:300])
        await close()
    await ph.evaluate("document.querySelector('[data-act=report][data-r=home]').click()"); await ph.wait_for_timeout(500)
    await ph.fill('#hlPrice', '3000000'); await ph.wait_for_timeout(200); t = await ph.inner_text('#hlOut')
    check('home loan: payment and income needed shown', 'Monthly payment' in t and 'gross' in t, t[:200])
    await ph.click('[data-act=hl-goal]'); await ph.wait_for_timeout(400); check('down payment becomes a goal', await ph.input_value('#gN') == 'House down payment')
    await close()

    # 13th month planner (Home card only Nov 15 – Jan; the sheet always works)
    if await ph.locator('#h13:not([hidden]) [data-act=p13]').count():
        await ph.click('#h13 [data-act=p13]'); await ph.wait_for_timeout(400); await ph.click('[data-act=p13-save]'); await ph.wait_for_timeout(400)
        check('13th month plan saved', 'planned' in await ph.inner_text('#h13'), await ph.inner_text('#h13'))

    # set aside for
    await ph.click('.tab[data-v=savings]'); await ph.wait_for_timeout(300); await ph.click('[data-act=fund-new] >> nth=0'); await ph.wait_for_timeout(300)
    await ph.click('[data-act=fund-preset][data-n="New phone"]'); await ph.fill('#fnTarget', '24000')
    due = await ph.evaluate("(()=>{const t=new Date(); const d=new Date(t.getFullYear(),t.getMonth()+6,1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');})()")
    await ph.fill('#fnDue', due); await ph.click('[data-act=fund-save]'); await ph.wait_for_timeout(400)
    t = await ph.inner_text('.fundlist'); check('fund shows an amount per payday', 'per payday' in t, t)
    await close()

    # reminders list (notifications themselves can't be shown in a test browser)
    await ph.evaluate("localStorage.setItem('pera:remind','true')"); await ph.click('#fab'); await ph.wait_for_timeout(300); await ph.fill('#fq', '50 candy'); await ph.press('#fq', 'Enter'); await ph.wait_for_timeout(1500)
    lst = await ph.evaluate("caches.open('pera-remind').then(c=>c.match('reminders.json')).then(r=>r?r.json():[])")
    titles = [x['title'] for x in lst]; check('reminders written for the bill and paydays', any('SPayLater' in x for x in titles) and 'Payday!' in titles, titles)

    # Customise Home
    await ph.click('#settingsBtn'); await ph.wait_for_timeout(400); await ph.click('[data-act=home-card][data-k=hFlow]'); await ph.wait_for_timeout(200); await close()
    check('hidden card stays hidden', await ph.locator('#hFlow.userhid').count() == 1)

    # Share → Pera
    img = base64.b64encode(open(os.path.join(HERE, 'fixtures', 'sample-receipt.png'), 'rb').read()).decode() if os.path.exists(os.path.join(HERE, 'fixtures', 'sample-receipt.png')) else None
    if img is None:
        pg = await b.new_page(); await pg.set_content('<body style="font:22px Arial;padding:20px">Nov 20, 2026 JOLLIBEE 450.00</body>'); img = base64.b64encode(await pg.screenshot()).decode(); await pg.close()
    await ph.reload(); await ph.wait_for_timeout(1200)
    res = await ph.evaluate("""async(b64)=>{const bin=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)); const fd=new FormData(); fd.append('shots', new File([bin],'shot.png',{type:'image/png'}));
       const r=await fetch('./share',{method:'POST',body:fd}); return r.url;}""", img)
    await ph.goto(f'http://localhost:{PORT}/?share=1'); await ph.wait_for_timeout(2000)
    t = await ph.inner_text('#sheetBody') if await ph.locator('#sheetBody').count() else ''
    check('shared screenshot opens the chooser', 'shared' in t and 'Maya time deposit' in t, (res, t[:150]))

    print('errors', errs + fails); await b.close()
asyncio.run(main()); srv.kill()
