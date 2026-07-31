-- ============================================================
-- AUDIT VLNA 3 (001) — bezpečnostné a kalendárové opravy
--
-- Rieši KRITICKÉ a VYSOKÉ nálezy auditu:
--  1. Prílohy pacientov: čítanie/mazanie len pre personál s rolou
--     (predtým ktokoľvek prihlásený videl a mazal všetky žiadanky).
--  2. invoice_counters: zapnuté RLS (jediná verejne prístupná tabuľka).
--  3. create_order: rate-limit podľa IP + zákaz termínu v minulosti
--     (nielen minulého dátumu, aj uplynulého času dnes).
--  4. lookup_order / cancel_order / patient_reschedule: validácia
--     formátu čísla objednávky (proti zaplneniu lookup_attempts) a
--     rate-limit kľúčovaný na TELEFÓN, nie na číslo objednávky
--     (predtým sa hádanie cudzích ID nelimitovalo vôbec).
--  5. patient_reschedule: zákaz presunu na uplynulý čas.
--
-- Bez kľúčov. Idempotentné — možno spúšťať opakovane.
-- Spúšťať PO complete-setup-002, fio-parovanie-002, pacient-presun-001,
-- doplnkove-hodiny-001, faktury-001.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Prílohy (storage bucket prilohy): čítanie a mazanie len personál
-- ------------------------------------------------------------
drop policy if exists "prilohy citanie personal" on storage.objects;
create policy "prilohy citanie personal" on storage.objects
  for select to authenticated
  using (bucket_id = 'prilohy' and my_role() in ('superadmin', 'sestra', 'lekar'));

drop policy if exists "prilohy mazanie personal" on storage.objects;
create policy "prilohy mazanie personal" on storage.objects
  for delete to authenticated
  using (bucket_id = 'prilohy' and my_role() in ('superadmin', 'sestra', 'lekar'));
-- upload (insert) ostáva pre anon — pacient nahráva žiadanku pri objednávaní

-- ------------------------------------------------------------
-- 2. invoice_counters — zapnúť RLS (prístup len cez SECURITY DEFINER)
-- ------------------------------------------------------------
alter table if exists invoice_counters enable row level security;

-- ------------------------------------------------------------
-- 3. Parametrizovaný rate-limit (pôvodný check_lookup_limit = 10/15 min)
-- ------------------------------------------------------------
create or replace function check_rate_limit(p_key text, p_max int)
returns void
language plpgsql security definer set search_path = public as $$
declare v lookup_attempts%rowtype;
begin
  select * into v from lookup_attempts where key = p_key for update;
  if not found then
    insert into lookup_attempts (key, attempts) values (p_key, 1)
    on conflict (key) do update set attempts = lookup_attempts.attempts + 1;
    return;
  end if;
  if v.window_start < now() - interval '15 minutes' then
    update lookup_attempts set window_start = now(), attempts = 1 where key = p_key;
    return;
  end if;
  if v.attempts >= p_max then
    raise exception 'Priveľa pokusov. Skúste to znova o 15 minút.';
  end if;
  update lookup_attempts set attempts = attempts + 1 where key = p_key;
end $$;
revoke all on function check_rate_limit(text, int) from public, anon, authenticated;

-- pôvodná funkcia ostáva (10/15 min) a deleguje na parametrizovanú
create or replace function check_lookup_limit(p_key text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_rate_limit(p_key, 10);
end $$;

-- pomocná: číslo objednávky musí mať platný formát (proti bloateniu
-- lookup_attempts a zbytočným dotazom)
create or replace function assert_order_id(p_id text)
returns void
language plpgsql set search_path = public as $$
begin
  if coalesce(p_id, '') !~ '^USG-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. create_order — + IP rate-limit + zákaz termínu v minulosti
-- ------------------------------------------------------------
create or replace function create_order(
  p_id text, p_exam_type_id text, p_exam_label text, p_price numeric,
  p_has_referral boolean, p_reason text, p_referrer_name text, p_referrer_facility text,
  p_patient_name text, p_birth_date date, p_insurance text, p_phone text, p_email text,
  p_slot_date date, p_slot_time time, p_variable_symbol text,
  p_attachments jsonb default '[]'::jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_doctor text;
  v_cell_doctor text;
  v_item   pricelist%rowtype;
  v_price  numeric;
  v_phone9 text;
  v_active int;
  v_dur    int;
  v_vs     text;
  n        int;
  v_cell   time;
  v_ip     text := '';
begin
  if p_id !~ '^USG-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;

  -- rate-limit podľa IP: brzda proti hromadnému zakladaniu fiktívnych
  -- objednávok (a tým e-mailovému/SMS spamu) z jedného zdroja
  begin
    v_ip := split_part(coalesce((current_setting('request.headers', true))::json ->> 'x-forwarded-for', ''), ',', 1);
  exception when others then
    v_ip := '';
  end;
  if v_ip <> '' then
    perform check_rate_limit('create-ip:' || v_ip, 20);
  end if;

  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_referrer_name, '')) > 200
     or length(coalesce(p_referrer_facility, '')) > 200
     or length(coalesce(p_insurance, '')) > 100
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;

  v_phone9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;

  select * into v_item from pricelist where id = p_exam_type_id and active = true;
  if not found then
    raise exception 'Vybrané vyšetrenie nie je v aktuálnom cenníku.';
  end if;
  if p_has_referral then
    if v_item.price_referral is null then
      raise exception 'Toto vyšetrenie je dostupné len ako samoplatca (bez žiadanky).';
    end if;
    v_price := v_item.price_referral;
  else
    v_price := v_item.price_self;
  end if;
  if p_price is distinct from v_price then
    raise exception 'Cenník sa medzičasom zmenil. Obnovte stránku a skúste znova.';
  end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 2), 2) * 5;

  select count(*) into v_active
  from orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky. Ak potrebujete ďalší termín, napíšte SMS na 0949 000 677.', v_active;
  end if;

  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  -- termín nesmie byť v minulosti — kontroluje sa dátum AJ čas (dnešok)
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  perform assert_referral_window(p_has_referral, p_slot_time);

  v_vs := nextval('vs_seq')::text;

  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor
    from open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then
      v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  if exists (
    select 1 from orders o
    where o.slot_date = p_slot_date and o.status <> 'rejected'
      and int4range(
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int,
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int + o.duration_min
          ) && int4range(
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int,
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int + v_dur
          )
  ) then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
  end if;

  insert into orders (
    id, has_referral, exam_type_id, exam_label, price, reason,
    referrer_name, referrer_facility, patient_name, birth_date,
    insurance, phone, email, slot_date, slot_time, variable_symbol, doctor, attachments, duration_min
  ) values (
    p_id, p_has_referral, p_exam_type_id, v_item.label, v_price, p_reason,
    coalesce(p_referrer_name, ''), coalesce(p_referrer_facility, ''), p_patient_name, p_birth_date,
    coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''), p_slot_date, p_slot_time, v_vs,
    coalesce(v_doctor, ''), coalesce(p_attachments, '[]'::jsonb), v_dur
  );
  return v_vs;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

