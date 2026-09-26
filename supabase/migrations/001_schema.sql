-- Controle CC — database schema
-- Run once in Supabase → SQL Editor on a NEW, dedicated project.
-- Security model:
--   * Every row belongs to auth.uid() (user_id default auth.uid()).
--   * Row Level Security on every table; access requires an MFA-verified session (aal2),
--     so a stolen password alone cannot read any data.
--   * Only the anon key is used by the app; the service_role key is never shipped.

create extension if not exists pgcrypto;

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  bank text not null,
  currency text not null check (currency in ('EUR','BRL')),
  type text not null default 'checking' check (type in ('checking','savings','card')),
  external_ref text not null,
  opening_balance numeric(14,2) not null default 0,
  opening_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, external_ref)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  kind text not null check (kind in ('income','expense','transfer')),
  color text not null default '#999999',
  sort int not null default 0,
  unique (user_id, name)
);

create table public.bank_category_map (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  bank text not null,
  bank_category text not null,
  bank_subcategory text not null default '*',
  category_id uuid not null references public.categories on delete cascade,
  unique (user_id, bank, bank_category, bank_subcategory)
);

create table public.category_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  pattern text not null check (length(pattern) between 2 and 100),
  bank text,
  sign text check (sign in ('debit','credit')),
  category_id uuid not null references public.categories on delete cascade,
  priority int not null default 1000,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  file_name text not null,
  file_sha256 text not null,
  source text not null,
  rows_total int not null,
  rows_inserted int not null,
  created_at timestamptz not null default now()
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  account_id uuid not null references public.accounts on delete cascade,
  booking_date date not null,
  value_date date,
  description text not null,
  merchant text not null default '',
  amount numeric(14,2) not null,
  currency text not null check (currency in ('EUR','BRL')),
  bank_category text,
  bank_subcategory text,
  category_id uuid references public.categories on delete set null,
  category_locked boolean not null default false, -- true = set by hand, rules won't override
  notes text,
  source text not null,
  fingerprint text not null,
  import_id uuid references public.imports on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, fingerprint)
);
create index on public.transactions (user_id, booking_date);
create index on public.transactions (account_id, booking_date);

create table public.balance_checkpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  account_id uuid not null references public.accounts on delete cascade,
  date date not null,
  balance numeric(14,2) not null,
  source text not null,
  unique (account_id, date)
);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  category_id uuid not null references public.categories on delete cascade,
  month date, -- null = default monthly budget; otherwise first day of month override
  amount numeric(14,2) not null check (amount >= 0),
  unique nulls not distinct (user_id, category_id, month)
);

create table public.fx_rates (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  date date not null,
  quote text not null, -- EUR→quote, e.g. BRL
  rate numeric(14,6) not null check (rate > 0),
  primary key (user_id, date, quote)
);

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  display_currency text not null default 'EUR' check (display_currency in ('EUR','BRL')),
  dashboard jsonb not null default '{}'::jsonb,
  dismissed_alerts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row Level Security: owner only, and only with an MFA (aal2) session.
do $$
declare t text;
begin
  foreach t in array array['accounts','categories','bank_category_map','category_rules','imports',
    'transactions','balance_checkpoints','budgets','fx_rates','scenarios','user_settings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format($p$create policy owner_all on public.%I for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()))$p$, t);
    execute format($p$create policy require_mfa on public.%I as restrictive for all to authenticated
      using ((select auth.jwt()->>'aal') = 'aal2')
      with check ((select auth.jwt()->>'aal') = 'aal2')$p$, t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Current balance per account = opening balance + all transactions.
create view public.v_account_balances with (security_invoker = true) as
select a.id as account_id, a.name, a.currency,
       a.opening_balance + coalesce(sum(t.amount), 0) as balance,
       max(t.booking_date) as last_transaction
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;
