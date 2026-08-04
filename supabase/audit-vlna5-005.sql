-- ============================================================
-- AUDIT VLNA 5 — 005  (e-mail/SMS triggery odolné voči chybám)
--
-- NÍZKE: notify_order_emails, notify_order_sms a ct_notify_trigger
-- neboli obalené výnimkou — chyba pri odosielaní (napr. pg_net,
-- chýbajúci settings) mohla zrolovať celú objednávku pacienta.
-- Tu ich re-emitujeme s vonkajším „exception when others" →
-- objednávka vždy prejde, e-mail/SMS je len best-effort.
-- Navyše: ct_notify_trigger HTML-escapuje status_note.
--
-- KĽÚČE: v repe je placeholder SEM_VLOZTE_RESEND_KLUC /
-- SEM_VLOZTE_APPLICATION_ID/TOKEN. Do Supabase spustite verziu
-- s vyplnenými kľúčmi (doručená v chate).
--
-- Telá funkcií sú prevzaté 1:1 z emaily-storna-001 a ct-002,
-- doplnené len o obalenie výnimkou (a escape status_note).
-- Idempotentné. Spúšťať PO emaily-storna-001 a ct-002.
-- ============================================================

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
  v_name    text;
  v_exam    text;
  v_doc     text;
  v_ambul   text;
  v_ambul_row text := '';
  v_footer  text;
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
  v_footer := email_footer(NEW.id);
  if v_ambul <> '' then
    v_ambul_row := '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Miesto</td><td><b>' || html_escape(v_ambul) || '</b></td></tr>';
  end if;

  -- pokyny k vyšetreniu (posielajú sa v rezervačnom, potvrdzovacom aj presunovom e-maile)
  select p.instructions into v_instr from pricelist p where p.id = NEW.exam_type_id;
  if v_instr is not null and v_instr <> '' then
    v_instr_html := '<div style="background:#eff6ff;border-left:4px solid #005ca9;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:12px"><b style="color:#003d7c">Pokyny k vyšetreniu</b><br>'
      || replace(html_escape(v_instr), chr(10), '<br>') || '</div>';
  end if;

  if TG_OP = 'INSERT' then
    if NEW.email <> '' then
      v_html :=
        '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
        || email_header()
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
        || v_footer
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
            || email_header()
            || '<h2 style="color:#003d7c">Nová objednávka na USG</h2>'
            || '<p><b>' || v_name || '</b><br>' || v_exam || '<br>' || v_termin
            || case when NEW.doctor <> '' then ' · ' || v_doc else '' end
            || '<br>Tel.: ' || html_escape(NEW.phone)
            || '<br>' || case when NEW.has_referral then 'so žiadankou (doplatok ' || v_price || ')' else 'samoplatca ' || v_price end
            || '</p></div>')
      );
    end if;

    return NEW;
  end if;

  if TG_OP = 'UPDATE' and NEW.email <> '' then
    if OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
      -- POTVRDENIE: kompletné informácie vrátane pokynov a miesta
      v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
        || email_header()
        || '<h2 style="color:#003d7c">Váš termín je potvrdený</h2>'
        || '<p>Platbu sme prijali a termín vyšetrenia je záväzne potvrdený.</p>'
        || '<table style="font-size:14px;border-collapse:collapse">'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Vyšetrenie</td><td><b>' || v_exam || '</b></td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
        || case when NEW.doctor <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || v_doc || '</td></tr>' else '' end
        || v_ambul_row
        || '</table>'
        || '<p style="font-size:13px">Príďte prosím <b>15 minút pred termínom</b>.</p>'
        || case when NEW.has_referral then '<p style="background:#fef9c3;padding:10px;border-radius:8px;font-size:13px">Nezabudnite si priniesť žiadanku (výmenný lístok).</p>' else '' end
        || v_instr_html
        || v_footer
        || '</div>';
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Termín USG potvrdený — ' || v_termin, 'html', v_html)
      );
    elsif OLD.status <> 'rejected' and NEW.status = 'rejected' then
      -- ZRUŠENIE: pri zaplatenej objednávke informácia o vrátení platby
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Objednávka USG zrušená — ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
            || email_header()
            || '<h2 style="color:#003d7c">Objednávka bola zrušená</h2>'
            || '<p>' || html_escape(coalesce(NEW.status_note, '')) || '</p>'
            || '<p><b>' || v_exam || '</b><br>' || v_termin || '</p>'
            || case when NEW.paid and NEW.price > 0 then
                 '<p style="background:#eff6ff;border-left:4px solid #005ca9;padding:10px 14px;border-radius:8px;font-size:13px"><b>Vrátenie platby:</b> uhradenú sumu '
                 || v_price || ' vám vrátime prevodom na účet, z ktorého platba prišla, do 7 pracovných dní. Nemusíte nič robiť.</p>'
               else '' end
            || '<p style="font-size:13px">Ak máte o vyšetrenie naďalej záujem, môžete si vytvoriť novú objednávku na '
            || '<a href="https://objednanie.cievny.sk" style="color:#2B46A2">objednanie.cievny.sk</a>.</p>'
            || v_footer
            || '</div>')
      );
    elsif OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time then
      -- PRESUN: nový termín + možnosť vybrať si iný alebo zrušiť s vrátením platby
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Zmena termínu USG — nový termín ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
            || email_header()
            || '<h2 style="color:#003d7c">Váš termín bol presunutý</h2>'
            || '<p>Nový termín: <b>' || v_termin || '</b><br>' || v_exam
            || case when NEW.doctor <> '' then '<br>Lekár: ' || v_doc else '' end
            || case when v_ambul <> '' then '<br>Miesto: <b>' || html_escape(v_ambul) || '</b>' else '' end
            || '</p>'
            || '<p style="background:#fef9c3;padding:10px 14px;border-radius:8px;font-size:13px">Ak vám nový termín <b>nevyhovuje</b>, '
            || 'cez odkaz nižšie môžete objednávku zrušiť (najneskôr 48 hodín pred termínom) a vytvoriť si novú na čas, ktorý vám vyhovuje. '
            || 'Zaplatenú platbu vám v takom prípade vrátime prevodom na účet, z ktorého prišla, do 7 pracovných dní.</p>'
            || v_instr_html
            || v_footer
            || '</div>')
      );
    elsif OLD.doctor is distinct from NEW.doctor and NEW.status in ('new', 'confirmed') then
      -- ZMENA LEKÁRA: informačný e-mail s uistením
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Zmena lekára pri vašom USG vyšetrení — ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
            || email_header()
            || '<h2 style="color:#003d7c">Zmena lekára pri vašom vyšetrení</h2>'
            || '<p>Z prevádzkových dôvodov vaše vyšetrenie vykoná <b>' || v_doc || '</b>.</p>'
            || '<p><b>Termín, čas aj rozsah vyšetrenia sa nemenia:</b><br>'
            || v_exam || '<br>' || v_termin
            || case when v_ambul <> '' then '<br>Miesto: <b>' || html_escape(v_ambul) || '</b>' else '' end
            || '</p>'
            || '<p style="background:#eff6ff;border-left:4px solid #005ca9;padding:10px 14px;border-radius:8px;font-size:13px">'
            || 'Všetci naši lekári sú skúsení odborníci v cievnej diagnostike — na kvalitu a odbornosť vyšetrenia '
            || 'nemá táto zmena žiadny vplyv. Informujeme vás pre úplnosť.</p>'
            || v_footer
            || '</div>')
      );
    end if;
    return NEW;
  end if;

  return NEW;
