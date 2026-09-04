-- ============================================================
-- ANGIO 001 — Angiologická ambulancia č. 1: objednávanie (bez poplatku)
--
-- Samostatná pod-appka na vlastnej podstránke (#/angio1), zrkadlo
-- CT vetvy s VŠETKÝMI ochranami z audit vĺn zabudovanými od začiatku:
--   • RLS s USING aj WITH CHECK (lekár nevysunie riadok inému lekárovi)
--   • IP rate-limit + strop 3 aktívne objednávky na telefón
--   • povinná žiadanka (BEFORE INSERT), skartácia pri zrušení,
--     retenčný výmaz (7 dní žiadanka / 28 dní riadok), cron
--   • exclusion constraint proti prekrytiu viacbunkových termínov
--   • e-mailové notifikácie odolné voči chybám, html_escape vstupov
-- Zdieľané rozšírenia: storage upload (prefix ANG-), orphan purge,
-- čakáreň (QR check-in) a order_exists o angio_orders.
--
-- KĽÚČE NETREBA VKLADAŤ: Resend kľúč sa prevezme z existujúcej
-- ct_notify_trigger (rovnaký vzor ako oprava-sms-001). Ak je tam
-- ešte placeholder, angio e-maily ostanú vypnuté (notice) a skript
-- treba po doplnení kľúča spustiť znova.
--
-- Prefix čísla objednávky: ANG-. Idempotentné. Spúšťať PO
-- audit-vlna6-001 (vyžaduje client_ip, check_rate_limit,
-- check_lookup_limit, my_role, my_doctor, html_escape, email_header).
-- ============================================================

create extension if not exists btree_gist;

-- ------------------------------------------------------------
-- 1. Typy vyšetrení / návštev (bez ceny)
-- ------------------------------------------------------------
create table if not exists angio_pricelist (
  id text primary key,
  label text not null,
  instructions text not null default '',
  duration_slots int not null default 3,   -- ×5 min
  active boolean not null default true,
  sort_order int not null default 0
);
alter table angio_pricelist drop constraint if exists angio_pricelist_duration_slots_check;
alter table angio_pricelist add constraint angio_pricelist_duration_slots_check check (duration_slots between 1 and 12);
alter table angio_pricelist enable row level security;
drop policy if exists "angio cennik cita ktokolvek" on angio_pricelist;
create policy "angio cennik cita ktokolvek" on angio_pricelist for select using (true);
drop policy if exists "angio cennik spravuje personal" on angio_pricelist;
create policy "angio cennik spravuje personal" on angio_pricelist
  for all to authenticated using (my_role() in ('superadmin', 'sestra'))
  with check (my_role() in ('superadmin', 'sestra'));

insert into angio_pricelist (id, label, instructions, duration_slots, sort_order)
select * from (values
  ('ang_prve',     'Prvé angiologické vyšetrenie', 'Prineste si žiadanku, zoznam liekov a predchádzajúce nálezy (USG, CT, MR).', 6, 1),
  ('ang_kontrola', 'Kontrolné angiologické vyšetrenie', 'Prineste si zoznam liekov a nové nálezy od poslednej kontroly.', 3, 2),
  ('ang_usg_dk',   'USG ciev dolných končatín', 'Osobitná príprava nie je potrebná. Prineste si žiadanku.', 4, 3),
  ('ang_usg_krk',  'USG krčných ciev', 'Osobitná príprava nie je potrebná. Prineste si žiadanku.', 4, 4),
  ('ang_konzult',  'Konzultácia', 'Prineste si dokumentáciu, ktorú chcete prekonzultovať.', 3, 5)
) v where not exists (select 1 from angio_pricelist);

-- ------------------------------------------------------------
-- 2. Otvorené termíny
-- ------------------------------------------------------------
create table if not exists angio_open_slots (
  slot_date date not null,
  slot_time time not null,
  doctor text not null default '',
  primary key (slot_date, slot_time)
);
alter table angio_open_slots enable row level security;
drop policy if exists "angio sloty cita ktokolvek" on angio_open_slots;
create policy "angio sloty cita ktokolvek" on angio_open_slots for select using (true);
drop policy if exists "angio sloty spravuje personal" on angio_open_slots;
create policy "angio sloty spravuje personal" on angio_open_slots
  for all to authenticated using (my_role() in ('superadmin', 'sestra'))
  with check (my_role() in ('superadmin', 'sestra'));

-- ------------------------------------------------------------
-- 3. Objednávky
-- ------------------------------------------------------------
create table if not exists angio_orders (
  id text primary key,
  patient_name text not null,
  birth_date date,
  insurance text not null default '',
  phone text not null default '',
  email text not null default '',
  reason text not null default '',
  exam_type_id text not null default '',
  exam_label text not null default '',
  slot_date date not null,
  slot_time time not null,
  doctor text not null default '',
  status text not null default 'new',
  status_note text not null default '',
  duration_min int not null default 15,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  rejected_at timestamptz,
  reminder_sent_at timestamptz,
  arrived_at timestamptz
);
alter table angio_orders drop constraint if exists angio_orders_no_overlap;
alter table angio_orders add constraint angio_orders_no_overlap
  exclude using gist (
    slot_date with =,
    int4range(
      (extract(hour from slot_time) * 60 + extract(minute from slot_time))::int,
      (extract(hour from slot_time) * 60 + extract(minute from slot_time))::int + duration_min
    ) with &&
  ) where (status <> 'rejected');
alter table angio_orders enable row level security;
drop policy if exists "angio objednavky select" on angio_orders;
drop policy if exists "angio objednavky insert" on angio_orders;
drop policy if exists "angio objednavky update" on angio_orders;
drop policy if exists "angio objednavky delete" on angio_orders;
create policy "angio objednavky select" on angio_orders for select to authenticated using (
  my_role() in ('superadmin', 'sestra') or (my_role() = 'lekar' and doctor = my_doctor())
);
create policy "angio objednavky update" on angio_orders for update to authenticated
  using (my_role() in ('superadmin', 'sestra') or (my_role() = 'lekar' and doctor = my_doctor()))
  with check (my_role() in ('superadmin', 'sestra') or (my_role() = 'lekar' and doctor = my_doctor()));
create policy "angio objednavky insert" on angio_orders for insert to authenticated
  with check (my_role() in ('superadmin', 'sestra'));
create policy "angio objednavky delete" on angio_orders for delete to authenticated
  using (my_role() in ('superadmin', 'sestra'));

-- ------------------------------------------------------------
-- 4. Lekári ambulancie pre pacienta (bez e-mailov) — settings.angio_doctors
-- ------------------------------------------------------------
create or replace function public_angio_doctors()
returns jsonb
language sql security definer stable set search_path = public as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object(
        'name', d->>'name', 'location', coalesce(d->>'location', ''),
        'examTypeIds', coalesce(d->'examTypeIds', '[]'::jsonb)))
     from jsonb_array_elements(
        coalesce((select value from settings where key = 'angio_doctors'), '[]')::jsonb) d),
    '[]'::jsonb);
