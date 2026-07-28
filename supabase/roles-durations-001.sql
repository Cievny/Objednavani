-- ============================================================
-- ⚠ ZASTARANÉ — NESPÚŠŤAŤ. Nahradené súborom complete-setup-002.sql,
-- ktorý obsahuje aktuálne a správne definície. Ponechané len pre históriu.
-- ROLES + DURATIONS 001
--   1. Roly personálu: superadmin / sestra / lekar (RLS)
--   2. Štatistika na odmeny: usg_stats + lekár + zaplatená suma
--   3. Mesačný prehľad doctor_monthly_stats()
--   4. Trvanie vyšetrení: násobky 10-min slotu + ochrana
--      proti prekrytiu (exclusion constraint)
--   5. Poradie cenníka: cievne vyšetrenia hore
--
-- PO SPUSTENÍ: priraďte si rolu superadmin (návod na konci).
-- Skript je idempotentný.
-- ============================================================

create extension if not exists btree_gist;

-- ------------------------------------------------------------
-- 1. Roly personálu
-- ------------------------------------------------------------
create table if not exists staff_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('superadmin', 'sestra', 'lekar')),
  doctor_name text not null default ''  -- pre rolu lekar: presne ako v Nastavenia → Lekári
);
alter table staff_roles enable row level security;

create or replace function my_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select role from staff_roles where user_id = auth.uid()), '');
$$;
create or replace function my_doctor()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select doctor_name from staff_roles where user_id = auth.uid()), '');
$$;

drop policy if exists "rola vlastna" on staff_roles;
create policy "rola vlastna" on staff_roles
  for select using (user_id = auth.uid() or my_role() = 'superadmin');
drop policy if exists "roly spravuje superadmin" on staff_roles;
create policy "roly spravuje superadmin" on staff_roles
  for all using (my_role() = 'superadmin');

-- ------------------------------------------------------------
-- 2. RLS podľa rolí
--    (bez záznamu v staff_roles prihlásený používateľ NIČ nevidí)
-- ------------------------------------------------------------
drop policy if exists "objednavky spravuje personal" on orders;
drop policy if exists "objednavky podla roly" on orders;
create policy "objednavky podla roly" on orders
  for all using (
    my_role() in ('superadmin', 'sestra')
    or (my_role() = 'lekar' and doctor = my_doctor())
  );

drop policy if exists "sloty spravuje personal" on open_slots;
drop policy if exists "sloty spravuje sestra a superadmin" on open_slots;
create policy "sloty spravuje sestra a superadmin" on open_slots
  for all using (my_role() in ('superadmin', 'sestra'));
-- čítanie slotov ostáva verejné (politika "sloty cita ktokolvek")

drop policy if exists "cennik spravuje personal" on pricelist;
drop policy if exists "cennik spravuje superadmin" on pricelist;
create policy "cennik spravuje superadmin" on pricelist
  for all using (my_role() = 'superadmin');

drop policy if exists "nastavenia spravuje personal" on settings;
drop policy if exists "nastavenia spravuje superadmin" on settings;
create policy "nastavenia spravuje superadmin" on settings
  for all using (my_role() = 'superadmin');

