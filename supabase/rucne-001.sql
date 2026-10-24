-- ============================================================
-- RUCNE-001 — personál pridá pacienta ručne (USG, angio, CT)
--
-- Lekár, sestra aj superadmin môžu v správe ktorejkoľvek ambulancie
-- objednať pacienta (napr. na kontrolu) bez SMS overenia telefónu,
-- bez povinnej žiadanky, aj na dnes a aj mimo otvorených termínov.
-- Prekrytie s iným pacientom nepustí existujúce vylučovacie obmedzenie
-- tabuľky (EXCLUDE … slot_date, interval trvania).
--
--  1  stĺpce created_by (kto objednávku zadal; prázdne = pacient online)
--     a notify_patient (false = pacient nedostane žiadnu SMS ani e-mail,
--     ani pripomienku deň vopred)
--  2  úprava existujúcich funkcií v mieste:
--     - notifikácie pacientovi (USG e-mail + SMS, angio e-mail + SMS,
--       CT e-mail) rešpektujú notify_patient
--     - e-mail personálu „Nová objednávka" sa pri ručne zadanej neposiela
--     - povinná žiadanka (USG so žiadankou, angio, CT) neplatí pre ručne zadané
--     - USG pripomienka nežiada platbu pri objednávke bez platby (cena 0)
--  3  RPC usg_staff_create_order, angio_staff_create_order,
--     ct_staff_create_order (SECURITY DEFINER; superadmin, sestra, lekár; MFA)
--     USG: platba „free" (kontrola, cena 0, hneď potvrdená) alebo podľa
--     cenníka „referral" / „self" (čaká na platbu ako online objednávka)
--
-- Idempotentné. Spúšťať PO angio-015.sql a boti-001.sql.
-- ============================================================

set local lock_timeout = '15s';

-- ------------------------------------------------------------
-- 0. predpoklady
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('my_role()') is null or to_regprocedure('my_doctor()') is null or to_regprocedure('mfa_ok()') is null then
    raise exception 'RUCNE-001: chýba my_role/my_doctor/mfa_ok — spustite najprv audit-vlna8-001.sql.';
  end if;
  if to_regclass('public.orders') is null or to_regclass('public.angio_orders') is null or to_regclass('public.ct_orders') is null then
    raise exception 'RUCNE-001: chýba niektorá z tabuliek orders / angio_orders / ct_orders.';
  end if;
  if to_regclass('public.vs_seq') is null then
    raise exception 'RUCNE-001: chýba sekvencia vs_seq (variabilné symboly USG).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. stĺpce
-- ------------------------------------------------------------
alter table orders       add column if not exists created_by text not null default '';
alter table orders       add column if not exists notify_patient boolean not null default true;
alter table angio_orders add column if not exists created_by text not null default '';
alter table angio_orders add column if not exists notify_patient boolean not null default true;
alter table ct_orders    add column if not exists created_by text not null default '';
alter table ct_orders    add column if not exists notify_patient boolean not null default true;

-- ------------------------------------------------------------
-- 2. úprava existujúcich funkcií v mieste
-- ------------------------------------------------------------
-- pomocná funkcia len pre tento skript (dočasná schéma, po odpojení zmizne);
-- ak sa vzor nenájde, skript skončí chybou a nič sa nezmení
create or replace function pg_temp.rucne_patch(p_fn text, p_pattern text, p_repl text, p_marker text)
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
      raise exception 'RUCNE-001: vo funkcii % sa nenašlo miesto na úpravu (%).', p_fn, p_marker;
    end if;
    execute v_new;
  end loop;
  if n = 0 then raise exception 'RUCNE-001: funkcia % neexistuje.', p_fn; end if;
end $f$;

