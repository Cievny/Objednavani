-- ============================================================
-- CT 002 — plná CT vetva na úrovni USG (bez poplatku)
--   • ct_pricelist: typy CT vyšetrení (názov, trvanie, pokyny)
--   • ct_doctors (settings): samostatný zoznam CT lekárov
--   • ct_orders: + typ vyšetrenia, viacbunkové trvanie, exclusion
--   • roly: superadmin/sestra spravujú, lekár vidí/mení svoje
--   • e-maily: prijaté / potvrdené / zrušené / presunuté
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_RESEND_KLUC.
-- Idempotentné. Spúšťať PO podappky-001.
-- ============================================================

create extension if not exists btree_gist;

-- ------------------------------------------------------------
-- 1. Typy CT vyšetrení (bez ceny)
-- ------------------------------------------------------------
create table if not exists ct_pricelist (
  id text primary key,
  label text not null,
  instructions text not null default '',
  duration_slots int not null default 3,   -- ×5 min (default 15 min)
  active boolean not null default true,
  sort_order int not null default 0
);
alter table ct_pricelist enable row level security;
drop policy if exists "ct cennik cita ktokolvek" on ct_pricelist;
create policy "ct cennik cita ktokolvek" on ct_pricelist for select using (true);
drop policy if exists "ct cennik spravuje personal" on ct_pricelist;
create policy "ct cennik spravuje personal" on ct_pricelist
  for all to authenticated using (my_role() in ('superadmin', 'sestra'))
  with check (my_role() in ('superadmin', 'sestra'));

-- predvyplnené typy (len ak je tabuľka prázdna)
insert into ct_pricelist (id, label, instructions, duration_slots, sort_order)
select * from (values
  ('ct_hlava',   'CT hlavy / mozgu', 'Osobitná príprava nie je potrebná. Prineste si žiadanku a predchádzajúce nálezy.', 3, 1),
  ('ct_hrudnik', 'CT hrudníka', 'Prineste si žiadanku a predchádzajúce snímky. Riaďte sa pokynmi personálu.', 3, 2),
  ('ct_brucho',  'CT brucha a malej panvy', 'Príďte nalačno (min. 4 hodiny nejedzte). Prineste si žiadanku.', 4, 3),
  ('ct_angio',   'CT angiografia', 'Príďte nalačno. Potrebná je funkčná obličková funkcia (kreatinín). Prineste žiadanku a nálezy.', 4, 4),
  ('ct_chrbtica','CT chrbtice', 'Osobitná príprava nie je potrebná. Prineste si žiadanku.', 3, 5)
) v where not exists (select 1 from ct_pricelist);

-- ------------------------------------------------------------
-- 2. ct_orders — doplniť typ vyšetrenia (viacbunkové trvanie už má
--    stĺpec duration_min); nahradiť diskrétny unikát exclusion cons.
-- ------------------------------------------------------------
alter table ct_orders add column if not exists exam_type_id text not null default '';
alter table ct_orders add column if not exists exam_label text not null default '';

drop index if exists ct_orders_slot_uniq;
alter table ct_orders drop constraint if exists ct_orders_no_overlap;
alter table ct_orders add constraint ct_orders_no_overlap
  exclude using gist (
    slot_date with =,
    int4range(
      (extract(hour from slot_time) * 60 + extract(minute from slot_time))::int,
      (extract(hour from slot_time) * 60 + extract(minute from slot_time))::int + duration_min
    ) with &&
  ) where (status <> 'rejected');

-- ------------------------------------------------------------
-- 3. RLS ct_orders — superadmin/sestra všetko, lekár len svoje
-- ------------------------------------------------------------
drop policy if exists "ct objednavky spravuje personal" on ct_orders;
drop policy if exists "ct objednavky select" on ct_orders;
drop policy if exists "ct objednavky insert" on ct_orders;
drop policy if exists "ct objednavky update" on ct_orders;
drop policy if exists "ct objednavky delete" on ct_orders;
create policy "ct objednavky select" on ct_orders for select using (
  my_role() in ('superadmin', 'sestra') or (my_role() = 'lekar' and doctor = my_doctor())
);
create policy "ct objednavky update" on ct_orders for update using (
  my_role() in ('superadmin', 'sestra') or (my_role() = 'lekar' and doctor = my_doctor())
);
create policy "ct objednavky insert" on ct_orders for insert with check (my_role() in ('superadmin', 'sestra'));
create policy "ct objednavky delete" on ct_orders for delete using (my_role() in ('superadmin', 'sestra'));

-- ------------------------------------------------------------
-- 4. CT lekári pre pacienta (bez e-mailov) — z settings.ct_doctors
-- ------------------------------------------------------------
create or replace function public_ct_doctors()
returns jsonb
language sql security definer stable set search_path = public as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object(
        'name', d->>'name', 'location', coalesce(d->>'location', ''),
        'examTypeIds', coalesce(d->'examTypeIds', '[]'::jsonb)))
     from jsonb_array_elements(
        coalesce((select value from settings where key = 'ct_doctors'), '[]')::jsonb) d),
    '[]'::jsonb);
$$;
grant execute on function public_ct_doctors() to anon, authenticated;

-- ------------------------------------------------------------
-- 5. Obsadené CT termíny (rozvinuté bunky trvania, bez PII)
-- ------------------------------------------------------------
create or replace function ct_get_booked_slots()
returns table (slot_date date, slot_time time)
language sql security definer set search_path = public as $$
  select o.slot_date, (o.slot_time + (n * 5) * interval '1 minute')::time
  from ct_orders o, generate_series(0, greatest(o.duration_min / 5 - 1, 0)) n
  where o.status <> 'rejected' and o.slot_date >= current_date;
