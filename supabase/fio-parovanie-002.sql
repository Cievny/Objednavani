-- ============================================================
-- FIO PÁROVANIE 002 — spoľahlivé párovanie platieb (audit vlna 2)
--
-- Rieši dva nálezy auditu:
--  1. Variabilný symbol sa teraz prideľuje zo SERVERA zo sekvencie
--     (vs_seq) — je vždy unikátny. Predtým ho generoval prehliadač
--     ako Date.now(), čo sa opakovalo a mohlo spárovať platbu na
--     nesprávnu objednávku.
--  2. Fio sťahovanie prešlo z /last na /periods (posledné 3 dni) —
--     zarážka sa neposúva, takže ani pri stratenej odpovedi banky
--     sa žiadna platba nestratí; opakované pohyby sa preskočia
--     podľa unikátneho tx_id.
--
-- PRED SPUSTENÍM: vo funkcii fio_poll nahraďte SEM_VLOZTE_FIO_TOKEN
-- vaším Fio tokenom. (create_order token nepotrebuje.)
-- Idempotentné — možno spustiť opakovane.
-- ============================================================

-- Variabilný symbol sa prideľuje zo servera zo sekvencie — je vždy
-- unikátny (na rozdiel od pôvodného klientského Date.now(), ktorý sa
-- opakoval a mohol spôsobiť spárovanie platby na nesprávnu objednávku).
create sequence if not exists vs_seq start 1000000000;

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
  v_cell_doctor text;
  v_item   pricelist%rowtype;
  v_price  numeric;
  v_phone9 text;
  v_active int;
  v_dur    int;
  v_vs     text;
  n        int;
  v_cell   time;
begin
  if p_id !~ '^USG-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;

  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_referrer_name, '')) > 200
     or length(coalesce(p_referrer_facility, '')) > 200
     or length(coalesce(p_insurance, '')) > 100
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;

  v_phone9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;

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
  v_dur := greatest(coalesce(v_item.duration_slots, 2), 2) * 5; -- minimálne trvanie 10 min

  select count(*) into v_active
  from orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  -- testovacie číslo pracoviska je z limitu vyňaté (porovnáva sa
  -- posledných 9 číslic, pokryje 0917911202 aj +421917911202)
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky. Ak potrebujete ďalší termín, napíšte SMS na 0949 000 677.', v_active;
  end if;

  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  if p_slot_date < current_date then
    raise exception 'Termín v minulosti nie je možné objednať.';
  end if;

  v_vs := nextval('vs_seq')::text; -- garantovane unikátny VS zo servera

  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor
    from open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then
      v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  if exists (
    select 1 from orders o
    where o.slot_date = p_slot_date and o.status <> 'rejected'
      and int4range(
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int,
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int + o.duration_min
          ) && int4range(
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int,
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int + v_dur
          )
  ) then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
  end if;

  insert into orders (
    id, has_referral, exam_type_id, exam_label, price, reason,
    referrer_name, referrer_facility, patient_name, birth_date,
    insurance, phone, email, slot_date, slot_time, variable_symbol, doctor, attachments, duration_min
  ) values (
    p_id, p_has_referral, p_exam_type_id, v_item.label, v_price, p_reason,
    coalesce(p_referrer_name, ''), coalesce(p_referrer_facility, ''), p_patient_name, p_birth_date,
    coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''), p_slot_date, p_slot_time, v_vs,
    coalesce(v_doctor, ''), coalesce(p_attachments, '[]'::jsonb), v_dur
  );
  return v_vs; -- klient zobrazí tento VS v QR platbe
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

create or replace function fio_poll()
returns int
language plpgsql security definer set search_path = public as $func$
declare
  v_token text := 'SEM_VLOZTE_FIO_TOKEN';
  r      record;
  tx     jsonb;
  v_json jsonb;
  v_req  bigint;
  v_cnt  int := 0;
  v_txid text;
  v_amt  numeric;
  v_cur  text;
  v_vs   text;
  v_msg  text;
  v_acct text;
  v_order orders%rowtype;
