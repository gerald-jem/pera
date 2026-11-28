# Pera

A small installable finance tracker (PWA). It runs on GitHub Pages and syncs through Supabase.

- **Works offline.** Changes save on the phone first and upload when you're back online.
- **Private.** This repo holds only code. Your numbers live in Supabase, and row-level security lets each account read only its own rows.
- **Backup.** Settings → Export backup / Import backup (`.json`).

## Setup
1. Supabase → SQL Editor → run `supabase.sql`.
2. Put the Project URL and anon key in `config.js`.
3. Supabase → Authentication → URL Configuration → set Site URL to your Pages URL.
4. GitHub → Settings → Pages → Deploy from branch `main`, folder `/ (root)`.
5. Open the Pages URL, create your account, then Settings → Import backup.
6. Optional: Supabase → Authentication → Sign In / Providers → turn off "Allow new users to sign up" once your account exists.

When you change app files, bump `VERSION` in `sw.js` so installed copies update.

## Pera AI (optional)

Ask Pera, Sort my spending, monthly summaries and Add by talking use **Google Gemini** through a small Supabase Edge Function, so the Gemini key never reaches your devices.

1. **Get a Gemini key** — go to [Google AI Studio](https://aistudio.google.com/apikey) → *Create API key*. The free tier is enough. (On the free tier Google may use prompts to improve its products.)
2. **Add secrets** — Supabase dashboard → *Edge Functions* → *Secrets* → add:
   - `GEMINI_API_KEY` = your key
   - `ALLOWED_EMAILS` = the email you sign in to Pera with (so nobody else who signs up can use your quota)
3. **Deploy the function** — *Edge Functions* → *Deploy a new function* → *Via Editor* → name it **`pera-ai`** → replace the sample code with [`supabase/functions/pera-ai/index.ts`](supabase/functions/pera-ai/index.ts) → *Deploy*. Leave **Verify JWT** on.
4. In Pera: *Settings* → *Pera AI* → **Check Pera AI**. It should say “Pera AI is working.”

Optional secret `GEMINI_MODEL` picks the model(s), tried in order (default `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite`). If Gemini often says it's busy, put the less crowded models first..
