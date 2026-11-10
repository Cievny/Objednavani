-- ============================================================
-- CT-LEKARI-001 — CT objednávanie pre lekárov NÚSCH
--
-- CT nie je verejné pre pacientov. Lekári NÚSCH sa prihlásia spoločným
-- heslom (nastavuje superadmin v správe CT → Nastavenia), vyberú voľný
-- otvorený CT termín a pošlú žiadosť za svojho pacienta: klinická otázka,
-- kontrastná látka (kreatinín / eGFR, alergia, metformín) a žiadanka
-- ako príloha. Žiadosť má stav „nová"; CT pracovisko ju potvrdí v správe.
-- Pacient dostane SMS / e-mail až po potvrdení (lekár to môže vypnúť).
--
--  1  stĺpce ct_orders: requested_by (objednávajúci lekár + kontakt),
--     clinical (údaje o kontraste), sms_reminder_sent_at
--  2  tabuľky ct_doctor_auth (hash spoločného hesla) a ct_doctor_sessions
--     (prihlásenie na 12 h); bez prístupu cez API
--  3  RPC: ct_doctor_login, ct_doctor_create_order, ct_doctor_list (anon
--     s platným prihlásením), ct_set_doctor_password, ct_doctor_password_info
--     (personál)
--  4  notifikácie: e-mail pacientovi pri žiadosti lekára až po potvrdení,
--     nové SMS pre CT (potvrdenie, zrušenie, presun, pripomienka deň vopred),
--     e-mail personálu „Žiadosť lekára o CT", pripomienka e-mailom len pre
--     potvrdené žiadosti, mazanie údajov o kontraste spolu s dôvodom
--
-- Idempotentné. Spúšťať PO rucne-001.sql.
-- ============================================================

set local lock_timeout = '15s';

-- ------------------------------------------------------------
-- 0. predpoklady
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('staff_order_validate(text, text, text, date, text, date, time)') is null then
    raise exception 'CT-LEKARI-001: spustite najprv rucne-001.sql.';
  end if;
  if to_regprocedure('check_rate_limit(text, integer)') is null or to_regprocedure('client_ip()') is null
     or to_regprocedure('assert_attachments(text, jsonb)') is null or to_regprocedure('app_secret(text)') is null then
    raise exception 'CT-LEKARI-001: chýba check_rate_limit / client_ip / assert_attachments / app_secret (audit vlna 8).';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    raise exception 'CT-LEKARI-001: chýba rozšírenie pgcrypto.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. stĺpce
-- ------------------------------------------------------------
alter table ct_orders add column if not exists requested_by text not null default '';
alter table ct_orders add column if not exists clinical jsonb not null default '{}'::jsonb;
alter table ct_orders add column if not exists sms_reminder_sent_at timestamptz;

-- ------------------------------------------------------------
-- 2. spoločné heslo a prihlásenia lekárov
-- ------------------------------------------------------------
create table if not exists ct_doctor_auth (
  id int primary key default 1 check (id = 1),
  pw_hash text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
alter table ct_doctor_auth enable row level security;
revoke all on ct_doctor_auth from public, anon, authenticated;

create table if not exists ct_doctor_sessions (
  token uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text not null default ''
);
alter table ct_doctor_sessions enable row level security;
revoke all on ct_doctor_sessions from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. RPC
-- ------------------------------------------------------------
-- prihlásenie spoločným heslom → token na 12 h. Nesprávne heslo vráti {ok:false}
-- (nevyhodí chybu), aby sa počítadlo pokusov z IP nezrušilo rollbackom.
create or replace function ct_doctor_login(p_password text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_ip text := client_ip(); v_token uuid; v_exp timestamptz := now() + interval '12 hours';
begin
  perform check_rate_limit('ct-doc-login:' || coalesce(nullif(v_ip, ''), 'bez-ip'), 10);
  select pw_hash into v_hash from ct_doctor_auth where id = 1;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'Prístup pre lekárov ešte nie je nastavený — kontaktujte CT pracovisko.');
  end if;
  if p_password is null or length(p_password) > 200 or crypt(p_password, v_hash) <> v_hash then
    return jsonb_build_object('ok', false, 'error', 'Nesprávne heslo.');
  end if;
  delete from ct_doctor_sessions where expires_at < now();
  insert into ct_doctor_sessions (expires_at, ip) values (v_exp, v_ip) returning token into v_token;
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_exp);
end $$;
revoke all on function ct_doctor_login(text) from public;
grant execute on function ct_doctor_login(text) to anon, authenticated;