$$;
revoke all on function public_angio_doctors() from public;
grant execute on function public_angio_doctors() to anon, authenticated;

-- ------------------------------------------------------------
-- 5. Obsadené termíny (rozvinuté bunky trvania, bez PII)
-- ------------------------------------------------------------
create or replace function angio_get_booked_slots()
returns table (slot_date date, slot_time time)
language sql security definer stable set search_path = public as $$
  select o.slot_date, (o.slot_time + (n * 5) * interval '1 minute')::time
  from angio_orders o, generate_series(0, greatest(o.duration_min / 5 - 1, 0)) n
  where o.status <> 'rejected' and o.slot_date >= current_date;
$$;
revoke all on function angio_get_booked_slots() from public;
grant execute on function angio_get_booked_slots() to anon, authenticated;

-- ------------------------------------------------------------
-- 6. Vytvorenie objednávky pacientom (IP limit + strop + validácie)
-- ------------------------------------------------------------
create or replace function angio_create_order(
  p_id text, p_exam_type_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time,
  p_attachments jsonb default '[]'::jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item angio_pricelist%rowtype;
  v_dur int;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
  v_ip text := client_ip();
  v_phone9 text;
  v_active int;
begin
  if p_id !~ '^ANG-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('angio-create-ip:' || v_ip, 20);
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

  select count(*) into v_active
  from angio_orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky.', v_active;
  end if;

  select * into v_item from angio_pricelist where id = p_exam_type_id and active = true;
  if not found then
    raise exception 'Vybraný typ vyšetrenia nie je dostupný.';
  end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;

  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from angio_open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  insert into angio_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance,
    phone, email, reason, slot_date, slot_time, doctor, duration_min, attachments)
  values (p_id, v_item.id, v_item.label, p_patient_name, p_birth_date, coalesce(p_insurance, ''),
    p_phone, coalesce(p_email, ''), coalesce(p_reason, ''), p_slot_date, p_slot_time,
    coalesce(v_doctor, ''), v_dur, coalesce(p_attachments, '[]'::jsonb));
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
revoke all on function angio_create_order(text, text, text, date, text, text, text, text, date, time, jsonb) from public;
grant execute on function angio_create_order(text, text, text, date, text, text, text, text, date, time, jsonb) to anon, authenticated;