-- ------------------------------------------------------------
-- 5. lookup_order — validácia ID + rate-limit na TELEFÓN
-- ------------------------------------------------------------
create or replace function lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform assert_order_id(p_id);
  perform check_lookup_limit('lookup:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));
  select to_jsonb(x) into result from (
    select o.id, o.status, o.status_note, o.has_referral, o.exam_label,
           o.exam_type_id, o.duration_min,
           o.price, o.slot_date, o.slot_time, o.doctor, o.paid
    from orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
  return result;
end $$;

-- ------------------------------------------------------------
-- 6. cancel_order — validácia ID + rate-limit na TELEFÓN
-- ------------------------------------------------------------
create or replace function cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_when timestamptz;
begin
  perform assert_order_id(p_id);
  perform check_lookup_limit('cancel:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));

  select ((o.slot_date + o.slot_time) at time zone 'Europe/Bratislava') into v_when
  from orders o
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');

  if v_when is not null and v_when - now() < interval '48 hours' then
    raise exception 'Do termínu zostáva menej ako 48 hodín — napíšte nám SMS s číslom objednávky na 0949 000 677.';
  end if;

  update orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- ------------------------------------------------------------
-- 7. patient_reschedule — validácia ID + rate-limit na TELEFÓN
--    + zákaz presunu na uplynulý čas
-- ------------------------------------------------------------
create or replace function patient_reschedule(p_id text, p_phone text, p_slot_date date, p_slot_time time)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
begin
  perform assert_order_id(p_id);
  perform check_lookup_limit('resched:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));

  select * into v_order from orders o
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  if not found then
    raise exception 'Objednávku sme nenašli alebo ju nemožno presunúť.';
  end if;

  if ((v_order.slot_date + v_order.slot_time) at time zone 'Europe/Bratislava') - now() < interval '48 hours' then
    raise exception 'Do termínu zostáva menej ako 48 hodín — napíšte nám SMS s číslom objednávky na 0949 000 677.';
  end if;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  perform assert_referral_window(v_order.has_referral, p_slot_time);

  for n in 0 .. (greatest(v_order.duration_min, 10) / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor
    from open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Vybraný čas už nie je dostupný. Vyberte iný.';
    end if;
    if n = 0 then
      v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Vybraný čas už nie je dostupný. Vyberte iný.';
    end if;
  end loop;

  if exists (
    select 1 from orders o
    where o.slot_date = p_slot_date and o.status <> 'rejected' and o.id <> v_order.id
      and int4range(
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int,
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int + o.duration_min
          ) && int4range(
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int,
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int + v_order.duration_min
          )
  ) then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
  end if;

  update orders set
    slot_date = p_slot_date,
    slot_time = p_slot_time,
    doctor = coalesce(v_doctor, ''),
    status_note = 'Presunuté pacientom z ' || to_char(v_order.slot_date, 'DD.MM.YYYY') || ' ' || to_char(v_order.slot_time, 'HH24:MI')
  where id = v_order.id;
  return true;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

grant execute on function patient_reschedule(text, text, date, time) to anon, authenticated;
grant execute on function lookup_order(text, text) to anon, authenticated;
grant execute on function cancel_order(text, text) to anon, authenticated;

-- Kontrola po spustení:
--   select lookup_order('x', '0900');                       -- 'Neplatné číslo objednávky.'
--   select relrowsecurity from pg_class where relname = 'invoice_counters';  -- t
-- ============================================================
