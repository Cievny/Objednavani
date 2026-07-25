-- ============================================================
-- AMBULANCIA 001 — miesto vyšetrenia (ambulancia lekára)
-- v e-mailoch, SMS a pripomienkach + predvyplnenie štandardnej
-- prípravy do cenníka.
--
-- Ambulancia sa nastavuje v správe objednávok: Nastavenia →
-- Lekári → pole „Ambulancia / miesto vyšetrenia" (od v15).
-- Uložená je v settings.doctors ako pole "location".
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_RESEND_KLUC svojím kľúčom.
-- Skript je idempotentný.
-- ============================================================

-- Pomocná funkcia: ambulancia lekára podľa mena (zo settings.doctors)
create or replace function doctor_location(p_doctor text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((
    select d->>'location'
    from settings s, jsonb_array_elements(s.value::jsonb) d
    where s.key = 'doctors' and d->>'name' = p_doctor
    limit 1
  ), '');
$$;

-- ------------------------------------------------------------
-- 1. E-maily: riadok „Miesto" v rezervačnom a potvrdzovacom
--    e-maile (plná verzia funkcie — nahrádza predchádzajúcu)
-- ------------------------------------------------------------
create or replace function notify_order_emails()
returns trigger
language plpgsql security definer set search_path = public as $func$
declare
  v_key     text := 'SEM_VLOZTE_RESEND_KLUC';
  v_from    text;
  v_iban    text;
  v_notify  text;
  v_termin  text;
  v_price   text;
  v_html    text;
  v_instr   text;
  v_instr_html text := '';
  v_docmail text;
  v_name    text;
  v_exam    text;
  v_doc     text;
  v_ambul   text;
  v_ambul_row text := '';
begin
  select value into v_from   from settings where key = 'mail_from';
  if v_from is null or v_from = '' then
    v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>';
  end if;
  select value into v_iban   from settings where key = 'iban';
  select value into v_notify from settings where key = 'notify_email';
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  v_price  := replace(to_char(NEW.price, 'FM990D00'), '.', ',') || ' €';
  v_name := html_escape(NEW.patient_name);
  v_exam := html_escape(NEW.exam_label);
  v_doc  := html_escape(NEW.doctor);
  v_ambul := doctor_location(NEW.doctor);
  if v_ambul <> '' then
    v_ambul_row := '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Miesto</td><td><b>' || html_escape(v_ambul) || '</b></td></tr>';
  end if;

  if TG_OP = 'INSERT' then
    select p.instructions into v_instr from pricelist p where p.id = NEW.exam_type_id;
    if v_instr is not null and v_instr <> '' then
      v_instr_html := '<div style="background:#eff6ff;border-left:4px solid #005ca9;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:12px"><b style="color:#003d7c">Pokyny k vyšetreniu</b><br>'
        || replace(html_escape(v_instr), chr(10), '<br>') || '</div>';
    end if;

    if NEW.email <> '' then
      v_html :=
        '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
        || '<div style="border-bottom:3px solid #e2001a;padding-bottom:12px;margin-bottom:16px">'
        || '<b style="color:#003d7c">Národný ústav srdcových a cievnych chorôb, a.s.</b><br>'
        || '<span style="color:#64748b;font-size:12px">Objednávanie na USG</span></div>'
        || '<h2 style="color:#003d7c">Rezervácia prijatá — čaká na platbu</h2>'
        || '<p>Ďakujeme za objednávku. Termín je rezervovaný a bude potvrdený po prijatí platby.</p>'
        || '<table style="font-size:14px;border-collapse:collapse">'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Vyšetrenie</td><td><b>' || v_exam || '</b></td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
        || case when NEW.doctor <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || v_doc || '</td></tr>' else '' end
        || v_ambul_row
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">' || case when NEW.has_referral then 'Doplatok' else 'Cena' end || '</td><td><b>' || v_price || '</b></td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">IBAN</td><td>' || html_escape(coalesce(v_iban, '')) || '</td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Variabilný symbol</td><td>' || html_escape(NEW.variable_symbol) || '</td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Číslo objednávky</td><td>' || html_escape(NEW.id) || '</td></tr>'
        || '</table>'
        || case when NEW.has_referral then '<p style="background:#fef9c3;padding:10px;border-radius:8px;font-size:13px">Nezabudnite si priniesť žiadanku (výmenný lístok).</p>' else '' end
        || v_instr_html
        || '</div>';
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Rezervácia USG vyšetrenia — ' || v_termin, 'html', v_html)
      );
    end if;

    if v_notify is not null and v_notify <> '' then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(v_notify),
          'subject', 'Nová objednávka: ' || NEW.patient_name || ' — ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">'
            || '<h2 style="color:#003d7c">Nová objednávka na USG</h2>'
            || '<p><b>' || v_name || '</b><br>' || v_exam || '<br>' || v_termin
            || case when NEW.doctor <> '' then ' · ' || v_doc else '' end
            || '<br>Tel.: ' || html_escape(NEW.phone)
            || '<br>' || case when NEW.has_referral then 'so žiadankou (doplatok ' || v_price || ')' else 'samoplatca ' || v_price end
            || '</p></div>')
      );
    end if;

    if NEW.doctor <> '' then
      select d->>'email' into v_docmail
      from settings s, jsonb_array_elements(s.value::jsonb) d
      where s.key = 'doctors' and d->>'name' = NEW.doctor
      limit 1;
      if v_docmail is not null and v_docmail <> '' and lower(v_docmail) <> lower(coalesce(v_notify, '')) then
        perform net.http_post(
          url := 'https://api.resend.com/emails',
          headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
          body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(v_docmail),
            'subject', 'Objednávka na Váš termín — ' || v_termin,
            'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">'
              || '<h2 style="color:#003d7c">Nová objednávka na Váš termín</h2>'
              || '<p><b>' || v_name || '</b><br>' || v_exam || '<br>' || v_termin
              || '<br>Tel.: ' || html_escape(NEW.phone)
              || '</p></div>')
        );
      end if;
    end if;
    return NEW;
  end if;

  if TG_OP = 'UPDATE' and NEW.email <> '' then
    if OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Termín USG potvrdený — ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">'
            || '<h2 style="color:#003d7c">Váš termín je potvrdený</h2>'
            || '<p>Platbu sme prijali a termín vyšetrenia je záväzne potvrdený.</p>'
            || '<p><b>' || v_exam || '</b><br>' || v_termin
            || case when NEW.doctor <> '' then '<br>Lekár: ' || v_doc else '' end
            || case when v_ambul <> '' then '<br>Miesto: <b>' || html_escape(v_ambul) || '</b>' else '' end
            || '</p></div>')
      );
    elsif OLD.status <> 'rejected' and NEW.status = 'rejected' then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Objednávka USG zrušená — ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">'
            || '<h2 style="color:#003d7c">Objednávka bola zrušená</h2>'
            || '<p>' || html_escape(coalesce(NEW.status_note, '')) || '</p>'
            || '<p><b>' || v_exam || '</b><br>' || v_termin || '</p></div>')
      );
    elsif OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Zmena termínu USG — ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">'
            || '<h2 style="color:#003d7c">Váš termín bol presunutý</h2>'
            || '<p>Nový termín: <b>' || v_termin || '</b><br>' || v_exam
            || case when v_ambul <> '' then '<br>Miesto: <b>' || html_escape(v_ambul) || '</b>' else '' end
            || '</p></div>')
      );
    end if;
    return NEW;
  end if;

  return NEW;