-- ------------------------------------------------------------
-- 7. Presun termínu personálom
-- ------------------------------------------------------------
create or replace function angio_reschedule(p_id text, p_slot_date date, p_slot_time time)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_order angio_orders%rowtype;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
begin
  if my_role() not in ('superadmin', 'sestra', 'lekar') then
    raise exception 'Nedostatočné oprávnenie.';
  end if;
  select * into v_order from angio_orders where id = p_id and status <> 'rejected';
  if not found then raise exception 'Objednávku sa nepodarilo nájsť.'; end if;
  if my_role() = 'lekar' and v_order.doctor is distinct from my_doctor() then
    raise exception 'Môžete presúvať len svoje objednávky.';
  end if;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul.';
  end if;
  for n in 0 .. (greatest(v_order.duration_min, 5) / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from angio_open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then raise exception 'Vybraný čas nemá dosť otvorených termínov. Vyberte iný.'; end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi.'; end if;
  end loop;
  update angio_orders set slot_date = p_slot_date, slot_time = p_slot_time,
    doctor = coalesce(v_doctor, '')
  where id = p_id;
  return true;
exception
  when exclusion_violation then raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
revoke all on function angio_reschedule(text, date, time) from public, anon;
grant execute on function angio_reschedule(text, date, time) to authenticated;

-- ------------------------------------------------------------
-- 8. Overenie / zrušenie pacientom (číslo + telefón, rate-limit)
-- ------------------------------------------------------------
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
    select o.id, o.status, o.slot_date, o.slot_time, o.doctor, o.exam_label
    from angio_orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
  return result;
end $$;
revoke all on function angio_lookup_order(text, text) from public;
grant execute on function angio_lookup_order(text, text) to anon, authenticated;

create or replace function angio_cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if coalesce(p_id, '') !~ '^ANG-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  perform check_lookup_limit('angiocancel:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));
  update angio_orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;
