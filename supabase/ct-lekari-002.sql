-- ============================================================
-- CT-LEKARI-002 — kontrast: „pacient prinesie čerstvý kreatinín"
--
-- Pri CT s kontrastnou látkou môže lekár namiesto kreatinínu / eGFR
-- s dátumom odberu označiť, že pacient prinesie čerstvý výsledok na
-- vyšetrenie (napr. žiadanka nemá kreatinín alebo je starší ako rok).
-- CT pracovisko to vidí v karte; pacientovi sa v SMS pri potvrdení
-- a v pripomienke deň vopred pripomenie priniesť výsledok kreatinínu.
--
-- Idempotentné. Spúšťať PO ct-lekari-001.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('ct_doctor_require(text)') is null then
    raise exception 'CT-LEKARI-002: spustite najprv ct-lekari-001.sql.';
  end if;
end $$;

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
  v_later boolean := false;
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
    -- ct-lekari-002: bez čerstvého výsledku môže lekár označiť, že ho pacient prinesie na vyšetrenie
    v_later := coalesce(v_c ->> 'labLater', '') = 'true';
    if not v_later then
      if coalesce(nullif(v_c ->> 'creatinine', '')::numeric, 0) <= 0 and coalesce(nullif(v_c ->> 'egfr', '')::numeric, 0) <= 0 then
        raise exception 'Pri kontrastnej látke uveďte kreatinín alebo eGFR, alebo označte, že pacient prinesie čerstvý výsledok.';
      end if;
      if nullif(v_c ->> 'labDate', '') is null or (v_c ->> 'labDate')::date > current_date or (v_c ->> 'labDate')::date < current_date - 365 then
        raise exception 'Uveďte dátum odberu kreatinínu / eGFR (najviac rok dozadu), alebo označte, že pacient prinesie čerstvý výsledok.';
      end if;
    end if;
    if coalesce(v_c ->> 'allergy', '') not in ('nie', 'ano', 'nevie') then
      raise exception 'Uveďte, či má pacient alergiu na jódovú kontrastnú látku.';
    end if;
    if jsonb_typeof(v_c -> 'metformin') is distinct from 'boolean' then
      raise exception 'Uveďte, či pacient užíva metformín.';
    end if;
    v_clean := v_clean || case when v_later
      then jsonb_build_object('labLater', true, 'allergy', v_c ->> 'allergy', 'metformin', (v_c ->> 'metformin')::boolean)
      else jsonb_strip_nulls(jsonb_build_object(
        'creatinine', nullif(v_c ->> 'creatinine', '')::numeric, 'egfr', nullif(v_c ->> 'egfr', '')::numeric,
        'labDate', v_c ->> 'labDate', 'allergy', v_c ->> 'allergy', 'metformin', (v_c ->> 'metformin')::boolean)) end;
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
    v_text := 'NUSCH: Termin CT vysetrenia ' || v_termin || ' je potvrdeny. Pridte 15 min vopred, Pod Krasnou horkou 1, Bratislava.'
      || case when coalesce(NEW.clinical ->> 'labLater', '') = 'true' then ' Prineste aktualny vysledok kreatininu.' else '' end;
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
              || ' CT vysetrenie, Pod Krasnou horkou 1, Bratislava. Pridte 15 min vopred.'
              || case when coalesce(r.clinical ->> 'labLater', '') = 'true' then ' Prineste aktualny vysledok kreatininu.' else '' end,
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


-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'ct_doctor_create_order' and prosrc like '%labLater%') then
    raise exception 'CT-LEKARI-002: ct_doctor_create_order bez voľby čerstvého kreatinínu.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'ct_notify_sms' and prosrc like '%kreatininu%') then
    raise exception 'CT-LEKARI-002: ct_notify_sms bez pripomenutia kreatinínu.';
  end if;
  if not has_function_privilege('anon', 'ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean)', 'execute') then
    raise exception 'CT-LEKARI-002: anon nemá EXECUTE na ct_doctor_create_order.';
  end if;
  raise notice 'CT-LEKARI-002 OK.';
end $$;
