-- ============================================================
-- ANGIO-015 — audit UX 1 (správa a pacientske toky)
--
--  1  angio_cancel_order: zrušenie pacientom najneskôr 24 h pred termínom
--     (texty na stránke to sľubovali, server to doteraz nevynucoval)
--  2  „Vrátiť medzi aktívne" (done/noshow → confirmed) nesmie pacientovi
--     poslať SMS a e-mail „termín potvrdený": notifikačné triggery angio
--     (e-mail + SMS) a CT (e-mail) reagujú len na prechod new → confirmed
--  3  angio_close_free_slots / ct_close_free_slots: hromadné zatvorenie
--     voľných buniek, server maže len bunky nepokryté aktívnou objednávkou
--     (aj keď má personál neaktuálny stav v prehliadači)
--  4  angio_reschedule / ct_reschedule: pri zmene dátumu vynulovať arrived_at
--     (pacient „v čakárni" sa nesmie preniesť na iný deň)
--  5  realtime: tabuľky ambulancií v publikácii supabase_realtime
--     (personál vidí nové objednávky a check-in bez obnovenia stránky)
--
-- Idempotentné. Spúšťať PO termin-zajtra-001.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. zrušenie pacientom len ≥ 24 h vopred
-- ------------------------------------------------------------
do $$
declare r record; v_def text; v_new text;
begin
  for r in select p.oid, p.oid::regprocedure as sig, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'angio_cancel_order' loop
    if r.prosrc like '%24 hodín vopred%' then raise notice 'ANGIO-015: % už má 24 h kontrolu.', r.sig; continue; end if;
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def,
      E'(\\n\\s*)(update angio_orders o set status = ''rejected'', status_note = ''Zrušené pacientom'')',
      E'\\1if exists (select 1 from angio_orders o where upper(o.id) = upper(p_id)\\1    and right(regexp_replace(o.phone, ''\\\\D'', '''', ''g''), 9) = right(regexp_replace(coalesce(p_phone, ''''), ''\\\\D'', '''', ''g''), 9)\\1    and o.status in (''new'', ''confirmed'')\\1    and (o.slot_date + o.slot_time) at time zone ''Europe/Bratislava'' < now() + interval ''24 hours'') then\\1  raise exception ''Objednávku možno online zrušiť najneskôr 24 hodín vopred. Napíšte nám SMS s číslom objednávky na 0949 000 677.'';\\1end if;\\1\\2');
    if v_new = v_def then raise exception 'ANGIO-015: % — nenašiel sa update, upravte ručne.', r.sig; end if;
    execute v_new;
    raise notice 'ANGIO-015: % — doplnená 24 h kontrola.', r.sig;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2. notifikácie „potvrdené" len z new → confirmed
-- ------------------------------------------------------------
do $$
declare r record; v_def text; v_new text; n int := 0;
begin
  for r in select p.oid, p.oid::regprocedure as sig, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('angio_notify_trigger', 'angio_notify_sms', 'ct_notify_trigger', 'ct_notify_sms')
      and p.prosrc like '%OLD.status <> ''confirmed'' and NEW.status = ''confirmed''%' loop
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def, 'OLD.status <> ''confirmed'' and NEW.status = ''confirmed''', 'OLD.status = ''new'' and NEW.status = ''confirmed''');
    execute v_new; n := n + 1;
    raise notice 'ANGIO-015: % — potvrdenie len z new.', r.sig;
  end loop;
  raise notice 'ANGIO-015: upravených notifikačných funkcií: %.', n;
end $$;

-- ------------------------------------------------------------
-- 3. hromadné zatvorenie voľných buniek (len nepokryté aktívnou objednávkou)
-- ------------------------------------------------------------
create or replace function angio_close_free_slots(p_date date, p_times time[])
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if my_role() not in ('superadmin', 'sestra') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  if p_date is null or p_times is null or array_length(p_times, 1) is null then return 0; end if;
  delete from angio_open_slots s
  where s.slot_date = p_date and s.slot_time = any(p_times)
    and not exists (
      select 1 from angio_orders o
      where o.slot_date = p_date and o.status <> 'rejected'
        and s.slot_time >= o.slot_time
        and s.slot_time < o.slot_time + (greatest(coalesce(o.duration_min, 15), 5) * interval '1 minute'));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function angio_close_free_slots(date, time[]) from public, anon;