create or replace function ct_doctor_require(p_token text)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_token is null or p_token !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or not exists (select 1 from ct_doctor_sessions where token = p_token::uuid and expires_at > now()) then
    raise exception 'Prihlásenie vypršalo — zadajte heslo znova.';
  end if;
end $$;
revoke all on function ct_doctor_require(text) from public, anon, authenticated;

-- žiadosť lekára o CT termín (stav „nová", potvrdí CT pracovisko)
create or replace function ct_doctor_create_order(
  p_token text, p_id text, p_requested_by text, p_exam_type_id text,
  p_patient_name text, p_birth_date date, p_insurance text, p_phone text, p_email text,
  p_indication text, p_clinical jsonb, p_slot_date date, p_slot_time time,
  p_attachments jsonb, p_notify boolean)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item ct_pricelist%rowtype; v_dur int; v_doctor text; v_cell_doctor text; n int; v_cell time;
  v_ip text := client_ip();
  v_c jsonb := coalesce(p_clinical, '{}'::jsonb);
  v_clean jsonb;
  v_notify boolean := coalesce(p_notify, true);
begin
  perform ct_doctor_require(p_token);
  if v_ip <> '' then perform check_rate_limit('ct-doc-create:' || v_ip, 30); end if;
  if p_id !~ '^CT-[A-Z0-9-]{4,40}$' then raise exception 'Neplatné číslo objednávky.'; end if;
  if length(btrim(coalesce(p_requested_by, ''))) not between 3 and 200 then
    raise exception 'Zadajte meno objednávajúceho lekára a kontakt (klapku).';
  end if;
  perform staff_order_validate(p_patient_name, p_phone, p_email, p_birth_date, p_indication, p_slot_date, p_slot_time);
  if length(btrim(coalesce(p_indication, ''))) < 5 then raise exception 'Napíšte klinickú otázku / indikáciu k CT.'; end if;

  -- kontrastná látka
  if jsonb_typeof(v_c) <> 'object' or length(v_c::text) > 1000 or jsonb_typeof(v_c -> 'contrast') is distinct from 'boolean' then
    raise exception 'Uveďte, či sa má podať kontrastná látka.';
  end if;
  v_clean := jsonb_build_object('contrast', (v_c ->> 'contrast')::boolean);
  if (v_c ->> 'contrast')::boolean then
    if coalesce(nullif(v_c ->> 'creatinine', '')::numeric, 0) <= 0 and coalesce(nullif(v_c ->> 'egfr', '')::numeric, 0) <= 0 then
      raise exception 'Pri kontrastnej látke uveďte kreatinín alebo eGFR.';
    end if;
    if nullif(v_c ->> 'labDate', '') is null or (v_c ->> 'labDate')::date > current_date or (v_c ->> 'labDate')::date < current_date - 365 then
      raise exception 'Uveďte dátum odberu kreatinínu / eGFR (najviac rok dozadu).';
    end if;
    if coalesce(v_c ->> 'allergy', '') not in ('nie', 'ano', 'nevie') then
      raise exception 'Uveďte, či má pacient alergiu na jódovú kontrastnú látku.';
    end if;
    if jsonb_typeof(v_c -> 'metformin') is distinct from 'boolean' then
      raise exception 'Uveďte, či pacient užíva metformín.';
    end if;
    v_clean := v_clean || jsonb_strip_nulls(jsonb_build_object(
      'creatinine', nullif(v_c ->> 'creatinine', '')::numeric, 'egfr', nullif(v_c ->> 'egfr', '')::numeric,
      'labDate', v_c ->> 'labDate', 'allergy', v_c ->> 'allergy', 'metformin', (v_c ->> 'metformin')::boolean));
  end if;

  -- žiadanka (príloha) povinná
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) not between 1 and 3 then
    raise exception 'Priložte žiadanku (1 až 3 súbory).';
  end if;
  perform assert_attachments(p_id, p_attachments);

  select * into v_item from ct_pricelist where id = p_exam_type_id and active = true;
  if not found then raise exception 'Vybrané CT vyšetrenie nie je dostupné.'; end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;
  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from ct_open_slots s where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  insert into ct_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance, phone, email, reason,
    slot_date, slot_time, doctor, duration_min, attachments, status, requested_by, clinical, notify_patient,
    reminder_sent_at, sms_reminder_sent_at)
  values (p_id, v_item.id, v_item.label, btrim(p_patient_name), p_birth_date, coalesce(p_insurance, ''),
    btrim(p_phone), coalesce(btrim(p_email), ''), btrim(p_indication),
    p_slot_date, p_slot_time, coalesce(v_doctor, ''), v_dur, p_attachments, 'new', btrim(p_requested_by), v_clean, v_notify,
    case when v_notify then null else now() end, case when v_notify then null else now() end);
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
revoke all on function ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean) from public;
grant execute on function ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean) to anon, authenticated;

