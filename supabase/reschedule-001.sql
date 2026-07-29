-- ============================================================
-- RESCHEDULE 001 — bezpečný presun termínu (audit vlna 2)
--
-- Presun objednávky prechádza rovnakými kontrolami ako vytvorenie:
-- celé trvanie vyšetrenia sa musí zmestiť do súvislých otvorených
-- buniek jedného lekára. Lekár objednávky sa pri presune nastaví
-- podľa cieľových buniek. Idempotentné.
-- ============================================================
-- ------------------------------------------------------------
-- PRESUN OBJEDNÁVKY: rovnaké kontroly ako pri vytvorení —
-- celé trvanie sa musí zmestiť do súvislých otvorených buniek
-- jedného lekára; lekár objednávky sa nastaví podľa cieľových
-- buniek (pacient dostane e-mail/SMS o presune s novým lekárom).
-- ------------------------------------------------------------
create or replace function reschedule_order(p_id text, p_slot_date date, p_slot_time time)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
begin
  if not (my_role() in ('superadmin', 'sestra')
          or (my_role() = 'lekar' and exists (select 1 from orders o where o.id = p_id and o.doctor = my_doctor()))) then
    raise exception 'Na presun objednávky nemáte oprávnenie.';
  end if;

  select * into v_order from orders where id = p_id;
  if not found or v_order.status not in ('new', 'confirmed') then
    raise exception 'Objednávku nemožno presunúť (neexistuje alebo je uzavretá).';
  end if;
  if p_slot_date < current_date then
    raise exception 'Termín v minulosti nie je možné nastaviť.';
  end if;

  for n in 0 .. (greatest(v_order.duration_min, 10) / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor
    from open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_order.duration_min;
    end if;
    if n = 0 then
      v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  -- prekrytie s INOU objednávkou (vlastná sa vynecháva; exclusion
  -- constraint orders_no_overlap ostáva ako race-safe posledná poistka)
  if exists (
    select 1 from orders o
    where o.slot_date = p_slot_date and o.status <> 'rejected' and o.id <> p_id
      and int4range(
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int,
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int + o.duration_min
          ) && int4range(
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int,
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int + v_order.duration_min
          )
  ) then
    raise exception 'Vybraný termín je obsadený. Vyberte iný.';
  end if;

  update orders set
    slot_date = p_slot_date,
    slot_time = p_slot_time,
    doctor = coalesce(v_doctor, ''),
    status_note = 'Presunuté z ' || to_char(v_order.slot_date, 'DD.MM.YYYY') || ' ' || to_char(v_order.slot_time, 'HH24:MI')
  where id = p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

revoke all on function reschedule_order(text, date, time) from public, anon;
grant execute on function reschedule_order(text, date, time) to authenticated;
