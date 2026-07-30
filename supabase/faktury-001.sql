-- ============================================================
-- FAKTÚRY 001 — automatická fakturácia online platieb
--
-- Podľa interného poučenia (dodávateľ = NEPLATCA DPH; všetky
-- platby prichádzajú prevodom na účet, takže eKasa sa nepoužíva):
--
--  1. Kniha faktúr `invoices` — trvalá evidencia (uchováva sa
--     10 rokov), NEZÁVISLÁ od objednávok: objednávky sa po 7/28
--     dňoch mažú, preto si faktúra nesie kópiu všetkých údajov
--     vrátane fakturačných údajov dodávateľa v čase vystavenia.
--  2. Neprerušený číselný rad RRRR/NNNN bez medzier
--     (invoice_counters — zámerne NIE sequence, tá má diery).
--  3. Faktúra sa vystaví automaticky pri prijatí platby (Fio
--     párovanie aj ručné „Platba prijatá") a pošle sa pacientovi
--     e-mailom; pri stornovaní zaplatenej objednávky sa vystaví
--     dobropis so zápornou sumou.
--  4. Faktúry sa vystavujú AŽ PO vyplnení fakturačných údajov
--     v Nastaveniach (kľúče invoice_* v settings). Skôr zaplatené
--     objednávky dovystaví RPC issue_missing_invoices().
--  5. GDPR: na faktúre nie sú žiadne zdravotné údaje — popis
--     položky je neutrálny („USG vyšetrenie" / „Doplatok za
--     poskytnutie USG vyšetrenia v doplnkových ordinačných
--     hodinách"), bez typu vyšetrenia a bez diagnózy.
--  6. Interný príznak `taxable` = NIE pre diagnostické USG
--     (oslobodené plnenie, nepočíta sa do obratu 50 000 €).
--
-- Poznámka k VS (vedomá odchýlka od poučenia): platba prebieha
-- PRED vystavením faktúry a VS prideľuje server pri objednávke
-- (automatické párovanie Fio). Faktúra preto nesie vlastné číslo
-- + VS skutočnej platby — účel pravidla (spárovanie s výpisom)
-- je zachovaný a párovanie je automatické.
--
-- PRED SPUSTENÍM: nahraďte SEM_VLOZTE_RESEND_KLUC.
-- Skript je idempotentný — možno ho spúšťať opakovane.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Kniha faktúr
-- ------------------------------------------------------------
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,                -- 2026/0001
  year int not null,
  seq int not null,
  kind text not null default 'faktura' check (kind in ('faktura', 'dobropis')),
  related_number text not null default '',    -- dobropis → číslo pôvodnej faktúry
  order_id text not null,
  patient_name text not null,
  patient_email text not null default '',
  item_desc text not null,
  amount numeric(10,2) not null,              -- dobropis má zápornú sumu
  issue_date date not null default current_date,
  delivery_date date,                         -- deň vyšetrenia
  payment_date date,                          -- deň prijatia platby
  payment_vs text not null default '',        -- VS, pod ktorým platba prišla
  taxable boolean not null default false,     -- interné sledovanie obratu 50 000 €
  supplier_name text not null default '',
  supplier_address text not null default '',
  supplier_ico text not null default '',
  supplier_dic text not null default '',
  supplier_or text not null default '',
  supplier_pzs text not null default '',
  supplier_iban text not null default '',
  created_at timestamptz not null default now()
);

alter table invoices enable row level security;
drop policy if exists "faktury cita superadmin" on invoices;
create policy "faktury cita superadmin" on invoices
  for select to authenticated using (my_role() = 'superadmin');
-- zápis výhradne cez SECURITY DEFINER funkcie nižšie
revoke insert, update, delete on invoices from anon, authenticated;
grant select on invoices to authenticated;

-- ------------------------------------------------------------
-- 2. Neprerušený číselný rad (per rok, bez medzier)
-- ------------------------------------------------------------
create table if not exists invoice_counters (
  year int primary key,
  last_seq int not null default 0
);

create or replace function next_invoice_number(out o_number text, out o_year int, out o_seq int)
language plpgsql set search_path = public as $$
begin
  o_year := extract(year from current_date)::int;
  insert into invoice_counters as c (year, last_seq) values (o_year, 1)
  on conflict (year) do update set last_seq = c.last_seq + 1
  returning last_seq into o_seq;
  o_number := o_year || '/' || lpad(o_seq::text, 4, '0');
end $$;

revoke all on function next_invoice_number() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Fakturačné údaje — faktúry sa vystavujú až po ich vyplnení
-- ------------------------------------------------------------
-- POZOR: subselect na neexistujúci riadok vracia NULL — preto je
-- coalesce OKOLO subselectu, inak by funkcia vrátila NULL namiesto
-- FALSE a poistka „bez údajov nefakturovať" by sa preskočila.
create or replace function invoice_supplier_ready()
returns boolean language sql stable set search_path = public as $$
  select coalesce((select value from settings where key = 'invoice_name'), '') <> ''
     and coalesce((select value from settings where key = 'invoice_address'), '') <> ''
     and coalesce((select value from settings where key = 'invoice_ico'), '') <> ''
     and coalesce((select value from settings where key = 'invoice_dic'), '') <> ''
     and coalesce((select value from settings where key = 'invoice_or'), '') <> ''
     and coalesce((select value from settings where key = 'invoice_pzs'), '') <> '';
$$;

-- hlavička e-mailov s logom — rovnaká definícia ako v emaily-storna-001,
-- zopakovaná idempotentne, aby tento skript fungoval samostatne
create or replace function email_header()
returns text language sql stable set search_path = public as $$
  select '<div style="border-bottom:3px solid #e2001a;padding-bottom:12px;margin-bottom:16px">'
    || '<table role="presentation" style="border-collapse:collapse"><tr>'
    || '<td style="padding:0;vertical-align:middle"><img src="https://objednanie.cievny.sk/logo-nusch.png" width="46" height="46" alt="NÚSCH" style="display:block;border:0"></td>'
    || '<td style="padding:0 0 0 10px;vertical-align:middle"><b style="color:#003d7c">Národný ústav srdcových a cievnych chorôb, a.s.</b><br>'
    || '<span style="color:#64748b;font-size:12px">Objednávanie na USG</span></td>'
    || '</tr></table></div>';
$$;

-- ------------------------------------------------------------
-- 4. Vystavenie faktúry / dobropisu + e-mail pacientovi
-- ------------------------------------------------------------
create or replace function issue_invoice(o orders, p_kind text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_key      text := 'SEM_VLOZTE_RESEND_KLUC';
  v_from     text;
  n          record;
  s          jsonb;
  v_desc     text;
  v_amount   numeric(10,2);
  v_related  text := '';
  v_sum      text;
  v_html     text;
  v_subject  text;
  v_title    text;
begin
  -- bez fakturačných údajov sa doklad nevystavuje (dovystaví ich
  -- issue_missing_invoices po ich doplnení v Nastaveniach)
  if not coalesce(invoice_supplier_ready(), false) then return; end if;
  if o.price is null or o.price <= 0 then return; end if;

  -- poistky proti duplicite (napr. platba odznačená a znova označená)
  if p_kind = 'faktura'
     and exists (select 1 from invoices where order_id = o.id and kind = 'faktura') then
    return;
  end if;
  if p_kind = 'dobropis' then
    select number into v_related from invoices
    where order_id = o.id and kind = 'faktura'
    order by created_at limit 1;
    if v_related is null then return; end if;  -- niet čo dobropisovať
    if exists (select 1 from invoices where order_id = o.id and kind = 'dobropis') then
      return;
    end if;
  end if;

  select jsonb_object_agg(key, value) into s
  from settings
  where key in ('invoice_name', 'invoice_address', 'invoice_ico', 'invoice_dic',
                'invoice_or', 'invoice_pzs', 'iban', 'mail_from');

  -- popis položky NEUTRÁLNE, bez typu vyšetrenia a diagnózy (GDPR)
  v_desc := case when o.has_referral
    then 'Doplatok za poskytnutie USG vyšetrenia v doplnkových ordinačných hodinách'
    else 'USG vyšetrenie' end;
  v_amount := case when p_kind = 'dobropis' then -o.price else o.price end;

  select * into n from next_invoice_number();

  insert into invoices (
    number, year, seq, kind, related_number, order_id,
    patient_name, patient_email, item_desc, amount,
    issue_date, delivery_date, payment_date, payment_vs, taxable,
    supplier_name, supplier_address, supplier_ico, supplier_dic,
    supplier_or, supplier_pzs, supplier_iban
  ) values (
    n.o_number, n.o_year, n.o_seq, p_kind, v_related, o.id,
    o.patient_name, coalesce(o.email, ''), v_desc, v_amount,
    current_date, o.slot_date, coalesce(o.paid_at::date, current_date),
    coalesce(o.variable_symbol, ''), false,
    coalesce(s->>'invoice_name', ''), coalesce(s->>'invoice_address', ''),
    coalesce(s->>'invoice_ico', ''), coalesce(s->>'invoice_dic', ''),
    coalesce(s->>'invoice_or', ''), coalesce(s->>'invoice_pzs', ''), coalesce(s->>'iban', '')
  );

  -- e-mail pacientovi s kompletným dokladom
  if coalesce(o.email, '') = '' or v_key like 'SEM_%' then return; end if;

  v_from := coalesce(nullif(s->>'mail_from', ''), 'NÚSCH Objednávanie <onboarding@resend.dev>');
  v_sum := replace(to_char(v_amount, 'FM9990D00'), '.', ',') || ' €';
  if p_kind = 'dobropis' then
    v_title := 'Dobropis č. ' || n.o_number || ' k faktúre č. ' || v_related;
    v_subject := v_title;
  else
    v_title := 'Faktúra č. ' || n.o_number;
    v_subject := v_title || ' — potvrdenie o úhrade';
  end if;

  v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
    || email_header()
    || '<h2 style="color:#003d7c">' || v_title || '</h2>'
    || case when p_kind = 'dobropis'
         then '<p>K zrušenej objednávke vystavujeme dobropis. Uhradenú sumu vám vrátime prevodom na účet, z ktorého platba prišla.</p>'
         else '<p>Ďakujeme za úhradu. Tento doklad si uschovajte — je potvrdením o zaplatení.</p>' end
    || '<table role="presentation" style="width:100%;font-size:13px;border-collapse:collapse;margin:8px 0">'
    || '<tr><td style="vertical-align:top;padding-right:12px;width:55%">'
    || '<b style="color:#64748b;font-size:11px">DODÁVATEĽ</b><br>'
    || '<b>' || html_escape(s->>'invoice_name') || '</b><br>'
    || html_escape(s->>'invoice_address') || '<br>'
    || 'IČO: ' || html_escape(s->>'invoice_ico') || ' · DIČ: ' || html_escape(s->>'invoice_dic') || '<br>'
    || 'Zápis: ' || html_escape(s->>'invoice_or') || '<br>'
    || 'Kód poskytovateľa ZS: ' || html_escape(s->>'invoice_pzs') || '<br>'
    || 'IBAN: ' || html_escape(coalesce(s->>'iban', '')) || '</td>'
    || '<td style="vertical-align:top">'
    || '<b style="color:#64748b;font-size:11px">ODBERATEĽ</b><br>'
    || '<b>' || html_escape(o.patient_name) || '</b></td></tr></table>'
    || '<table style="font-size:13px;border-collapse:collapse">'
    || '<tr><td style="color:#64748b;padding:2px 12px 2px 0">Dátum vystavenia</td><td>' || to_char(current_date, 'DD.MM.YYYY') || '</td></tr>'
    || '<tr><td style="color:#64748b;padding:2px 12px 2px 0">Dátum dodania (deň vyšetrenia)</td><td>' || to_char(o.slot_date, 'DD.MM.YYYY') || '</td></tr>'
    || '<tr><td style="color:#64748b;padding:2px 12px 2px 0">Dátum úhrady</td><td>' || to_char(coalesce(o.paid_at::date, current_date), 'DD.MM.YYYY') || '</td></tr>'
    || '<tr><td style="color:#64748b;padding:2px 12px 2px 0">Variabilný symbol platby</td><td>' || html_escape(coalesce(o.variable_symbol, '')) || '</td></tr>'
    || '<tr><td style="color:#64748b;padding:2px 12px 2px 0">Číslo objednávky</td><td>' || html_escape(o.id) || '</td></tr>'
    || '</table>'
    || '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:10px">'
    || '<tr style="border-bottom:1px solid #cbd5e1"><th style="text-align:left;padding:4px 0">Popis</th><th style="text-align:right">Množ.</th><th style="text-align:right;padding-left:12px">Suma</th></tr>'
    || '<tr><td style="padding:6px 0">' || html_escape(v_desc) || '</td><td style="text-align:right">1</td><td style="text-align:right;padding-left:12px">' || v_sum || '</td></tr>'
    || '<tr style="border-top:2px solid #0f172a"><td style="padding:6px 0"><b>'
    || case when p_kind = 'dobropis' then 'SUMA NA VRÁTENIE' else 'SPOLU' end
    || '</b></td><td></td><td style="text-align:right;padding-left:12px"><b>' || v_sum || '</b></td></tr>'
    || '</table>'
    || case when p_kind = 'dobropis' then ''
         else '<p style="font-size:13px;font-weight:bold;color:#16a34a">Stav: UHRADENÉ</p>' end
    || '<p style="font-size:12px;color:#64748b">Dodávateľ nie je platiteľom DPH.<br>Forma úhrady: online / prevodom na účet.</p>'
    || email_footer(o.id)
    || '</div>';

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(o.email),
      'subject', v_subject, 'html', v_html)
  );