end $func$;

drop trigger if exists orders_email_notify on orders;
create trigger orders_email_notify
after insert or update on orders
for each row execute function notify_order_emails();

-- ------------------------------------------------------------
-- 2. SMS: doplniť ambulanciu do rezervačnej a potvrdzovacej SMS
--    (spustí sa naplno až po nastavení BulkGate kľúčov)
-- ------------------------------------------------------------
create or replace function notify_order_sms()
returns trigger
language plpgsql security definer set search_path = public as $func$
declare
  v_app_id    text := 'SEM_VLOZTE_APPLICATION_ID';
  v_app_token text := 'SEM_VLOZTE_APPLICATION_TOKEN';
  v_number    text;
  v_termin    text;
  v_text      text := '';
  v_ambul     text;
begin
  if v_app_id like 'SEM_%' then
    return NEW; -- SMS brána ešte nie je nastavená
  end if;
  v_number := sms_number(NEW.phone);
  if length(v_number) < 11 then
    return NEW;
  end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  v_ambul := doctor_location(NEW.doctor);

  if TG_OP = 'INSERT' then
    v_text := 'NUSCH: Rezervacia USG ' || v_termin
      || '. Uhradte ' || replace(to_char(NEW.price, 'FM990D00'), '.', ',') || ' EUR, VS '
      || NEW.variable_symbol || '. Platobne udaje najdete v e-maili.';
  elsif TG_OP = 'UPDATE' then
    if OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
      v_text := 'NUSCH: Vas termin USG ' || v_termin || ' je potvrdeny.'
        || case when v_ambul <> '' then ' Miesto: ' || v_ambul || '.' else '' end
        || ' Tesime sa na Vas.';
    elsif OLD.status <> 'rejected' and NEW.status = 'rejected' then
      v_text := 'NUSCH: Vasa objednavka USG na ' || v_termin || ' bola zrusena. Podrobnosti v e-maili.';
    elsif OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time then
      v_text := 'NUSCH: Zmena terminu USG. Novy termin: ' || v_termin || '.'
        || case when v_ambul <> '' then ' Miesto: ' || v_ambul || '.' else '' end;
    end if;
  end if;

  if v_text <> '' then
    perform net.http_post(
      url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'application_id', v_app_id, 'application_token', v_app_token,
        'number', v_number, 'text', v_text, 'unicode', false,
        'sender_id', 'gText', 'sender_id_value', 'NUSCH')
    );
  end if;
  return NEW;
