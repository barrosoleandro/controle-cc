-- Pedido de acesso aprovado pelo celular do dono da casa (QR code). Depende da 011 (household_members).
--
-- O aparelho novo (sem login) informa o e-mail da pessoa e mostra um QR code + um número. O dono da
-- casa, logado no celular, lê o QR, confere o número e aprova. A Edge Function "household-access":
--   * pessoa nova: cria a conta e a inclui na casa ANTES do primeiro login (o app não cria dados padrão);
--   * pessoa da casa (ou o próprio dono): só entrega o login;
--   * conta de fora da casa: recusa.
-- Depois, o aparelho novo recebe um token de login de uso único (nenhum e-mail é enviado).
--
-- Rode no SQL Editor do Supabase, depois da 011. É re-executável. Para desfazer, veja o fim.

create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  pair_code text not null unique,               -- 8 caracteres: o que o QR carrega e o celular digita
  poll_hash text not null,                      -- sha-256 do segredo que só o aparelho novo conhece
  match_code smallint not null check (match_code between 10 and 99),
  email text not null,                          -- de quem pede o acesso
  requester jsonb not null default '{}'::jsonb, -- sistema, navegador e IP, mostrados no celular
  status text not null default 'pending' check (status in ('pending','approved','claimed','denied')),
  approved_by uuid references auth.users on delete cascade,
  user_id uuid references auth.users on delete cascade,
  approved_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 minutes'
);
-- Só a Edge Function (service_role) lê e escreve.
alter table public.access_requests enable row level security;
revoke all on public.access_requests from anon, authenticated;

-- O e-mail do membro, para a lista em Ajustes (o app não lê auth.users).
alter table public.household_members add column if not exists email text;

-- A Edge Function acha uma conta pelo e-mail. Só ela (service_role) pode chamar.
create or replace function public.user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1
$$;
revoke all on function public.user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;

-- ─── Para desfazer ───────────────────────────────────────────────────────────────────────────
-- drop function if exists public.user_id_by_email(text);
-- alter table public.household_members drop column if exists email;
-- drop table if exists public.access_requests;
