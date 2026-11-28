// Pera AI — runs on Supabase (Edge Function "pera-ai"). Keeps the Gemini key on the server.
// Secrets (Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY   your key from Google AI Studio            (required)
//   ALLOWED_EMAILS   your sign-in email, comma-separated list  (recommended: nobody else can use your quota)
//   GEMINI_MODEL     optional, e.g. "gemini-3.8-flash,gemini-3.5-flash-lite" (tried in order)
// Keep "Verify JWT" ON: Supabase then checks the caller is signed in before this code runs.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MODELS = (Deno.env.get('GEMINI_MODEL') || 'gemini-3.8-flash,gemini-3.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean);
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...CORS, 'Content-Type': 'application/json'}});

// The platform already verified this token; we only read who is calling.
function caller(req: Request): Record<string, unknown> | null {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const part = token.split('.')[1];
  if (!part) return null;
  try { return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))); } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers: CORS});
  if (req.method !== 'POST') return reply({error: 'Use POST'}, 405);

  const who = caller(req);
  if (!who || !who.sub || who.role !== 'authenticated') return reply({error: 'Sign in to use Pera AI'}, 401);
  const allowed = (Deno.env.get('ALLOWED_EMAILS') || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(who.email || '').toLowerCase())) return reply({error: 'This account isn’t allowed to use Pera AI'}, 403);

  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return reply({error: 'Pera AI isn’t set up: add the GEMINI_API_KEY secret in Supabase'}, 500);

  let body: {system?: string; messages?: {role: string; text: string}[]; json?: boolean; schema?: unknown; maxTokens?: number; stream?: boolean; think?: string};
  try { body = await req.json(); } catch { return reply({error: 'Bad request'}, 400); }
  if (JSON.stringify(body).length > 600_000) return reply({error: 'Too much data in one request'}, 413);

  const payload = {
    systemInstruction: body.system ? {parts: [{text: String(body.system)}]} : undefined,
    contents: (body.messages || []).slice(-24).map(m => ({role: m.role === 'model' ? 'model' : 'user', parts: [{text: String(m.text || '')}]})),
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: Math.min(Number(body.maxTokens) || 1500, 6000),
      ...(body.json ? {responseMimeType: 'application/json', ...(body.schema ? {responseSchema: body.schema} : {})} : {}),
      // Gemini 3 thinks a lot by default; quick money questions don't need it ("low" unless the app asks otherwise)
      thinkingConfig: {thinkingLevel: ['minimal', 'low', 'medium', 'high'].includes(String(body.think)) ? body.think : 'low'},
    } as Record<string, unknown>,
  };
  const call = (model: string, stream: boolean) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
    method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': key}, body: JSON.stringify(payload),
  });
  // an older model that doesn't know thinkingLevel: drop it and ask again
  const send = async (model: string, stream: boolean) => {
    let r = await call(model, stream);
    if (r.status === 400) {
      const t = await r.clone().text();
      if (/thinking/i.test(t)) { delete (payload.generationConfig as Record<string, unknown>).thinkingConfig; r = await call(model, stream); }
    }
    return r;
  };

  let last = 'no answer';
  // streaming: send the answer's text as it is written, so the app can show it word by word
  if (body.stream && !body.json) {
    for (const model of MODELS) {
      const r = await send(model, true);
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        last = d?.error?.message || `HTTP ${r.status}`;
        if (![404, 429, 500, 503].includes(r.status)) break;
        continue;
      }
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      const out = new ReadableStream({
        async start(ctrl) {
          const enc = new TextEncoder(); let buf = '';
          try {
            for (;;) {
              const {value, done} = await reader.read(); if (done) break;
              buf += value; const lines = buf.split('\n'); buf = lines.pop() || '';
              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                try {
                  const d = JSON.parse(line.slice(5));
                  const text = (d?.candidates?.[0]?.content?.parts || []).filter((p: {thought?: boolean}) => !p.thought).map((p: {text?: string}) => p.text || '').join('');
                  if (text) ctrl.enqueue(enc.encode(text));
                } catch { /* partial line */ }
              }
            }
          } finally { ctrl.close(); }
        },
      });
      return new Response(out, {headers: {...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'X-Pera-Model': model, 'Access-Control-Expose-Headers': 'X-Pera-Model'}});
    }
    return reply({error: `Gemini: ${last}`}, 502);
  }
  for (const model of MODELS) {
    const r = await send(model, false);
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      const parts = d?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p: {thought?: boolean}) => !p.thought).map((p: {text?: string}) => p.text || '').join('');
      if (text) return reply({text, model});
      last = d?.candidates?.[0]?.finishReason || d?.promptFeedback?.blockReason || 'empty answer';
      continue;
    }
    last = d?.error?.message || `HTTP ${r.status}`;
    if (![404, 429, 500, 503].includes(r.status)) break;   // only try the next model when this one is missing or busy
  }
  return reply({error: `Gemini: ${last}`}, 502);
});
