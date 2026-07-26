-- ============================================================
-- FIO PÁROVANIE 001 — automatické párovanie platieb cez Fio API
--
-- Každých 5 minút: stiahnu sa nové pohyby na účte (endpoint
-- /last — Fio sám posúva zarážku, každý pohyb príde len raz),
-- podľa variabilného symbolu sa nájde objednávka, označí sa
-- zaplatená a termín sa potvrdí → pacientovi automaticky odíde
-- potvrdzovací e-mail a SMS (existujúce triggery).
--
-- Nespárovateľné platby (neznámy VS, nižšia suma, iná mena)
-- sa NEPÁRUJÚ — ostanú v tabuľke fio_payments s poznámkou
-- na ručné preverenie:  select * from fio_payments order by
-- received_at desc;
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_FIO_TOKEN tokenom z Fio
-- internetbankingu (Nastavenia → API → pridať token, práva
-- „pouze sledovat" — len na čítanie). Token platí max 180 dní,
-- potom ho treba obnoviť a spustiť tento skript znova.
-- Kým je v skripte placeholder, funkcia sa ticho preskočí.
-- ============================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- evidencia požiadaviek na Fio (odpovede chodia asynchrónne)
create table if not exists fio_requests (
  request_id bigint primary key,
  requested_at timestamptz not null default now(),
  processed boolean not null default false
);
alter table fio_requests enable row level security; -- len funkcie

-- evidencia došlých platieb (kontrola a ručné preverenie)
create table if not exists fio_payments (
  tx_id text primary key,
  received_at timestamptz not null default now(),
  vs text not null default '',
  amount numeric(12,2) not null,
  currency text not null default '',
  counter_account text not null default '',
  message text not null default '',
  matched_order_id text,
  note text not null default ''
);
alter table fio_payments enable row level security;
drop policy if exists "platby vidi personal" on fio_payments;
create policy "platby vidi personal" on fio_payments
  for select using (my_role() in ('superadmin', 'sestra'));

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

  -- 2. nová požiadavka na banku (odpoveď spracuje ďalší beh)
  select net.http_get(url := 'https://fioapi.fio.cz/v1/rest/last/' || v_token || '/transactions.json')
  into v_req;
  insert into fio_requests (request_id) values (v_req);

  -- 3. upratovanie (finančné logy držíme 90 dní ako ostatné logy)
  delete from fio_payments where received_at < now() - interval '90 days';
  delete from fio_requests where requested_at < now() - interval '7 days';

  return v_cnt;
end $func$;

revoke all on function fio_poll() from public, anon, authenticated;

-- každých 5 minút (Fio povoľuje 1 požiadavku za 30 s — rezerva veľká)
do $$
begin
  perform cron.unschedule('fio-parovanie');
exception when others then null;
end $$;
select cron.schedule('fio-parovanie', '*/5 * * * *', $$select fio_poll()$$);

-- Diagnostika:
--   select fio_poll();                                        -- ručný beh
--   select * from fio_payments order by received_at desc;     -- došlé platby a stav párovania
--   select * from cron.job;                                   -- job fio-parovanie existuje
-- ============================================================