end $func$;

drop trigger if exists orders_sms_notify on orders;
create trigger orders_sms_notify
after insert or update on orders
for each row execute function notify_order_sms();

-- ------------------------------------------------------------
-- 3. Pripomienka deň vopred: doplniť miesto (e-mail aj SMS)
-- ------------------------------------------------------------
create or replace function send_reminders()
returns int
language plpgsql security definer set search_path = public as $func$
declare
  v_key       text := 'SEM_VLOZTE_RESEND_KLUC';
  v_sms_id    text := 'SEM_VLOZTE_APPLICATION_ID';
  v_sms_token text := 'SEM_VLOZTE_APPLICATION_TOKEN';
  v_from    text;
  v_iban    text;
  r         record;
  v_termin  text;
  v_price   text;
  v_html    text;
  v_pay     text;
  v_sms     text;
  v_number  text;
  v_ambul   text;
  v_count   int := 0;
begin
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then
    v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>';
  end if;
  select value into v_iban from settings where key = 'iban';

  for r in
    select * from orders
    where slot_date = current_date + 1
      and status in ('new', 'confirmed')
      and reminder_sent_at is null
  loop
    v_termin := to_char(r.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(r.slot_time, 'HH24:MI');
    v_price  := replace(to_char(r.price, 'FM990D00'), '.', ',') || ' €';
    v_ambul  := doctor_location(r.doctor);

    if r.email <> '' then
      if not r.paid then
        v_pay := '<p style="background:#fef2f2;border-left:4px solid #e2001a;padding:10px 14px;border-radius:8px;font-size:13px">'
          || '<b>Evidujeme, že platba zatiaľ nedorazila.</b> Uhraďte prosím '
          || v_price || ' na IBAN ' || html_escape(coalesce(v_iban, '')) || ', variabilný symbol '
          || html_escape(r.variable_symbol) || ' — inak termín nemôžeme garantovať.</p>';
      else
        v_pay := '';
      end if;
      v_html :=
        '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
        || '<div style="border-bottom:3px solid #e2001a;padding-bottom:12px;margin-bottom:16px">'
        || '<b style="color:#003d7c">Národný ústav srdcových a cievnych chorôb, a.s.</b><br>'
        || '<span style="color:#64748b;font-size:12px">Objednávanie na USG</span></div>'
        || '<h2 style="color:#003d7c">Pripomienka: zajtra máte vyšetrenie</h2>'
        || '<p><b>' || html_escape(r.exam_label) || '</b><br>' || v_termin
        || case when r.doctor <> '' then '<br>Lekár: ' || html_escape(r.doctor) else '' end
        || case when v_ambul <> '' then '<br>Miesto: <b>' || html_escape(v_ambul) || '</b>' else '' end
        || '</p>'
        || v_pay
        || case when r.has_referral then '<p style="background:#fef9c3;padding:10px;border-radius:8px;font-size:13px">Nezabudnite si priniesť žiadanku (výmenný lístok).</p>' else '' end
        || '<p style="font-size:13px;color:#64748b">Pod Krásnou hôrkou 1, Bratislava. Príďte prosím 15 minút vopred.</p>'
        || '</div>';
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(r.email),
          'subject', 'Pripomienka: zajtra ' || to_char(r.slot_time, 'HH24:MI') || ' — USG vyšetrenie', 'html', v_html)
      );
    end if;

    if v_sms_id not like 'SEM_%' and v_sms_token not like 'SEM_%' then
      v_number := sms_number(r.phone);
      if length(v_number) >= 11 then
        v_sms := 'NUSCH: Pripomienka - zajtra ' || to_char(r.slot_time, 'HH24:MI')
          || ' mate USG vysetrenie.'
          || case when v_ambul <> '' then ' Miesto: ' || v_ambul || '.' else '' end
          || case when not r.paid then ' Platba zatial nedorazila - uhradte ' || replace(to_char(r.price, 'FM990D00'), '.', ',') || ' EUR, VS ' || r.variable_symbol || '.' else '' end
          || case when r.has_referral then ' Prineste si ziadanku.' else '' end;
        perform net.http_post(
          url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'application_id', v_sms_id, 'application_token', v_sms_token,
            'number', v_number, 'text', v_sms, 'unicode', false,
            'sender_id', 'gText', 'sender_id_value', 'NUSCH')
        );
      end if;
    end if;

    update orders set reminder_sent_at = now() where id = r.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $func$;

