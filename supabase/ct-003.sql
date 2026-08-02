-- ============================================================
-- CT 003 — prílohy (žiadanky) k CT objednávkam
--   • ct_orders.attachments jsonb (rovnako ako USG orders)
--   • ct_create_order prijíma p_attachments (max 3)
--   • čistenie osirelých CT príloh (purge)
--
-- Prílohy sa nahrávajú do rovnakého storage bucketu 'prilohy'
-- (čítanie/mazanie len personál — už zabezpečené audit-vlna3).
-- Idempotentné. Spúšťať PO ct-002.
-- ============================================================

alter table ct_orders add column if not exists attachments jsonb not null default '[]'::jsonb;

-- nová verzia ct_create_order s prílohami (nahradí 10-arg verziu z ct-002)
drop function if exists ct_create_order(text, text, text, date, text, text, text, text, date, time);

create or replace function ct_create_order(
  p_id text, p_exam_type_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time,
  p_attachments jsonb default '[]'::jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item ct_pricelist%rowtype;
  v_dur int;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
begin
  if p_id !~ '^CT-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_insurance, '')) > 100
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;
  if length(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9)) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  select * into v_item from ct_pricelist where id = p_exam_type_id and active = true;
  if not found then
    raise exception 'Vybrané CT vyšetrenie nie je dostupné.';
  end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;

  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from ct_open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  insert into ct_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance,
    phone, email, reason, slot_date, slot_time, doctor, duration_min, attachments)
  values (p_id, v_item.id, v_item.label, p_patient_name, p_birth_date, coalesce(p_insurance, ''),
    p_phone, coalesce(p_email, ''), coalesce(p_reason, ''), p_slot_date, p_slot_time,
    coalesce(v_doctor, ''), v_dur, coalesce(p_attachments, '[]'::jsonb));
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
grant execute on function ct_create_order(text, text, text, date, text, text, text, text, date, time, jsonb) to anon, authenticated;

-- Diagnostika:
--   select column_name from information_schema.columns where table_name='ct_orders' and column_name='attachments';
-- ============================================================
