-- ============================================================
-- PACIENT PRESUN 001 — zmena termínu pacientom (samoobsluha)
--
-- Pacient si v „Už máte objednávku?" (aj cez odkaz z e-mailu) môže
-- sám presunúť termín: vyberie nový deň a jeden z najbližších
-- voľných časov. Platba zostáva v platnosti; e-mail/SMS o presune
-- posielajú existujúce triggery.
--
-- Pravidlá (stráži databáza):
--  - overenie číslom objednávky + telefónom (ako pri zrušení),
--  - najneskôr 48 hodín pred PÔVODNÝM termínom,
--  - nový termín: celé trvanie v súvislých otvorených bunkách
--    jedného lekára, bez prekrytia s inou objednávkou,
--  - rate-limit 10 pokusov / 15 min na objednávku.
--
-- Bez kľúčov. Idempotentné.
-- ============================================================

-- lookup_order navyše vracia typ vyšetrenia a trvanie (frontend z nich
-- počíta ponuku voľných časov pre presun) — stále žiadne osobné údaje
create or replace function lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform check_lookup_limit('lookup:' || upper(coalesce(p_id, '')));
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
  -- (assert_referral_window definuje doplnkove-hodiny-001.sql / complete-setup)
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
-- ============================================================