-- prehľad CT objednávok pre prihlásených lekárov (od 7 dní dozadu; bez kontaktov a príloh)
create or replace function ct_doctor_list(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform ct_doctor_require(p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'date', o.slot_date, 'time', to_char(o.slot_time, 'HH24:MI'), 'durationMin', o.duration_min,
      'exam', o.exam_label, 'patient', o.patient_name, 'birthYear', extract(year from o.birth_date)::int,
      'status', o.status, 'note', o.status_note, 'requestedBy', o.requested_by) order by o.slot_date, o.slot_time)
    from ct_orders o where o.slot_date >= current_date - 7), '[]'::jsonb);
end $$;
revoke all on function ct_doctor_list(text) from public;
grant execute on function ct_doctor_list(text) to anon, authenticated;

-- nastavenie spoločného hesla (len superadmin); zmena odhlási všetkých lekárov
create or replace function ct_set_doctor_password(p_password text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if my_role() <> 'superadmin' or not mfa_ok() then raise exception 'Heslo pre lekárov môže meniť len superadmin.'; end if;
  if length(coalesce(p_password, '')) not between 8 and 100 then raise exception 'Heslo musí mať 8 až 100 znakov.'; end if;
  insert into ct_doctor_auth (id, pw_hash, updated_at, updated_by)
  values (1, crypt(p_password, gen_salt('bf')), now(), staff_display_name())
  on conflict (id) do update set pw_hash = excluded.pw_hash, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  -- odhlásiť všetkých lekárov (Supabase nepustí DELETE bez WHERE)
  delete from ct_doctor_sessions where token is not null;
end $$;
revoke all on function ct_set_doctor_password(text) from public, anon;
grant execute on function ct_set_doctor_password(text) to authenticated;

create or replace function ct_doctor_password_info()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r ct_doctor_auth%rowtype;
begin
  if my_role() not in ('superadmin', 'sestra') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  select * into r from ct_doctor_auth where id = 1;
  return jsonb_build_object('set', found, 'updatedAt', r.updated_at, 'updatedBy', r.updated_by,
    'activeSessions', (select count(*) from ct_doctor_sessions where expires_at > now()));
end $$;
revoke all on function ct_doctor_password_info() from public, anon;
grant execute on function ct_doctor_password_info() to authenticated;

-- ------------------------------------------------------------
-- 4. notifikácie
-- ------------------------------------------------------------
create or replace function pg_temp.ctl_patch(p_fn text, p_pattern text, p_repl text, p_marker text)
returns void language plpgsql as $f$
declare r record; v_def text; v_new text; n int := 0;
begin
  for r in select p.oid, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = p_fn loop
    n := n + 1;
    if strpos(r.prosrc, p_marker) > 0 then continue; end if;
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, p_pattern, p_repl);
    if v_new = v_def then
      raise exception 'CT-LEKARI-001: vo funkcii % sa nenašlo miesto na úpravu (%).', p_fn, p_marker;
    end if;
    execute v_new;
  end loop;
  if n = 0 then raise exception 'CT-LEKARI-001: funkcia % neexistuje.', p_fn; end if;
end $f$;