-- sestra smie meniť LEN poradie cenníka
create or replace function update_pricelist_order(p_order jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare item jsonb;
begin
  if my_role() not in ('superadmin', 'sestra') then
    raise exception 'Na zmenu poradia nemáte oprávnenie.';
  end if;
  for item in select * from jsonb_array_elements(p_order) loop
    update pricelist set sort_order = (item->>'sort_order')::int
    where id = item->>'id';
  end loop;
end $$;
revoke all on function update_pricelist_order(jsonb) from public, anon;
grant execute on function update_pricelist_order(jsonb) to authenticated;

-- ------------------------------------------------------------
-- 3. Štatistika s lekárom a zaplatenou sumou
--    (anonymná voči pacientom; slúži na mesačné odmeny)
-- ------------------------------------------------------------
alter table usg_stats add column if not exists doctor text not null default '';
alter table usg_stats add column if not exists paid_cnt int not null default 0;
alter table usg_stats add column if not exists paid_eur numeric(10,2) not null default 0;
alter table usg_stats drop constraint if exists usg_stats_pkey;
alter table usg_stats add primary key (day, exam_type_id, status, doctor);

drop policy if exists "statistiku cita personal" on usg_stats;
drop policy if exists "statistika podla roly" on usg_stats;
create policy "statistika podla roly" on usg_stats
  for select using (
    my_role() = 'superadmin'
    or (my_role() = 'lekar' and doctor = my_doctor())
  );

-- purge_orders: zapisuje aj lekára a zaplatenú sumu
create or replace function purge_orders()
returns table (deleted_done int, deleted_old int, scrubbed int)
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_done int := 0;
  v_old int := 0;
  v_scrub int := 0;
begin
  for r in
    select id from orders
    where (attachments <> '[]'::jsonb or reason <> '' or referrer_name <> '')
      and (
        (slot_date < current_date and status in ('new', 'rejected', 'noshow'))
        or slot_date <= current_date - 7
      )
  loop
    perform purge_order_files(r.id);
    update orders set attachments = '[]'::jsonb, reason = '', referrer_name = '', referrer_facility = ''
    where id = r.id;
    v_scrub := v_scrub + 1;
  end loop;

  for r in
    select id, slot_date, exam_type_id, status, doctor, paid, price from orders
    where status = 'done' and slot_date <= current_date - 7
  loop
    perform purge_order_files(r.id);
    insert into usg_stats (day, exam_type_id, status, doctor, cnt, paid_cnt, paid_eur)
    values (r.slot_date, r.exam_type_id, r.status, coalesce(r.doctor, ''), 1,
            case when r.paid then 1 else 0 end,
            case when r.paid then r.price else 0 end)
    on conflict (day, exam_type_id, status, doctor) do update
      set cnt = usg_stats.cnt + 1,
          paid_cnt = usg_stats.paid_cnt + excluded.paid_cnt,
          paid_eur = usg_stats.paid_eur + excluded.paid_eur;
    delete from orders where id = r.id;
    v_done := v_done + 1;
  end loop;

  for r in
    select id, slot_date, exam_type_id, status, doctor, paid, price from orders
    where slot_date < current_date - 28 and status <> 'done'
  loop
    perform purge_order_files(r.id);
    insert into usg_stats (day, exam_type_id, status, doctor, cnt, paid_cnt, paid_eur)
    values (r.slot_date, r.exam_type_id, r.status, coalesce(r.doctor, ''), 1, 0, 0)
    on conflict (day, exam_type_id, status, doctor) do update set cnt = usg_stats.cnt + 1;
    delete from orders where id = r.id;
    v_old := v_old + 1;
  end loop;

  delete from audit_log where at < now() - interval '90 days';
  delete from lookup_attempts where window_start < now() - interval '90 days';
  begin
    delete from net._http_response where created < now() - interval '90 days';
  exception when others then null;
  end;
  begin
    delete from cron.job_run_details where end_time < now() - interval '90 days';
  exception when others then null;
  end;

  return query select v_done, v_old, v_scrub;
end $$;
revoke all on function purge_orders() from public, anon, authenticated;

-- Mesačný prehľad: živé objednávky + archívna štatistika.
-- SECURITY INVOKER → RLS automaticky obmedzí lekára na jeho riadky.
create or replace function doctor_monthly_stats(p_from date, p_to date)
returns table (doctor text, exam_type_id text, done_paid_cnt bigint, paid_eur numeric)
language sql stable as $$
  select doctor, exam_type_id, sum(cnt)::bigint, sum(eur)
  from (
    select o.doctor, o.exam_type_id, 1 as cnt, o.price as eur
    from orders o
    where o.status = 'done' and o.paid
      and o.slot_date >= p_from and o.slot_date <= p_to
    union all
    select s.doctor, s.exam_type_id, s.paid_cnt, s.paid_eur
    from usg_stats s
    where s.status = 'done'
      and s.day >= p_from and s.day <= p_to
  ) x
  group by doctor, exam_type_id
  order by doctor, exam_type_id;
$$;
revoke all on function doctor_monthly_stats(date, date) from public, anon;
grant execute on function doctor_monthly_stats(date, date) to authenticated;

-- ------------------------------------------------------------
-- 4. Trvanie vyšetrení (násobky 10-min slotu)
-- ------------------------------------------------------------
alter table pricelist add column if not exists duration_slots int not null default 1
  check (duration_slots between 1 and 6);
alter table orders add column if not exists duration_min int not null default 10;

-- prekrytie stráži exclusion constraint (race-safe)
drop index if exists orders_slot_unique;
alter table orders drop constraint if exists orders_no_overlap;
alter table orders add constraint orders_no_overlap
  exclude using gist (
    slot_date with =,
    int4range(
      (extract(hour from slot_time) * 60 + extract(minute from slot_time))::int,
      (extract(hour from slot_time) * 60 + extract(minute from slot_time))::int + duration_min
    ) with &&
  ) where (status <> 'rejected');

-- obsadenosť pre pacientsky kalendár: rozvinúť na 10-min bunky
create or replace function get_booked_slots()
returns table (slot_date date, slot_time time)
language sql security definer set search_path = public as $$
  select o.slot_date, (o.slot_time + (n * 10) * interval '1 minute')::time
  from orders o, generate_series(0, greatest(o.duration_min / 10 - 1, 0)) n
  where o.status <> 'rejected' and o.slot_date >= current_date;
$$;

-- create_order: dĺžka z cenníka; všetky pokryté bunky musia byť
-- otvorené (rovnaký lekár) a voľné
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
  v_dur := coalesce(v_item.duration_slots, 1) * 10;

  select count(*) into v_active
  from orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky. Kontaktujte pracovisko.', v_active;
  end if;

  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  if p_slot_date < current_date then
    raise exception 'Termín v minulosti nie je možné objednať.';
  end if;

  -- každá pokrytá 10-min bunka musí byť otvorená a s tým istým lekárom
  for n in 0 .. (v_dur / 10 - 1) loop
    v_cell := p_slot_time + (n * 10) * interval '1 minute';
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

  -- obsadenosť (prekrytie s existujúcou objednávkou)
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
    coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''), p_slot_date, p_slot_time, p_variable_symbol,
    coalesce(v_doctor, ''), coalesce(p_attachments, '[]'::jsonb), v_dur
  );
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

