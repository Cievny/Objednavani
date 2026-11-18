-- ============================================================
-- AUDIT-VLNA10-002 — rozhodnutia po audite (17. 11. 2026)
--
--  1  CT: pacient si termín online nezruší (musí sa ozvať pracovisku).
--     Verejná funkcia ct_cancel_order je zrušená — stránka ju nepoužívala,
--     dala sa však zavolať priamo, aj pár minút pred termínom.
--  2  ANGIO a CT: zrušené objednávky sa mažú 7 dní po zrušení (ako USG);
--     doteraz ostávali s menom a telefónom do termínu + 28 dní.
--  3  BANKA: párovanie platieb pozerá 10 dní dozadu (doteraz 3) — po
--     dlhšom výpadku sa staršie platby dopárujú samy.
--
-- Idempotentné. Spúšťať PO audit-vlna10-001.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('system_http_watch()') is null then
    raise exception 'AUDIT-VLNA10-002: spustite najprv audit-vlna10-001.sql (a ste v projekte „USG objednavanie"?).';
  end if;
end $$;

-- pomôcka: úprava existujúcej funkcie na mieste (raz — podľa značky)
create or replace function pg_temp.av10_patch(p_fn text, p_pattern text, p_repl text, p_marker text, p_flags text default '')
returns void language plpgsql as $f$
declare r record; v_def text; v_new text; n int := 0;
begin
  for r in select p.oid, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = p_fn loop
    n := n + 1;
    if strpos(r.prosrc, p_marker) > 0 then continue; end if;
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, p_pattern, p_repl, p_flags);
    if v_new = v_def then
      raise exception 'AUDIT-VLNA10-002: vo funkcii % sa nenašlo miesto na úpravu (%).', p_fn, p_marker;
    end if;
    execute v_new;
  end loop;
  if n = 0 then raise exception 'AUDIT-VLNA10-002: funkcia % neexistuje.', p_fn; end if;
end $f$;

-- ------------------------------------------------------------
-- 1. CT: pacient si termín online nezruší (rozhodnutie 17. 11. 2026)
-- ------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'ct_cancel_order' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2. ANGIO a CT: zrušené objednávky zmazať 7 dní po zrušení (ako USG)
--     (staršie záznamy bez dátumu zrušenia ostávajú pri pravidle termín + 28 dní)
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.av10_patch('angio_purge_orders',
    E'select id from angio_orders where slot_date < current_date - 28',
    E'select id from angio_orders where slot_date < current_date - 28\n      or (status = ''rejected'' and rejected_at <= now() - interval ''7 days'') -- audit-vlna10:zrusene7',
    'audit-vlna10:zrusene7');
  perform pg_temp.av10_patch('ct_purge_orders',
    E'select id from ct_orders where slot_date < current_date - 28',
    E'select id from ct_orders where slot_date < current_date - 28\n      or (status = ''rejected'' and rejected_at <= now() - interval ''7 days'') -- audit-vlna10:zrusene7',
    'audit-vlna10:zrusene7');
end $$;

-- ------------------------------------------------------------
-- 3. BANKA: párovanie pozerá 10 dní dozadu (už zapísané platby sa preskočia)
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.av10_patch('fio_poll',
    E'to_char\\(current_date - 3, ',
    E'to_char(current_date - 10 /* audit-vlna10:fio10 */, ',
    'audit-vlna10:fio10');
end $$;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'ct_cancel_order'
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception 'AUDIT-VLNA10-002: ct_cancel_order je stále dostupná cez API.';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('angio_purge_orders', 'ct_purge_orders') and prosrc like '%audit-vlna10:zrusene7%') <> 2
     or not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'fio_poll' and prosrc like '%audit-vlna10:fio10%') then
    raise exception 'AUDIT-VLNA10-002: mazanie zrušených po 7 dňoch / 10-dňové okno banky sa neaplikovali.';
  end if;
  raise notice 'AUDIT-VLNA10-002 OK. Zrušené objednávky na zmazanie dnes v noci: angio %, CT %.',
    (select count(*) from angio_orders where status = 'rejected' and rejected_at <= now() - interval '7 days'),
    (select count(*) from ct_orders where status = 'rejected' and rejected_at <= now() - interval '7 days');
end $$;