do $$
declare
  -- vloží sa hneď za úvodné „begin" tela funkcie
  -- (pozor: v E'' reťazci je \\1 spätný odkaz a \n skutočný nový riadok)
  c_begin   constant text := E'(\\nbegin[ \\t]*\\r?\\n)';
  c_notify  constant text := E'\\1  -- rucne-001:notify (pacient si neželá SMS ani e-maily)\n  if NEW.notify_patient is false then return NEW; end if;\n';
  c_freeusg constant text := E'\\1  -- rucne-001:free (ručne zadaná bez platby: potvrdenie posiela usg_staff_create_order)\n  if TG_OP = ''INSERT'' and coalesce(NEW.created_by, '''') <> '''' and coalesce(NEW.price, 0) = 0 then return NEW; end if;\n';
  c_staff   constant text := E'\\1  -- rucne-001:staff (objednávku zadal personál — e-mail personálu netreba)\n  if TG_OP = ''INSERT'' and coalesce(NEW.created_by, '''') <> '''' then return NEW; end if;\n';
  c_ziad    constant text := E'\\1  -- rucne-001:ziadanka (ručne zadaná personálom — žiadanka nie je povinná)\n  if coalesce(NEW.created_by, '''') <> '''' then return NEW; end if;\n';
  f text;
begin
  foreach f in array array['notify_order_emails', 'notify_order_sms', 'angio_notify_trigger', 'angio_notify_sms', 'ct_notify_trigger'] loop
    perform pg_temp.rucne_patch(f, c_begin, c_notify, 'rucne-001:notify');
  end loop;
  perform pg_temp.rucne_patch('notify_order_emails', c_begin, c_freeusg, 'rucne-001:free');
  perform pg_temp.rucne_patch('notify_order_emails',
    'if v_notify is not null and v_notify <> '''' then',
    'if v_notify is not null and v_notify <> '''' and coalesce(NEW.created_by, '''') = '''' then',
    'and coalesce(NEW.created_by, '''') = '''' then');
  perform pg_temp.rucne_patch('clinic_notify_staff', c_begin, c_staff, 'rucne-001:staff');
  foreach f in array array['orders_require_referral_attachment', 'angio_require_attachment', 'ct_require_attachment'] loop
    perform pg_temp.rucne_patch(f, c_begin, c_ziad, 'rucne-001:ziadanka');
  end loop;
  perform pg_temp.rucne_patch('send_reminders', 'if not r.paid then',
    'if not r.paid and coalesce(r.price, 0) > 0 then', 'if not r.paid and coalesce(r.price, 0) > 0 then');
  perform pg_temp.rucne_patch('send_reminders', 'case when not r.paid then',
    'case when not r.paid and coalesce(r.price, 0) > 0 then', 'case when not r.paid and coalesce(r.price, 0) > 0 then');
end $$;

-- ------------------------------------------------------------
-- 3. pomocné funkcie a RPC
-- ------------------------------------------------------------
-- kto objednávku zadal (meno lekára, inak e-mail konta)
create or replace function staff_display_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(my_doctor(), ''), (select u.email::text from auth.users u where u.id = auth.uid()), 'personál')
$$;
revoke all on function staff_display_name() from public, anon, authenticated;

create or replace function staff_order_validate(p_name text, p_phone text, p_email text, p_birth date,
  p_reason text, p_date date, p_time time)
