-- ============================================================
-- AUDIT FIXY 001 — nízkorizikové opravy z komplexného auditu (v32)
--
-- Obsah:
--  1. Timezone bug v pravidle 48 h (storno) — naivný čas termínu
--     sa teraz interpretuje ako bratislavský, nie UTC.
--  2. audit_log RLS — číta len superadmin a sestra (nie ktokoľvek
--     prihlásený / lekár / konto bez roly).
--  3. Pripomienkový e-mail dostane rovnakú pätičku (VOP/GDPR odkazy,
--     možnosť zrušenia, kontakt) ako ostatné e-maily.
--  4. Výmaz nevyužitých objednávok presne po 28 dňoch (nie 29).
--
-- Idempotentné (create or replace / drop policy). Spustiť po
-- complete-setup-002.sql a emaily-storna-001.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Timezone-korektné pravidlo 48 hodín pri pacientskom zrušení
-- ------------------------------------------------------------
create or replace function cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_when timestamptz;
begin
  perform check_lookup_limit('cancel:' || upper(coalesce(p_id, '')));

  -- naivný čas termínu (bez zóny) interpretujeme ako bratislavský,
  -- takže rozdiel voči now() je správny nezávisle od letného času
  select ((o.slot_date + o.slot_time) at time zone 'Europe/Bratislava') into v_when
  from orders o
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');

  if v_when is not null and v_when - now() < interval '48 hours' then
    raise exception 'Do termínu zostáva menej ako 48 hodín — napíšte nám SMS s číslom objednávky na 0949 000 677.';
  end if;

  update orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- ------------------------------------------------------------
-- 2. audit_log — čítať smie len superadmin a sestra
-- ------------------------------------------------------------
drop policy if exists "audit cita personal" on audit_log;
create policy "audit cita personal" on audit_log
  for select using (my_role() in ('superadmin', 'sestra'));

-- ------------------------------------------------------------
-- 3. Výmaz nevyužitých objednávok presne po 28 dňoch
--    (jediná zmena v purge_orders oproti complete-setup-002)
-- ------------------------------------------------------------
create or replace function purge_orders()
returns table (deleted_done int, deleted_old int, scrubbed int)
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_done int := 0;
  v_old int := 0;
  v_scrub int := 0;
begin
  for r in
    select id from orders
    where (attachments <> '[]'::jsonb or reason <> '' or referrer_name <> '')
      and status <> 'rejected'
      and (
        (slot_date < current_date and status in ('new', 'noshow'))
        or slot_date <= current_date - 7
      )
  loop
    perform purge_order_files(r.id);
    update orders set attachments = '[]'::jsonb, reason = '', referrer_name = '', referrer_facility = ''
    where id = r.id;
    v_scrub := v_scrub + 1;
  end loop;

  for r in
    select id, slot_date, exam_type_id, status, doctor from orders
    where status = 'rejected' and coalesce(rejected_at, now()) <= now() - interval '7 days'
  loop
    perform purge_order_files(r.id);
    insert into usg_stats (day, exam_type_id, status, doctor, cnt, paid_cnt, paid_eur)
    values (r.slot_date, r.exam_type_id, r.status, coalesce(r.doctor, ''), 1, 0, 0)
    on conflict (day, exam_type_id, status, doctor) do update set cnt = usg_stats.cnt + 1;
    delete from orders where id = r.id;
    v_old := v_old + 1;
  end loop;

  for r in
    select id, slot_date, exam_type_id, status, doctor, paid, price from orders
    where status = 'done' and slot_date <= current_date - 7
  loop
    perform purge_order_files(r.id);
    insert into usg_stats (day, exam_type_id, status, doctor, cnt, paid_cnt, paid_eur)
    values (r.slot_date, r.exam_type_id, r.status, coalesce(r.doctor, ''), 1,
            case when r.paid then 1 else 0 end,
            case when r.paid then r.price else 0 end)
    on conflict (day, exam_type_id, status, doctor) do update
      set cnt = usg_stats.cnt + 1,
          paid_cnt = usg_stats.paid_cnt + excluded.paid_cnt,
          paid_eur = usg_stats.paid_eur + excluded.paid_eur;
    delete from orders where id = r.id;
    v_done := v_done + 1;
  end loop;

  for r in
    select id, slot_date, exam_type_id, status, doctor from orders
    where slot_date <= current_date - 28 and status not in ('done', 'rejected')
  loop
    perform purge_order_files(r.id);
    insert into usg_stats (day, exam_type_id, status, doctor, cnt, paid_cnt, paid_eur)
    values (r.slot_date, r.exam_type_id, r.status, coalesce(r.doctor, ''), 1, 0, 0)
    on conflict (day, exam_type_id, status, doctor) do update set cnt = usg_stats.cnt + 1;
    delete from orders where id = r.id;
    v_old := v_old + 1;
  end loop;

  delete from audit_log where at < now() - interval '90 days';
  delete from lookup_attempts where window_start < now() - interval '90 days';
  begin
    delete from net._http_response where created < now() - interval '90 days';
  exception when others then null;
  end;
  begin
    delete from cron.job_run_details where end_time < now() - interval '90 days';
  exception when others then null;
  end;

  return query select v_done, v_old, v_scrub;
end $$;

-- ------------------------------------------------------------
-- 4. Pripomienkový e-mail s pätičkou (VOP/GDPR odkazy, zrušenie,
--    kontakt) — plná verzia send_reminders
--    PRED SPUSTENÍM: doplňte SEM_VLOZTE_RESEND_KLUC a BulkGate údaje.
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
        || email_footer(r.id)
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
-- ============================================================
