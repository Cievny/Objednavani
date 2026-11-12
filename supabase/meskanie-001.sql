-- ============================================================
-- MESKANIE-001 — hromadná SMS „meškáme pre akútneho pacienta"
--
-- Personál (USG, angiologická ambulancia, CT) jedným tlačidlom v Prehľade
-- pošle všetkým dnešným ešte nevybaveným pacientom ospravedlnenie, že pre
-- akútneho pacienta sa vyšetrenia oneskoria a ich termín platí.
--
--  • Príjemcovia: dnešné objednávky v stave nová / potvrdená (nie vykonané,
--    neprišiel, zrušené), so zapnutými správami a mobilným číslom; pri CT
--    bez nepotvrdených žiadostí lekárov (pacient o termíne ešte nevie).
--    Jedno číslo dostane SMS len raz. Lekár (rola lekar) len svojim pacientom.
--  • Text je pevný (bez diakritiky, do 160 znakov), voliteľne s odhadom
--    meškania 15–120 min. Voľný text sa poslať nedá.
--  • Ochrana: len prihlásený personál s MFA; ďalšia SMS najskôr o 10 minút,
--    najviac 5 za deň na ambulanciu; každé odoslanie sa zapíše (kto, kedy,
--    koľkým) do delay_sms_log.
--
-- RPC clinic_delay_sms(p_clinic, p_delay_min, p_dry_run):
--   p_dry_run = true  → len náhľad (počet príjemcov, text, posledné odoslanie)
--   p_dry_run = false → odošle
--
-- Idempotentné. Spúšťať PO rucne-001.sql a ct-lekari-001.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('my_role()') is null or to_regprocedure('my_doctor()') is null or to_regprocedure('mfa_ok()') is null
     or to_regprocedure('staff_display_name()') is null or to_regprocedure('sms_number(text)') is null
     or to_regprocedure('app_secret(text)') is null then
    raise exception 'MESKANIE-001: chýbajú pomocné funkcie — spustite najprv rucne-001.sql.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'notify_patient')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'angio_orders' and column_name = 'notify_patient')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ct_orders' and column_name = 'requested_by') then
    raise exception 'MESKANIE-001: spustite najprv rucne-001.sql a ct-lekari-001.sql.';
  end if;
end $$;

-- záznam odoslaní (kto, kedy, koľkým) — cez API nedostupný, číta ho len RPC
create table if not exists delay_sms_log (
  id         bigint generated always as identity primary key,
  clinic     text not null check (clinic in ('usg', 'angio', 'ct')),
  sent_on    date not null,
  sent_at    timestamptz not null default now(),
  sent_by    text not null default '',
  delay_min  int,
  recipients int not null default 0
);
create index if not exists delay_sms_log_day_idx on delay_sms_log (clinic, sent_on);
alter table delay_sms_log enable row level security;
revoke all on delay_sms_log from public, anon, authenticated;

