-- ============================================================
-- KOMPLETNÝ SETUP 002 — všetko v jednom, v správnom poradí:
--   retencia (GDPR výmaz) → roly → štatistika → trvanie
--   vyšetrení → poradie cenníka → správa používateľov
--   → bootstrap superadmina
--
-- Idempotentné: možno spúšťať opakovane. Nahrádza potrebu
-- spúšťať retention-001, roles-durations-001 a admin-users-001
-- osobitne.
--
-- Na konci skriptu sa priradí superadmin kontu
-- lukas.vincze@nusch.sk — ak sa prihlasujete iným e-mailom,
-- zmeňte ho tam.
-- ============================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;
create extension if not exists btree_gist;

alter table pricelist add column if not exists instructions text not null default '';

-- ------------------------------------------------------------
-- 1. ANONYMNÁ ŠTATISTIKA (prežije výmaz; slúži aj na odmeny)
-- ------------------------------------------------------------
create table if not exists usg_stats (
  day date not null,
  exam_type_id text not null,
  status text not null,
  cnt int not null default 0
);
alter table usg_stats add column if not exists doctor text not null default '';
alter table usg_stats add column if not exists paid_cnt int not null default 0;
alter table usg_stats add column if not exists paid_eur numeric(10,2) not null default 0;
alter table usg_stats drop constraint if exists usg_stats_pkey;
alter table usg_stats add primary key (day, exam_type_id, status, doctor);
alter table usg_stats enable row level security;

-- ------------------------------------------------------------
-- 2. AUDITNÝ LOG operácií personálu (90 dní)
-- ------------------------------------------------------------
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  order_id text,
  action text not null,
  detail text not null default ''
);
alter table audit_log enable row level security;
drop policy if exists "audit cita personal" on audit_log;
create policy "audit cita personal" on audit_log
  for select using (auth.role() = 'authenticated');

create or replace function audit_orders()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'UPDATE' then
    if OLD.status is distinct from NEW.status then
      insert into audit_log (user_id, order_id, action, detail)
      values (auth.uid(), NEW.id, 'status', OLD.status || ' → ' || NEW.status);
    end if;
    if OLD.paid is distinct from NEW.paid then
      insert into audit_log (user_id, order_id, action, detail)
      values (auth.uid(), NEW.id, 'paid', case when NEW.paid then 'zaplatené' else 'platba zrušená' end);
    end if;
    if OLD.slot_date is distinct from NEW.slot_date or OLD.slot_time is distinct from NEW.slot_time then
      insert into audit_log (user_id, order_id, action, detail)
      values (auth.uid(), NEW.id, 'reschedule',
        OLD.slot_date || ' ' || OLD.slot_time || ' → ' || NEW.slot_date || ' ' || NEW.slot_time);
    end if;
  elsif TG_OP = 'INSERT' then
    insert into audit_log (user_id, order_id, action, detail)
    values (auth.uid(), NEW.id, 'created', NEW.exam_type_id);
  end if;
  return NEW;
end $$;

drop trigger if exists orders_audit on orders;
create trigger orders_audit
after insert or update on orders
for each row execute function audit_orders();