-- predvolené trvania (upraviteľné v Nastavenia → Cenník)
update pricelist set duration_slots = v.d
from (values
  ('abdomen', 2), ('kidneys', 2), ('pelvis', 2), ('soft', 2),
  ('thyroid', 2), ('neck', 2), ('carotid', 2),
  ('upper1', 2), ('upper2', 3), ('lower1', 2), ('lower2', 3),
  ('renal', 3), ('aorta', 2), ('tos', 3),
  ('complete_vessels', 4), ('compressions', 6), ('consultation', 3)
) as v(id, d)
where pricelist.id = v.id and pricelist.duration_slots = 1;

-- ------------------------------------------------------------
-- 5. Poradie: cievne vyšetrenia hore
-- ------------------------------------------------------------
update pricelist set sort_order = v.s
from (values
  ('carotid', 0), ('lower1', 1), ('lower2', 2), ('upper1', 3), ('upper2', 4),
  ('tos', 5), ('renal', 6), ('aorta', 7), ('complete_vessels', 8), ('compressions', 9),
  ('abdomen', 10), ('kidneys', 11), ('pelvis', 12), ('soft', 13),
  ('thyroid', 14), ('neck', 15), ('consultation', 16)
) as v(id, s)
where pricelist.id = v.id;

-- ------------------------------------------------------------
-- PO SPUSTENÍ — priradenie rolí (nahraďte e-maily):
--
-- superadmin (vy):
--   insert into staff_roles (user_id, role)
--   select id, 'superadmin' from auth.users where email = 'lukas.vincze@nusch.sk'
--   on conflict (user_id) do update set role = 'superadmin';
--
-- sestra:
--   insert into staff_roles (user_id, role)
--   select id, 'sestra' from auth.users where email = 'sestra@nusch.sk'
--   on conflict (user_id) do update set role = 'sestra';
--
-- lekár (doctor_name PRESNE ako v Nastavenia → Lekári):
--   insert into staff_roles (user_id, role, doctor_name)
--   select id, 'lekar', 'MUDr. Meno Priezvisko' from auth.users where email = 'lekar@nusch.sk'
--   on conflict (user_id) do update set role = 'lekar', doctor_name = excluded.doctor_name;
--
-- Kontrola: select u.email, r.role, r.doctor_name
--           from staff_roles r join auth.users u on u.id = r.user_id;
-- ============================================================