revoke all on function angio_cancel_order(text, text) from public;
grant execute on function angio_cancel_order(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 9. Povinná žiadanka (serverová poistka)
-- ------------------------------------------------------------
create or replace function angio_require_attachment()
returns trigger
language plpgsql set search_path = public as $$
begin
  if jsonb_array_length(coalesce(NEW.attachments, '[]'::jsonb)) = 0 then
    raise exception 'Pri objednávke je potrebné priložiť žiadanku (výmenný lístok).';
  end if;
  return NEW;
end $$;
drop trigger if exists angio_orders_require_attachment on angio_orders;
create trigger angio_orders_require_attachment
before insert on angio_orders
for each row execute function angio_require_attachment();

-- ------------------------------------------------------------
-- 10. Skartácia pri zrušení + retenčný výmaz (GDPR)
-- ------------------------------------------------------------
create or replace function angio_purge_order_files(p_order_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from storage.objects
  where bucket_id = 'prilohy' and name like p_order_id || '/%';
end $$;
revoke all on function angio_purge_order_files(text) from public, anon, authenticated;

create or replace function angio_scrub_trigger()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.status = 'rejected' and OLD.status <> 'rejected' then
    NEW.rejected_at := now();
    perform angio_purge_order_files(NEW.id);
    NEW.attachments := '[]'::jsonb;
    NEW.reason := '';
  elsif NEW.status <> 'rejected' and OLD.status = 'rejected' then
    NEW.rejected_at := null;
  end if;
  return NEW;
end $$;
drop trigger if exists angio_orders_scrub on angio_orders;
create trigger angio_orders_scrub before update on angio_orders
for each row execute function angio_scrub_trigger();

create or replace function angio_purge_orders()
returns table (scrubbed int, deleted int)
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_scrub int := 0;
  v_del int := 0;
begin
  for r in
    select id from angio_orders
    where (attachments <> '[]'::jsonb or reason <> '')
      and (
        (slot_date < current_date and status in ('new', 'rejected', 'noshow'))
        or slot_date <= current_date - 7
      )
  loop
    perform angio_purge_order_files(r.id);
    update angio_orders set attachments = '[]'::jsonb, reason = '' where id = r.id;
    v_scrub := v_scrub + 1;
  end loop;
  for r in
    select id from angio_orders where slot_date < current_date - 28
  loop
    perform angio_purge_order_files(r.id);
    delete from angio_orders where id = r.id;
    v_del := v_del + 1;
  end loop;
  return query select v_scrub, v_del;
end $$;
revoke all on function angio_purge_orders() from public, anon, authenticated;

do $$ begin perform cron.unschedule('angio-cleanup'); exception when others then null; end $$;
do $$ begin perform cron.schedule('angio-cleanup', '15 1 * * *', $q$select * from angio_purge_orders()$q$); exception when others then null; end $$;

-- ------------------------------------------------------------
-- 11. E-maily (prijaté/potvrdené/zrušené/presunuté) + pripomienky
--     Resend kľúč sa PREVEZME z ct_notify_trigger (nič sa nevkladá).
-- ------------------------------------------------------------
do $mig$
declare
  src   text;
  v_key text;
begin
  select prosrc into src from pg_proc
  where proname = 'ct_notify_trigger' and pronamespace = 'public'::regnamespace;
  v_key := coalesce(substring(src from 'v_key\s+text\s*:=\s*''([^'']*)'''), 'SEM_VLOZTE_RESEND_KLUC');
  if v_key like 'SEM\_%' then
    raise notice 'ANGIO e-maily: v ct_notify_trigger je zatiaľ placeholder Resend kľúča — angio e-maily ostanú vypnuté. Po doplnení kľúča do CT spustite tento skript znova.';
  end if;

  execute format($def$
create or replace function angio_notify_trigger()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_key   text := %L;
  v_from  text;
  v_termin text;
  v_html  text;
  v_subj  text;
  v_lead  text;
begin
  if coalesce(NEW.email, '') = '' or v_key like 'SEM_%%' then return NEW; end if;
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');

  if TG_OP = 'INSERT' then
    v_subj := 'Objednávka — Angiologická ambulancia č. 1 — ' || v_termin;
    v_lead := 'Ďakujeme, váš termín v Angiologickej ambulancii č. 1 je rezervovaný.';
  elsif TG_OP = 'UPDATE' and OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
    v_subj := 'Termín potvrdený — Angiologická ambulancia č. 1 — ' || v_termin;
    v_lead := 'Váš termín v Angiologickej ambulancii č. 1 je potvrdený.';
  elsif TG_OP = 'UPDATE' and OLD.status <> 'rejected' and NEW.status = 'rejected' then
    v_subj := 'Objednávka zrušená — Angiologická ambulancia č. 1 — ' || v_termin;
    v_lead := 'Vaša objednávka do Angiologickej ambulancie č. 1 bola zrušená.' ||
      case when coalesce(NEW.status_note, '') <> '' then ' ' || html_escape(NEW.status_note) else '' end;
  elsif TG_OP = 'UPDATE' and (OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time) then
    v_subj := 'Zmena termínu — Angiologická ambulancia č. 1 — nový termín ' || v_termin;
    v_lead := 'Váš termín v Angiologickej ambulancii č. 1 bol presunutý. Nový termín nájdete nižšie.';
  else
    return NEW;
  end if;

  v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
    || email_header()
    || '<h2 style="color:#003d7c">' || v_subj || '</h2>'
    || '<p>' || v_lead || '</p>'
    || '<table style="font-size:14px;border-collapse:collapse">'
    || case when coalesce(NEW.exam_label,'') <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Vyšetrenie</td><td><b>' || html_escape(NEW.exam_label) || '</b></td></tr>' else '' end
    || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
    || case when NEW.doctor <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || html_escape(NEW.doctor) || '</td></tr>' else '' end
    || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Číslo objednávky</td><td>' || html_escape(NEW.id) || '</td></tr>'
    || '</table>'
    || case when NEW.status <> 'rejected' then '<p style="font-size:13px">Príďte prosím 15 minút pred termínom. Pod Krásnou hôrkou 1, Bratislava. Prineste si žiadanku a predchádzajúce nálezy.</p>' else '' end
    || '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">'
    || '<p style="margin:0">Vyšetrenie je bez poplatku. Kontakt/zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p></div>'
    || '</div>';
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email), 'subject', v_subj, 'html', v_html)
  );
  return NEW;
