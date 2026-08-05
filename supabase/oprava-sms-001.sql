-- ============================================================
-- OPRAVA SMS — 001: rezervačná SMS sa neposielala pri objednávke
-- bez ceny (price NULL) — to_char(NULL) zmenil celý text na NULL
-- a trigger ju potichu preskočil. Potvrdzovacia SMS cenu
-- neobsahuje, preto chodila normálne.
--
-- Oprava: null-safe rezervačný text — pri objednávke bez ceny
-- (alebo 0 €) sa pošle verzia bez platobných údajov. Ostatné
-- vetvy (potvrdenie, zrušenie, presun, zmena lekára) aj obalenie
-- výnimkou ostávajú 1:1 z audit-vlna5-005.
--
-- KĽÚČE NETREBA VKLADAŤ: skript si BulkGate application_id/token
-- prečíta z aktuálnej funkcie v databáze a vloží ich do novej.
-- Ak by v databáze boli ešte placeholder kľúče (SEM_…), skript
-- skončí chybou s upozornením — vtedy treba najprv spustiť
-- vlna5-005 s vyplnenými kľúčmi.
--
-- DIAGNOSTIKA (spustite samostatne, ak chcete overiť stav):
--   -- sú v databáze skutočné kľúče? (false = v poriadku)
--   select prosrc like '%SEM_VLOZTE%' as placeholder_kluce
--   from pg_proc where proname = 'notify_order_sms'
--     and pronamespace = 'public'::regnamespace;
--   -- odpovede SMS brány na posledné pokusy:
--   select id, status_code, left(content::text, 200)
--   from net._http_response order by id desc limit 10;
--   -- mali posledné objednávky cenu?
--   select id, price, variable_symbol, created_at
--   from orders order by created_at desc limit 5;
-- ============================================================

do $fix$
declare
  src   text;
  v_id  text;
  v_tok text;
begin
  select prosrc into src
  from pg_proc
  where proname = 'notify_order_sms' and pronamespace = 'public'::regnamespace;

  if src is null then
    raise exception 'Funkcia notify_order_sms neexistuje — spustite najprv audit-vlna5-005 s kľúčmi.';
  end if;

  v_id  := substring(src from 'v_app_id\s+text\s*:=\s*''([^'']*)''');
  v_tok := substring(src from 'v_app_token\s+text\s*:=\s*''([^'']*)''');

  if v_id is null or v_tok is null or v_id like 'SEM\_%' or v_tok like 'SEM\_%' then
    raise exception 'V databáze sú placeholder SMS kľúče (SEM_…) — SMS sú teraz úplne vypnuté! Spustite audit-vlna5-005 s vyplnenými BulkGate kľúčmi a potom tento skript.';
  end if;

  execute format($def$
create or replace function notify_order_sms()
returns trigger
language plpgsql security definer set search_path = public as $func$
declare
  v_app_id    text := %L;
  v_app_token text := %L;
  v_number    text;
  v_termin    text;
  v_text      text := '';
  v_ambul     text;
begin
  if v_app_id like 'SEM_%%' then
    return NEW;
  end if;
  v_number := sms_number(NEW.phone);
  if length(v_number) < 11 then
    return NEW;
  end if;
  v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
  v_ambul := doctor_location(NEW.doctor);

  if TG_OP = 'INSERT' then
    -- null-safe: objednávka bez ceny (žiadanka bez doplatku a pod.)
    -- dostane rezervačnú SMS bez platobných údajov
    if NEW.price is not null and NEW.price > 0 then
      v_text := 'NUSCH: Rezervacia USG ' || v_termin
        || '. Uhradte ' || replace(to_char(NEW.price, 'FM990D00'), '.', ',') || ' EUR, VS '
        || coalesce(NEW.variable_symbol, '') || '. Platobne udaje najdete v e-maili.';
    else
      v_text := 'NUSCH: Rezervacia USG ' || v_termin || '. Podrobnosti najdete v e-maili.';
    end if;
  elsif TG_OP = 'UPDATE' then
    if OLD.status <> 'confirmed' and NEW.status = 'confirmed' then
      v_text := 'NUSCH: Vas termin USG ' || v_termin || ' je potvrdeny.'
        || case when v_ambul <> '' then ' Miesto: ' || v_ambul || '.' else '' end
        || ' Tesime sa na Vas.';
    elsif OLD.status <> 'rejected' and NEW.status = 'rejected' then
      v_text := 'NUSCH: Vasa objednavka USG na ' || v_termin || ' bola zrusena.'
        || case when NEW.paid and coalesce(NEW.price, 0) > 0 then ' Platbu vam vratime prevodom do 7 prac. dni.' else '' end
        || ' Podrobnosti v e-maili.';
    elsif OLD.slot_date <> NEW.slot_date or OLD.slot_time <> NEW.slot_time then
      v_text := 'NUSCH: Zmena terminu USG. Novy termin: ' || v_termin || '.'
        || case when v_ambul <> '' then ' Miesto: ' || v_ambul || '.' else '' end
        || ' Ak vam nevyhovuje, mozete ho zrusit cez odkaz v e-maili (min. 48 h vopred).';
    elsif OLD.doctor is distinct from NEW.doctor and NEW.status in ('new', 'confirmed') then
      v_text := 'NUSCH: Vase USG vysetrenie ' || v_termin || ' vykona ' || NEW.doctor || '.'
        || case when v_ambul <> '' then ' Miesto: ' || v_ambul || '.' else '' end
        || ' Termin a cas sa nemenia, kvalita vysetrenia zostava rovnaka.';
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
end $func$;
$def$, v_id, v_tok);

  raise notice 'notify_order_sms opravená, BulkGate kľúče zachované.';
end $fix$;

drop trigger if exists orders_sms_notify on orders;
create trigger orders_sms_notify
after insert or update on orders
for each row execute function notify_order_sms();
