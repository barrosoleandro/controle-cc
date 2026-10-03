-- Credit cards linked to accounts (Itaú card bill import).
-- Run once in Supabase → SQL Editor, after 001–003.
--   * accounts.parent_account_id: the account that pays a card's bill.
--   * transactions.statement_due: the bill (fatura) a card row belongs to, by due date.
--   * card_statements: one row per bill, with the total the bank billed.

alter table public.accounts
  add column if not exists parent_account_id uuid references public.accounts on delete set null;
alter table public.accounts
  drop constraint if exists accounts_parent_not_self,
  add constraint accounts_parent_not_self check (parent_account_id is null or parent_account_id <> id);

alter table public.transactions add column if not exists statement_due date;
create index if not exists transactions_statement on public.transactions (account_id, statement_due);

create table if not exists public.card_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  account_id uuid not null references public.accounts on delete cascade,
  due_date date not null,
  total numeric(14,2) not null,
  status text not null check (status in ('paga', 'aberta')),
  file_name text,
  updated_at timestamptz not null default now(),
  unique (account_id, due_date)
);

alter table public.card_statements enable row level security;
alter table public.card_statements force row level security;
-- Postgres has no "create policy if not exists": dropping first keeps this re-runnable.
drop policy if exists owner_all on public.card_statements;
drop policy if exists require_mfa on public.card_statements;
create policy owner_all on public.card_statements for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy require_mfa on public.card_statements as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');
revoke all on public.card_statements from anon;
