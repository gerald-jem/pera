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
