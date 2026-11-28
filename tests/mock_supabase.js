// Supabase stand-in backed by one store shared by every page in the test (window.dbOp is exposed from Python)
window.supabase = { createClient: () => {
  let cb; const session = {user:{id:'u1',email:'user@example.com'}};
  const sel = () => { const q = {keys: null, in(_c, k) { q.keys = k; return q; }, then(res, rej) { return window.dbOp('select', q.keys).then(rows => ({data: rows, error: null})).then(res, rej); }}; return q; };
  return {
    auth: { onAuthStateChange: f => { cb = f; setTimeout(() => f('INITIAL_SESSION', session), 30); return {data:{subscription:{unsubscribe(){}}}}; },
            signOut: async () => { cb('SIGNED_OUT', null); return {}; }, signInWithPassword: async () => ({data:{session}}), signUp: async () => ({data:{session:null}}) },
    from: () => ({
      select: () => sel(),
      delete: () => ({eq: () => ({in: async (_c, keys) => { await window.dbOp('delete', keys); return {error: null}; }})}),
      upsert: async rows => { await window.dbOp('upsert', rows.map(r => ({key: r.key, data: r.data}))); return {error: null}; }
    })
  };
}};