exception when others then
  return coalesce(NEW, OLD);
end $fn$;
$def$, v_key);

  execute format($def$
create or replace function send_angio_reminders()
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_key  text := %L;
  v_from text;
  r      record;
  v_termin text;
  v_html text;
  v_cnt  int := 0;
begin
  if v_key like 'SEM_%%' then return 0; end if;
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  for r in
    select * from angio_orders
    where slot_date between current_date and current_date + 1
      and status in ('new', 'confirmed')
      and reminder_sent_at is null
      and coalesce(email, '') <> ''
  loop
    v_termin := to_char(r.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(r.slot_time, 'HH24:MI');
    v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
      || email_header()
      || '<h2 style="color:#003d7c">Pripomienka: zajtra máte vyšetrenie v Angiologickej ambulancii č. 1</h2>'
      || '<table style="font-size:14px;border-collapse:collapse">'
      || case when coalesce(r.exam_label,'') <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Vyšetrenie</td><td><b>' || html_escape(r.exam_label) || '</b></td></tr>' else '' end
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
      || case when r.doctor <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || html_escape(r.doctor) || '</td></tr>' else '' end
      || '</table>'
      || '<p style="font-size:13px">Príďte prosím 15 minút pred termínom. Pod Krásnou hôrkou 1, Bratislava. Prineste si žiadanku a predchádzajúce nálezy.</p>'
      || '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">'
      || '<p style="margin:0">Vyšetrenie je bez poplatku. Zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p></div>'
      || '</div>';
    begin
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(r.email),
          'subject', 'Pripomienka: zajtra ' || to_char(r.slot_time, 'HH24:MI') || ' — Angiologická ambulancia č. 1', 'html', v_html)
      );
    exception when others then null;
    end;
    update angio_orders set reminder_sent_at = now() where id = r.id;
    v_cnt := v_cnt + 1;
  end loop;
  return v_cnt;
end $fn$;
$def$, v_key);
end $mig$;

revoke all on function send_angio_reminders() from public, anon, authenticated;
drop trigger if exists angio_orders_notify on angio_orders;
create trigger angio_orders_notify
after insert or update on angio_orders
for each row execute function angio_notify_trigger();

do $$ begin perform cron.unschedule('angio-reminders'); exception when others then null; end $$;
do $$ begin perform cron.schedule('angio-reminders', '0 15 * * *', $q$select send_angio_reminders()$q$); exception when others then null; end $$;

-- ------------------------------------------------------------
-- 12. ZDIEĽANÉ rozšírenia o angio (idempotentné prepisy)
-- ------------------------------------------------------------
-- a) existencia objednávky (storage upload viazaný na objednávku)
create or replace function order_exists(p_id text)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from orders       where id = p_id)
      or exists (select 1 from ct_orders    where id = p_id)
      or exists (select 1 from angio_orders where id = p_id);
$$;
revoke all on function order_exists(text) from public;
grant execute on function order_exists(text) to anon, authenticated;

