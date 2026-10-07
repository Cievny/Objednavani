-- ============================================================
-- KÓPIA KAŽDEJ POŽIADAVKY 001 — e-mail na lukas.vincze@nusch.sk
--   Pri každej novej objednávke v ktoromkoľvek objednávaní (USG, CT,
--   Angiologická ambulancia č. 1) a pri každej zmene/zrušení termínu,
--   ktoré urobil pacient sám, odíde kópia na adresu v settings.copy_email.
--   • nezávislé od existujúceho notify_email (USG) — to ostáva, ako je
--   • adresa sa dá zmeniť: update settings set value='…' where key='copy_email';
--     prázdna hodnota = kópie vypnuté; viac adries oddeľte čiarkou
--   • bez zdravotných údajov v e-maili (meno, typ vyšetrenia, termín, telefón,
--     číslo objednávky, lekár) + odkaz do správy
--   KĽÚČ NETREBA VKLADAŤ: Resend kľúč sa prevezme z notify_order_emails.
--   Idempotentné. Spúšťať kedykoľvek po angio-001 (ak angio_orders chýba,
--   trigger naň sa preskočí a dá sa spustiť neskôr znova).
-- ============================================================

insert into settings (key, value) values ('copy_email', 'lukas.vincze@nusch.sk')
on conflict (key) do update set value = excluded.value;

do $mig$
declare
  src   text;
  v_key text;
begin
  select prosrc into src from pg_proc
  where proname = 'notify_order_emails' and pronamespace = 'public'::regnamespace;
  v_key := coalesce(substring(src from 'v_key\s+text\s*:=\s*''([^'']*)'''), 'SEM_VLOZTE_RESEND_KLUC');
  if v_key like 'SEM\_%' then
    raise notice 'Resend kľúč nie je nastavený v notify_order_emails — kópie ostanú vypnuté.';
  end if;

  execute format($def$
create or replace function notify_copy_staff()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_key    text := %L;
  v_from   text;
  v_to     text;
  v_clinic text;
  v_what   text;
  v_termin text;
  v_link   text;
  v_exam   text;
  v_html   text;
  v_addrs  jsonb;
begin
  select value into v_to from settings where key = 'copy_email';
  if coalesce(v_to, '') = '' or v_key like 'SEM_%%' then return NEW; end if;

  if TG_OP = 'INSERT' then
    v_what := 'Nová objednávka';
  elsif TG_OP = 'UPDATE' and OLD.status <> 'rejected' and NEW.status = 'rejected'
        and NEW.status_note = 'Zrušené pacientom' then
    v_what := 'Pacient zrušil termín';
  elsif TG_OP = 'UPDATE' and (OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time)
        and NEW.status_note like 'Termín zmenil pacient%%' then
    v_what := 'Pacient zmenil termín';
  else
    return NEW;
  end if;

  v_clinic := case TG_TABLE_NAME
    when 'orders' then 'USG'
    when 'ct_orders' then 'CT'
    when 'angio_orders' then 'Angiologická ambulancia č. 1'
    else TG_TABLE_NAME end;
  v_link := case TG_TABLE_NAME
    when 'orders' then 'https://objednanie.cievny.sk/sprava/'
    when 'ct_orders' then 'https://objednanie.cievny.sk/sprava/#/ct'
    when 'angio_orders' then 'https://objednanie.cievny.sk/sprava/#/angio1'
    else 'https://objednanie.cievny.sk/sprava/' end;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  v_exam := coalesce(NEW.exam_label, '');

  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  select jsonb_agg(btrim(a)) into v_addrs from unnest(string_to_array(v_to, ',')) a where btrim(a) <> '';

  v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
    || email_header()
    || '<h2 style="color:#003d7c">' || v_what || ' — ' || html_escape(v_clinic) || '</h2>'
    || '<table style="font-size:14px;border-collapse:collapse">'
    || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Pacient</td><td><b>' || html_escape(NEW.patient_name) || '</b></td></tr>'
    || case when v_exam <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Vyšetrenie</td><td>' || html_escape(v_exam) || '</td></tr>' else '' end
    || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
    || case when TG_OP = 'UPDATE' and (OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time)
         then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Pôvodne</td><td>' || to_char(OLD.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(OLD.slot_time, 'HH24:MI') || '</td></tr>' else '' end
    || case when coalesce(NEW.doctor, '') <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || html_escape(NEW.doctor) || '</td></tr>' else '' end
    || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Telefón</td><td>' || html_escape(NEW.phone) || '</td></tr>'
    || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Číslo objednávky</td><td>' || html_escape(NEW.id) || '</td></tr>'
    || '</table>'
    || '<p style="margin-top:14px"><a href="' || v_link || '" style="color:#2B46A2;font-weight:bold">Otvoriť v správe objednávok</a></p>'
    || '<p style="font-size:12px;color:#64748b">Automatická kópia požiadavky (settings.copy_email).</p>'
    || '</div>';

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', v_addrs,
      'subject', v_what || ' (' || v_clinic || '): ' || NEW.patient_name || ' — ' || v_termin, 'html', v_html)
  );
  return NEW;
exception when others then
  return coalesce(NEW, OLD);
end $fn$;
$def$, v_key);
end $mig$;
revoke all on function notify_copy_staff() from public, anon, authenticated;

-- triggery na všetky tri tabuľky (angio sa preskočí, ak ešte neexistuje)
do $$
declare t text;
begin
  foreach t in array array['orders', 'ct_orders', 'angio_orders'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'Tabuľka % neexistuje — trigger preskočený.', t;
      continue;
    end if;
    execute format('drop trigger if exists %I on %I', t || '_copy_staff', t);
    execute format('create trigger %I after insert or update on %I for each row execute function notify_copy_staff()', t || '_copy_staff', t);
  end loop;
end $$;

-- Diagnostika:
--   select value from settings where key = 'copy_email';
--   select tgname, tgrelid::regclass from pg_trigger where tgname like '%copy_staff';
-- ============================================================