exception when others then
  return coalesce(NEW, OLD);
end $func$;

drop trigger if exists orders_email_notify on orders;
create trigger orders_email_notify
after insert or update on orders
for each row execute function notify_order_emails();

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
    return NEW;
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
      v_text := 'NUSCH: Vasa objednavka USG na ' || v_termin || ' bola zrusena.'
        || case when NEW.paid and NEW.price > 0 then ' Platbu vam vratime prevodom do 7 prac. dni.' else '' end
        || ' Podrobnosti v e-maili.';
    elsif OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time then
      v_text := 'NUSCH: Zmena terminu USG. Novy termin: ' || v_termin || '.'
        || case when v_ambul <> '' then ' Miesto: ' || v_ambul || '.' else '' end
        || ' Ak vam nevyhovuje, mozete ho zrusit cez odkaz v e-maili (min. 48 h vopred).';
    elsif OLD.doctor is distinct from NEW.doctor and NEW.status in ('new', 'confirmed') then
      v_text := 'NUSCH: Vase USG vysetrenie ' || v_termin || ' vykona ' || NEW.doctor || '.'
        || case when v_ambul <> '' then ' Miesto: ' || v_ambul || '.' else '' end
        || ' Termin a cas sa nemenia, kvalita vysetrenia zostava rovnaka.';
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
exception when others then
  return coalesce(NEW, OLD);
end $func$;

drop trigger if exists orders_sms_notify on orders;
create trigger orders_sms_notify
after insert or update on orders
for each row execute function notify_order_sms();

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
      case when coalesce(NEW.status_note, '') <> '' then ' ' || html_escape(NEW.status_note) else '' end;
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
exception when others then
  return coalesce(NEW, OLD);
end $fn$;

drop trigger if exists ct_orders_notify on ct_orders;
create trigger ct_orders_notify
after insert or update on ct_orders
for each row execute function ct_notify_trigger();
-- ============================================================
