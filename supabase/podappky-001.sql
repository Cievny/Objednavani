-- ============================================================
-- POD-APPKY 001 — (A) ad-hoc platby za iné výkony, (B) CT objednávanie
--
-- Dve oddelené testovacie sekcie, ktoré NEZASAHUJÚ do produkčných
-- USG tabuliek (orders, open_slots). Znovupoužívajú len:
--   vs_seq, invoices, invoice_counters, next_invoice_number,
--   invoice_supplier_ready, email_header/email_footer, html_escape,
--   check_lookup_limit, assert_order_id, Fio sťahovanie (fio_poll).
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_RESEND_KLUC.
-- Idempotentné. Spúšťať PO faktury-001, audit-vlna3/4, fio-parovanie-003.
-- ============================================================

-- ============================================================
-- A. AD-HOC PLATBY
-- ============================================================
create table if not exists adhoc_payments (
  id text primary key,
  item_name text not null,
  amount numeric(10,2) not null check (amount > 0),
  variable_symbol text not null default '',
  patient_name text not null default '',
  email text not null default '',
  note text not null default '',
  paid boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid
);
alter table adhoc_payments enable row level security;
drop policy if exists "adhoc spravuje personal" on adhoc_payments;
create policy "adhoc spravuje personal" on adhoc_payments
  for select to authenticated using (my_role() in ('superadmin', 'sestra'));
-- zápis výhradne cez SECURITY DEFINER funkcie
revoke insert, update, delete on adhoc_payments from anon, authenticated;
grant select on adhoc_payments to authenticated;

