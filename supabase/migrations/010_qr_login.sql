-- Acesso pontual aprovado pelo celular (QR code).
--
-- O laptop pede um login (Edge Function qr-login, ação "start") e mostra um QR code com um código
-- de pareamento. O celular, já logado com o segundo fator, lê o QR, escolhe o número que o laptop
-- mostra e confirma de novo com biometria ou o código do autenticador. A função então entrega ao
-- laptop uma sessão aal1, e registra o session_id dela em approved_sessions, por no máximo 12 horas.
--
-- O RLS passa de "aal2" para "aal2 OU sessão aprovada por um aparelho aal2, ainda válida e não
-- revogada" (public.strong_session()). Uma sessão aal1 comum (só senha, ou só e-mail) continua sem
-- acesso a nada.
--
-- Rode no SQL Editor do Supabase. É re-executável. Para desfazer, veja o fim do arquivo.

-- Pedidos de login por QR. Só a Edge Function (service_role) lê e escreve: sem policies, e sem
-- grants para anon/authenticated.
create table if not exists public.qr_logins (
  id uuid primary key default gen_random_uuid(),
  pair_code text not null unique,               -- 8 caracteres, o que o QR carrega e o celular digita
  poll_hash text not null,                      -- sha-256 do segredo que só o laptop conhece
  match_code smallint not null check (match_code between 10 and 99),
  requester jsonb not null default '{}'::jsonb, -- sistema, navegador e IP do laptop, mostrados no celular
  status text not null default 'pending' check (status in ('pending','approved','claimed','done','denied')),
  user_id uuid references auth.users on delete cascade,
  approved_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 minutes'
);
alter table public.qr_logins enable row level security;
revoke all on public.qr_logins from anon, authenticated;

-- Sessões (do Supabase Auth) que um aparelho aal2 aprovou. Visíveis e revogáveis em
-- Ajustes → Aparelhos, só por uma sessão aal2 de verdade: uma sessão aprovada não se estende.
create table if not exists public.approved_sessions (
  session_id uuid primary key,
  user_id uuid not null references auth.users on delete cascade,
  qr_login_id uuid references public.qr_logins on delete set null,
  requester jsonb not null default '{}'::jsonb,
  approved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
-- Sem FORCE: a função security definer abaixo (dona da tabela) precisa ler sem as policies.
alter table public.approved_sessions enable row level security;
drop policy if exists owner_read on public.approved_sessions;
drop policy if exists owner_revoke on public.approved_sessions;
create policy owner_read on public.approved_sessions for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2');
create policy owner_revoke on public.approved_sessions for update to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2')
  with check (user_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2');
revoke all on public.approved_sessions from anon;
revoke insert, update, delete on public.approved_sessions from authenticated;
grant select, update (revoked_at) on public.approved_sessions to authenticated;

-- aal2, ou uma sessão aprovada pelo celular, ainda no prazo e não revogada.
create or replace function public.strong_session() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((auth.jwt()->>'aal') = 'aal2', false)
    or exists (
      select 1 from public.approved_sessions s
      where s.session_id = nullif(auth.jwt()->>'session_id', '')::uuid
        and s.user_id = auth.uid()
        and s.revoked_at is null
        and s.expires_at > now()
    )
$$;
revoke all on function public.strong_session() from public, anon;
grant execute on function public.strong_session() to authenticated;

-- Troca a regra "require_mfa" de todas as tabelas que a têm (as das migrações 001 a 009).
do $$
declare r record;
begin
  for r in select tablename from pg_policies where schemaname = 'public' and policyname = 'require_mfa' loop
    execute format('drop policy require_mfa on public.%I', r.tablename);
    execute format($p$create policy require_mfa on public.%I as restrictive for all to authenticated
      using ((select public.strong_session()))
      with check ((select public.strong_session()))$p$, r.tablename);
  end loop;
end $$;

-- Conferência: deve listar as tabelas, todas com strong_session.
-- select tablename, qual from pg_policies where policyname = 'require_mfa' order by 1;

-- ─── Para desfazer (volta a exigir aal2 em tudo) ─────────────────────────────────────────────
-- do $$
-- declare r record;
-- begin
--   for r in select tablename from pg_policies where schemaname = 'public' and policyname = 'require_mfa' loop
--     execute format('drop policy require_mfa on public.%I', r.tablename);
--     execute format($p$create policy require_mfa on public.%I as restrictive for all to authenticated
--       using ((select auth.jwt()->>'aal') = 'aal2')
--       with check ((select auth.jwt()->>'aal') = 'aal2')$p$, r.tablename);
--   end loop;
-- end $$;
-- drop function if exists public.strong_session();
-- drop table if exists public.approved_sessions;
-- drop table if exists public.qr_logins;
