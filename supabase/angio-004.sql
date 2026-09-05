-- ============================================================
-- ANGIO 004 — spoločné pokyny pre pacientov + žiadanka podľa typu
--   • settings.angio_common_notes — spoločné pokyny (jeden pokyn na
--     riadok); pacient ich vidí pri každom objednaní a dostane ich
--     v potvrdzovacom e-maili aj v pripomienke deň vopred
--   • angio_pricelist.requires_referral — či typ vyšetrenia vyžaduje
--     žiadanku (výmenný lístok); trigger angio_require_attachment
--     ju odteraz vyžaduje len pri takých typoch
--   • e-maily: „Príďte 15 minút vopred" nahradené spoločnými pokynmi
--     (10 minút); SMS: 10 min vopred, žiadanka len ak ju typ vyžaduje
--
-- KĽÚČE NETREBA VKLADAŤ: Resend kľúč sa prevezme z angio_notify_trigger,
-- BulkGate kľúče z angio_notify_sms (vytvorené v angio-001 / angio-002).
-- Idempotentné. Spúšťať PO angio-001, angio-002 a angio-003.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Spoločné pokyny — verejne čitateľný kľúč v settings
-- ------------------------------------------------------------
drop policy if exists "settings verejne citanie" on settings;
create policy "settings verejne citanie" on settings
  for select using (key in ('iban', 'beneficiary', 'referral_from', 'slot_base_min', 'angio_common_notes', 'angio_sms_verify'));
-- (angio_sms_verify je tu preventívne — rovnaký zoznam ako v angio-005, aby poradie spustenia nič nezúžilo)

insert into settings (key, value)
select 'angio_common_notes', E'Príďte 10 minút pred termínom, so sebou kartičku poistenca a doklad totožnosti.\nAk nemôžete prísť, zrušte alebo presuňte termín aspoň 24 hodín vopred – uvoľníte miesto inému pacientovi.\nPoložky označené „po dohovore" sa neobjednávajú priamo online – najprv nás kontaktujte, dohodneme vhodný termín a prípravu.\nVyšetrenia nalačno objednávame prednostne na ranné hodiny.\nAk užívate lieky na riedenie krvi, nikdy ich nevysadzujte sami – o postupe rozhodneme spolu.\nČas termínu je orientačný. Sme špecializované pracovisko najvyššieho typu – termín sa výnimočne môže posunúť pre akútny zákrok. O plánovaných zmenách termínu vás vždy vopred informujeme e-mailom a SMS.'
where not exists (select 1 from settings where key = 'angio_common_notes');