$$;
grant execute on function ct_get_booked_slots() to anon, authenticated;

-- ------------------------------------------------------------
-- 6. Vytvorenie CT objednávky (typ vyšetrenia + viacbunkové trvanie)
-- ------------------------------------------------------------
create or replace function ct_create_order(
  p_id text, p_exam_type_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time
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
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;
  if length(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9)) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
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
    phone, email, reason, slot_date, slot_time, doctor, duration_min)
  values (p_id, v_item.id, v_item.label, p_patient_name, p_birth_date, coalesce(p_insurance, ''),
    p_phone, coalesce(p_email, ''), coalesce(p_reason, ''), p_slot_date, p_slot_time,
    coalesce(v_doctor, ''), v_dur);
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
grant execute on function ct_create_order(text, text, text, date, text, text, text, text, date, time) to anon, authenticated;

-- ------------------------------------------------------------
-- 7. Presun CT termínu personálom (viacbunkové trvanie)
-- ------------------------------------------------------------
create or replace function ct_reschedule(p_id text, p_slot_date date, p_slot_time time)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_order ct_orders%rowtype;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
begin
  if my_role() not in ('superadmin', 'sestra', 'lekar') then
    raise exception 'Nedostatočné oprávnenie.';
  end if;
  select * into v_order from ct_orders where id = p_id and status <> 'rejected';
  if not found then raise exception 'Objednávku sa nepodarilo nájsť.'; end if;
  if my_role() = 'lekar' and v_order.doctor is distinct from my_doctor() then
    raise exception 'Môžete presúvať len svoje objednávky.';
  end if;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul.';
  end if;
  for n in 0 .. (greatest(v_order.duration_min, 5) / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from ct_open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then raise exception 'Vybraný čas nemá dosť otvorených termínov. Vyberte iný.'; end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi.'; end if;
  end loop;
  update ct_orders set slot_date = p_slot_date, slot_time = p_slot_time,
    doctor = coalesce(v_doctor, ''),
    status = case when status = 'confirmed' then 'confirmed' else status end
  where id = p_id;
  return true;
exception
  when exclusion_violation then raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
grant execute on function ct_reschedule(text, date, time) to authenticated;

-- ------------------------------------------------------------
-- 8. lookup / cancel pacientom (bez zmeny — ostávajú z podappky-001)
--    tu len doplníme kôš: rejected_at sa nastaví pri zrušení nižšie
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 9. E-maily: prijaté / potvrdené / zrušené / presunuté
-- ------------------------------------------------------------
create or replace function ct_notify_trigger()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_key   text := 'SEM_VLOZTE_RESEND_KLUC';
  v_from  text;
  v_termin text;
  v_html  text;
  v_subj  text;
  v_lead  text;
begin
  if coalesce(NEW.email, '') = '' or v_key like 'SEM_%' then return NEW; end if;
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');

  if TG_OP = 'INSERT' then
    v_subj := 'Objednávka na CT — ' || v_termin;
    v_lead := 'Ďakujeme, váš termín na CT vyšetrenie je rezervovaný.';
  elsif TG_OP = 'UPDATE' and OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
    v_subj := 'CT termín potvrdený — ' || v_termin;
    v_lead := 'Váš termín na CT vyšetrenie je potvrdený.';
  elsif TG_OP = 'UPDATE' and OLD.status <> 'rejected' and NEW.status = 'rejected' then
    v_subj := 'CT objednávka zrušená — ' || v_termin;
    v_lead := 'Vaša objednávka na CT vyšetrenie bola zrušená.' ||
      case when coalesce(NEW.status_note, '') <> '' then ' ' || NEW.status_note else '' end;
  elsif TG_OP = 'UPDATE' and (OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time) then
    v_subj := 'Zmena CT termínu — nový termín ' || v_termin;
    v_lead := 'Váš termín na CT vyšetrenie bol presunutý. Nový termín nájdete nižšie.';
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
    || case when NEW.status <> 'rejected' then '<p style="font-size:13px">Príďte prosím 15 minút pred termínom. Pod Krásnou hôrkou 1, Bratislava.</p>' else '' end
    || '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">'
    || '<p style="margin:0">CT vyšetrenie je bez poplatku. Kontakt/zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p></div>'
    || '</div>';
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email), 'subject', v_subj, 'html', v_html)
  );
  return NEW;
end $fn$;

-- status_note stĺpec + kôš (rejected_at sa už nastavuje v ct_cancel_order;
-- pri zrušení personálom nastavíme cez trigger nižšie)
alter table ct_orders add column if not exists status_note text not null default '';

create or replace function ct_scrub_trigger()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.status = 'rejected' and OLD.status <> 'rejected' then NEW.rejected_at := now();
  elsif NEW.status <> 'rejected' and OLD.status = 'rejected' then NEW.rejected_at := null;
  end if;
  return NEW;
end $$;
drop trigger if exists ct_orders_scrub on ct_orders;
create trigger ct_orders_scrub before update on ct_orders
for each row execute function ct_scrub_trigger();

drop trigger if exists ct_orders_notify on ct_orders;
create trigger ct_orders_notify after insert or update on ct_orders
for each row execute function ct_notify_trigger();

-- Diagnostika:
--   select * from ct_pricelist order by sort_order;
--   select public_ct_doctors();
-- ============================================================
