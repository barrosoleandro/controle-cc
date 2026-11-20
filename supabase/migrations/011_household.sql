-- Casa compartilhada: outra pessoa vê e edita os MESMOS dados que o dono.
--
-- Cada membro aponta para um dono (household_members). public.data_owner() devolve o dono de quem
-- está logado (ou a própria pessoa, se ela não for membro de ninguém). Todas as tabelas passam a:
--   * aceitar as linhas cujo user_id é o dono da casa (policy owner_all);
--   * gravar linhas novas no nome do dono (default de user_id), mesmo quando quem importa é o membro.
-- Os dados que já existem não mudam. A tabela devices fica de fora: cada pessoa tem os próprios
-- aparelhos (senão o iPhone de um seria reconhecido como o do outro, e revogar um tiraria os dois).
--
-- Rode no SQL Editor do Supabase. É re-executável. Para desfazer, veja o fim do arquivo.

create table if not exists public.household_members (
  member_id uuid primary key references auth.users on delete cascade, -- uma pessoa pertence a uma casa só
  owner_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  check (member_id <> owner_id)
);
alter table public.household_members enable row level security;
drop policy if exists see_household on public.household_members;
drop policy if exists owner_removes on public.household_members;
-- O membro vê o próprio vínculo; o dono vê os membros dele.
create policy see_household on public.household_members for select to authenticated
  using (member_id = (select auth.uid()) or owner_id = (select auth.uid()));
-- Só o dono remove um membro. Incluir membro: pelo SQL Editor (ou, no PR seguinte, pela aprovação no celular).
create policy owner_removes on public.household_members for delete to authenticated
  using (owner_id = (select auth.uid()));
revoke all on public.household_members from anon;
revoke insert, update on public.household_members from authenticated;

-- Dono da casa de quem está logado. security definer: lê household_members sem depender das policies.
create or replace function public.data_owner() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((select h.owner_id from public.household_members h where h.member_id = auth.uid()), auth.uid())
$$;
revoke all on function public.data_owner() from public, anon;
grant execute on function public.data_owner() to authenticated;

do $$
declare r record;
begin
  -- Linhas novas no nome do dono da casa.
  for r in select table_name from information_schema.columns
           where table_schema = 'public' and column_name = 'user_id' and column_default like '%auth.uid()%'
             and table_name <> 'devices' loop
    execute format('alter table public.%I alter column user_id set default public.data_owner()', r.table_name);
  end loop;
  -- Ver e editar as linhas do dono da casa.
  for r in select tablename from pg_policies where schemaname = 'public' and policyname = 'owner_all' and tablename <> 'devices' loop
    execute format('drop policy owner_all on public.%I', r.tablename);
    execute format('create policy owner_all on public.%I for all to authenticated using (user_id = (select public.data_owner())) with check (user_id = (select public.data_owner()))', r.tablename);
  end loop;
end $$;

-- Conferência (devem mostrar data_owner):
-- select tablename, qual from pg_policies where policyname = 'owner_all' order by 1;
-- select table_name, column_default from information_schema.columns where table_schema = 'public' and column_name = 'user_id' order by 1;

-- ─── Incluir um membro (depois de criar o usuário em Authentication → Users) ───────────────────
-- insert into public.household_members (member_id, owner_id)
-- select m.id, o.id from auth.users m, auth.users o where m.email = 'EMAIL_DO_MEMBRO' and o.email = 'SEU_EMAIL';

-- ─── Para desfazer (cada um volta a ver só as próprias linhas) ───────────────────────────────
-- do $$
-- declare r record;
-- begin
--   for r in select table_name from information_schema.columns
--            where table_schema = 'public' and column_name = 'user_id' and column_default like '%data_owner()%' loop
--     execute format('alter table public.%I alter column user_id set default auth.uid()', r.table_name);
--   end loop;
--   for r in select tablename from pg_policies where schemaname = 'public' and policyname = 'owner_all' loop
--     execute format('drop policy owner_all on public.%I', r.tablename);
--     execute format('create policy owner_all on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', r.tablename);
--   end loop;
-- end $$;
-- drop function if exists public.data_owner();
-- drop table if exists public.household_members;
