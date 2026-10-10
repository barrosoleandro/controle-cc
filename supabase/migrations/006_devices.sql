-- Computers: the local-AI settings of each machine the app is opened on.
--
-- The Ollama address and model belong to the computer, not to the account, so they used to
-- live in the browser's localStorage. That lost them whenever the site changed address
-- (localhost vs the Vercel URL), the browser changed, or site data was cleared. Here they
-- survive all of that, and the app recognises the machine by itself (src/domain/device.ts):
-- by the hardware the browser reports and by the models its local Ollama holds.

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,                          -- e.g. 'SURFACE_L'; the browser cannot read it, the user can rename
  hardware jsonb not null default '{}'::jsonb, -- {os, cores, memory, gpu} as last reported by the browser
  model_digests text[] not null default '{}',  -- digests of the models in this machine's Ollama (/api/tags)
  ollama_url text not null default 'http://localhost:11434',
  ollama_model text not null default '',
  ollama_enabled boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.devices enable row level security;
alter table public.devices force row level security;
-- Postgres has no "create policy if not exists": dropping first keeps this re-runnable.
drop policy if exists owner_all on public.devices;
drop policy if exists require_mfa on public.devices;
create policy owner_all on public.devices for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy require_mfa on public.devices as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');
revoke all on public.devices from anon;