-- vytvorenie ad-hoc platby personálom → vráti id + VS pre QR
create or replace function create_adhoc_payment(p_item_name text, p_amount numeric, p_patient_name text, p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id text;
  v_vs text;
begin
  if my_role() not in ('superadmin', 'sestra') then
    raise exception 'Ad-hoc platby môže vytvárať len personál.';
  end if;
  if coalesce(trim(p_item_name), '') = '' or length(p_item_name) > 200 then
    raise exception 'Zadajte názov výkonu (max 200 znakov).';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000 then
    raise exception 'Zadajte platnú sumu.';
  end if;
  if length(coalesce(p_email, '')) > 254 or length(coalesce(p_patient_name, '')) > 200 then
    raise exception 'Meno alebo e-mail je príliš dlhý.';
  end if;
  v_id := 'PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  v_vs := nextval('vs_seq')::text;
  insert into adhoc_payments (id, item_name, amount, variable_symbol, patient_name, email, created_by)
  values (v_id, trim(p_item_name), round(p_amount, 2), v_vs, coalesce(p_patient_name, ''), coalesce(p_email, ''), auth.uid());
  return jsonb_build_object('id', v_id, 'variable_symbol', v_vs);
end $$;
revoke all on function create_adhoc_payment(text, numeric, text, text) from public, anon;
grant execute on function create_adhoc_payment(text, numeric, text, text) to authenticated;

-- manuálne označenie ad-hoc platby ako zaplatenej (personál) — spustí faktúru
create or replace function mark_adhoc_paid(p_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if my_role() not in ('superadmin', 'sestra') then
    raise exception 'Platbu môže potvrdiť len personál.';
  end if;
  update adhoc_payments set paid = true, paid_at = now() where id = p_id and not paid;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;
revoke all on function mark_adhoc_paid(text) from public, anon;
grant execute on function mark_adhoc_paid(text) to authenticated;

-- faktúra za ad-hoc platbu (popis = zadaný názov výkonu) + e-mail
create or replace function issue_adhoc_invoice(p adhoc_payments)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_key   text := 'SEM_VLOZTE_RESEND_KLUC';
  v_from  text;
  n       record;
  s       jsonb;
  v_sum   text;
  v_html  text;
begin
  if not coalesce(invoice_supplier_ready(), false) then return; end if;
  if p.amount is null or p.amount <= 0 then return; end if;
  if exists (select 1 from invoices where order_id = p.id and kind = 'faktura') then return; end if;

  select jsonb_object_agg(key, value) into s
  from settings
  where key in ('invoice_name', 'invoice_address', 'invoice_ico', 'invoice_dic',
                'invoice_or', 'invoice_pzs', 'iban', 'mail_from');

  select * into n from next_invoice_number();

  insert into invoices (
    number, year, seq, kind, related_number, order_id,
    patient_name, patient_email, item_desc, amount,
    issue_date, delivery_date, payment_date, payment_vs, taxable,
    supplier_name, supplier_address, supplier_ico, supplier_dic,
    supplier_or, supplier_pzs, supplier_iban
  ) values (
    n.o_number, n.o_year, n.o_seq, 'faktura', '', p.id,
    p.patient_name, coalesce(p.email, ''), p.item_name, p.amount,
    current_date, coalesce(p.paid_at::date, current_date), coalesce(p.paid_at::date, current_date),
    coalesce(p.variable_symbol, ''), false,
    coalesce(s->>'invoice_name', ''), coalesce(s->>'invoice_address', ''),
    coalesce(s->>'invoice_ico', ''), coalesce(s->>'invoice_dic', ''),
    coalesce(s->>'invoice_or', ''), coalesce(s->>'invoice_pzs', ''), coalesce(s->>'iban', '')
  );

  if coalesce(p.email, '') = '' or v_key like 'SEM_%' then return; end if;
  v_from := coalesce(nullif(s->>'mail_from', ''), 'NÚSCH Objednávanie <onboarding@resend.dev>');
  v_sum := replace(to_char(p.amount, 'FM9990D00'), '.', ',') || ' €';

  v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
    || email_header()
    || '<h2 style="color:#003d7c">Faktúra č. ' || n.o_number || '</h2>'
    || '<p>Ďakujeme za úhradu. Tento doklad si uschovajte — je potvrdením o zaplatení.</p>'
    || '<table role="presentation" style="width:100%;font-size:13px;border-collapse:collapse;margin:8px 0">'
    || '<tr><td style="vertical-align:top;padding-right:12px;width:55%">'
    || '<b style="color:#64748b;font-size:11px">DODÁVATEĽ</b><br>'
    || '<b>' || html_escape(s->>'invoice_name') || '</b><br>'
    || html_escape(s->>'invoice_address') || '<br>'
    || 'IČO: ' || html_escape(s->>'invoice_ico') || ' · DIČ: ' || html_escape(s->>'invoice_dic') || '<br>'
    || 'Zápis: ' || html_escape(s->>'invoice_or') || '<br>'
    || 'Kód poskytovateľa ZS: ' || html_escape(s->>'invoice_pzs') || '<br>'
    || 'IBAN: ' || html_escape(coalesce(s->>'iban', '')) || '</td>'
    || '<td style="vertical-align:top"><b style="color:#64748b;font-size:11px">ODBERATEĽ</b><br>'
    || '<b>' || html_escape(coalesce(p.patient_name, '')) || '</b></td></tr></table>'
    || '<table style="font-size:13px;border-collapse:collapse">'
    || '<tr><td style="color:#64748b;padding:2px 12px 2px 0">Dátum vystavenia</td><td>' || to_char(current_date, 'DD.MM.YYYY') || '</td></tr>'
    || '<tr><td style="color:#64748b;padding:2px 12px 2px 0">Dátum úhrady</td><td>' || to_char(coalesce(p.paid_at::date, current_date), 'DD.MM.YYYY') || '</td></tr>'
    || '<tr><td style="color:#64748b;padding:2px 12px 2px 0">Variabilný symbol platby</td><td>' || html_escape(coalesce(p.variable_symbol, '')) || '</td></tr>'
    || '</table>'
    || '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:10px">'
    || '<tr style="border-bottom:1px solid #cbd5e1"><th style="text-align:left;padding:4px 0">Popis</th><th style="text-align:right">Množ.</th><th style="text-align:right;padding-left:12px">Suma</th></tr>'
    || '<tr><td style="padding:6px 0">' || html_escape(p.item_name) || '</td><td style="text-align:right">1</td><td style="text-align:right;padding-left:12px">' || v_sum || '</td></tr>'
    || '<tr style="border-top:2px solid #0f172a"><td style="padding:6px 0"><b>SPOLU</b></td><td></td><td style="text-align:right;padding-left:12px"><b>' || v_sum || '</b></td></tr>'
    || '</table>'
    || '<p style="font-size:13px;font-weight:bold;color:#16a34a">Stav: UHRADENÉ</p>'
    || '<p style="font-size:12px;color:#64748b">Dodávateľ nie je platiteľom DPH.<br>Forma úhrady: online / prevodom na účet.</p>'
    || '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">'
    || '<p style="margin:0 0 6px">Národný ústav srdcových a cievnych chorôb, a.s. · Pod Krásnou hôrkou 1, Bratislava</p>'
    || '<p style="margin:0">Kontakt: SMS na 0949 000 677.</p></div>'
    || '</div>';

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(p.email),
      'subject', 'Faktúra č. ' || n.o_number || ' — potvrdenie o úhrade', 'html', v_html)
  );
end $fn$;
revoke all on function issue_adhoc_invoice(adhoc_payments) from public, anon, authenticated;

create or replace function adhoc_paid_trigger()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(OLD.paid, false) and NEW.paid then
    begin
      perform issue_adhoc_invoice(NEW);
    exception when others then
      raise warning 'Ad-hoc faktúra k % zlyhala: %', NEW.id, sqlerrm;
    end;
  end if;
  return NEW;
