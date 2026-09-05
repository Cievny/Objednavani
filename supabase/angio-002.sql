-- ============================================================
-- ANGIO 002 — SMS notifikácie pre Angiologickú ambulanciu č. 1
--   • rezervácia (prijatie), potvrdenie, zrušenie, presun termínu
--   • pripomienka deň vopred (cron 15:00 UTC, samostatný stĺpec
--     sms_reminder_sent_at — nezávislé od e-mailovej pripomienky)
--
-- Bez platobných údajov (vyšetrenie je bez poplatku). SMS bez
-- diakritiky (160 znakov), cez BulkGate ako USG.
--
-- KĽÚČE NETREBA VKLADAŤ: application_id/token sa prevezmú z
-- existujúcej notify_order_sms (rovnaký vzor ako oprava-sms-001).
-- Ak sú tam placeholdery, SMS ostanú vypnuté (notice) — po doplnení
-- kľúčov spustite skript znova.
--
-- Idempotentné. Spúšťať PO angio-001 (vyžaduje sms_number, net.http_post).
-- ============================================================

alter table angio_orders add column if not exists sms_reminder_sent_at timestamptz;

do $mig$
declare
  src   text;
  v_id  text;
  v_tok text;
begin
  select prosrc into src from pg_proc
  where proname = 'notify_order_sms' and pronamespace = 'public'::regnamespace;
  v_id  := coalesce(substring(src from 'v_app_id\s+text\s*:=\s*''([^'']*)'''),    'SEM_VLOZTE_APPLICATION_ID');
  v_tok := coalesce(substring(src from 'v_app_token\s+text\s*:=\s*''([^'']*)'''), 'SEM_VLOZTE_APPLICATION_TOKEN');
  if v_id like 'SEM\_%' or v_tok like 'SEM\_%' then
    raise notice 'ANGIO SMS: v notify_order_sms sú zatiaľ placeholder BulkGate kľúče — angio SMS ostanú vypnuté. Po doplnení kľúčov spustite tento skript znova.';
  end if;

  -- ---------------------------------------------------------
  -- trigger: rezervácia / potvrdenie / zrušenie / presun
  -- ---------------------------------------------------------
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
begin
  if v_app_id like 'SEM_%%' then return NEW; end if;
  v_number := sms_number(NEW.phone);
  if length(v_number) < 11 then return NEW; end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');

  if TG_OP = 'INSERT' then
    v_text := 'NUSCH: Rezervacia - angiologicka amb. c. 1, ' || v_termin
      || '. Prineste ziadanku a zoznam liekov. Podrobnosti v e-maili.';
  elsif TG_OP = 'UPDATE' then
    if OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
      v_text := 'NUSCH: Vas termin v angiologickej amb. c. 1 ' || v_termin
        || ' je potvrdeny. Pridte 15 min vopred so ziadankou.';
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

  -- ---------------------------------------------------------
  -- pripomienka SMS deň vopred (dnes + zajtra, raz na objednávku)
  -- ---------------------------------------------------------
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
    select * from angio_orders
    where slot_date between current_date and current_date + 1
      and status in ('new', 'confirmed')
      and sms_reminder_sent_at is null
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
              || ' angiologicka amb. c. 1. Prineste ziadanku a zoznam liekov. Zrusenie: SMS na 0949 000 677.',
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

drop trigger if exists angio_orders_sms_notify on angio_orders;
create trigger angio_orders_sms_notify
after insert or update on angio_orders
for each row execute function angio_notify_sms();

do $$ begin perform cron.unschedule('angio-sms-reminders'); exception when others then null; end $$;
do $$ begin perform cron.schedule('angio-sms-reminders', '0 15 * * *', $q$select send_angio_sms_reminders()$q$); exception when others then null; end $$;

-- Diagnostika (odpoveď SMS brány):
--   select id, status_code, content::text from net._http_response order by id desc limit 5;
-- ============================================================