-- ------------------------------------------------------------
-- 3. OKAMŽITÝ VÝMAZ príloh a údajov zo žiadanky pri zrušení
-- ------------------------------------------------------------
create or replace function purge_order_files(p_order_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from storage.objects
  where bucket_id = 'prilohy' and name like p_order_id || '/%';
end $$;

create or replace function scrub_on_cancel()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.status = 'rejected' and OLD.status <> 'rejected' then
    perform purge_order_files(NEW.id);
    NEW.attachments := '[]'::jsonb;
    NEW.reason := '';
    NEW.referrer_name := '';
    NEW.referrer_facility := '';
  end if;
  return NEW;
end $$;

drop trigger if exists orders_scrub_on_cancel on orders;
create trigger orders_scrub_on_cancel
before update on orders
for each row execute function scrub_on_cancel();

-- ------------------------------------------------------------
-- 4. RATE-LIMITING overovania objednávky (10 pokusov / 15 min)
-- ------------------------------------------------------------
create table if not exists lookup_attempts (
  key text primary key,
  window_start timestamptz not null default now(),
  attempts int not null default 0
);
alter table lookup_attempts enable row level security;

create or replace function check_lookup_limit(p_key text)
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
  if v.attempts >= 10 then
    raise exception 'Priveľa pokusov o overenie. Skúste to znova o 15 minút.';
  end if;
  update lookup_attempts set attempts = attempts + 1 where key = p_key;
end $$;

create or replace function lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform check_lookup_limit('lookup:' || upper(coalesce(p_id, '')));
  select to_jsonb(x) into result from (
    select o.id, o.status, o.status_note, o.has_referral, o.exam_label,
           o.price, o.slot_date, o.slot_time, o.doctor, o.paid
    from orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
  return result;
end $$;

create or replace function cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  perform check_lookup_limit('cancel:' || upper(coalesce(p_id, '')));
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
-- 5. ROLY PERSONÁLU: superadmin / sestra / lekar
-- ------------------------------------------------------------
create table if not exists staff_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('superadmin', 'sestra', 'lekar')),
  doctor_name text not null default ''
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

-- RLS podľa rolí
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

drop policy if exists "cennik spravuje personal" on pricelist;
drop policy if exists "cennik spravuje superadmin" on pricelist;
create policy "cennik spravuje superadmin" on pricelist
  for all using (my_role() = 'superadmin');

drop policy if exists "nastavenia spravuje personal" on settings;
drop policy if exists "nastavenia spravuje superadmin" on settings;
create policy "nastavenia spravuje superadmin" on settings
  for all using (my_role() = 'superadmin');

drop policy if exists "statistiku cita personal" on usg_stats;
drop policy if exists "statistika podla roly" on usg_stats;
create policy "statistika podla roly" on usg_stats
  for select using (
    my_role() = 'superadmin'
    or (my_role() = 'lekar' and doctor = my_doctor())
  );

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
-- 6. DENNÝ VÝMAZ podľa GDPR lehôt + zápis do štatistiky
-- ------------------------------------------------------------
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
    select id, slot_date, exam_type_id, status, doctor from orders
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
revoke all on function purge_order_files(text) from public, anon, authenticated;
revoke all on function check_lookup_limit(text) from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('usg-cleanup');
exception when others then null;
end $$;
select cron.schedule('usg-cleanup', '0 1 * * *', $$select * from purge_orders()$$);

-- ------------------------------------------------------------
-- 7. MESAČNÝ PREHĽAD na odmeny (vykonané + zaplatené)
-- ------------------------------------------------------------
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
-- 8. TRVANIE VYŠETRENÍ (násobky 10-min slotu)
-- ------------------------------------------------------------
alter table pricelist add column if not exists duration_slots int not null default 1;
alter table pricelist drop constraint if exists pricelist_duration_slots_check;
alter table pricelist add constraint pricelist_duration_slots_check check (duration_slots between 1 and 12);
alter table orders add column if not exists duration_min int not null default 5;

-- Základná bunka = 5 minút. Ak databáza bežala so 10-min bunkou,
-- prepočíta trvania (×2) — len raz, stráži to settings.slot_base_min.
do $mig$
begin
  if coalesce((select value from settings where key = 'slot_base_min'), '10') <> '5' then
    update pricelist set duration_slots = least(duration_slots * 2, 12);
    insert into settings (key, value) values ('slot_base_min', '5')
    on conflict (key) do update set value = '5';
  end if;
end $mig$;

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

create or replace function get_booked_slots()
returns table (slot_date date, slot_time time)
language sql security definer set search_path = public as $$
  select o.slot_date, (o.slot_time + (n * 5) * interval '1 minute')::time
  from orders o, generate_series(0, greatest(o.duration_min / 5 - 1, 0)) n
  where o.status <> 'rejected' and o.slot_date >= current_date;
$$;

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
  v_dur := coalesce(v_item.duration_slots, 1) * 5;

  select count(*) into v_active
  from orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  -- testovacie číslo pracoviska je z limitu vyňaté (porovnáva sa
  -- posledných 9 číslic, pokryje 0917911202 aj +421917911202)
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky. Kontaktujte pracovisko.', v_active;
  end if;

  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  if p_slot_date < current_date then
    raise exception 'Termín v minulosti nie je možné objednať.';
  end if;

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
    coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''), p_slot_date, p_slot_time, p_variable_symbol,
    coalesce(v_doctor, ''), coalesce(p_attachments, '[]'::jsonb), v_dur
  );
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

