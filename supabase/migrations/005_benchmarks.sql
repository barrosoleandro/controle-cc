-- Market benchmarking: the roles being tracked and every figure ever recorded for them.
--
-- Entries are append-only by design: a new reading never replaces an old one, so the
-- history shows how the market moved and when each figure was taken. A correction is a
-- new row with a later as_of; deleting is only for a row entered by mistake.

create table if not exists public.benchmark_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,                 -- e.g. 'CIO regional'
  scope text not null default 'regional' check (scope in ('regional','global','nacional','local')),
  region text not null default '',    -- e.g. 'França', 'Europa', 'Brasil'
  notes text not null default '',
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name, region)
);

create table if not exists public.benchmark_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  role_id uuid not null references public.benchmark_roles on delete cascade,
  as_of date not null,                -- the date the figure refers to, not when it was typed
  source text not null,               -- 'APEC', 'Glassdoor', 'Syntec', 'Eurostat earn_ses22_25'…
  source_url text not null default '',
  -- What the numbers mean. Everything is stored as given and converted only for display.
  basis text not null default 'gross_year' check (basis in ('gross_year','gross_month','net_month','total_comp_year')),
  currency text not null default 'EUR' check (currency in ('EUR','BRL')),
  p25 numeric(14,2),
  p50 numeric(14,2),                  -- the median: the one figure every source publishes
  p75 numeric(14,2),
  sample_size int,                    -- how many salaries back it, when the source says
  official boolean not null default false, -- true for a statistics office, false for a survey site
  notes text not null default '',
  created_at timestamptz not null default now(),
  -- The same source cannot be recorded twice for the same role and reference date.
  unique (user_id, role_id, as_of, source, basis)
);

do $$
declare t text;
begin
  foreach t in array array['benchmark_roles','benchmark_entries']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    -- Postgres has no "create policy if not exists": dropping first keeps this re-runnable.
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('drop policy if exists require_mfa on public.%I', t);
    execute format($p$create policy owner_all on public.%I for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()))$p$, t);
    execute format($p$create policy require_mfa on public.%I as restrictive for all to authenticated
      using ((select auth.jwt()->>'aal') = 'aal2')
      with check ((select auth.jwt()->>'aal') = 'aal2')$p$, t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

create index if not exists benchmark_entries_role_date on public.benchmark_entries (user_id, role_id, as_of desc);
