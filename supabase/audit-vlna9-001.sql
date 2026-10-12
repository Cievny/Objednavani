-- ============================================================
-- AUDIT VLNA 9 — po kontrole zmien v95–v99 (Zachráň nohu, spätné
-- volania) a výstupu Supabase Security Advisors
--
--  1  search_path pre 6 funkcií bez neho (advisor function_search_path_mutable):
--     sms_number, html_escape, doctor_monthly_stats, angio_instr_html,
--     angio_autoformat_instructions, angio_split_instructions
--  2  trigger funkcie SECURITY DEFINER nie sú spustiteľné anon/authenticated
--     (advisor anon_security_definer_function_executable) — triggery
--     EXECUTE nepotrebujú, priame volanie aj tak zlyhá
--  3  stará create_order(… bez p_attachments) zrušená — frontend volá
--     verziu s prílohami; stará nemá assert_attachments ani client_ip()
--  4  mfa_ok() do staff RPC, ktoré ho ešte nemali: reschedule_order,
--     create_adhoc_payment, resend_adhoc_email, issue_missing_invoices,
--     list_staff (pri mfa_enforce = off bez vplyvu; pri on už nič neobíde MFA)
--
-- Bez kľúčov. Idempotentné. Spúšťať PO audit-vlna8-001.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. search_path
-- ------------------------------------------------------------
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('sms_number', 'html_escape', 'doctor_monthly_stats', 'angio_instr_html',
                        'angio_autoformat_instructions', 'angio_split_instructions')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public', r.sig);
    n := n + 1;
  end loop;
  raise notice 'VLNA 9: search_path doplnený % funkciám.', n;
end $$;

-- ------------------------------------------------------------
-- 2. trigger funkcie: žiadne EXECUTE pre aplikačné roly
-- ------------------------------------------------------------
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prorettype = 'trigger'::regtype
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    n := n + 1;
  end loop;
  raise notice 'VLNA 9: EXECUTE odobraté % trigger funkciám.', n;
end $$;

-- ------------------------------------------------------------
-- 3. stará create_order bez príloh
-- ------------------------------------------------------------
drop function if exists create_order(text, text, text, numeric, boolean, text, text, text, text, date, text, text, text, date, time, text);

-- ------------------------------------------------------------
-- 4. mfa_ok() do zvyšných staff RPC (úprava v mieste, telo ostáva)
-- ------------------------------------------------------------
do $$
declare
  r record; v_def text; v_new text; n int := 0;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig, p.proname
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('reschedule_order', 'create_adhoc_payment', 'resend_adhoc_email', 'issue_missing_invoices', 'list_staff')
      and p.prosrc like '%my_role()%'
      and p.prosrc not like '%mfa_ok()%'
  loop
    v_def := pg_get_functiondef(r.oid);
    -- prvý „begin" tela: hneď za ním kontrola MFA
    v_new := regexp_replace(v_def, '(\n\s*begin\s*\n)',
      E'\\1  if not mfa_ok() then raise exception ''Vyžaduje sa dvojfaktorové overenie (MFA).''; end if;\n', 'i');
    if v_new = v_def then
      raise warning 'VLNA 9: % — nenašiel sa začiatok tela, mfa_ok() nedoplnený (doplňte ručne).', r.sig;
      continue;
    end if;
    execute v_new;
    n := n + 1;
  end loop;
  raise notice 'VLNA 9: mfa_ok() doplnený do % RPC.', n;
end $$;

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
declare v text; c int;
begin
  select string_agg(proname, ', ') into v from pg_proc p
    where pronamespace = 'public'::regnamespace
      and proname in ('sms_number', 'html_escape', 'doctor_monthly_stats', 'angio_instr_html', 'angio_autoformat_instructions', 'angio_split_instructions')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) x where x like 'search_path=%');
  if v is not null then raise exception 'VLNA 9: bez search_path: %', v; end if;

  select count(*) into c from pg_proc p where pronamespace = 'public'::regnamespace and prorettype = 'trigger'::regtype
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if c > 0 then raise exception 'VLNA 9: % trigger funkcií stále spustiteľných aplikačnými rolami', c; end if;

  select count(*) into c from pg_proc where proname = 'create_order' and pronamespace = 'public'::regnamespace;
  if c > 1 then raise exception 'VLNA 9: create_order má stále % verzií', c; end if;

  select string_agg(proname, ', ') into v from pg_proc p
    where pronamespace = 'public'::regnamespace
      and proname in ('reschedule_order', 'create_adhoc_payment', 'resend_adhoc_email', 'issue_missing_invoices', 'list_staff')
      and prosrc like '%my_role()%' and prosrc not like '%mfa_ok()%';
  if v is not null then raise warning 'VLNA 9: bez mfa_ok(): %', v; end if;

  raise notice 'VLNA 9 OK.';
end $$;
