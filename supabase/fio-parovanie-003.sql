-- ============================================================
-- FIO PÁROVANIE 003 — rýchle párovanie (~1 minúta od pripísania)
--
-- Zmeny oproti 002:
--  1. Cron beží každú MINÚTU (Fio limit je 1 požiadavka / 30 s —
--     stále s rezervou).
--  2. fio_poll si odpoveď banky počká (~8 s) a spáruje platby hneď
--     v tom istom behu — žiadne čakanie na ďalší cyklus. Staršie
--     nespracované odpovede sa dorátajú na začiatku behu (poistka).
--  Výsledok: platba pripísaná v banke sa spáruje typicky do minúty
--  a pacientovi hneď odíde potvrdzovací e-mail/SMS. Tlačidlo
--  „Overiť platby" funguje na jedno kliknutie.
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_FIO_TOKEN vaším Fio tokenom.
-- Idempotentné — možno spúšťať opakovane.
-- ============================================================

-- Spracovanie jednej odpovede banky: parsovanie pohybov + párovanie.
-- Vracia počet novo spárovaných objednávok.
create or replace function fio_process_request(p_request_id bigint, p_requested_at timestamptz)
returns int
language plpgsql security definer set search_path = public as $func$
declare
  tx     jsonb;
  v_json jsonb;
  v_cnt  int := 0;
  v_txid text;
  v_amt  numeric;
  v_cur  text;
  v_vs   text;
  v_msg  text;
  v_acct text;
  v_order orders%rowtype;
begin
  select content::jsonb into v_json
  from net._http_response
  where id = p_request_id and status_code = 200;

  if v_json is null then
    -- odpoveď ešte nedorazila alebo zlyhala; po hodine to vzdaj
    -- (/periods zarážku neposúva, takže sa nič nestratí — pohyby
    -- prídu v ďalšom 3-dňovom okne)
    if p_requested_at < now() - interval '1 hour' then
      update fio_requests set processed = true where request_id = p_request_id;
    end if;
    return 0;
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

    if v_txid is null or v_amt is null or v_amt <= 0 then
      continue; -- len došlé platby
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

  update fio_requests set processed = true where request_id = p_request_id;
  return v_cnt;
end $func$;

revoke all on function fio_process_request(bigint, timestamptz) from public, anon, authenticated;

create or replace function fio_poll()
returns int
language plpgsql security definer set search_path = public as $func$
declare
  v_token text := 'SEM_VLOZTE_FIO_TOKEN';
  r      record;
  v_req  bigint;
  v_cnt  int := 0;
begin
  if v_token like 'SEM_%' then
    return 0;
  end if;

  -- 1. poistka: dopracuj prípadné staršie nespracované odpovede
  for r in select fr.request_id, fr.requested_at from fio_requests fr where not fr.processed loop
    v_cnt := v_cnt + fio_process_request(r.request_id, r.requested_at);
  end loop;

  -- 2. nová požiadavka za posledné 3 dni (/periods zarážku neposúva)
  select net.http_get(url := 'https://fioapi.fio.cz/v1/rest/periods/' || v_token || '/'
      || to_char(current_date - 3, 'YYYY-MM-DD') || '/'
      || to_char(current_date, 'YYYY-MM-DD') || '/transactions.json')
  into v_req;
  insert into fio_requests (request_id) values (v_req);

  -- 3. počkaj na odpoveď a spáruj HNEĎ (bez čakania na ďalší beh)
  perform pg_sleep(8);
  v_cnt := v_cnt + fio_process_request(v_req, now());

  -- 4. upratovanie
  delete from fio_payments where received_at < now() - interval '90 days';
  delete from fio_requests where requested_at < now() - interval '7 days';

  return v_cnt;
end $func$;

revoke all on function fio_poll() from public, anon, authenticated;

-- každú minútu (predtým každých 5 minút)
do $$
begin
  perform cron.unschedule('fio-parovanie');
exception when others then null;
end $$;
select cron.schedule('fio-parovanie', '* * * * *', $$select fio_poll()$$);

-- Kontrola:
--   select * from cron.job where jobname = 'fio-parovanie';   -- schedule = * * * * *
--   select * from fio_payments order by received_at desc;     -- stav párovania
-- ============================================================
