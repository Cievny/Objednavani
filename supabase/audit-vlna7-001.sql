-- ============================================================
-- AUDIT VLNA 7 — bezpečnostné opravy po angio vetve (v76–v86)
--
--  A1  IP adresa pre limity sa brala z PRVÉHO prvku X-Forwarded-For,
--      ktorý si klient môže podstrčiť → všetky IP limity (objednávky,
--      OTP SMS, upload, check-in) sa dali obísť. client_ip() teraz
--      uprednostní cf-connecting-ip / x-real-ip (nastavuje ich brána),
--      X-Forwarded-For je až posledná možnosť.
--  A2  lookup_attempts: kľúč bez limitu dĺžky + upratovanie až po
--      90 dňoch → útočník vie tabuľku nafúknuť. Kľúč sa skracuje,
--      staré okná (15 min) sa mažú každú hodinu (cron).
--  A3  OTP SMS: chýbal globálny strop — z mnohých IP sa dali posielať
--      SMS na cudzie čísla vo veľkom (náklady). Pridaný strop 60 / 15 min
--      pre celé pracovisko (bežná prevádzka je rádovo jednotky).
--  A4  angio_lookup_order / angio_cancel_order / angio_patient_reschedule
--      mali len limit na telefón (útočník mení telefón) → pridaný IP limit.
--  A5  angio_create_order: e-mail a dátum narodenia sa overovali len
--      v prehliadači → serverová kontrola formátu e-mailu a rozumného
--      rozsahu dátumu (bez e-mailu neodídu notifikácie).
--  A6  Priradenie lekára k typu vyšetrenia (Nastavenia → lekár robí len
--      vybrané typy) sa kontrolovalo len v prehliadači → nová
--      angio_doctor_does_exam() sa overuje aj v angio_create_order
--      a angio_patient_reschedule.
--  A7  (frontend v87) spoločné pokyny a prepínač SMS overovania ukladá
--      do settings — politika povoľuje zápis len superadminovi; sestre
--      sa polia zobrazovali aktívne a uloženie padalo na RLS.
--  A8  (angio-004) verejný whitelist settings zjednotený s angio-005,
--      aby opačné poradie spustenia neodstránilo kľúč angio_sms_verify.
--
-- Bez kľúčov (angio_send_otp sa upraví v mieste, kľúče ostávajú).
-- Idempotentné. Spúšťať PO angio-001 … angio-007 (a oprava-* skriptoch).
-- ============================================================

-- ------------------------------------------------------------
-- A1. client_ip — dôveryhodné hlavičky brány
-- ------------------------------------------------------------
create or replace function client_ip()
returns text language plpgsql stable set search_path = public as $$
declare
  h    json;
  v_ip text := '';
begin
  begin
    h := (current_setting('request.headers', true))::json;
  exception when others then
    return '';
  end;
  if h is null then return ''; end if;
  v_ip := coalesce(nullif(btrim(h ->> 'cf-connecting-ip'), ''), nullif(btrim(h ->> 'x-real-ip'), ''), '');
  if v_ip = '' then
    -- núdzový režim (brána bez cf-connecting-ip / x-real-ip): pôvodné správanie
    v_ip := btrim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1));
  end if;
  -- len znaky IPv4/IPv6 od začiatku (zvyšok zahodiť), max 45 znakov
  return left(coalesce(substring(v_ip from '^[0-9A-Fa-f:.]+'), ''), 45);
end $$;

-- ------------------------------------------------------------
-- A2. check_rate_limit — skrátený kľúč + hodinové upratovanie
-- ------------------------------------------------------------
create or replace function check_rate_limit(p_key text, p_max int)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v   lookup_attempts%rowtype;
  k   text := left(coalesce(p_key, ''), 120);
begin
  select * into v from lookup_attempts where key = k for update;
  if not found then
    insert into lookup_attempts (key, attempts) values (k, 1)
    on conflict (key) do update set attempts = lookup_attempts.attempts + 1;
    return;
  end if;
  if v.window_start < now() - interval '15 minutes' then
    update lookup_attempts set window_start = now(), attempts = 1 where key = k;
    return;
  end if;
  if v.attempts >= p_max then
    raise exception 'Príliš veľa pokusov. Skúste to prosím o 15 minút.';
  end if;
  update lookup_attempts set attempts = attempts + 1 where key = k;
end $$;
revoke all on function check_rate_limit(text, int) from public, anon, authenticated;

