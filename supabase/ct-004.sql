-- ============================================================
-- CT 004 — pripomienka deň pred CT vyšetrením (e-mail)
--   Denne o 15:00 UTC (17:00 SELČ) prejde CT objednávky na
--   zajtra (a nedoručené na dnes) a pošle pripomienku.
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_RESEND_KLUC.
-- Idempotentné. Spúšťať PO ct-002.
-- ============================================================

create extension if not exists pg_cron;

alter table ct_orders add column if not exists reminder_sent_at timestamptz;

create or replace function send_ct_reminders()
returns int
language plpgsql security definer set search_path = public as $func$
declare
  v_key  text := 'SEM_VLOZTE_RESEND_KLUC';
  v_from text;
  r      record;
  v_termin text;
  v_html text;
  v_cnt  int := 0;
begin
  if v_key like 'SEM_%' then return 0; end if;
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;

  for r in
    select * from ct_orders
    where slot_date between current_date and current_date + 1
      and status in ('new', 'confirmed')
      and reminder_sent_at is null
      and coalesce(email, '') <> ''
  loop
    v_termin := to_char(r.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(r.slot_time, 'HH24:MI');
    v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
      || email_header()
      || '<h2 style="color:#003d7c">Pripomienka: zajtra máte CT vyšetrenie</h2>'
      || '<table style="font-size:14px;border-collapse:collapse">'
      || case when coalesce(r.exam_label,'') <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Vyšetrenie</td><td><b>' || html_escape(r.exam_label) || '</b></td></tr>' else '' end
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
      || case when r.doctor <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || html_escape(r.doctor) || '</td></tr>' else '' end
      || '</table>'
      || '<p style="font-size:13px">Príďte prosím 15 minút pred termínom. Pod Krásnou hôrkou 1, Bratislava. Prineste si žiadanku a predchádzajúce nálezy.</p>'
      || '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">'
      || '<p style="margin:0">CT je bez poplatku. Zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p></div>'
      || '</div>';
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(r.email),
        'subject', 'Pripomienka: zajtra ' || to_char(r.slot_time, 'HH24:MI') || ' — CT vyšetrenie', 'html', v_html)
    );
    update ct_orders set reminder_sent_at = now() where id = r.id;
    v_cnt := v_cnt + 1;
  end loop;
  return v_cnt;
end $func$;
revoke all on function send_ct_reminders() from public, anon, authenticated;

do $$ begin perform cron.unschedule('ct-reminders'); exception when others then null; end $$;
select cron.schedule('ct-reminders', '0 15 * * *', $$select send_ct_reminders()$$);

-- Diagnostika:  select send_ct_reminders();
-- ============================================================
