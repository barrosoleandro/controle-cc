-- What each merchant is: filled during an import by the AI enrichment step, then
-- corrected by hand. Kept separate from transactions so the description survives
-- re-imports and is reused by the next one (this is the memory that makes the
-- import get better over time).
create table public.merchant_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  merchant text not null, -- merchantKey(), the same grouping key used everywhere
  description text not null default '',
  suggested_category_id uuid references public.categories on delete set null,
  confidence numeric(4,3),
  source text not null default 'ai' check (source in ('ai', 'manual')),
  accepted boolean not null default false, -- true once the user applied it
  updated_at timestamptz not null default now(),
  unique (user_id, merchant) -- one profile per merchant: re-enriching replaces it
);

alter table public.merchant_profiles enable row level security;
alter table public.merchant_profiles force row level security;
create policy owner_all on public.merchant_profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy require_mfa on public.merchant_profiles as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');
revoke all on public.merchant_profiles from anon;

create index merchant_profiles_user_merchant on public.merchant_profiles (user_id, merchant);
