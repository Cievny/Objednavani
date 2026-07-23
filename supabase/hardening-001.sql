-- ============================================================
-- HARDENING 001 — bezpečnostné spevnenie po audite (07/2026)
--
-- Spustite celý skript v Supabase SQL editore. Je idempotentný
-- (create or replace), dá sa spustiť opakovane.
--
-- Obsah:
--   1. create_order: cena a názov vyšetrenia sa overujú proti
--      cenníku NA SERVERI (klientovi sa neverí), limit počtu
--      aktívnych objednávok na jedno telefónne číslo, limity
--      dĺžky vstupov a počtu príloh
--   2. html_escape + notify_order_emails: údaje od pacienta sa
--      v e-mailoch escapujú (ochrana pred HTML injection),
--      odosielateľ sa číta z settings.mail_from, inštrukcie
--      z cenníka, notifikácia lekárovi podľa settings.doctors
--   3. storage bucket 'prilohy': limit 5 MB + povolené len
--      PDF/JPG/PNG
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_RESEND_KLUC svojím
-- kľúčom z resend.com (API Keys).
-- ============================================================

-- ============================================================
-- 1. create_order — server-side validácia
-- ============================================================
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
  v_item   pricelist%rowtype;
  v_price  numeric;
  v_phone9 text;
  v_active int;
begin
  -- Formát čísla objednávky (generuje aplikácia)
  if p_id !~ '^USG-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;

  -- Limity dĺžky vstupov (ochrana pred odpadovými dátami)
  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_referrer_name, '')) > 200
     or length(coalesce(p_referrer_facility, '')) > 200
     or length(coalesce(p_insurance, '')) > 100
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;

  -- Telefón: aspoň 9 číslic
  v_phone9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;

  -- Cena a názov sa berú z cenníka NA SERVERI — klientovi sa neverí
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

  -- Anti-spam: max 3 aktívne budúce objednávky na jedno telefónne číslo
  select count(*) into v_active
  from orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky. Kontaktujte pracovisko.', v_active;
  end if;

  -- Prílohy: max 3, len očakávané polia
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  -- Termín musí byť otvorený pracoviskom a voľný
  select s.doctor into v_doctor
  from open_slots s
  where s.slot_date = p_slot_date and s.slot_time = p_slot_time;
  if not found then
    raise exception 'Vybraný termín nie je otvorený na objednávanie.';
  end if;
  if p_slot_date < current_date then
    raise exception 'Termín v minulosti nie je možné objednať.';
  end if;
  if exists (select 1 from orders o where o.slot_date = p_slot_date and o.slot_time = p_slot_time and o.status <> 'rejected') then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
  end if;

  insert into orders (
    id, has_referral, exam_type_id, exam_label, price, reason,
    referrer_name, referrer_facility, patient_name, birth_date,
    insurance, phone, email, slot_date, slot_time, variable_symbol, doctor, attachments
  ) values (
    p_id, p_has_referral, p_exam_type_id, v_item.label, v_price, p_reason,
    coalesce(p_referrer_name, ''), coalesce(p_referrer_facility, ''), p_patient_name, p_birth_date,
    coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''), p_slot_date, p_slot_time, p_variable_symbol,
    coalesce(v_doctor, ''), coalesce(p_attachments, '[]'::jsonb)
  );
  return p_id;
end $$;

-- ============================================================
-- 2. E-maily: escapovanie + odosielateľ zo settings + lekár
-- ============================================================

-- Escapovanie údajov od pacienta pred vložením do HTML e-mailu
create or replace function html_escape(t text)
returns text language sql immutable as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

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
begin
  select value into v_from   from settings where key = 'mail_from';
  if v_from is null or v_from = '' then
    v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>';
  end if;
  select value into v_iban   from settings where key = 'iban';
  select value into v_notify from settings where key = 'notify_email';
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  v_price  := replace(to_char(NEW.price, 'FM990D00'), '.', ',') || ' €';
  -- escapované kópie polí, ktoré zadáva pacient / môžu obsahovať HTML
  v_name := html_escape(NEW.patient_name);
  v_exam := html_escape(NEW.exam_label);
  v_doc  := html_escape(NEW.doctor);

  -- ---------- NOVÁ OBJEDNÁVKA ----------
  if TG_OP = 'INSERT' then
    -- inštrukcie k typu vyšetrenia z cenníka
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

    -- upozornenie pracovisku
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

    -- upozornenie lekárovi, na ktorého termín objednávka padla
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
            || '<p><b>' || v_exam || '</b><br>' || v_termin
            || case when NEW.doctor <> '' then '<br>Lekár: ' || v_doc else '' end || '</p></div>')
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
            || '<p>Nový termín: <b>' || v_termin || '</b><br>' || v_exam || '</p></div>')
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

-- ============================================================
-- 3. Storage: limit veľkosti a typov príloh (5 MB, PDF/JPG/PNG)
-- ============================================================
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png']
where id = 'prilohy';