returns void language plpgsql set search_path = public as $$
declare v_today date := (now() at time zone 'Europe/Bratislava')::date;
begin
  if length(btrim(coalesce(p_name, ''))) not between 3 and 200 then
    raise exception 'Zadajte meno a priezvisko pacienta.';
  end if;
  if p_birth is null then raise exception 'Zadajte dátum narodenia pacienta.'; end if;
  if p_birth > current_date or p_birth < date '1900-01-01' then raise exception 'Zadajte platný dátum narodenia.'; end if;
  if length(coalesce(p_phone, '')) > 30 or length(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9)) < 9 then
    raise exception 'Zadajte platné telefónne číslo pacienta.';
  end if;
  if coalesce(btrim(p_email), '') <> '' and (length(p_email) > 254 or btrim(p_email) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'E-mail nie je platný — opravte ho alebo nechajte pole prázdne.';
  end if;
  if length(coalesce(p_reason, '')) > 2000 then raise exception 'Poznámka je príliš dlhá (najviac 2000 znakov).'; end if;
  if p_date is null or p_time is null then raise exception 'Vyberte dátum a čas.'; end if;
  if p_date < v_today then raise exception 'Dátum je v minulosti.'; end if;
  if p_date > v_today + 730 then raise exception 'Termín môže byť najviac 2 roky dopredu.'; end if;
  if (extract(minute from p_time)::int % 5) <> 0 or extract(second from p_time) <> 0 then
    raise exception 'Čas zadajte po 5 minútach (napr. 9:05).';
  end if;
end $$;
revoke all on function staff_order_validate(text, text, text, date, text, date, time) from public, anon, authenticated;

-- potvrdenie pacientovi pri USG bez platby (kontrola) — „čaká na platbu" by bolo zavádzajúce
create or replace function usg_staff_booking_email(p_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  v_key text := app_secret('resend_api_key');
  v_from text; v_termin text; v_instr text; v_ambul text; v_html text;
  row_fn constant text := '<tr><td style="color:#64748b;padding:4px 12px 4px 0">%s</td><td>%s</td></tr>';
begin
  select * into o from orders where id = p_id;
  if not found or coalesce(o.email, '') = '' or v_key like 'SEM\_%' then return; end if;
  select value into v_from from settings where key = 'mail_from';
  if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  v_termin := to_char(o.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(o.slot_time, 'HH24:MI');
  v_ambul := coalesce(doctor_location(o.doctor), '');
  select coalesce(p.instructions, '') into v_instr from pricelist p where p.id = o.exam_type_id;
  v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
    || email_header()
    || '<h2 style="color:#003d7c">Termín USG vyšetrenia</h2>'
    || '<p>Naše pracovisko vám naplánovalo termín vyšetrenia. Vyšetrenie je bez poplatku.</p>'
    || '<table style="font-size:14px;border-collapse:collapse">'
    || format(row_fn, 'Vyšetrenie', '<b>' || html_escape(o.exam_label) || '</b>')
    || format(row_fn, 'Termín', '<b>' || v_termin || '</b>')
    || case when coalesce(o.doctor, '') <> '' then format(row_fn, 'Lekár', html_escape(o.doctor)) else '' end
    || case when v_ambul <> '' then format(row_fn, 'Miesto', '<b>' || html_escape(v_ambul) || '</b>') else '' end
    || format(row_fn, 'Číslo objednávky', html_escape(o.id))
    || '</table>'
    || '<p style="font-size:13px">Príďte prosím <b>15 minút pred termínom</b>. Pod Krásnou hôrkou 1, Bratislava.</p>'
    || case when coalesce(v_instr, '') <> '' then
         '<div style="background:#eff6ff;border-left:4px solid #005ca9;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:12px"><b style="color:#003d7c">Pokyny k vyšetreniu</b><br>'
         || replace(html_escape(v_instr), chr(10), '<br>') || '</div>'
       else '' end
    || email_footer(o.id)
    || '</div>';
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(o.email),
      'subject', 'Termín USG vyšetrenia — ' || v_termin, 'html', v_html));
exception when others then
  null; -- e-mail nesmie zablokovať objednávku
end $$;
revoke all on function usg_staff_booking_email(text) from public, anon, authenticated;

-- USG
create or replace function usg_staff_create_order(
  p_exam_type_id text, p_payment text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time, p_doctor text, p_notify boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_item pricelist%rowtype; v_price numeric; v_ref boolean; v_dur int; v_doctor text; v_id text; v_vs text;
  v_notify boolean := coalesce(p_notify, true);
begin
  if my_role() not in ('superadmin', 'sestra', 'lekar') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  perform staff_order_validate(p_patient_name, p_phone, p_email, p_birth_date, p_reason, p_slot_date, p_slot_time);
  select * into v_item from pricelist where id = p_exam_type_id;
  if not found then raise exception 'Vyberte vyšetrenie.'; end if;
  if p_payment = 'free' then v_price := 0; v_ref := false;
  elsif p_payment = 'referral' then
    if v_item.price_referral is null then raise exception 'Toto vyšetrenie je len pre samoplatcov (bez žiadanky).'; end if;
    v_price := v_item.price_referral; v_ref := true;
  elsif p_payment = 'self' then v_price := v_item.price_self; v_ref := false;
  else raise exception 'Vyberte spôsob platby.';
  end if;
  v_price := coalesce(v_price, 0);
  if v_price > 0 and v_notify and coalesce(btrim(p_email), '') = '' then
    raise exception 'Pri platenom vyšetrení zadajte e-mail pacienta — pošleme naň platobné údaje. Alebo zvoľte „Bez platby".';
  end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 2), 2) * 5;
  v_doctor := coalesce(nullif(btrim(coalesce(p_doctor, '')), ''),
    (select s.doctor from open_slots s where s.slot_date = p_slot_date and s.slot_time = p_slot_time),
    case when my_role() = 'lekar' then my_doctor() end, '');
  v_vs := case when v_price > 0 then nextval('vs_seq')::text else '' end;
  v_id := 'USG-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
  insert into orders (id, has_referral, exam_type_id, exam_label, price, reason, referrer_name, referrer_facility,
    patient_name, birth_date, insurance, phone, email, slot_date, slot_time, variable_symbol, doctor, attachments,
    duration_min, status, created_by, notify_patient, reminder_sent_at)
  values (v_id, v_ref, v_item.id, v_item.label, v_price, coalesce(p_reason, ''), '', '',
    btrim(p_patient_name), p_birth_date, coalesce(p_insurance, ''), btrim(p_phone), coalesce(btrim(p_email), ''),
    p_slot_date, p_slot_time, v_vs, v_doctor, '[]'::jsonb,
    v_dur, case when v_price > 0 then 'new' else 'confirmed' end, staff_display_name(), v_notify,
    case when v_notify then null else now() end);
  if v_notify and v_price = 0 then perform usg_staff_booking_email(v_id); end if;
  return jsonb_build_object('id', v_id, 'variable_symbol', v_vs, 'price', v_price);