grant execute on function angio_close_free_slots(date, time[]) to authenticated;

do $$
begin
  if to_regclass('public.ct_open_slots') is null then return; end if;
  execute $f$
    create or replace function ct_close_free_slots(p_date date, p_times time[])
    returns int
    language plpgsql security definer set search_path = public as $b$
    declare n int;
    begin
      if my_role() not in ('superadmin', 'sestra') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
      if p_date is null or p_times is null or array_length(p_times, 1) is null then return 0; end if;
      delete from ct_open_slots s
      where s.slot_date = p_date and s.slot_time = any(p_times)
        and not exists (
          select 1 from ct_orders o
          where o.slot_date = p_date and o.status <> 'rejected'
            and s.slot_time >= o.slot_time
            and s.slot_time < o.slot_time + (greatest(coalesce(o.duration_min, 15), 5) * interval '1 minute'));
      get diagnostics n = row_count;
      return n;
    end $b$;
  $f$;
  execute 'revoke all on function ct_close_free_slots(date, time[]) from public, anon';
  execute 'grant execute on function ct_close_free_slots(date, time[]) to authenticated';
end $$;

-- ------------------------------------------------------------
-- 4. presun personálom na iný deň nuluje arrived_at
-- ------------------------------------------------------------
do $$
declare r record; v_def text; v_new text;
begin
  for r in select p.oid, p.oid::regprocedure as sig, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('angio_reschedule', 'ct_reschedule') loop
    if r.prosrc like '%arrived_at = case%' then continue; end if;
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def,
      E'(update (angio|ct)_orders set slot_date = p_slot_date, slot_time = p_slot_time,)',
      E'\\1\\n    arrived_at = case when v_order.slot_date = p_slot_date then arrived_at else null end,');
    if v_new = v_def then raise warning 'ANGIO-015: % — update sa nenašiel, arrived_at neupravené.', r.sig; continue; end if;
    execute v_new;
    raise notice 'ANGIO-015: % — arrived_at sa pri zmene dňa nuluje.', r.sig;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 5. realtime publikácia
-- ------------------------------------------------------------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'ANGIO-015: publikácia supabase_realtime neexistuje (lokálny stub) — preskakujem.'; return;
  end if;
  foreach t in array array['angio_orders', 'angio_open_slots', 'angio_callbacks', 'ct_orders', 'ct_open_slots'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
      raise notice 'ANGIO-015: realtime pre %.', t;
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
declare v text; c int;
begin
  select prosrc into v from pg_proc where proname = 'angio_cancel_order' and pronamespace = 'public'::regnamespace limit 1;
  if v is null then raise exception 'ANGIO-015: angio_cancel_order neexistuje — spustite najprv audit-vlna7-001.sql.'; end if;
  if v not like '%24 hodín vopred%' then raise exception 'ANGIO-015: angio_cancel_order bez 24 h kontroly'; end if;
  select count(*) into c from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('angio_notify_trigger', 'angio_notify_sms', 'ct_notify_trigger')
    and prosrc like '%OLD.status <> ''confirmed'' and NEW.status = ''confirmed''%';
  if c > 0 then raise exception 'ANGIO-015: % notifikačných funkcií stále reaguje na každý prechod do confirmed', c; end if;
  if to_regprocedure('angio_close_free_slots(date, time[])') is null then raise exception 'ANGIO-015: chýba angio_close_free_slots'; end if;
  if has_function_privilege('anon', 'angio_close_free_slots(date, time[])', 'execute') then raise exception 'ANGIO-015: anon má EXECUTE na angio_close_free_slots'; end if;
  raise notice 'ANGIO-015 OK.';
end $$;
