-- Landing-page waitlist capture (final state).
-- Mirrors what is applied to the remote project; kept here for version control.
create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  source      text not null default 'landing',
  user_agent  text,
  created_at  timestamptz not null default now(),
  constraint waitlist_email_format check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create unique index if not exists waitlist_email_lower_idx on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

drop policy if exists "waitlist_public_insert" on public.waitlist;
create policy "waitlist_public_insert"
  on public.waitlist for insert to anon, authenticated
  with check (
    source = 'landing'
    and char_length(email) between 3 and 254
    and (user_agent is null or char_length(user_agent) <= 1024)
  );
