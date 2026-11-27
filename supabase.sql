-- Run once in Supabase → SQL Editor.
create table if not exists public.pera_docs (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  key        text        not null check (key = 'meta' or key ~ '^y[0-9]{4}$'),
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.pera_docs enable row level security;

-- Each signed-in user can only see and change their own rows.
create policy "own rows: select" on public.pera_docs for select to authenticated using (auth.uid() = user_id);
create policy "own rows: insert" on public.pera_docs for insert to authenticated with check (auth.uid() = user_id);
create policy "own rows: update" on public.pera_docs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows: delete" on public.pera_docs for delete to authenticated using (auth.uid() = user_id);

-- Let signed-in users reach the table through the Data API (RLS above still limits them to their own rows).
grant select, insert, update, delete on public.pera_docs to authenticated;
revoke all on public.pera_docs from anon;