create or replace function clinic_delay_sms(p_clinic text, p_delay_min int default null, p_dry_run boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role      text := my_role();
  v_today     date := (now() at time zone 'Europe/Bratislava')::date;
  v_label     text;
  v_text      text;
  v_nums      text[];
  v_skipped   int;
  v_last      delay_sms_log%rowtype;
  v_today_cnt int;
  v_wait      int := 0;
  v_app_id    text := app_secret('bulkgate_app_id');
  v_app_token text := app_secret('bulkgate_app_token');
  v_num       text;
begin
  if v_role not in ('superadmin', 'sestra', 'lekar') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  v_label := case p_clinic when 'usg' then 'USG' when 'angio' then 'angiologia' when 'ct' then 'CT' end;
  if v_label is null then raise exception 'Neznáma ambulancia.'; end if;
  if p_delay_min is not null and p_delay_min not in (15, 30, 45, 60, 90, 120) then
    raise exception 'Odhad meškania vyberte z ponuky (15 až 120 minút).';
  end if;

  v_text := 'NUSCH ' || v_label || ': Ospravedlnujeme sa, pre akutneho pacienta dnes meskame'
    || case when p_delay_min is null then '' else ' asi ' || p_delay_min || ' min' end
    || '. Vas termin plati, prosime o trpezlivost. Dakujeme za pochopenie.';

  -- dnešní nevybavení pacienti ambulancie (lekár len svoji); jedno číslo raz
  with src as (
    select phone, doctor, status, notify_patient, slot_date, ''::text as requested_by from orders where p_clinic = 'usg'
    union all
    select phone, doctor, status, notify_patient, slot_date, ''::text from angio_orders where p_clinic = 'angio'
    union all
    select phone, doctor, status, notify_patient, slot_date, coalesce(requested_by, '') from ct_orders where p_clinic = 'ct'
  ), todays as (
    select sms_number(phone) as num, notify_patient
    from src
    where slot_date = v_today and status in ('new', 'confirmed')
      and not (requested_by <> '' and status = 'new')
      and (v_role <> 'lekar' or doctor = my_doctor())
  )
  select coalesce(array_agg(distinct num) filter (where notify_patient is not false and length(num) >= 11), '{}'),
         count(*) filter (where notify_patient is false or length(num) < 11)
    into v_nums, v_skipped
  from todays;

  select * into v_last from delay_sms_log where clinic = p_clinic and sent_on = v_today order by sent_at desc limit 1;
  select count(*) into v_today_cnt from delay_sms_log where clinic = p_clinic and sent_on = v_today;
  if v_last.id is not null and v_last.sent_at > now() - interval '10 minutes' then
    v_wait := greatest(1, ceil(extract(epoch from (v_last.sent_at + interval '10 minutes' - now())) / 60)::int);
  end if;

  if not coalesce(p_dry_run, true) then
    if v_app_id like 'SEM\_%' or v_app_token like 'SEM\_%' then raise exception 'SMS brána nie je nastavená.'; end if;
    if v_wait > 0 then
      raise exception 'SMS o meškaní bola odoslaná pred chvíľou (%). Ďalšiu môžete poslať o % min.',
        to_char(v_last.sent_at at time zone 'Europe/Bratislava', 'HH24:MI'), v_wait;
    end if;
    if v_today_cnt >= 5 then raise exception 'Dnes už bolo odoslaných 5 SMS o meškaní — viac sa poslať nedá.'; end if;
    if cardinality(v_nums) = 0 then raise exception 'Dnes nie je komu poslať SMS (žiadni nevybavení pacienti s mobilným číslom).'; end if;
    if cardinality(v_nums) > 300 then raise exception 'Príliš veľa príjemcov (%).', cardinality(v_nums); end if;
    foreach v_num in array v_nums loop
      perform net.http_post(
        url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'application_id', v_app_id, 'application_token', v_app_token,
          'number', v_num, 'text', v_text, 'unicode', false,
          'sender_id', 'gText', 'sender_id_value', 'NUSCH'));
    end loop;
    insert into delay_sms_log (clinic, sent_on, sent_by, delay_min, recipients)
      values (p_clinic, v_today, staff_display_name(), p_delay_min, cardinality(v_nums));
  end if;

  return jsonb_build_object(
    'sent', not coalesce(p_dry_run, true),
    'count', cardinality(v_nums), 'skipped', v_skipped, 'text', v_text,
    'wait_min', case when coalesce(p_dry_run, true) then v_wait else 10 end,
    'today_sends', v_today_cnt + case when coalesce(p_dry_run, true) then 0 else 1 end,
    'last', case
      when not coalesce(p_dry_run, true) then jsonb_build_object('at', now(), 'by', staff_display_name(), 'count', cardinality(v_nums), 'delay_min', p_delay_min)
      when v_last.id is null then null
      else jsonb_build_object('at', v_last.sent_at, 'by', v_last.sent_by, 'count', v_last.recipients, 'delay_min', v_last.delay_min) end);
end $$;
revoke all on function clinic_delay_sms(text, int, boolean) from public, anon;
grant execute on function clinic_delay_sms(text, int, boolean) to authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
declare v text;
begin
  if has_function_privilege('anon', 'clinic_delay_sms(text, int, boolean)', 'execute') then
    raise exception 'MESKANIE-001: anon nesmie mať EXECUTE na clinic_delay_sms.';
  end if;
  if not has_function_privilege('authenticated', 'clinic_delay_sms(text, int, boolean)', 'execute') then
    raise exception 'MESKANIE-001: personál nemá EXECUTE na clinic_delay_sms.';
  end if;
  if has_table_privilege('authenticated', 'delay_sms_log', 'select') or has_table_privilege('anon', 'delay_sms_log', 'select') then
    raise exception 'MESKANIE-001: delay_sms_log je dostupný cez API.';
  end if;
  -- najdlhší text (angiologia, 120 min) sa musí zmestiť do jednej SMS
  v := 'NUSCH angiologia: Ospravedlnujeme sa, pre akutneho pacienta dnes meskame asi 120 min. Vas termin plati, prosime o trpezlivost. Dakujeme za pochopenie.';
  if length(v) > 160 then raise exception 'MESKANIE-001: text SMS má % znakov (najviac 160).', length(v); end if;
  raise notice 'MESKANIE-001 OK.';
end $$;
