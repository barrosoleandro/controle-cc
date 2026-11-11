-- Payslips in dollars (US pay statements, biweekly, grouped by month) next to the French ones in
-- euros. A month can hold one payslip per currency: in the transfer month (and for share vesting
-- paid by the US after the move) there is both a bulletin de paie and a US statement.
-- Run after 002_payslips.sql. Without it the French payslips keep working; US ones cannot be saved.

alter table public.payslips add column if not exists currency text not null default 'EUR';
alter table public.payslips drop constraint if exists payslips_currency_check;
alter table public.payslips add constraint payslips_currency_check check (currency in ('EUR', 'USD'));

alter table public.payslips drop constraint if exists payslips_user_id_period_key;
create unique index if not exists payslips_user_period_currency on public.payslips (user_id, period, currency);
