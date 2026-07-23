-- ============================================================
-- SMS notifikácie pacientom cez BulkGate (portal.bulkgate.com)
--
-- Rovnaký princíp ako e-maily: trigger na tabuľke orders volá
-- SMS API cez pg_net. Beží popri e-mailovom triggeri.
--
-- PRED SPUSTENÍM doplňte:
--   v_app_id    — Application ID    (BulkGate -> Moduly -> API)
--   v_app_token — Application token
--
-- SMS sú zámerne bez diakritiky: s diakritikou sa SMS delí už
-- po 70 znakoch (2–3x drahšie), bez nej má 160 znakov.
-- ============================================================

create extension if not exists pg_net;

-- Telefón do medzinárodného tvaru (0903... -> 421903...)
create or replace function sms_number(p_phone text)
returns text language sql immutable as $$
  select case
    when d like '00%'  then substring(d from 3)
    when d like '421%' then d
    when d like '0%'   then '421' || substring(d from 2)
    else d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) x;
$$;

create or replace function notify_order_sms()
returns trigger
language plpgsql security definer set search_path = public as $func$
declare
  v_app_id    text := 'SEM_VLOZTE_APPLICATION_ID';
  v_app_token text := 'SEM_VLOZTE_APPLICATION_TOKEN';
  v_number    text;
  v_termin    text;
  v_text      text := '';
begin
  v_number := sms_number(NEW.phone);
  if length(v_number) < 11 then
    return NEW; -- neplatné číslo, SMS sa neposiela
  end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');

  if TG_OP = 'INSERT' then
    v_text := 'NUSCH: Rezervacia USG ' || v_termin
      || '. Uhradte ' || replace(to_char(NEW.price, 'FM990D00'), '.', ',') || ' EUR, VS '
      || NEW.variable_symbol || '. Platobne udaje najdete v e-maili.';
  elsif TG_OP = 'UPDATE' then
    if OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
      v_text := 'NUSCH: Vas termin USG ' || v_termin || ' je potvrdeny. Tesime sa na Vas.';
    elsif OLD.status <> 'rejected' and NEW.status = 'rejected' then
      v_text := 'NUSCH: Vasa objednavka USG na ' || v_termin || ' bola zrusena. Podrobnosti v e-maili.';
    elsif OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time then
      v_text := 'NUSCH: Zmena terminu USG. Novy termin: ' || v_termin || '.';
    end if;
  end if;

  if v_text <> '' then
    perform net.http_post(
      url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'application_id', v_app_id,
        'application_token', v_app_token,
        'number', v_number,
        'text', v_text,
        'unicode', false,
        'sender_id', 'gText',
        'sender_id_value', 'NUSCH'
      )
    );
  end if;
  return NEW;
end $func$;

drop trigger if exists orders_sms_notify on orders;
create trigger orders_sms_notify
after insert or update on orders
for each row execute function notify_order_sms();

-- Diagnostika po testovacej objednávke (odpoveď SMS brány):
--   select id, status_code, content::text
--   from net._http_response order by id desc limit 5;

-- Vypnutie SMS notifikácií:
--   drop trigger if exists orders_sms_notify on orders;