exception
  when exclusion_violation then
    raise exception 'V tomto čase je už objednaný iný pacient. Vyberte iný čas.';
end $$;
revoke all on function usg_staff_create_order(text, text, text, date, text, text, text, text, date, time, text, boolean) from public, anon;
grant execute on function usg_staff_create_order(text, text, text, date, text, text, text, text, date, time, text, boolean) to authenticated;

-- angiologická ambulancia
create or replace function angio_staff_create_order(
  p_exam_type_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time, p_doctor text, p_notify boolean)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item angio_pricelist%rowtype; v_dur int; v_doctor text; v_id text;
  v_notify boolean := coalesce(p_notify, true);
begin
  if my_role() not in ('superadmin', 'sestra', 'lekar') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  perform staff_order_validate(p_patient_name, p_phone, p_email, p_birth_date, p_reason, p_slot_date, p_slot_time);
  select * into v_item from angio_pricelist where id = p_exam_type_id;
  if not found then raise exception 'Vyberte vyšetrenie.'; end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;
  v_doctor := coalesce(nullif(btrim(coalesce(p_doctor, '')), ''),
    (select s.doctor from angio_open_slots s where s.slot_date = p_slot_date and s.slot_time = p_slot_time),
    case when my_role() = 'lekar' then my_doctor() end, '');
  v_id := 'ANG-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
  insert into angio_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance, phone, email, reason,
    slot_date, slot_time, doctor, duration_min, attachments, status, created_by, notify_patient,
    reminder_sent_at, sms_reminder_sent_at)
  values (v_id, v_item.id, v_item.label, btrim(p_patient_name), p_birth_date, coalesce(p_insurance, ''),
    btrim(p_phone), coalesce(btrim(p_email), ''), coalesce(p_reason, ''),
    p_slot_date, p_slot_time, v_doctor, v_dur, '[]'::jsonb, 'confirmed', staff_display_name(), v_notify,
    case when v_notify then null else now() end, case when v_notify then null else now() end);
  return v_id;
exception
  when exclusion_violation then
    raise exception 'V tomto čase je už objednaný iný pacient. Vyberte iný čas.';
