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

  let body: {system?: string; messages?: {role: string; text: string}[]; json?: boolean; schema?: unknown; maxTokens?: number};
  try { body = await req.json(); } catch { return reply({error: 'Bad request'}, 400); }
  if (JSON.stringify(body).length > 600_000) return reply({error: 'Too much data in one request'}, 413);

  const payload = {
    systemInstruction: body.system ? {parts: [{text: String(body.system)}]} : undefined,
    contents: (body.messages || []).slice(-24).map(m => ({role: m.role === 'model' ? 'model' : 'user', parts: [{text: String(m.text || '')}]})),
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: Math.min(Number(body.maxTokens) || 1500, 6000),
      ...(body.json ? {responseMimeType: 'application/json', ...(body.schema ? {responseSchema: body.schema} : {})} : {}),
    },
  };

  let last = 'no answer';
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': key}, body: JSON.stringify(payload),
    });
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
