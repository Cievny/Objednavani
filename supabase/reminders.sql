-- ============================================================
-- Pripomienka deň pred vyšetrením (e-mail + voliteľne SMS)
--
-- Denne o 15:00 UTC (17:00 letného SK času) prejde objednávky
-- na zajtrajšok a pošle pacientom pripomienku. Ak objednávka
-- ešte nie je zaplatená, doplní aj výzvu na platbu s IBAN a VS.
--
-- PRED SPUSTENÍM:
--   v_key         — Resend kľúč (rovnaký ako v notify_order_emails)
--   v_sms_id/token — BulkGate kľúče; ak ostanú SEM_…, SMS sa
--                    jednoducho preskočí a chodí len e-mail.
--
-- Skript je idempotentný — možno ho spúšťať opakovane (napr.
-- po doplnení BulkGate kľúčov).
--
-- Test: objednávka na zajtra + `select send_reminders();`
-- Druhé spustenie už nič neposiela (reminder_sent_at).
-- ============================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table orders add column if not exists reminder_sent_at timestamptz;

-- Telefón do medzinárodného tvaru (0903... -> 421903...; zvládne aj
-- zadanie bez úvodnej nuly: 903... -> 421903...)
create or replace function sms_number(p_phone text)
returns text language sql immutable as $$
  select case
    when d like '00%'  then substring(d from 3)
    when d like '421%' then d
    when d like '0%'   then '421' || substring(d from 2)
    when length(d) = 9 and d like '9%' then '421' || d
    else d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) x;
$$;

-- Hlavička s logom NÚSCH — rovnaká definícia ako v emaily-storna-001.sql
-- (create or replace, takže je jedno, ktorý skript sa spustí prvý)
create or replace function email_header()
returns text language sql stable set search_path = public as $$
  select '<div style="border-bottom:3px solid #e2001a;padding-bottom:12px;margin-bottom:16px">'
    || '<table role="presentation" style="border-collapse:collapse"><tr>'
    || '<td style="padding:0;vertical-align:middle"><img src="https://objednanie.cievny.sk/logo-nusch.png" width="46" height="46" alt="NÚSCH" style="display:block;border:0"></td>'
    || '<td style="padding:0 0 0 10px;vertical-align:middle"><b style="color:#003d7c">Národný ústav srdcových a cievnych chorôb, a.s.</b><br>'
    || '<span style="color:#64748b;font-size:12px">Objednávanie na USG</span></td>'
    || '</tr></table></div>';
$$;

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

    -- e-mail
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
        || email_header()
        || '<h2 style="color:#003d7c">Pripomienka: zajtra máte vyšetrenie</h2>'
        || '<p><b>' || html_escape(r.exam_label) || '</b><br>' || v_termin
        || case when r.doctor <> '' then '<br>Lekár: ' || html_escape(r.doctor) else '' end || '</p>'
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

    -- SMS (len ak sú vyplnené BulkGate kľúče)
    if v_sms_id not like 'SEM_%' and v_sms_token not like 'SEM_%' then
      v_number := sms_number(r.phone);
      if length(v_number) >= 11 then
        v_sms := 'NUSCH: Pripomienka - zajtra ' || to_char(r.slot_time, 'HH24:MI')
          || ' mate USG vysetrenie.'
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

-- funkcia je interná — nespúšťa ju pacient ani personál, len cron
revoke all on function send_reminders() from public, anon, authenticated;

-- naplánovať denne 15:00 UTC (17:00 SELČ / 16:00 SEČ); idempotentne
do $$
begin
  perform cron.unschedule('usg-reminders');
exception when others then null;
end $$;
select cron.schedule('usg-reminders', '0 15 * * *', $$select send_reminders()$$);

-- Diagnostika:
--   select * from cron.job;                                  -- job existuje?
--   select send_reminders();                                 -- ručný test (vráti počet)
--   select id, status_code from net._http_response order by id desc limit 5;
