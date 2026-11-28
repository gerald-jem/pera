// Test-only stand-in for the pera-ai Supabase function. window.__aiMode: 'ok' | 'missing' | 'busy'
window.__aiCalls = [];
window.__mockInvoke = async (name, {body}) => {
  window.__aiCalls.push(body);
  await new Promise(r => setTimeout(r, 120));
  const mode = window.__aiMode || 'ok';
  if (mode === 'missing') return {data: null, error: {message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify({code: 'NOT_FOUND', message: 'Requested function was not found'}), {status: 404})}};
  if (mode === 'busy') return {data: null, error: {message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify({error: 'Gemini: Resource has been exhausted (e.g. check quota).'}), {status: 502})}};
  const last = (body.messages || []).slice(-1)[0]?.text || '';
  if (body.task === 'ping') return {data: {text: 'OK', model: 'mock'}};
  if (body.task === 'ask') return {data: {text: `You spent **₱3,250** on food last month.\n- Jollibee: ₱1,200\n- Food Panda: ₱900\nThat’s about the same as your usual month. <img src=x onerror=alert(1)>`}};
  if (body.task === 'summary') return {data: {text: 'October went well: you kept **₱18,400** of ₱54,600.\n- Food was ₱1,100 above usual\n- Transport dropped ₱600\nTry setting a ₱5,000 food limit for November.'}};
  if (body.task === 'sort') {
    const notes = [...last.matchAll(/^(\d+)\. (.*)$/gm)].map(m => [+m[1], m[2]]);
    const guess = n => /grab|angkas|joyride/i.test(n) ? 'Transport' : /panda|jollibee|mcdo/i.test(n) ? 'Food & drinks' : /sent to|instapay/i.test(n) ? 'Transfers' : /steam|netflix/i.test(n) ? 'Subscriptions & games' : 'Other';
    return {data: {text: JSON.stringify(notes.map(([n, t]) => ({n, category: guess(t), name: t.split(/[ *-]+/).filter(w => w.length > 2)[1] || t})))}};
  }
  if (body.task === 'talk') return {data: {text: JSON.stringify([
    {type: 'exp', amount: 550, note: 'Grab', date: '2026-11-27', category: 'Transport'},
    {type: 'exp', amount: 180, note: 'Jollibee', date: '2026-11-27', category: 'Food & drinks'},
    {type: 'inc', amount: 25000, note: 'Salary', date: '2026-11-30'},
    {type: 'bill', amount: 2340, note: 'Meralco', date: '2026-12-20', payments: 1}])}};
  return {data: {text: '?'}};
};