end $$;
drop trigger if exists adhoc_invoice on adhoc_payments;
create trigger adhoc_invoice after update on adhoc_payments
for each row execute function adhoc_paid_trigger();

-- ============================================================
-- B. CT OBJEDNÁVANIE (bez poplatku)
-- ============================================================
create table if not exists ct_open_slots (
  slot_date date not null,
  slot_time time not null,
  doctor text not null default '',
  primary key (slot_date, slot_time)
);
alter table ct_open_slots enable row level security;
drop policy if exists "ct sloty cita ktokolvek" on ct_open_slots;
create policy "ct sloty cita ktokolvek" on ct_open_slots for select using (true);
drop policy if exists "ct sloty spravuje personal" on ct_open_slots;
create policy "ct sloty spravuje personal" on ct_open_slots
  for all using (my_role() in ('superadmin', 'sestra'));

create table if not exists ct_orders (
  id text primary key,
  patient_name text not null,
  birth_date date,
  insurance text not null default '',
  phone text not null default '',
  email text not null default '',
  reason text not null default '',
  slot_date date not null,
  slot_time time not null,
  doctor text not null default '',
  status text not null default 'new',
  duration_min int not null default 15,
  created_at timestamptz not null default now(),
  rejected_at timestamptz
);
alter table ct_orders enable row level security;
drop policy if exists "ct objednavky spravuje personal" on ct_orders;
create policy "ct objednavky spravuje personal" on ct_orders
  for all using (my_role() in ('superadmin', 'sestra'));
-- jeden CT termín = jedna aktívna objednávka
drop index if exists ct_orders_slot_uniq;
create unique index ct_orders_slot_uniq on ct_orders (slot_date, slot_time) where status <> 'rejected';

-- obsadené CT termíny (pre pacientsky kalendár, bez osobných údajov)
create or replace function ct_get_booked_slots()
returns table (slot_date date, slot_time time)
language sql security definer set search_path = public as $$
  select o.slot_date, o.slot_time from ct_orders o where o.status <> 'rejected';
$$;
grant execute on function ct_get_booked_slots() to anon, authenticated;

-- vytvorenie CT objednávky pacientom (bez platby)
create or replace function ct_create_order(
  p_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time
) returns text
language plpgsql security definer set search_path = public as $$
begin
  if p_id !~ '^CT-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;
  if length(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9)) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;
  if not exists (select 1 from ct_open_slots s where s.slot_date = p_slot_date and s.slot_time = p_slot_time) then
    raise exception 'Tento CT termín nie je otvorený. Vyberte iný.';
  end if;
  insert into ct_orders (id, patient_name, birth_date, insurance, phone, email, reason, slot_date, slot_time,
    doctor)
  select p_id, p_patient_name, p_birth_date, coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''),
    coalesce(p_reason, ''), p_slot_date, p_slot_time, coalesce(s.doctor, '')
  from ct_open_slots s where s.slot_date = p_slot_date and s.slot_time = p_slot_time;
  return p_id;
exception
  when unique_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
grant execute on function ct_create_order(text, text, date, text, text, text, text, date, time) to anon, authenticated;

-- overenie CT objednávky (číslo + telefón) — bez platobných údajov
create or replace function ct_lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if coalesce(p_id, '') !~ '^CT-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  perform check_lookup_limit('ctlookup:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));
  select to_jsonb(x) into result from (
    select o.id, o.status, o.slot_date, o.slot_time, o.doctor
    from ct_orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
  return result;
end $$;
grant execute on function ct_lookup_order(text, text) to anon, authenticated;

-- zrušenie CT objednávky pacientom (bez 48h pravidla — bez platby)
create or replace function ct_cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if coalesce(p_id, '') !~ '^CT-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  perform check_lookup_limit('ctcancel:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));
  update ct_orders o set status = 'rejected', rejected_at = now()
  where upper(o.id) = upper(p_id)
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;
grant execute on function ct_cancel_order(text, text) to anon, authenticated;

-- potvrdzovací e-mail o CT objednávke (bez platby)
create or replace function ct_notify_trigger()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_key  text := 'SEM_VLOZTE_RESEND_KLUC';
  v_from text;
  v_termin text;
  v_html text;