end $fn$;

revoke all on function issue_invoice(orders, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Trigger: platba prijatá → faktúra; storno zaplatenej → dobropis
-- ------------------------------------------------------------
-- Fakturácia NIKDY nesmie zablokovať zapísanie platby ani storno —
-- prípadná chyba sa len zaloguje a doklad sa dovystaví neskôr
-- tlačidlom „Dovystaviť chýbajúce faktúry".
create or replace function orders_invoice_trigger()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  begin
    if not coalesce(OLD.paid, false) and NEW.paid then
      perform issue_invoice(NEW, 'faktura');
    elsif OLD.status <> 'rejected' and NEW.status = 'rejected' and NEW.paid then
      perform issue_invoice(NEW, 'dobropis');
    end if;
  exception when others then
    raise warning 'Vystavenie faktúry k % zlyhalo: %', NEW.id, sqlerrm;
  end;
  return NEW;
end $fn$;

drop trigger if exists orders_invoice on orders;
create trigger orders_invoice
after update on orders
for each row execute function orders_invoice_trigger();

-- ------------------------------------------------------------
-- 6. Dovystavenie faktúr pre skôr zaplatené objednávky
--    (spustí superadmin tlačidlom v záložke Faktúry)
-- ------------------------------------------------------------
create or replace function issue_missing_invoices()
returns int
language plpgsql security definer set search_path = public as $$
declare
  r orders%rowtype;
  v_count int := 0;
begin
  if my_role() <> 'superadmin' then
    raise exception 'Dovystavenie faktúr je dostupné len pre superadmina.';
  end if;
  if not invoice_supplier_ready() then
    raise exception 'Najprv vyplňte fakturačné údaje v Nastaveniach.';
  end if;
  for r in
    select * from orders o
    where o.paid and o.price > 0
      and not exists (select 1 from invoices i where i.order_id = o.id and i.kind = 'faktura')
    order by o.paid_at nulls last, o.created_at
  loop
    perform issue_invoice(r, 'faktura');
    v_count := v_count + 1;
    if r.status = 'rejected' then
      perform issue_invoice(r, 'dobropis');
    end if;
  end loop;
  -- dobropisy k už fakturovaným, medzičasom stornovaným objednávkam
  for r in
    select * from orders o
    where o.paid and o.price > 0 and o.status = 'rejected'
      and exists (select 1 from invoices i where i.order_id = o.id and i.kind = 'faktura')
      and not exists (select 1 from invoices i where i.order_id = o.id and i.kind = 'dobropis')
  loop
    perform issue_invoice(r, 'dobropis');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

revoke all on function issue_missing_invoices() from public, anon;
grant execute on function issue_missing_invoices() to authenticated;

-- Diagnostika:
--   select invoice_supplier_ready();
--   select * from invoices order by number;
--   select issue_missing_invoices();   -- ako prihlásený superadmin
-- ============================================================