create or replace function purge_rate_limits()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from lookup_attempts where window_start < now() - interval '1 hour';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function purge_rate_limits() from public, anon, authenticated;
do $$ begin perform cron.unschedule('rate-limit-cleanup'); exception when others then null; end $$;
do $$ begin perform cron.schedule('rate-limit-cleanup', '17 * * * *', $q$select purge_rate_limits()$q$); exception when others then null; end $$;

-- ------------------------------------------------------------
-- A3. OTP SMS — globálny strop (úprava v mieste, kľúče ostávajú)
-- ------------------------------------------------------------
do $mig$
declare v_body text;
begin
  select prosrc into v_body from pg_proc where proname = 'angio_send_otp' and pronamespace = 'public'::regnamespace;
  if v_body is null then
    raise notice 'angio_send_otp neexistuje (angio-005 nespustené) — A3 preskočené.';
  elsif position('otp-global' in v_body) > 0 then
    raise notice 'angio_send_otp už má globálny strop.';
  else
    v_body := replace(v_body,
      $o$perform check_rate_limit('otp-phone:' || v_number, 3);$o$,
      $n$perform check_rate_limit('otp-phone:' || v_number, 3);
  perform check_rate_limit('otp-global', 60);$n$);
    if position('otp-global' in v_body) = 0 then
      raise notice 'angio_send_otp má neočakávané telo — globálny strop nepridaný.';
    else
      execute format('create or replace function angio_send_otp(p_phone text) returns void language plpgsql security definer set search_path = public as %L', v_body);
      raise notice 'angio_send_otp — pridaný globálny strop 60 SMS / 15 min.';
    end if;
  end if;
end $mig$;

