-- ============================================================
-- Migrácia 002 — lekári pri termínoch + oddelená evidencia platby
-- Spustite v Supabase SQL editore, AK ste už predtým spustili
-- pôvodný schema.sql. (Pri čerstvej inštalácii stačí nový
-- schema.sql, ktorý už tieto stĺpce obsahuje.)
-- ============================================================

alter table open_slots add column if not exists doctor text not null default '';
alter table orders add column if not exists doctor text not null default '';
alter table orders add column if not exists paid boolean not null default false;
alter table orders add column if not exists paid_at timestamptz;

insert into settings (key, value) values ('doctors', '[]')
on conflict (key) do nothing;

-- create_order: lekára preberá zo samotného otvoreného termínu
create or replace function create_order(
  p_id text, p_exam_type_id text, p_exam_label text, p_price numeric,
  p_has_referral boolean, p_reason text, p_referrer_name text, p_referrer_facility text,
  p_patient_name text, p_birth_date date, p_insurance text, p_phone text, p_email text,
  p_slot_date date, p_slot_time time, p_variable_symbol text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_doctor text;
begin
  select s.doctor into v_doctor
  from open_slots s
  where s.slot_date = p_slot_date and s.slot_time = p_slot_time;
  if not found then
    raise exception 'Vybraný termín nie je otvorený na objednávanie.';
  end if;
  if exists (select 1 from orders o where o.slot_date = p_slot_date and o.slot_time = p_slot_time and o.status <> 'rejected') then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
  end if;
  insert into orders (
    id, has_referral, exam_type_id, exam_label, price, reason,
    referrer_name, referrer_facility, patient_name, birth_date,
    insurance, phone, email, slot_date, slot_time, variable_symbol, doctor
  ) values (
    p_id, p_has_referral, p_exam_type_id, p_exam_label, p_price, p_reason,
    coalesce(p_referrer_name, ''), coalesce(p_referrer_facility, ''), p_patient_name, p_birth_date,
    coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''), p_slot_date, p_slot_time, p_variable_symbol,
    coalesce(v_doctor, '')
  );
  return p_id;
end $$;

-- lookup_order: doplnené polia doctor a paid
create or replace function lookup_order(p_id text, p_phone text)
returns jsonb
language sql security definer set search_path = public as $$
  select to_jsonb(x) from (
    select o.id, o.status, o.status_note, o.has_referral, o.exam_label,
           o.price, o.slot_date, o.slot_time, o.doctor, o.paid
    from orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
$$;
