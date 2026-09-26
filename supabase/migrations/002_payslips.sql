-- Payslips (bulletins de paie): one row per month, parsed in the browser.
-- Only amounts and labels are stored (no social-security number, no bank account).
create table public.payslips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  period date not null, -- first day of the pay month
  employer text not null default '',
  pay_date date,
  transfer_date date,
  gross numeric(14,2),
  employee_contrib numeric(14,2),
  employer_contrib numeric(14,2),
  employer_cost numeric(14,2),
  net_social numeric(14,2),
  net_before_tax numeric(14,2),
  net_taxable numeric(14,2),
  cumul_taxable numeric(14,2),
  pas_rate numeric(6,3),
  pas_amount numeric(14,2),
  net_paid numeric(14,2),
  lines jsonb not null,
  file_sha256 text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, period) -- one payslip per month: re-importing replaces it, never duplicates
);

alter table public.payslips enable row level security;
alter table public.payslips force row level security;
create policy owner_all on public.payslips for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy require_mfa on public.payslips as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2') with check ((select auth.jwt()->>'aal') = 'aal2');
revoke all on public.payslips from anon;

-- Contract amounts expected on every payslip (null = app defaults).
alter table public.user_settings add column payroll_contract jsonb;