-- ------------------------------------------------------------
-- 4. Predvyplnenie štandardnej prípravy — LEN do prázdnych polí
--    (existujúce texty pracoviska sa nikdy neprepíšu)
-- ------------------------------------------------------------
alter table pricelist add column if not exists instructions text not null default '';

with prep(id, txt) as (values
  ('abdomen', 'Príďte nalačno (min. 6 hodín nejedzte). Deň vopred vynechajte nadúvajúce jedlá (strukoviny, kapustu, čerstvé pečivo) a sýtené nápoje. Ranné lieky zapite malým množstvom vody. 2 hodiny pred vyšetrením vypite cca 0,5 l neperlivej vody. Pred vyšetrením nefajčite a nežujte žuvačku.'),
  ('renal',   'Príďte nalačno (min. 6 hodín nejedzte). Deň vopred vynechajte nadúvajúce jedlá (strukoviny, kapustu, čerstvé pečivo) a sýtené nápoje. Ranné lieky zapite malým množstvom vody. 2 hodiny pred vyšetrením vypite cca 0,5 l neperlivej vody. Pred vyšetrením nefajčite a nežujte žuvačku.'),
  ('aorta',   'Príďte nalačno (min. 6 hodín nejedzte). Deň vopred vynechajte nadúvajúce jedlá (strukoviny, kapustu, čerstvé pečivo) a sýtené nápoje. Ranné lieky zapite malým množstvom vody. 2 hodiny pred vyšetrením vypite cca 0,5 l neperlivej vody. Pred vyšetrením nefajčite a nežujte žuvačku.'),
  ('compressions', 'Príďte nalačno (min. 6 hodín nejedzte). Deň vopred vynechajte nadúvajúce jedlá (strukoviny, kapustu, čerstvé pečivo) a sýtené nápoje. Ranné lieky zapite malým množstvom vody. 2 hodiny pred vyšetrením vypite cca 0,5 l neperlivej vody. Pred vyšetrením nefajčite a nežujte žuvačku. Prineste si všetku dostupnú zdravotnú dokumentáciu, CD/USB so snímkami z predchádzajúcich vyšetrení a aktuálny zoznam užívaných liekov.'),
  ('kidneys', 'Hodinu pred vyšetrením vypite 0,5–0,7 l tekutín a nemočte — vyšetrenie vyžaduje naplnený močový mechúr.'),
  ('pelvis',  'Hodinu pred vyšetrením vypite 0,5–0,7 l tekutín a nemočte — vyšetrenie vyžaduje naplnený močový mechúr.'),
  ('soft',    'Osobitná príprava nie je potrebná.'),
  ('thyroid', 'Osobitná príprava nie je potrebná. Zvoľte si voľný odev okolo krku (rozopínateľný golier), šperky z krku nechajte doma.'),
  ('neck',    'Osobitná príprava nie je potrebná. Zvoľte si voľný odev okolo krku (rozopínateľný golier), šperky z krku nechajte doma.'),
  ('carotid', 'Osobitná príprava nie je potrebná. Zvoľte si voľný odev okolo krku (rozopínateľný golier), šperky z krku nechajte doma.'),
  ('upper1',  'Osobitná príprava nie je potrebná. Zvoľte si pohodlný odev, ktorý sa dá ľahko vyzliecť z vyšetrovaných končatín.'),
  ('upper2',  'Osobitná príprava nie je potrebná. Zvoľte si pohodlný odev, ktorý sa dá ľahko vyzliecť z vyšetrovaných končatín.'),
  ('lower1',  'Osobitná príprava nie je potrebná. Zvoľte si pohodlný odev, ktorý sa dá ľahko vyzliecť z vyšetrovaných končatín.'),
  ('lower2',  'Osobitná príprava nie je potrebná. Zvoľte si pohodlný odev, ktorý sa dá ľahko vyzliecť z vyšetrovaných končatín.'),
  ('tos',     'Osobitná príprava nie je potrebná. Zvoľte si pohodlný odev, ktorý sa dá ľahko vyzliecť z vyšetrovaných končatín.'),
  ('complete_vessels', 'Osobitná príprava nie je potrebná. Zvoľte si pohodlný odev, ktorý sa dá ľahko vyzliecť z vyšetrovaných končatín.'),
  ('consultation', 'Prineste si všetku dostupnú zdravotnú dokumentáciu, CD/USB so snímkami z predchádzajúcich vyšetrení a aktuálny zoznam užívaných liekov.')
)
update pricelist p
set instructions = prep.txt
from prep
where p.id = prep.id
  and (p.instructions is null or p.instructions = '');

-- Kontrola:
--   select id, left(instructions, 60) from pricelist order by sort_order;
