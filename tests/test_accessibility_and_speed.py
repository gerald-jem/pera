import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE); FIX = os.path.join(HERE, 'fixtures')
OUT = os.environ.get('OUT', os.path.join(HERE, 'out')); os.makedirs(OUT, exist_ok=True)
CHROME = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
AXE_JS = os.environ.get('AXE', os.path.join(HERE, 'node_modules', 'axe-core', 'axe.min.js'))
import asyncio, subprocess, time, json
from playwright.async_api import async_playwright
srv = subprocess.Popen(['python3','-m','http.server','8811','-d',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.8)
mock=open(os.path.join(HERE,'mock_supabase.js')).read(); AXE=open(AXE_JS).read(); DB={}
async def op(source, kind, payload):
    if kind=='select': return [{'key':k,'data':v} for k,v in DB.items() if payload is None or k in payload]
    if kind=='upsert':
        for r in payload: DB[r['key']]=r['data']
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**CHROME)
    allv={}
    for scheme in ['light','dark']:
        ctx=await b.new_context(viewport={'width':390,'height':844}, color_scheme=scheme); await ctx.expose_binding('dbOp', op)
        await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
        await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
        ph=await ctx.new_page(); errs=[]; ph.on('pageerror',lambda e:errs.append(str(e)))
        await ph.goto('http://localhost:8811/'); await ph.wait_for_timeout(700)
        if scheme=='light':
            await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-backup.json')); await ph.wait_for_timeout(900)
            await ph.click('#settingsBtn'); await ph.wait_for_timeout(300); await ph.set_input_files('#importFile',os.path.join(FIX,'sample-savings.json')); await ph.wait_for_timeout(900)
            await ph.click('[data-act=close]') if await ph.locator('#sheet.on').count() else None
        await ph.reload(); await ph.wait_for_timeout(1500)
        await ph.add_script_tag(content=AXE)
        for v in ['home','months','savings','bills','settings','add','search']:
            if v in ('home','months','savings','bills'): await ph.click(f'.tab[data-v={v}]'); await ph.wait_for_timeout(1000)
            elif v=='settings': await ph.click('#settingsBtn'); await ph.wait_for_timeout(400)
            elif v=='add': await ph.keyboard.press('Escape'); await ph.wait_for_timeout(300); await ph.click('#fab'); await ph.wait_for_timeout(400)
            elif v=='search': await ph.keyboard.press('Escape'); await ph.wait_for_timeout(300); await ph.click('[data-act=search]'); await ph.wait_for_timeout(400)
            res=json.loads(await ph.evaluate("async()=>JSON.stringify((await axe.run(document,{runOnly:['wcag2a','wcag2aa','best-practice']})).violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.length,ex:v.nodes.slice(0,2).map(n=>n.target.join(' ')+' :: '+(n.failureSummary||'').split('\\n')[1])})))"))
            for r in res:
                k=(r['id'],scheme); allv.setdefault(k,{'impact':r['impact'],'views':[],'n':0,'ex':r['ex']}); allv[k]['views'].append(v); allv[k]['n']+=r['n']
        print(scheme,'page errors',errs)
    for (i,s),v in sorted(allv.items(), key=lambda x:{'critical':0,'serious':1,'moderate':2,'minor':3}.get(x[1]['impact'],4)):
        print(f"{v['impact']:9} {i:32} {s:5} n={v['n']:3} views={','.join(v['views'])}\n            e.g. {v['ex'][0][:180]}")
    # performance: cold load, no cache
    ctx=await b.new_context(viewport={'width':390,'height':844}); await ctx.expose_binding('dbOp', op)
    await ctx.route('**/vendor/supabase.js', lambda r: r.fulfill(body=mock, content_type='text/javascript'))
    await ctx.route('**/config.js*', lambda r: r.fulfill(body="window.PERA_CONFIG={supabaseUrl:'x',supabaseAnonKey:'k'}", content_type='text/javascript'))
    ph=await ctx.new_page(); cdp=await ctx.new_cdp_session(ph)
    await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':150,'downloadThroughput':1.6e6/8,'uploadThroughput':750e3/8})
    await cdp.send('Emulation.setCPUThrottlingRate',{'rate':4})
    t0=time.time(); await ph.goto('http://localhost:8811/', wait_until='load'); load=time.time()-t0
    await ph.wait_for_timeout(300)
    perf=json.loads(await ph.evaluate("JSON.stringify({fcp:((performance.getEntriesByType('paint').find(e=>e.name==='first-contentful-paint'))||{startTime:-1}).startTime, res:performance.getEntriesByType('resource').map(r=>[r.name.split('/').pop().slice(0,30), Math.round(r.transferSize/1024), Math.round(r.duration)])})"))
    await ph.wait_for_timeout(1500)
    tasks=await ph.evaluate("(()=>{const t0=performance.now(); for(let k=0;k<5;k++){document.querySelector('.tab[data-v=months]').click();document.querySelector('.tab[data-v=home]').click();} return Math.round((performance.now()-t0)/10)})()")
    print(f"\nslow-4G + 4x CPU: load {load:.1f}s, first paint {perf['fcp']:.0f}ms; tab switch ≈{tasks}ms")
    for r in perf['res']: print('   ', r)
    await b.close()
asyncio.run(main()); srv.kill()
