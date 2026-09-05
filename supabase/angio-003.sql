-- ============================================================
-- ANGIO 003 — krátky popis vyšetrenia + pokyny do e-mailu
--   • angio_pricelist.description — jednoriadkový popis, pacient
--     ho vidí pri výbere typu vyšetrenia
--   • angio_pricelist.instructions (existujúci) — pokyny/príprava,
--     odteraz sa posielajú v potvrdzovacom e-maili a v pripomienke
--
-- KĽÚČE NETREBA VKLADAŤ: Resend kľúč sa prevezme z existujúcej
-- angio_notify_trigger (vytvorenej v angio-001).
-- Idempotentné. Spúšťať PO angio-001.
-- ============================================================

alter table angio_pricelist add column if not exists description text not null default '';

-- predvyplnené krátke popisy (len tam, kde ešte chýbajú)
update angio_pricelist set description = v.d
from (values
  ('ang_prve',     'Komplexné vyšetrenie ciev pri nových ťažkostiach'),
  ('ang_kontrola', 'Kontrola u pacientov v našej starostlivosti'),
  ('ang_usg_dk',   'Ultrazvuk tepien a žíl nôh'),
  ('ang_usg_krk',  'Ultrazvuk krčných tepien'),
  ('ang_konzult',  'Konzultácia nálezov a ďalšieho postupu')
) v(id, d)
where angio_pricelist.id = v.id and angio_pricelist.description = '';

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
    || case when NEW.status <> 'rejected' then '<p style="font-size:13px">Príďte prosím 15 minút pred termínom. Pod Krásnou hôrkou 1, Bratislava.</p>' else '' end
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
  v_cnt  int := 0;
begin
  if v_key like 'SEM_%%' then return 0; end if;
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
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
      || '<p style="font-size:13px">Príďte prosím 15 minút pred termínom. Pod Krásnou hôrkou 1, Bratislava.</p>'
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
-- trigger angio_orders_notify ostáva (viaže sa na názov funkcie)
-- ============================================================