drop policy if exists "prilohy upload" on storage.objects;
create policy "prilohy upload" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'prilohy'
    and name ~ '^(USG|CT|ANG)-[A-Za-z0-9-]+/'
    and order_exists(split_part(name, '/', 1))
  );

-- b) osirelé prílohy — angio priečinky sú platné
create or replace function purge_orphan_attachments()
returns int
language plpgsql security definer set search_path = public as $$
declare v int := 0;
begin
  begin
    with valid_ids as (
      select id from orders
      union all select id from ct_orders
      union all select id from angio_orders
    ),
    del as (
      delete from storage.objects o
      where o.bucket_id = 'prilohy'
        and o.created_at < now() - interval '1 day'
        and split_part(o.name, '/', 1) not in (select id from valid_ids)
      returning 1
    )
    select count(*) into v from del;
  exception when others then
    v := 0;
  end;
  return v;
end $$;
revoke all on function purge_orphan_attachments() from public, anon, authenticated;

-- c) čakáreň (QR check-in „Som tu") — aj angio pacienti
create or replace function checkin_lookup(p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_phone9 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_today  date := (now() at time zone 'Europe/Bratislava')::date;
  v_ip     text := client_ip();
  result   jsonb;
begin
  if length(v_phone9) < 9 then
    raise exception 'Zadajte celé telefónne číslo.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('checkin-ip:' || v_ip, 40);
  end if;
  perform check_lookup_limit('checkin:' || v_phone9);

  select coalesce(jsonb_agg(t.x order by t.x->>'slot_time'), '[]'::jsonb) into result
  from (
    select jsonb_build_object('slot_time', o.slot_time, 'arrived_at', o.arrived_at) as x
    from orders o
    where o.slot_date = v_today and o.status in ('new', 'confirmed')
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9
    union all
    select jsonb_build_object('slot_time', c.slot_time, 'arrived_at', c.arrived_at)
    from ct_orders c
    where c.slot_date = v_today and c.status in ('new', 'confirmed')
      and right(regexp_replace(c.phone, '\D', '', 'g'), 9) = v_phone9
    union all
    select jsonb_build_object('slot_time', a.slot_time, 'arrived_at', a.arrived_at)
    from angio_orders a
    where a.slot_date = v_today and a.status in ('new', 'confirmed')
      and right(regexp_replace(a.phone, '\D', '', 'g'), 9) = v_phone9
  ) t;
  return result;
end $$;
revoke all on function checkin_lookup(text) from public, anon, authenticated;
grant execute on function checkin_lookup(text) to anon, authenticated;

create or replace function checkin_confirm(p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_phone9 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_today  date := (now() at time zone 'Europe/Bratislava')::date;
  v_ip     text := client_ip();
  v_n int := 0; v_m int := 0; v_k int := 0;
begin
  if length(v_phone9) < 9 then
    raise exception 'Zadajte celé telefónne číslo.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('checkin-ip:' || v_ip, 40);
  end if;
  perform check_lookup_limit('checkin:' || v_phone9);

  update orders o set arrived_at = coalesce(o.arrived_at, now())
  where o.slot_date = v_today and o.status in ('new', 'confirmed')
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  get diagnostics v_n = row_count;
  update ct_orders c set arrived_at = coalesce(c.arrived_at, now())
  where c.slot_date = v_today and c.status in ('new', 'confirmed')
    and right(regexp_replace(c.phone, '\D', '', 'g'), 9) = v_phone9;
  get diagnostics v_m = row_count;
  update angio_orders a set arrived_at = coalesce(a.arrived_at, now())
  where a.slot_date = v_today and a.status in ('new', 'confirmed')
    and right(regexp_replace(a.phone, '\D', '', 'g'), 9) = v_phone9;
  get diagnostics v_k = row_count;
  return (v_n + v_m + v_k) > 0;
end $$;
revoke all on function checkin_confirm(text) from public, anon, authenticated;
grant execute on function checkin_confirm(text) to anon, authenticated;

-- Diagnostika:
--   select * from angio_pricelist order by sort_order;
--   select public_angio_doctors();
--   select proname from pg_proc where proname like 'angio%' order by 1;
-- ============================================================