-- ------------------------------------------------------------
-- A6. lekár robí daný typ vyšetrenia (podľa settings.angio_doctors)
--     rovnaká logika ako doctorDoesExam v prehliadači: neznámy lekár
--     alebo bez obmedzenia → true
-- ------------------------------------------------------------
create or replace function angio_doctor_does_exam(p_doctor text, p_exam_type_id text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_json jsonb;
  d      jsonb;
begin
  if coalesce(p_doctor, '') = '' or coalesce(p_exam_type_id, '') = '' then return true; end if;
  begin
    select value::jsonb into v_json from settings where key = 'angio_doctors';
  exception when others then
    return true;
  end;
  if v_json is null or jsonb_typeof(v_json) <> 'array' then return true; end if;
  select x into d from jsonb_array_elements(v_json) x where x ->> 'name' = p_doctor limit 1;
  if d is null then return true; end if;
  if jsonb_typeof(d -> 'examTypeIds') <> 'array' or jsonb_array_length(d -> 'examTypeIds') = 0 then return true; end if;
  return d -> 'examTypeIds' ? p_exam_type_id;
end $$;
revoke all on function angio_doctor_does_exam(text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- A4. lookup / cancel — IP limit
-- ------------------------------------------------------------
create or replace function angio_lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb; v_ip text := client_ip();
begin
  if coalesce(p_id, '') !~ '^ANG-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then perform check_rate_limit('angiolookup-ip:' || v_ip, 30); end if;
  perform check_lookup_limit('angiolookup:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));
  select to_jsonb(x) into result from (
    select o.id, o.status, o.slot_date, o.slot_time, o.doctor, o.exam_label, o.exam_type_id, o.duration_min
    from angio_orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
  return result;
end $$;
revoke all on function angio_lookup_order(text, text) from public;
grant execute on function angio_lookup_order(text, text) to anon, authenticated;

create or replace function angio_cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int; v_ip text := client_ip();
begin
  if coalesce(p_id, '') !~ '^ANG-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then perform check_rate_limit('angiocancel-ip:' || v_ip, 30); end if;
  perform check_lookup_limit('angiocancel:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));
  update angio_orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;
revoke all on function angio_cancel_order(text, text) from public;
grant execute on function angio_cancel_order(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- A4 + A6. zmena termínu pacientom — IP limit + lekár robí typ
-- ------------------------------------------------------------
create or replace function angio_patient_reschedule(p_id text, p_phone text, p_slot_date date, p_slot_time time)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_order angio_orders%rowtype;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
  v_ip text := client_ip();
  v_phone9 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
begin
  if coalesce(p_id, '') !~ '^ANG-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;
  if v_ip <> '' then perform check_rate_limit('angioresched-ip:' || v_ip, 30); end if;
  perform check_lookup_limit('angioresched:' || v_phone9);

  select * into v_order from angio_orders o
  where upper(o.id) = upper(p_id)
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9
  for update;
  if not found then
    raise exception 'Objednávku sme nenašli. Skontrolujte číslo a telefón.';
  end if;
  if v_order.status not in ('new', 'confirmed') then
    raise exception 'Túto objednávku už nie je možné meniť.';
  end if;
  if (v_order.slot_date + v_order.slot_time) at time zone 'Europe/Bratislava' < now() + interval '24 hours' then
    raise exception 'Termín možno online zmeniť najneskôr 24 hodín vopred. Napíšte nám SMS na 0949 000 677 (uveďte číslo objednávky).';
  end if;
  if p_slot_date = v_order.slot_date and p_slot_time = v_order.slot_time then
    raise exception 'Vybrali ste rovnaký termín, aký už máte.';
  end if;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  for n in 0 .. (greatest(v_order.duration_min, 5) / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from angio_open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Vybraný čas nemá dosť otvorených termínov za sebou. Vyberte iný.';
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;
  if not angio_doctor_does_exam(v_doctor, v_order.exam_type_id) then
    raise exception 'Tento lekár dané vyšetrenie nerobí. Vyberte iný čas.';
  end if;

  update angio_orders set
    slot_date = p_slot_date, slot_time = p_slot_time, doctor = coalesce(v_doctor, ''),
    status = 'new',
    status_note = 'Termín zmenil pacient (pôvodne ' || to_char(v_order.slot_date, 'DD.MM.YYYY') || ' ' || to_char(v_order.slot_time, 'HH24:MI') || ')'
  where id = v_order.id;
  return true;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
revoke all on function angio_patient_reschedule(text, text, date, time) from public;
grant execute on function angio_patient_reschedule(text, text, date, time) to anon, authenticated;

-- ------------------------------------------------------------
-- A5 + A6. angio_create_order — e-mail, dátum narodenia, lekár robí typ
--   (podpis z angio-005 s p_verify_token; starý 11-parametrový sa zruší)
-- ------------------------------------------------------------
drop function if exists angio_create_order(text, text, text, date, text, text, text, text, date, time, jsonb);

create or replace function angio_create_order(
  p_id text, p_exam_type_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time,
  p_attachments jsonb default '[]'::jsonb,
  p_verify_token text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item angio_pricelist%rowtype;
  v_dur int;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
  v_ip text := client_ip();
  v_phone9 text;
  v_active int;
  v_verify text;
  v_ver phone_verifications%rowtype;
begin
  if p_id !~ '^ANG-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('angio-create-ip:' || v_ip, 20);
  end if;
  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_insurance, '')) > 100
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;
  if coalesce(p_email, '') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Zadajte platný e-mail (posielame naň potvrdenie).';
  end if;
  if p_birth_date is not null and (p_birth_date > current_date or p_birth_date < date '1900-01-01') then
    raise exception 'Zadajte platný dátum narodenia.';
  end if;
  v_phone9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  -- overenie telefónu SMS kódom (pacient bez prihlásenia; personál nie)
  select value into v_verify from settings where key = 'angio_sms_verify';
  if coalesce(v_verify, 'off') = 'on' and my_role() not in ('superadmin', 'sestra', 'lekar') then
    select * into v_ver from phone_verifications
    where token = p_verify_token and phone = sms_number(p_phone)
      and verified_at is not null and used_at is null and token_expires_at > now()
    for update;
    if not found then
      raise exception 'Telefónne číslo nie je overené. Nechajte si poslať SMS kód a zadajte ho.';
    end if;
    update phone_verifications set used_at = now() where id = v_ver.id;
  end if;

  select count(*) into v_active
  from angio_orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky.', v_active;
  end if;

  select * into v_item from angio_pricelist where id = p_exam_type_id and active = true;
  if not found then
    raise exception 'Vybraný typ vyšetrenia nie je dostupný.';
  end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;

  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from angio_open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;
  if not angio_doctor_does_exam(v_doctor, v_item.id) then
    raise exception 'Tento lekár dané vyšetrenie nerobí. Vyberte iný čas.';
  end if;

  insert into angio_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance,
    phone, email, reason, slot_date, slot_time, doctor, duration_min, attachments)
  values (p_id, v_item.id, v_item.label, p_patient_name, p_birth_date, coalesce(p_insurance, ''),
    p_phone, coalesce(p_email, ''), coalesce(p_reason, ''), p_slot_date, p_slot_time,
    coalesce(v_doctor, ''), v_dur, coalesce(p_attachments, '[]'::jsonb));
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
revoke all on function angio_create_order(text, text, text, date, text, text, text, text, date, time, jsonb, text) from public;
grant execute on function angio_create_order(text, text, text, date, text, text, text, text, date, time, jsonb, text) to anon, authenticated;

-- Diagnostika:
--   select client_ip();
--   select jobname, schedule from cron.job where jobname = 'rate-limit-cleanup';
-- ============================================================