begin
  if v_token like 'SEM_%' then
    return 0; -- token ešte nie je nastavený
  end if;

  -- 1. spracovať odpovede na predchádzajúce požiadavky
  for r in select fr.request_id, fr.requested_at from fio_requests fr where not fr.processed loop
    select content::jsonb into v_json
    from net._http_response
    where id = r.request_id and status_code = 200;

    if v_json is null then
      -- odpoveď ešte nedorazila alebo zlyhala; po hodine to vzdaj
      if r.requested_at < now() - interval '1 hour' then
        update fio_requests set processed = true where request_id = r.request_id;
      end if;
      continue;
    end if;

    for tx in
      select * from jsonb_array_elements(
        coalesce(v_json #> '{accountStatement,transactionList,transaction}', '[]'::jsonb))
    loop
      v_txid := tx #>> '{column22,value}';  -- ID pohybu
      v_amt  := nullif(tx #>> '{column1,value}', '')::numeric;   -- objem
      v_cur  := coalesce(tx #>> '{column14,value}', '');         -- mena
      v_vs   := coalesce(tx #>> '{column5,value}', '');          -- variabilný symbol
      v_msg  := coalesce(tx #>> '{column16,value}', '');         -- správa pre príjemcu
      v_acct := coalesce(tx #>> '{column2,value}', '');          -- protiúčet

      -- len došlé platby (kladné sumy)
      if v_txid is null or v_amt is null or v_amt <= 0 then
        continue;
      end if;

      -- idempotencia: každý pohyb spracuj len raz
      begin
        insert into fio_payments (tx_id, vs, amount, currency, counter_account, message)
        values (v_txid, v_vs, v_amt, v_cur, v_acct, left(v_msg, 200));
      exception when unique_violation then
        continue;
      end;

      select * into v_order from orders o
      where o.variable_symbol = v_vs and o.variable_symbol <> '' and o.status <> 'rejected'
      order by o.created_at desc limit 1;

      if not found then
        update fio_payments set note = 'nespárované — objednávka s týmto VS neexistuje' where tx_id = v_txid;
        continue;
      end if;
      if v_order.paid then
        update fio_payments set matched_order_id = v_order.id, note = 'objednávka už bola zaplatená' where tx_id = v_txid;
        continue;
      end if;
      if v_cur <> '' and v_cur <> 'EUR' then
        update fio_payments set matched_order_id = v_order.id, note = 'iná mena (' || v_cur || ') — preveriť ručne' where tx_id = v_txid;
        continue;
      end if;
      if v_amt + 0.005 < v_order.price then
        update fio_payments set matched_order_id = v_order.id,
          note = 'nižšia suma (' || v_amt || ' z ' || v_order.price || ' €) — preveriť ručne' where tx_id = v_txid;
        continue;
      end if;

      -- spárované: zaplatené + potvrdenie termínu (spustí e-mail a SMS)
      update orders set
        paid = true,
        paid_at = now(),
        status = case when status = 'new' then 'confirmed' else status end
      where id = v_order.id;
      update fio_payments set matched_order_id = v_order.id, note = 'spárované automaticky' where tx_id = v_txid;
      v_cnt := v_cnt + 1;
    end loop;

    update fio_requests set processed = true where request_id = r.request_id;
  end loop;

  -- 2. nová požiadavka na banku za posledné 3 dni (odpoveď spracuje
  -- ďalší beh). /periods neposúva zarážku — okná sa prekrývajú a
  -- idempotencia cez tx_id zaručí, že sa žiadna platba nestratí ani
  -- nespáruje dvakrát.
  select net.http_get(url := 'https://fioapi.fio.cz/v1/rest/periods/' || v_token || '/'
      || to_char(current_date - 3, 'YYYY-MM-DD') || '/'
      || to_char(current_date, 'YYYY-MM-DD') || '/transactions.json')
  into v_req;
  insert into fio_requests (request_id) values (v_req);

  -- 3. upratovanie (finančné logy držíme 90 dní ako ostatné logy)
  delete from fio_payments where received_at < now() - interval '90 days';
  delete from fio_requests where requested_at < now() - interval '7 days';

  return v_cnt;
end $func$;
-- ============================================================
