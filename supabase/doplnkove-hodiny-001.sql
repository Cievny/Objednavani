-- ============================================================
-- DOPLNKOVÉ HODINY 001 — doplatkové termíny až od nastaveného času
--
-- Pacient SO ŽIADANKOU (doplatok = doplnkové ordinačné hodiny) si
-- môže vybrať len termín od času nastaveného v správe (Nastavenia →
-- Nastavenia platby → „Termíny so žiadankou najskôr od"). Samoplatca
-- (plná cena) vidí všetky otvorené termíny.
--
-- Frontend časy filtruje v ponuke; táto migrácia pridáva rovnaké
-- pravidlo aj na server (create_order + patient_reschedule), aby ho
-- nebolo možné obísť. Personál v správe obmedzený nie je.
--
-- Nastavenie: settings.referral_from (napr. '14:00'); prázdne alebo
-- chýbajúce = bez obmedzenia. Zle zadaná hodnota objednávanie
-- NEZABLOKUJE (kontrola sa vtedy preskočí).
--
-- Bez kľúčov. Idempotentné — možno spúšťať opakovane.
-- ============================================================

create or replace function assert_referral_window(p_has_referral boolean, p_slot_time time)
returns void
language plpgsql set search_path = public as $$
declare
  v_from time;
begin
  if not coalesce(p_has_referral, false) then return; end if;
  begin
    v_from := nullif((select value from settings where key = 'referral_from'), '')::time;
  exception when others then
    v_from := null; -- pokazený formát času v nastaveniach nesmie zablokovať objednávanie
  end;
  if v_from is not null and p_slot_time < v_from then
    raise exception 'Termíny so žiadankou (doplatok v doplnkových ordinačných hodinách) sú dostupné až od % h. Vyberte neskorší čas.', to_char(v_from, 'HH24:MI');
  end if;
end $$;

-- ------------------------------------------------------------
-- create_order — plná aktuálna verzia (fio-parovanie-002)
-- + kontrola doplnkových hodín pre objednávky so žiadankou
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
begin
  if p_id !~ '^USG-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
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
  v_dur := greatest(coalesce(v_item.duration_slots, 2), 2) * 5; -- minimálne trvanie 10 min

  select count(*) into v_active
  from orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  -- testovacie číslo pracoviska je z limitu vyňaté (porovnáva sa
  -- posledných 9 číslic, pokryje 0917911202 aj +421917911202)
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky. Ak potrebujete ďalší termín, napíšte SMS na 0949 000 677.', v_active;
  end if;

  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  if p_slot_date < current_date then
    raise exception 'Termín v minulosti nie je možné objednať.';
  end if;

  -- doplatkové termíny (so žiadankou) až od nastaveného času
  perform assert_referral_window(p_has_referral, p_slot_time);

  v_vs := nextval('vs_seq')::text; -- garantovane unikátny VS zo servera

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
  return v_vs; -- klient zobrazí tento VS v QR platbe
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

-- ------------------------------------------------------------
-- patient_reschedule — plná aktuálna verzia (pacient-presun-001)
-- + kontrola doplnkových hodín podľa žiadanky na objednávke
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
  perform check_lookup_limit('resched:' || upper(coalesce(p_id, '')));

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
  if p_slot_date < current_date then
    raise exception 'Termín v minulosti nie je možné vybrať.';
  end if;

  -- doplatkové termíny (so žiadankou) až od nastaveného času
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

-- Kontrola po spustení:
--   insert into settings (key, value) values ('referral_from', '14:00')
--     on conflict (key) do update set value = excluded.value;   -- alebo cez správu
--   select assert_referral_window(true, '10:00'::time);          -- má vyhodiť chybu
--   select assert_referral_window(false, '10:00'::time);         -- prejde (samoplatca)
-- ============================================================