begin
  if TG_OP = 'INSERT' and coalesce(NEW.email, '') <> '' and v_key not like 'SEM_%' then
    select value into v_from from settings where key = 'mail_from';
    if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
    v_termin := to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI');
    v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
      || email_header()
      || '<h2 style="color:#003d7c">Objednávka na CT je prijatá</h2>'
      || '<p>Ďakujeme, váš termín na CT vyšetrenie je rezervovaný.</p>'
      || '<table style="font-size:14px;border-collapse:collapse">'
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Termín</td><td><b>' || v_termin || '</b></td></tr>'
      || case when NEW.doctor <> '' then '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Lekár</td><td>' || html_escape(NEW.doctor) || '</td></tr>' else '' end
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Číslo objednávky</td><td>' || html_escape(NEW.id) || '</td></tr>'
      || '</table>'
      || '<p style="font-size:13px">Príďte prosím 15 minút pred termínom. Pod Krásnou hôrkou 1, Bratislava.</p>'
      || '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">'
      || '<p style="margin:0">CT vyšetrenie je bez poplatku. Kontakt/zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p></div>'
      || '</div>';
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email),
        'subject', 'Objednávka na CT — ' || v_termin, 'html', v_html)
    );
  end if;
  return NEW;
end $fn$;
drop trigger if exists ct_orders_notify on ct_orders;
create trigger ct_orders_notify after insert on ct_orders
for each row execute function ct_notify_trigger();

-- ============================================================
-- C. FIO PÁROVANIE — rozšírené aj o ad-hoc platby
--    (ak sa VS nenájde v orders, skúsi sa adhoc_payments).
--    VS je z tej istej sekvencie vs_seq → globálne unikátny.
-- ============================================================
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
  v_adhoc adhoc_payments%rowtype;
begin
  select content::jsonb into v_json
  from net._http_response
  where id = p_request_id and status_code = 200;

  if v_json is null then
    if p_requested_at < now() - interval '1 hour' then
      update fio_requests set processed = true where request_id = p_request_id;
    end if;
    return 0;
  end if;

  for tx in
    select * from jsonb_array_elements(
      coalesce(v_json #> '{accountStatement,transactionList,transaction}', '[]'::jsonb))
  loop
    v_txid := tx #>> '{column22,value}';
    v_amt  := nullif(tx #>> '{column1,value}', '')::numeric;
    v_cur  := coalesce(tx #>> '{column14,value}', '');
    v_vs   := coalesce(tx #>> '{column5,value}', '');
    v_msg  := coalesce(tx #>> '{column16,value}', '');
    v_acct := coalesce(tx #>> '{column2,value}', '');

    if v_txid is null or v_amt is null or v_amt <= 0 then
      continue;
    end if;

    begin
      insert into fio_payments (tx_id, vs, amount, currency, counter_account, message)
      values (v_txid, v_vs, v_amt, v_cur, v_acct, left(v_msg, 200));
    exception when unique_violation then
      continue;
    end;

    -- 1) skús USG objednávku
    select * into v_order from orders o
    where o.variable_symbol = v_vs and o.variable_symbol <> '' and o.status <> 'rejected'
    order by o.created_at desc limit 1;

    if found then
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
      update orders set paid = true, paid_at = now(),
        status = case when status = 'new' then 'confirmed' else status end
      where id = v_order.id;
      update fio_payments set matched_order_id = v_order.id, note = 'spárované automaticky' where tx_id = v_txid;
      v_cnt := v_cnt + 1;
      continue;
    end if;

    -- 2) skús ad-hoc platbu
    select * into v_adhoc from adhoc_payments a
    where a.variable_symbol = v_vs and a.variable_symbol <> ''
    order by a.created_at desc limit 1;

    if found then
      if v_adhoc.paid then
        update fio_payments set matched_order_id = v_adhoc.id, note = 'ad-hoc platba už bola zaplatená' where tx_id = v_txid;
        continue;
      end if;
      if v_cur <> '' and v_cur <> 'EUR' then
        update fio_payments set matched_order_id = v_adhoc.id, note = 'iná mena (' || v_cur || ') — preveriť ručne' where tx_id = v_txid;
        continue;
      end if;
      if v_amt + 0.005 < v_adhoc.amount then
        update fio_payments set matched_order_id = v_adhoc.id,
          note = 'nižšia suma (' || v_amt || ' z ' || v_adhoc.amount || ' €) — preveriť ručne' where tx_id = v_txid;
        continue;
      end if;
      update adhoc_payments set paid = true, paid_at = now() where id = v_adhoc.id;
      update fio_payments set matched_order_id = v_adhoc.id, note = 'ad-hoc spárované automaticky' where tx_id = v_txid;
      v_cnt := v_cnt + 1;
      continue;
    end if;

    update fio_payments set note = 'nespárované — objednávka s týmto VS neexistuje' where tx_id = v_txid;
  end loop;

  update fio_requests set processed = true where request_id = p_request_id;
  return v_cnt;
end $func$;
revoke all on function fio_process_request(bigint, timestamptz) from public, anon, authenticated;

-- Diagnostika:
--   select create_adhoc_payment('Konzultácia', 30, 'Ján Test', 'jan@test.sk');
--   select * from adhoc_payments; select * from ct_open_slots; select * from ct_orders;
-- ============================================================