end $$;
revoke all on function angio_staff_create_order(text, text, date, text, text, text, text, date, time, text, boolean) from public, anon;
grant execute on function angio_staff_create_order(text, text, date, text, text, text, text, date, time, text, boolean) to authenticated;

-- CT
create or replace function ct_staff_create_order(
  p_exam_type_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time, p_doctor text, p_notify boolean)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item ct_pricelist%rowtype; v_dur int; v_doctor text; v_id text;
  v_notify boolean := coalesce(p_notify, true);
begin
  if my_role() not in ('superadmin', 'sestra', 'lekar') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  perform staff_order_validate(p_patient_name, p_phone, p_email, p_birth_date, p_reason, p_slot_date, p_slot_time);
  select * into v_item from ct_pricelist where id = p_exam_type_id;
  if not found then raise exception 'Vyberte vyšetrenie.'; end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;
  v_doctor := coalesce(nullif(btrim(coalesce(p_doctor, '')), ''),
    (select s.doctor from ct_open_slots s where s.slot_date = p_slot_date and s.slot_time = p_slot_time),
    case when my_role() = 'lekar' then my_doctor() end, '');
  v_id := 'CT-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
  insert into ct_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance, phone, email, reason,
    slot_date, slot_time, doctor, duration_min, attachments, status, created_by, notify_patient, reminder_sent_at)
  values (v_id, v_item.id, v_item.label, btrim(p_patient_name), p_birth_date, coalesce(p_insurance, ''),
    btrim(p_phone), coalesce(btrim(p_email), ''), coalesce(p_reason, ''),
    p_slot_date, p_slot_time, v_doctor, v_dur, '[]'::jsonb, 'confirmed', staff_display_name(), v_notify,
    case when v_notify then null else now() end);
  return v_id;
exception
  when exclusion_violation then
    raise exception 'V tomto čase je už objednaný iný pacient. Vyberte iný čas.';
end $$;
revoke all on function ct_staff_create_order(text, text, date, text, text, text, text, date, time, text, boolean) from public, anon;
grant execute on function ct_staff_create_order(text, text, date, text, text, text, text, date, time, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
declare n int; f text;
begin
  select count(*) into n from information_schema.columns where table_schema = 'public'
    and table_name in ('orders', 'angio_orders', 'ct_orders') and column_name in ('created_by', 'notify_patient');
  if n <> 6 then raise exception 'RUCNE-001: chýbajú stĺpce created_by / notify_patient (%/6).', n; end if;
  foreach f in array array['notify_order_emails', 'notify_order_sms', 'angio_notify_trigger', 'angio_notify_sms', 'ct_notify_trigger'] loop
    if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = f and prosrc not like '%rucne-001:notify%') then
      raise exception 'RUCNE-001: % nerešpektuje notify_patient.', f;
    end if;
  end loop;
  foreach f in array array['orders_require_referral_attachment', 'angio_require_attachment', 'ct_require_attachment'] loop
    if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = f and prosrc not like '%rucne-001:ziadanka%') then
      raise exception 'RUCNE-001: % stále vyžaduje žiadanku aj pri ručne zadanej.', f;
    end if;
  end loop;
  if not exists (select 1 from pg_proc where proname = 'clinic_notify_staff' and prosrc like '%rucne-001:staff%') then
    raise exception 'RUCNE-001: clinic_notify_staff bez výnimky pre ručne zadané.';
  end if;
  foreach f in array array['usg_staff_create_order(text, text, text, date, text, text, text, text, date, time, text, boolean)',
                           'angio_staff_create_order(text, text, date, text, text, text, text, date, time, text, boolean)',
                           'ct_staff_create_order(text, text, date, text, text, text, text, date, time, text, boolean)'] loop
    if to_regprocedure(f) is null then raise exception 'RUCNE-001: chýba %.', f; end if;
    if has_function_privilege('anon', f, 'execute') then raise exception 'RUCNE-001: anon má EXECUTE na %.', f; end if;
  end loop;
  raise notice 'RUCNE-001 OK.';
end $$;