update pricelist set duration_slots = v.d
from (values
  ('abdomen', 4), ('kidneys', 4), ('pelvis', 4), ('soft', 4),
  ('thyroid', 4), ('neck', 4), ('carotid', 4),
  ('upper1', 4), ('upper2', 6), ('lower1', 4), ('lower2', 6),
  ('renal', 6), ('aorta', 4), ('tos', 6),
  ('complete_vessels', 8), ('compressions', 12), ('consultation', 6)
) as v(id, d)
where pricelist.id = v.id and pricelist.duration_slots in (1, 2);

-- ------------------------------------------------------------
-- 9. PORADIE CENNÍKA: cievne vyšetrenia hore
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
-- 10. SPRÁVA POUŽÍVATEĽOV V APLIKÁCII (záložka Používatelia)
-- ------------------------------------------------------------
create or replace function list_staff()
returns table (email text, role text, doctor_name text)
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  return query
    select u.email::text,
           coalesce(r.role, '')::text,
           coalesce(r.doctor_name, '')::text
    from auth.users u
    left join staff_roles r on r.user_id = u.id
    order by u.email;
end $$;

create or replace function set_staff_role(p_email text, p_role text, p_doctor_name text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_my_email text;
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  if p_role not in ('superadmin', 'sestra', 'lekar') then
    raise exception 'Neznáma rola.';
  end if;
  if p_role = 'lekar' and coalesce(trim(p_doctor_name), '') = '' then
    raise exception 'Pri role lekár vyberte meno lekára.';
  end if;
  select u.id into v_uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if not found then
    raise exception 'Konto % neexistuje. Najprv ho pozvite v Supabase (Authentication → Users → Invite user).', p_email;
  end if;
  select u.email into v_my_email from auth.users u where u.id = auth.uid();
  if lower(v_my_email) = lower(trim(p_email)) and p_role <> 'superadmin' then
    raise exception 'Nemôžete si odobrať vlastnú rolu superadmina.';
  end if;
  insert into staff_roles (user_id, role, doctor_name)
  values (v_uid, p_role, case when p_role = 'lekar' then trim(p_doctor_name) else '' end)
  on conflict (user_id) do update
    set role = excluded.role, doctor_name = excluded.doctor_name;
end $$;

create or replace function remove_staff_role(p_email text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_my_email text;
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  select u.email into v_my_email from auth.users u where u.id = auth.uid();
  if lower(v_my_email) = lower(trim(p_email)) then
    raise exception 'Nemôžete odobrať rolu sám sebe.';
  end if;
  delete from staff_roles
  where user_id = (select id from auth.users where lower(email) = lower(trim(p_email)));
end $$;

revoke all on function list_staff() from public, anon;
revoke all on function set_staff_role(text, text, text) from public, anon;
revoke all on function remove_staff_role(text) from public, anon;
grant execute on function list_staff() to authenticated;
grant execute on function set_staff_role(text, text, text) to authenticated;
grant execute on function remove_staff_role(text) to authenticated;

-- ------------------------------------------------------------
-- 11. BOOTSTRAP: prvý superadmin (zmeňte e-mail, ak treba)
-- ------------------------------------------------------------
insert into staff_roles (user_id, role)
select id, 'superadmin' from auth.users where email = 'lukas.vincze@nusch.sk'
on conflict (user_id) do update set role = 'superadmin';

-- Kontrola na záver — má vrátiť vaše konto s rolou superadmin:
select u.email, r.role, r.doctor_name
from staff_roles r join auth.users u on u.id = r.user_id;
