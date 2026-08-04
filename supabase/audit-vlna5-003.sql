-- ============================================================
-- AUDIT VLNA 5 — 003  (CT hardening + retencia + poistky)
--
-- #2 (VYSOKÉ):  ct_create_order — IP rate-limit + strop 3 aktívnych
--               objednávok na telefón (ako USG create_order).
-- #7 (VYSOKÉ):  CT retencia PII + skartácia žiadanky pri zrušení
--               (ct_orders doteraz nemalo žiadny výmaz — GDPR).
-- #3 (poistka): vynútiť správny get_booked_slots (5-min krok) a
--               rozsah trvania cenníka 1..12 aj na starých DB, kde
--               nebežal complete-setup-002.
-- + sprísnenie upload politiky bucketu 'prilohy' na formát cesty.
--
-- Idempotentné. Bez kľúčov. Spúšťať PO ct-003 a audit-vlna4-001.
-- ============================================================

-- poistka: stĺpec kôš (ak by chýbal)
alter table ct_orders add column if not exists rejected_at timestamptz;

-- ------------------------------------------------------------
-- #2 — ct_create_order + IP rate-limit + strop na telefón
--      (telo zhodné s ct-003, doplnené dve brzdy)
-- ------------------------------------------------------------
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
  v_ip text := '';
  v_phone9 text;
  v_active int;
begin
  if p_id !~ '^CT-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;

  -- rate-limit podľa IP: brzda proti hromadnému zakladaniu objednávok
  -- (a tým e-mailovému spamu) z jedného zdroja
  begin
    v_ip := split_part(coalesce((current_setting('request.headers', true))::json ->> 'x-forwarded-for', ''), ',', 1);
  exception when others then
    v_ip := '';
  end;
  if v_ip <> '' then
    perform check_rate_limit('ct-create-ip:' || v_ip, 20);
  end if;

  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_insurance, '')) > 100
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;
  v_phone9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  -- strop aktívnych objednávok na jedno telefónne číslo (test. číslo bez limitu)
  select count(*) into v_active
  from ct_orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne CT objednávky.', v_active;
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

-- ------------------------------------------------------------
-- #7 — CT: skartácia žiadanky + PII pri zrušení a retenčný výmaz
-- ------------------------------------------------------------
create or replace function ct_purge_order_files(p_order_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from storage.objects
  where bucket_id = 'prilohy' and name like p_order_id || '/%';
end $$;
revoke all on function ct_purge_order_files(text) from public, anon, authenticated;

-- rozšírený scrub trigger: pri prechode do 'rejected' bezodkladne
-- zmaže prílohu (žiadanku) aj citlivé polia (BEFORE UPDATE)
create or replace function ct_scrub_trigger()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.status = 'rejected' and OLD.status <> 'rejected' then
    NEW.rejected_at := now();
    perform ct_purge_order_files(NEW.id);
    NEW.attachments := '[]'::jsonb;
    NEW.reason := '';
  elsif NEW.status <> 'rejected' and OLD.status = 'rejected' then
    NEW.rejected_at := null;
  end if;
  return NEW;
end $$;
drop trigger if exists ct_orders_scrub on ct_orders;
create trigger ct_orders_scrub before update on ct_orders
for each row execute function ct_scrub_trigger();

-- denný retenčný výmaz pre ct_orders (analóg purge_orders)
create or replace function ct_purge_orders()
returns table (scrubbed int, deleted int)
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_scrub int := 0;
  v_del int := 0;
begin
  -- a) žiadanky + dôvod: nevyužité/zrušené ihneď po termíne, ostatné do 7 dní
  for r in
    select id from ct_orders
    where (attachments <> '[]'::jsonb or reason <> '')
      and (
        (slot_date < current_date and status in ('new', 'rejected', 'noshow'))
        or slot_date <= current_date - 7
      )
  loop
    perform ct_purge_order_files(r.id);
    update ct_orders set attachments = '[]'::jsonb, reason = '' where id = r.id;
    v_scrub := v_scrub + 1;
  end loop;

  -- b) celý riadok (PII) 28 dní po termíne
  for r in
    select id from ct_orders where slot_date < current_date - 28
  loop
    perform ct_purge_order_files(r.id);
    delete from ct_orders where id = r.id;
    v_del := v_del + 1;
  end loop;

  return query select v_scrub, v_del;
end $$;
revoke all on function ct_purge_orders() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('ct-cleanup');
exception when others then null;
end $$;
select cron.schedule('ct-cleanup', '15 1 * * *', $$select * from ct_purge_orders()$$);

-- ------------------------------------------------------------
-- #3 (poistka) — správny get_booked_slots (5-min krok) + rozsah
--      trvania cenníka 1..12 aj na DB bez complete-setup-002
-- ------------------------------------------------------------
create or replace function get_booked_slots()
returns table (slot_date date, slot_time time)
language sql security definer set search_path = public stable as $$
  select o.slot_date, (o.slot_time + (n * 5) * interval '1 minute')::time
  from orders o, generate_series(0, greatest(o.duration_min / 5 - 1, 0)) n
  where o.status <> 'rejected';
$$;
revoke all on function get_booked_slots() from public;
grant execute on function get_booked_slots() to anon, authenticated;

alter table pricelist drop constraint if exists pricelist_duration_slots_check;
alter table pricelist add constraint pricelist_duration_slots_check check (duration_slots between 1 and 12);

-- ------------------------------------------------------------
-- Sprísnenie upload politiky bucketu 'prilohy': anon smie zapisovať
-- len na cesty v tvare USG-…/… alebo CT-…/… (nie ľubovoľné súbory)
-- ------------------------------------------------------------
drop policy if exists "prilohy upload" on storage.objects;
create policy "prilohy upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'prilohy' and name ~ '^(USG|CT)-[A-Za-z0-9-]+/');

-- Diagnostika #3 (spustite samostatne pre kontrolu pôvodného stavu):
--   select pg_get_functiondef('get_booked_slots()'::regprocedure);
-- ============================================================
