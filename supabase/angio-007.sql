-- ============================================================
-- ANGIO 007 — zmena termínu pacientom
--   Pacient si v sekcii „Už máte objednávku?" (číslo objednávky + telefón)
--   môže sám vybrať iný voľný termín z otvorených — napr. keď mu presunutý
--   termín nevyhovuje.
--   • povolené len pre aktívne objednávky (nová / potvrdená)
--   • najneskôr 24 hodín pred aktuálnym termínom (inak SMS pracovisku),
--     v súlade so spoločnými pokynmi
--   • nový termín musí byť v budúcnosti a mať dosť súvislých otvorených
--     buniek jedného lekára (rovnaké pravidlá ako presun personálom)
--   • potvrdená objednávka sa vráti do stavu „nová" (personál ju znova
--     potvrdí); e-mail a SMS o zmene termínu odídu automaticky (triggery)
--   • rate-limit ako pri vyhľadaní/zrušení (check_lookup_limit)
--   angio_lookup_order navyše vracia exam_type_id a duration_min, aby
--   stránka vedela ponúknuť správne dlhé termíny.
-- Idempotentné. Spúšťať PO angio-001.
-- ============================================================

create or replace function angio_lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if coalesce(p_id, '') !~ '^ANG-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
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

create or replace function angio_patient_reschedule(p_id text, p_phone text, p_slot_date date, p_slot_time time)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_order angio_orders%rowtype;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
  v_phone9 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
begin
  if coalesce(p_id, '') !~ '^ANG-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;
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
    raise exception 'Termín možno online zmeniť najneskôr 24 hodín vopred. V naozaj nutnom prípade nám napíšte SMS na 0949 000 677 (uveďte číslo objednávky) – ozveme sa vám späť.';
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
-- ============================================================