do $$
begin
  -- e-mail pacientovi: pri žiadosti lekára nič, kým ju CT pracovisko nepotvrdí
  -- (ani pri presune či zamietnutí nepotvrdenej žiadosti — pacient o nej ešte nevie)
  perform pg_temp.ctl_patch('ct_notify_trigger', E'(\\nbegin[ \\t]*\\r?\\n)',
    E'\\1  -- ct-lekari-001:ziadost (žiadosť lekára — pacientovi až po potvrdení)\n  if coalesce(NEW.requested_by, '''') <> '''' and (NEW.status = ''new'' or (TG_OP = ''UPDATE'' and OLD.status = ''new'' and NEW.status = ''rejected'')) then return NEW; end if;\n',
    'ct-lekari-001:ziadost');
  -- e-mail personálu: predmet a úvod pre žiadosť lekára
  perform pg_temp.ctl_patch('clinic_notify_staff',
    'v_subj := ''Nová objednávka — '' \|\|',
    'v_subj := case when coalesce(j ->> ''requested_by'', '''') <> '''' then ''Žiadosť lekára o termín — '' else ''Nová objednávka — '' end ||',
    'Žiadosť lekára o termín');
  perform pg_temp.ctl_patch('clinic_notify_staff',
    'v_lead := ''Pacient sa objednal online\.'';',
    'v_lead := case when coalesce(j ->> ''requested_by'', '''') <> '''' then ''Lekár '' || html_escape(j ->> ''requested_by'') || '' žiada o termín. Žiadosť potvrďte, presuňte alebo zrušte v správe CT.'' else ''Pacient sa objednal online.'' end;',
    'žiada o termín. Žiadosť potvrďte');
  -- pripomienka e-mailom: nepotvrdená žiadosť lekára ju nedostane
  perform pg_temp.ctl_patch('send_ct_reminders',
    'and status in \(''new'', ''confirmed''\)',
    'and (status = ''confirmed'' or (status = ''new'' and coalesce(requested_by, '''') = ''''))',
    'coalesce(requested_by, '''') = ''''');
  -- mazanie údajov o kontraste spolu so žiadankou a dôvodom
  perform pg_temp.ctl_patch('ct_purge_orders',
    'where \(attachments <> ''\[\]''::jsonb or reason <> ''''\)',
    'where (attachments <> ''[]''::jsonb or reason <> '''' or clinical <> ''{}''::jsonb)',
    'or clinical <> ''{}''::jsonb');
  perform pg_temp.ctl_patch('ct_purge_orders',
    'set attachments = ''\[\]''::jsonb, reason = '''' where',
    'set attachments = ''[]''::jsonb, reason = '''', clinical = ''{}''::jsonb where',
    'reason = '''', clinical = ''{}''::jsonb');
end $$;

-- SMS pacientovi pre CT (doteraz len e-mail): potvrdenie, zrušenie, presun
create or replace function ct_notify_sms()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_app_id    text := app_secret('bulkgate_app_id');
  v_app_token text := app_secret('bulkgate_app_token');
  v_number    text;
  v_termin    text;
  v_text      text := '';
begin
  if NEW.notify_patient is false or v_app_id like 'SEM\_%' or v_app_token like 'SEM\_%' then return NEW; end if;
  v_number := sms_number(NEW.phone);
  if length(v_number) < 11 then return NEW; end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  if TG_OP = 'INSERT' then
    if NEW.status = 'confirmed' then
      v_text := 'NUSCH: Termin CT vysetrenia ' || v_termin || '. Pridte 15 min vopred, Pod Krasnou horkou 1, Bratislava.';
    end if;
  elsif OLD.status = 'new' and NEW.status = 'confirmed' then
    v_text := 'NUSCH: Termin CT vysetrenia ' || v_termin || ' je potvrdeny. Pridte 15 min vopred, Pod Krasnou horkou 1, Bratislava.';
  elsif NEW.status = 'rejected' and OLD.status <> 'rejected'
        and (OLD.status = 'confirmed' or coalesce(NEW.requested_by, '') = '') then
    v_text := 'NUSCH: Termin CT vysetrenia ' || v_termin || ' bol zruseny. O dalsom postupe vas bude informovat vas lekar.';
  elsif NEW.status = 'confirmed' and (OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time) then
    v_text := 'NUSCH: Zmena terminu CT vysetrenia. Novy termin: ' || v_termin || '.';
  end if;
  if v_text <> '' then
    perform net.http_post(
      url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'application_id', v_app_id, 'application_token', v_app_token,
        'number', v_number, 'text', v_text, 'unicode', false,
        'sender_id', 'gText', 'sender_id_value', 'NUSCH'));
  end if;
  return NEW;
exception when others then
  return coalesce(NEW, OLD);
end $$;
revoke all on function ct_notify_sms() from public, anon, authenticated;
drop trigger if exists ct_orders_sms_notify on ct_orders;
create trigger ct_orders_sms_notify after insert or update on ct_orders
  for each row execute function ct_notify_sms();

-- SMS pripomienka deň vopred (len potvrdené, len so zapnutými notifikáciami)
create or replace function send_ct_sms_reminders()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_app_id    text := app_secret('bulkgate_app_id');
  v_app_token text := app_secret('bulkgate_app_token');
  r record; v_number text; v_cnt int := 0;
begin
  if v_app_id like 'SEM\_%' or v_app_token like 'SEM\_%' then return 0; end if;
  for r in select * from ct_orders
    where slot_date = current_date + 1 and status = 'confirmed' and notify_patient and sms_reminder_sent_at is null loop
    v_number := sms_number(r.phone);
    if length(v_number) >= 11 then
      begin
        perform net.http_post(
          url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'application_id', v_app_id, 'application_token', v_app_token, 'number', v_number,
            'text', 'NUSCH: Pripomienka - zajtra ' || to_char(r.slot_time, 'HH24:MI')
              || ' CT vysetrenie, Pod Krasnou horkou 1, Bratislava. Pridte 15 min vopred.',
            'unicode', false, 'sender_id', 'gText', 'sender_id_value', 'NUSCH'));
        v_cnt := v_cnt + 1;
      exception when others then null;
      end;
    end if;
    update ct_orders set sms_reminder_sent_at = now() where id = r.id;
  end loop;
  return v_cnt;
end $$;
revoke all on function send_ct_sms_reminders() from public, anon, authenticated;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'CT-LEKARI-001: pg_cron nie je (lokálny stub) — plán ct-sms-reminders preskočený.';
    return;
  end if;
  if not exists (select 1 from cron.job where jobname = 'ct-sms-reminders') then
    perform cron.schedule('ct-sms-reminders', '0 15 * * *', 'select send_ct_sms_reminders()');
  end if;
end $$;

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
declare n int; f text;
begin
  select count(*) into n from information_schema.columns where table_schema = 'public' and table_name = 'ct_orders'
    and column_name in ('requested_by', 'clinical', 'sms_reminder_sent_at');
  if n <> 3 then raise exception 'CT-LEKARI-001: chýbajú stĺpce ct_orders (%/3).', n; end if;
  if not exists (select 1 from pg_proc where proname = 'ct_notify_trigger' and prosrc like '%ct-lekari-001:ziadost%') then
    raise exception 'CT-LEKARI-001: ct_notify_trigger bez úpravy pre žiadosti lekárov.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'ct_orders_sms_notify') then
    raise exception 'CT-LEKARI-001: chýba trigger ct_orders_sms_notify.';
  end if;
  foreach f in array array['ct_doctor_login(text)', 'ct_doctor_list(text)',
    'ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception 'CT-LEKARI-001: anon nemá EXECUTE na %.', f; end if;
  end loop;
  foreach f in array array['ct_set_doctor_password(text)', 'ct_doctor_password_info()', 'ct_doctor_require(text)', 'send_ct_sms_reminders()'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception 'CT-LEKARI-001: anon má EXECUTE na %.', f; end if;
  end loop;
  if has_table_privilege('anon', 'ct_doctor_auth', 'select') or has_table_privilege('authenticated', 'ct_doctor_sessions', 'select') then
    raise exception 'CT-LEKARI-001: tabuľky hesla / prihlásení sú prístupné cez API.';
  end if;
  raise notice 'CT-LEKARI-001 OK.';
end $$;
