-- ============================================================
-- E-mailové notifikácie priamo z databázy (bez Edge Function)
-- Trigger na tabuľke orders volá Resend API cez pg_net.
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_RESEND_KLUC svojím kľúčom
-- z resend.com (API Keys). Kľúč ostáva v tele funkcie (SECURITY
-- DEFINER), ktoré nie je prístupné cez verejné API — je v bezpečí.
--
-- Kým nie je v Resend overená doména nusch.sk, platí:
--   - v_from musí byť onboarding@resend.dev
--   - e-maily prídu LEN na adresu, ktorou ste sa registrovali na
--     resend.com (do testovacej objednávky dajte túto adresu)
-- Po overení domény zmeňte v_from na napr.
--   'NÚSCH Objednávanie <info@objednavky.nusch.sk>'
-- ============================================================

create extension if not exists pg_net;

create or replace function notify_order_emails()
returns trigger
language plpgsql security definer set search_path = public as $func$
declare
  v_key    text := 'SEM_VLOZTE_RESEND_KLUC';
  v_from   text := 'NÚSCH Objednávanie <onboarding@resend.dev>';
  v_iban   text;
  v_notify text;
  v_termin text;
  v_price  text;
  v_html   text;
begin
  select value into v_iban   from settings where key = 'iban';
  select value into v_notify from settings where key = 'notify_email';
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  v_price  := replace(to_char(NEW.price, 'FM990D00'), '.', ',') || ' €';

  -- ---------- NOVÁ OBJEDNÁVKA ----------
  if TG_OP = 'INSERT' then
    if NEW.email <> '' then
      v_html :=
        '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
        || '<div style="border-bottom:3px solid #e2001a;padding-bottom:12px;margin-bottom:16px">'
        || '<b style="color:#003d7c">Národný ústav srdcových a cievnych chorôb, a.s.</b><br>'
        || '<span style="color:#64748b;font-size:12px">Objednávanie na USG</span></div>'
        || '<h2 style="color:#003d7c">Rezervácia prijatá — čaká na platbu</h2>'
        || '<p>Ďakujeme za objednávku. Termín je rezervovaný a bude potvrdený po prijatí platby.</p>'
        || '<table style="font-size:14px;border-collapse:collapse">'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Vyšetrenie</td><td><b>' || NEW.exam_label || '</b></td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
        || case when NEW.doctor <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || NEW.doctor || '</td></tr>' else '' end
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">' || case when NEW.has_referral then 'Doplatok' else 'Cena' end || '</td><td><b>' || v_price || '</b></td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">IBAN</td><td>' || coalesce(v_iban, '') || '</td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Variabilný symbol</td><td>' || NEW.variable_symbol || '</td></tr>'
        || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Číslo objednávky</td><td>' || NEW.id || '</td></tr>'
        || '</table>'
        || case when NEW.has_referral then '<p style="background:#fef9c3;padding:10px;border-radius:8px;font-size:13px">Nezabudnite si priniesť žiadanku (výmenný lístok).</p>' else '' end
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
            || '<p><b>' || NEW.patient_name || '</b><br>' || NEW.exam_label || '<br>' || v_termin
            || case when NEW.doctor <> '' then ' · ' || NEW.doctor else '' end
            || '<br>Tel.: ' || NEW.phone
            || '<br>' || case when NEW.has_referral then 'so žiadankou (doplatok ' || v_price || ')' else 'samoplatca ' || v_price end
            || '</p></div>')
      );
    end if;
    return NEW;
  end if;

  -- ---------- ZMENY OBJEDNÁVKY ----------
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
            || '<p><b>' || NEW.exam_label || '</b><br>' || v_termin
            || case when NEW.doctor <> '' then '<br>Lekár: ' || NEW.doctor else '' end || '</p></div>')
      );
    elsif OLD.status <> 'rejected' and NEW.status = 'rejected' then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Objednávka USG zrušená — ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">'
            || '<h2 style="color:#003d7c">Objednávka bola zrušená</h2>'
            || '<p>' || coalesce(NEW.status_note, '') || '</p>'
            || '<p><b>' || NEW.exam_label || '</b><br>' || v_termin || '</p></div>')
      );
    elsif OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
          'subject', 'Zmena termínu USG — ' || v_termin,
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">'
            || '<h2 style="color:#003d7c">Váš termín bol presunutý</h2>'
            || '<p>Nový termín: <b>' || v_termin || '</b><br>' || NEW.exam_label || '</p></div>')
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