-- HTML zoznam zo spoločných pokynov (jeden pokyn = riadok; „* ", „- ", „• " na začiatku sa ignorujú)
create or replace function angio_notes_html()
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_txt text;
  v_out text := '';
  l     text;
begin
  select value into v_txt from settings where key = 'angio_common_notes';
  if coalesce(v_txt, '') = '' then return ''; end if;
  for l in select regexp_split_to_table(v_txt, E'\r?\n') loop
    l := btrim(regexp_replace(btrim(l), '^[*•-]\s*', ''));
    if l <> '' then
      v_out := v_out || '<li style="margin:3px 0">' || html_escape(l) || '</li>';
    end if;
  end loop;
  if v_out = '' then return ''; end if;
  return '<div style="margin-top:14px;font-size:13px"><b>Všeobecné pokyny:</b><ul style="margin:6px 0 0;padding-left:20px">' || v_out || '</ul></div>';
end $$;
revoke all on function angio_notes_html() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Žiadanka podľa typu vyšetrenia
-- ------------------------------------------------------------
alter table angio_pricelist add column if not exists requires_referral boolean not null default true;

create or replace function angio_require_attachment()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_req boolean := true;
begin
  -- angio_pricelist je verejne čitateľný; neznámy typ = žiadanka povinná
  select coalesce(p.requires_referral, true) into v_req from angio_pricelist p where p.id = NEW.exam_type_id;
  if coalesce(v_req, true) and jsonb_array_length(coalesce(NEW.attachments, '[]'::jsonb)) = 0 then
    raise exception 'Pri objednávke je potrebné priložiť žiadanku (výmenný lístok).';
  end if;
  return NEW;
end $$;
-- trigger angio_orders_require_attachment (angio-001) ostáva

-- ------------------------------------------------------------
-- 3. E-maily: pokyny typu + spoločné pokyny
-- ------------------------------------------------------------
do $mig$
declare
  src   text;
  v_key text;
begin
  select prosrc into src from pg_proc
  where proname = 'angio_notify_trigger' and pronamespace = 'public'::regnamespace;
  v_key := coalesce(substring(src from 'v_key\s+text\s*:=\s*''([^'']*)'''), 'SEM_VLOZTE_RESEND_KLUC');
  if v_key like 'SEM\_%' then
    raise notice 'ANGIO e-maily: Resend kľúč zatiaľ nie je nastavený — e-maily ostanú vypnuté.';
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
  v_instr text := '';
begin
  if coalesce(NEW.email, '') = '' or v_key like 'SEM_%%' then return NEW; end if;
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  select coalesce(p.instructions, '') into v_instr from angio_pricelist p where p.id = NEW.exam_type_id;

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
    || case when NEW.status <> 'rejected' and v_instr <> '' then
         '<div style="margin-top:14px;padding:10px 12px;background:#F0F4FF;border-left:4px solid #2B46A2;font-size:13px"><b>Príprava a pokyny:</b><br>' || replace(html_escape(v_instr), E'\n', '<br>') || '</div>'
       else '' end
    || case when NEW.status <> 'rejected' then angio_notes_html() else '' end
    || case when NEW.status <> 'rejected' then '<p style="font-size:13px">Adresa: Pod Krásnou hôrkou 1, Bratislava.</p>' else '' end
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
  v_instr text;
  v_notes text;
  v_cnt  int := 0;
begin
  if v_key like 'SEM_%%' then return 0; end if;
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  v_notes := angio_notes_html();
  for r in
    select o.*, coalesce(p.instructions, '') as instr
    from angio_orders o left join angio_pricelist p on p.id = o.exam_type_id
    where o.slot_date between current_date and current_date + 1
      and o.status in ('new', 'confirmed')
      and o.reminder_sent_at is null
      and coalesce(o.email, '') <> ''
  loop
    v_termin := to_char(r.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(r.slot_time, 'HH24:MI');
    v_instr := r.instr;
    v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
      || email_header()
      || '<h2 style="color:#003d7c">Pripomienka: zajtra máte vyšetrenie v Angiologickej ambulancii č. 1</h2>'
      || '<table style="font-size:14px;border-collapse:collapse">'
      || case when coalesce(r.exam_label,'') <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Vyšetrenie</td><td><b>' || html_escape(r.exam_label) || '</b></td></tr>' else '' end
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
      || case when r.doctor <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || html_escape(r.doctor) || '</td></tr>' else '' end
      || '</table>'
      || case when v_instr <> '' then
           '<div style="margin-top:14px;padding:10px 12px;background:#F0F4FF;border-left:4px solid #2B46A2;font-size:13px"><b>Príprava a pokyny:</b><br>' || replace(html_escape(v_instr), E'\n', '<br>') || '</div>'
         else '' end
      || v_notes
      || '<p style="font-size:13px">Adresa: Pod Krásnou hôrkou 1, Bratislava.</p>'
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

-- ------------------------------------------------------------
-- 4. SMS: 10 min vopred, žiadanka len ak ju typ vyžaduje
-- ------------------------------------------------------------
do $mig$
declare
  src   text;
  v_id  text;
  v_tok text;
begin
  select prosrc into src from pg_proc
  where proname = 'angio_notify_sms' and pronamespace = 'public'::regnamespace;
  if src is null then
    raise notice 'ANGIO SMS: angio_notify_sms neexistuje — najprv spustite angio-002.sql; SMS časť preskočená.';
    return;
  end if;
  v_id  := coalesce(substring(src from 'v_app_id\s+text\s*:=\s*''([^'']*)'''),    'SEM_VLOZTE_APPLICATION_ID');
  v_tok := coalesce(substring(src from 'v_app_token\s+text\s*:=\s*''([^'']*)'''), 'SEM_VLOZTE_APPLICATION_TOKEN');

  execute format($def$
create or replace function angio_notify_sms()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_app_id    text := %L;
  v_app_token text := %L;
  v_number    text;
  v_termin    text;
  v_text      text := '';
  v_req       boolean := true;
  v_bring     text;
begin
  if v_app_id like 'SEM_%%' then return NEW; end if;
  v_number := sms_number(NEW.phone);
  if length(v_number) < 11 then return NEW; end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  select coalesce(p.requires_referral, true) into v_req from angio_pricelist p where p.id = NEW.exam_type_id;
  v_bring := case when coalesce(v_req, true) then 'Prineste ziadanku a zoznam liekov.' else 'Prineste zoznam liekov.' end;

  if TG_OP = 'INSERT' then
    v_text := 'NUSCH: Rezervacia - angiologicka amb. c. 1, ' || v_termin
      || '. ' || v_bring || ' Podrobnosti v e-maili.';
  elsif TG_OP = 'UPDATE' then
    if OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
      v_text := 'NUSCH: Vas termin v angiologickej amb. c. 1 ' || v_termin
        || ' je potvrdeny. Pridte 10 min vopred' || case when coalesce(v_req, true) then ' so ziadankou.' else '.' end;
    elsif OLD.status <> 'rejected' and NEW.status = 'rejected' then
      v_text := 'NUSCH: Vasa objednavka do angiologickej amb. c. 1 na ' || v_termin
        || ' bola zrusena. Podrobnosti v e-maili.';
    elsif OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time then
      v_text := 'NUSCH: Zmena terminu - angiologicka amb. c. 1. Novy termin: ' || v_termin
        || '. Podrobnosti v e-maili.';
    end if;
  end if;

  if v_text is not null and v_text <> '' then
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
end $fn$;
$def$, v_id, v_tok);

  execute format($def$
create or replace function send_angio_sms_reminders()
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_app_id    text := %L;
  v_app_token text := %L;
  r        record;
  v_number text;
  v_cnt    int := 0;
begin
  if v_app_id like 'SEM_%%' then return 0; end if;
  for r in
    select o.*, coalesce(p.requires_referral, true) as req
    from angio_orders o left join angio_pricelist p on p.id = o.exam_type_id
    where o.slot_date between current_date and current_date + 1
      and o.status in ('new', 'confirmed')
      and o.sms_reminder_sent_at is null
  loop
    v_number := sms_number(r.phone);
    if length(v_number) >= 11 then
      begin
        perform net.http_post(
          url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'application_id', v_app_id, 'application_token', v_app_token,
            'number', v_number,
            'text', 'NUSCH: Pripomienka - zajtra ' || to_char(r.slot_time, 'HH24:MI')
              || ' angiologicka amb. c. 1. Pridte 10 min vopred. '
              || case when r.req then 'Prineste ziadanku a zoznam liekov.' else 'Prineste zoznam liekov.' end
              || ' Zrusenie: SMS na 0949 000 677.',
            'unicode', false, 'sender_id', 'gText', 'sender_id_value', 'NUSCH')
        );
        v_cnt := v_cnt + 1;
      exception when others then null;
      end;
    end if;
    update angio_orders set sms_reminder_sent_at = now() where id = r.id;
  end loop;
  return v_cnt;
end $fn$;
$def$, v_id, v_tok);
end $mig$;

revoke all on function send_angio_sms_reminders() from public, anon, authenticated;
-- ============================================================
