-- ============================================================
-- FIO DIAG 001 — diagnostika spojenia s Fio bankou jedným príkazom
--
-- Použitie v SQL editore:
--   select fio_diag();
--
-- Funkcia pošle testovaciu požiadavku na Fio API (endpoint
-- /periods — NEPOSÚVA zarážku sťahovania, je bezpečné ju
-- spúšťať opakovane), počká na odpoveď a vráti slovenský
-- verdikt, kde presne to viazne:
--   ✓ 200  = API funguje, párovanie pôjde
--   409    = limit 1 požiadavka / 30 s — počkať a spustiť znova
--   422    = banka čaká na autorizáciu tokenu v internetbankingu
--   404/5xx= token je neplatný — vygenerovať nový
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_FIO_TOKEN skutočným
-- tokenom (ten istý ako vo fio-parovanie-001.sql).
-- ============================================================

create or replace function fio_diag()
returns text
language plpgsql security definer set search_path = public as $func$
declare
  v_token text := 'SEM_VLOZTE_FIO_TOKEN';
  v_req   bigint;
  v_status int;
  v_body  text;
  v_json  jsonb;
  v_txn   int;
begin
  if v_token like 'SEM_%' then
    return 'Token nie je nastavený — do skriptu vložte Fio token a spustite znova.';
  end if;

  -- /periods za posledných 7 dní — na rozdiel od /last neposúva zarážku
  select net.http_get(
    url := 'https://fioapi.fio.cz/v1/rest/periods/' || v_token || '/'
        || to_char(current_date - 7, 'YYYY-MM-DD') || '/'
        || to_char(current_date, 'YYYY-MM-DD') || '/transactions.json')
  into v_req;

  -- pg_net odpovedá asynchrónne — chvíľu počkáme
  perform pg_sleep(8);

  select status_code, left(coalesce(content, ''), 300)
  into v_status, v_body
  from net._http_response
  where id = v_req;

  if v_status is null then
    return 'Banka za 8 sekúnd neodpovedala — spustite select fio_diag(); ešte raz. '
        || 'Ak sa to opakuje, problém je v pg_net (nie v banke) — pošlite mi tento výstup.';
  end if;

  if v_status = 200 then
    begin
      v_json := v_body::jsonb;
    exception when others then
      v_json := null;
    end;
    -- v_body je skrátené na 300 znakov, JSON preto parsujeme len orientačne
    select jsonb_array_length(coalesce(c.content::jsonb #> '{accountStatement,transactionList,transaction}', '[]'::jsonb))
    into v_txn
    from net._http_response c where c.id = v_req;

    return '✓ API FUNGUJE, token je autorizovaný. Pohybov na účte za posledných 7 dní: '
        || coalesce(v_txn::text, '0')
        || '. Spustite select * from check_payments(); — párovanie pôjde.';
  elsif v_status = 409 then
    return 'HTTP 409 — Fio povoľuje 1 požiadavku za 30 sekúnd. Počkajte pol minúty a spustite znova.';
  elsif v_status = 422 then
    return 'HTTP 422 — banka ČAKÁ NA AUTORIZÁCIU tokenu v internetbankingu. '
        || 'Prihláste sa do Fio internetbankingu → Nastavení → API a potvrďte čakajúci pokyn '
        || '(SMS alebo Fio klíč). Potom spustite select fio_diag(); znova. '
        || 'Odpoveď banky: ' || v_body;
  elsif v_status in (404, 500) then
    return 'HTTP ' || v_status || ' — token je pravdepodobne NEPLATNÝ alebo zle skopírovaný. '
        || 'Vygenerujte v internetbankingu nový (Nastavení → API, práva „pouze sledovat") '
        || 'a pošlite mi ho — nastavím ho do funkcií. Odpoveď banky: ' || v_body;
  else
    return 'HTTP ' || v_status || ' — nečakaná odpoveď banky: ' || v_body;
  end if;
end $func$;

-- len pre SQL editor — aplikačné roly funkciu nevidia
revoke all on function fio_diag() from public, anon, authenticated;
