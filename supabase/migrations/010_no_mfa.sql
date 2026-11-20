-- Remove a exigência de verificação em duas etapas (aal2) de todas as tabelas.
--
-- Decisão do dono do app (13/11/2026): login só com senha ou código por e-mail, sem Authenticator.
-- Continua valendo a regra owner_all: cada usuário só vê e altera as próprias linhas.
-- Consequência: quem tiver a senha (ou acesso ao e-mail) vê todos os dados financeiros.
--
-- Rode no SQL Editor do Supabase. É re-executável.

do $$
declare r record;
begin
  for r in select tablename from pg_policies where schemaname = 'public' and policyname = 'require_mfa' loop
    execute format('drop policy require_mfa on public.%I', r.tablename);
  end loop;
end $$;

-- Conferência: não deve retornar nenhuma linha.
-- select tablename from pg_policies where policyname = 'require_mfa';

-- ─── Para voltar a exigir o Authenticator (aal2) ─────────────────────────────────────────────
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['accounts','categories','bank_category_map','category_rules','imports','transactions',
--     'balance_checkpoints','budgets','fx_rates','scenarios','user_settings','payslips','merchant_profiles',
--     'card_statements','benchmark_roles','benchmark_entries','devices']
--   loop
--     execute format('create policy require_mfa on public.%I as restrictive for all to authenticated
--       using ((select auth.jwt()->>''aal'') = ''aal2'') with check ((select auth.jwt()->>''aal'') = ''aal2'')', t);
--   end loop;
-- end $$;
