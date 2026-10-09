-- ============================================================
-- AUDIT VLNA 8 — 001  (zabezpečenie pred ostrým spustením platených USG)
--
-- Cieľ: (1) systém sa nemá dať ľahko napadnúť, (2) ani pri prieniku do
-- účtu personálu alebo do prehliadača nesmie byť možné zmeniť bankový
-- účet (IBAN) ani odcudziť údaje pacientov.
--
-- Hranica dôvery = session_user. Aplikácia (PostgREST) sa pripája ako
-- rola `authenticator` a mení len current_user; SQL editor a cron bežia
-- ako `postgres`. Ochranné triggery preto púšťajú len
-- session_user in ('postgres','supabase_admin') → žiadna cesta cez API
-- (ani superadmin, ani SECURITY DEFINER funkcia) ich neobíde.
--
-- Sekcie (poradie = závislosti):
--   0  preflight (duplicitné VS, rozšírenia, práva na schému)
--   1  kľúče (Resend, BulkGate, Fio) → Supabase Vault, app_secret()
--   2  IBAN nemenný: payment_identity + settings_protect + payment_iban()
--   3  e-maily/faktúry/pripomienky čítajú IBAN len cez payment_iban()
--   4  VS unikátny, cena/VS/typ nemenné, ručné „zaplatené" len s dôvodom
--   5  MFA (TOTP) helpery is_aal2()/mfa_ok() + settings.mfa_enforce (off)
--   6  prílohy: lekár vidí len prílohy svojich pacientov, assert_attachments
--   7  rate-limity: client_ip() v create_order/ct_create_order, IP limity
--      na lookup/cancel/reschedule, rozdelený globálny OTP strop
--   8  OTP kryptograficky bezpečný (gen_random_bytes)
--   9  audit: settings/staff_roles/pricelist/ct_orders/angio_orders,
--      superadmin nie je prideliteľný cez RPC
--  10  health_events (základ)
--  11  revoke/drop, mfa_ok() do VŠETKÝCH politík s my_role(), kontrola
--
-- KĽÚČE NETREBA VKLADAŤ: skript prevezme reálne hodnoty z existujúcich
-- funkcií a uloží ich do Vaultu; funkcie potom čítajú app_secret('…').
-- Rotácia kľúča = Dashboard → Vault (alebo vault.update_secret), bez
-- prepisovania funkcií.
--
-- Idempotentné. Spúšťať PO všetkých doterajších skriptoch (vrátane
-- usg-otp-001 a kopia-poziadavky-001). Vyžaduje zapnuté rozšírenie
-- Vault (Dashboard → Database → Extensions → supabase_vault).
-- ============================================================

-- ------------------------------------------------------------
-- 0. PREFLIGHT
-- ------------------------------------------------------------
do $$
declare v text;
begin
  if to_regclass('public.orders') is null or to_regclass('public.ct_orders') is null
     or to_regclass('public.angio_orders') is null or to_regclass('public.adhoc_payments') is null then
    raise exception 'Vlna 8: chýba tabuľka orders/ct_orders/angio_orders/adhoc_payments — spustite najprv podappky-001 a angio-001.';
  end if;
  select string_agg(variable_symbol, ', ') into v
  from (select variable_symbol from orders where variable_symbol <> '' group by 1 having count(*) > 1) d;
  if v is not null then
    raise exception 'Vlna 8: duplicitné variabilné symboly v orders (%). Vyriešte ručne a spustite znova.', v;
  end if;
  select string_agg(variable_symbol, ', ') into v
  from (select variable_symbol from adhoc_payments where variable_symbol <> '' group by 1 having count(*) > 1) d;
  if v is not null then
    raise exception 'Vlna 8: duplicitné variabilné symboly v adhoc_payments (%).', v;
  end if;
  if to_regnamespace('vault') is null
     or not exists (select 1 from pg_proc where proname = 'create_secret' and pronamespace = to_regnamespace('vault')) then
    raise exception 'Vlna 8: rozšírenie Vault nie je zapnuté. Dashboard → Database → Extensions → „supabase_vault" → Enable, potom spustite znova.';
  end if;
  if to_regnamespace('net') is null then
    raise exception 'Vlna 8: rozšírenie pg_net nie je zapnuté.';
  end if;
  if to_regprocedure('extensions.gen_random_bytes(int)') is null and to_regprocedure('public.gen_random_bytes(int)') is null then
    raise exception 'Vlna 8: rozšírenie pgcrypto nie je zapnuté (gen_random_bytes).';
  end if;
  -- aplikačné roly nesmú vytvárať objekty v schéme public
  execute 'revoke create on schema public from public, anon, authenticated';
  -- TRUNCATE nikdy z API
  execute 'revoke truncate on all tables in schema public from public, anon, authenticated';
end $$;

-- gen_random_bytes bez ohľadu na schému, v ktorej je pgcrypto
do $$
declare v_schema text;
begin
  v_schema := case when to_regprocedure('extensions.gen_random_bytes(int)') is not null then 'extensions' else 'public' end;
  execute format($f$
    create or replace function app_random_bytes(p_n int)
    returns bytea language sql volatile set search_path = '' as $b$ select %I.gen_random_bytes(p_n) $b$
  $f$, v_schema);
end $$;
revoke all on function app_random_bytes(int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 1. KĹÚČE → SUPABASE VAULT
-- ------------------------------------------------------------
-- app_secret(meno): hodnota z Vaultu; ak chýba → 'SEM_VLOZTE_<MENO>'
-- (existujúce stráže `like 'SEM_%'` vo funkciách ostávajú funkčné)
create or replace function app_secret(p_name text)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select ds.decrypted_secret into v
  from vault.decrypted_secrets ds
  where ds.name = p_name
  order by ds.created_at desc
  limit 1;
  if v is null or v = '' then
    return 'SEM_VLOZTE_' || upper(p_name);
  end if;
  return v;
exception when others then
  return 'SEM_VLOZTE_' || upper(p_name);
end $$;
revoke all on function app_secret(text) from public, anon, authenticated;

-- Migrácia: každá funkcia v public, ktorá má kľúč ako literál, sa prepíše na
-- app_secret('…'); reálne hodnoty sa (ak vo Vaulte ešte nie sú) uložia.
do $mig$
declare
  r        record;
  v_def    text;
  v_new    text;
  v_val    text;
  m        text[];
  v_pat    text;
  v_names  text[] := array['resend_api_key', 'bulkgate_app_id', 'bulkgate_app_token', 'fio_token'];
  v_vars   text[][] := array[
    array['v_key',       'resend_api_key'],
    array['v_app_id',    'bulkgate_app_id'],
    array['v_sms_id',    'bulkgate_app_id'],
    array['v_app_token', 'bulkgate_app_token'],
    array['v_sms_token', 'bulkgate_app_token'],
    array['v_token',     'fio_token']
  ];
  i        int;
  v_changed int := 0;
  v_missing text := '';
begin
  for r in
    select p.oid, p.proname
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and p.prosrc ~ '\m(v_key|v_app_id|v_sms_id|v_app_token|v_sms_token|v_token)\s+text\s*:=\s*''[^'']*'''
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    for i in 1 .. array_length(v_vars, 1) loop
      v_pat := '\m' || v_vars[i][1] || '\s+text\s*:=\s*''([^'']*)''';
      m := regexp_match(v_new, v_pat);
      if m is not null then
        v_val := m[1];
        if v_val not like 'SEM\_%' and v_val <> '' then
          if not exists (select 1 from vault.secrets s where s.name = v_vars[i][2]) then
            perform vault.create_secret(v_val, v_vars[i][2], 'NÚSCH objednávanie — vlna 8 (prevzaté z ' || r.proname || ')');
            raise notice 'Vault: uložený kľúč % (z funkcie %).', v_vars[i][2], r.proname;
          end if;
        end if;
        v_new := regexp_replace(v_new, v_pat,
          v_vars[i][1] || ' text := app_secret(' || quote_literal(v_vars[i][2]) || ')', 'g');
      end if;
    end loop;
    if v_new <> v_def then
      execute v_new;
      v_changed := v_changed + 1;
    end if;
  end loop;
  raise notice 'Vault: % funkcií prepísaných na app_secret().', v_changed;

  -- ktoré kľúče vo Vaulte stále chýbajú
  for i in 1 .. array_length(v_names, 1) loop
    if not exists (select 1 from vault.secrets s where s.name = v_names[i]) then
      v_missing := v_missing || ' ' || v_names[i];
    end if;
  end loop;
  if v_missing <> '' then
    raise notice 'Vault: CHÝBAJÚ kľúče:% — doplňte v Dashboard → Vault (presne tieto mená). Funkcie, ktoré ich používajú, sú dovtedy neaktívne.', v_missing;
  end if;
end $mig$;

-- kontrola: v žiadnej funkcii nesmie ostať literál kľúča
do $$
declare v text;
begin
  select string_agg(proname, ', ') into v
  from pg_proc
  where pronamespace = 'public'::regnamespace
    and (prosrc ~ '''re_[A-Za-z0-9_]{12,}''' or prosrc ~ '\m(v_key|v_app_id|v_sms_id|v_app_token|v_sms_token|v_token)\s+text\s*:=\s*''(?!SEM_)[^'']+''');
  if v is not null then
    raise exception 'Vlna 8: vo funkciách % ostal kľúč ako literál.', v;
  end if;
end $$;

-- privilegované funkcie nikdy z API pre anon (a kde netreba ani authenticated)
do $$
declare f text;
begin
  foreach f in array array['send_reminders()', 'send_ct_reminders()', 'send_angio_reminders()', 'send_angio_sms_reminders()',
                           'fio_poll()', 'fio_poll_guarded()', 'fio_diag()', 'issue_missing_invoices()',
                           'purge_orders()', 'ct_purge_orders()', 'angio_purge_orders()', 'purge_orphan_attachments()', 'purge_rate_limits()'] loop
    if to_regprocedure('public.' || f) is not null then
      execute format('revoke all on function public.%s from public, anon, authenticated', f);
    end if;
  end loop;
  if to_regprocedure('public.check_payments()') is not null then
    execute 'revoke all on function public.check_payments() from public, anon';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. IBAN NEMENNÝ Z APLIKÁCIE (3 vrstvy, fail-closed)
--    • payment_identity — jediný riadok, mení sa LEN v SQL editore
--    • settings.iban/beneficiary = zrkadlo (chránené triggerom)
--    • payment_iban() — vráti IBAN len ak je platný a zhodný so zrkadlom
-- ------------------------------------------------------------
create or replace function iban_valid(p text)
returns boolean
language plpgsql immutable set search_path = public as $$
declare
  s text := upper(regexp_replace(coalesce(p, ''), '\s', '', 'g'));
  r text;
  i int;
  c text;
  n int := 0;
begin
  if s !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then return false; end if;
  if left(s, 2) = 'SK' and length(s) <> 24 then return false; end if;
  r := substr(s, 5) || left(s, 4);
  for i in 1 .. length(r) loop
    c := substr(r, i, 1);
    if c between '0' and '9' then
      n := (n * 10 + (ascii(c) - 48)) % 97;
    else
      n := (n * 100 + (ascii(c) - 55)) % 97;
    end if;
  end loop;
  return n = 1;
end $$;

-- demo/placeholder účty z vývoja nikdy nesmú byť „ostrým" IBAN-om
create or replace function iban_is_demo(p text)
returns boolean
language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(p, ''), '\s', '', 'g')) in ('SK3112000000198742637541')
      or coalesce(p, '') like 'SK\_\_%' or coalesce(p, '') = '';
$$;

create table if not exists payment_identity (
  id          boolean primary key default true check (id),
  iban        text not null check (iban_valid(iban) and not iban_is_demo(iban)),
  beneficiary text not null default 'NÚSCH, a.s.' check (length(beneficiary) between 2 and 120),
  updated_at  timestamptz not null default now(),
  updated_by  text not null default session_user
);
alter table payment_identity enable row level security;
revoke all on payment_identity from public, anon, authenticated;
grant select on payment_identity to anon, authenticated;
drop policy if exists "platobne udaje cita ktokolvek" on payment_identity;
create policy "platobne udaje cita ktokolvek" on payment_identity for select using (true);

create or replace function protected_setting_key(p_key text)
returns boolean
language sql immutable set search_path = public as $$
  select p_key in ('iban', 'beneficiary', 'notify_email', 'copy_email', 'mail_from', 'mfa_enforce');
$$;

-- trigger: chránené kľúče mení len SQL editor / cron (session_user postgres)
create or replace function settings_protect()
returns trigger
language plpgsql security definer set search_path = public as $$
declare k text := coalesce(NEW.key, OLD.key);
begin
  if session_user in ('postgres', 'supabase_admin') then
    return coalesce(NEW, OLD);
  end if;
  if TG_OP = 'UPDATE' and NEW.key = OLD.key and NEW.value = OLD.value then
    return NEW; -- no-op (staršie verzie aplikácie posielajú celý formulár)
  end if;
  if protected_setting_key(k) or (TG_OP = 'UPDATE' and protected_setting_key(OLD.key)) then
    raise exception 'Nastavenie „%" je chránené — mení sa výlučne v SQL editore Supabase (GO-LIVE.md → runbook).', k;
  end if;
  return coalesce(NEW, OLD);
end $$;
drop trigger if exists settings_protect on settings;
create trigger settings_protect
before insert or update or delete on settings
for each row execute function settings_protect();

create or replace function settings_protect_truncate()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if session_user not in ('postgres', 'supabase_admin') then
    raise exception 'TRUNCATE nastavení nie je z aplikácie povolený.';
  end if;
  return null;
end $$;
drop trigger if exists settings_protect_truncate on settings;
create trigger settings_protect_truncate
before truncate on settings
for each statement execute function settings_protect_truncate();

-- trigger na payment_identity: rovnaký guard + zrkadlo do settings
create or replace function payment_identity_protect()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Platobné údaje (IBAN) sa menia výlučne v SQL editore Supabase — pozri GO-LIVE.md, runbook „Zmena IBAN".';
  end if;
  if TG_OP = 'DELETE' then
    delete from settings where key in ('iban', 'beneficiary');
    return OLD;
  end if;
  NEW.id := true;
  NEW.updated_at := now();
  NEW.updated_by := session_user;
  insert into settings (key, value) values ('iban', NEW.iban), ('beneficiary', NEW.beneficiary)
  on conflict (key) do update set value = excluded.value;
  insert into audit_log (user_id, order_id, action, detail)
  values (auth.uid(), 'payment_identity', 'iban-change',
    '[' || session_user || '] ' || coalesce((case when TG_OP = 'UPDATE' then OLD.iban end), '—') || ' → ' || NEW.iban || ' (' || NEW.beneficiary || ')');
  return NEW;
end $$;
drop trigger if exists payment_identity_protect on payment_identity;
create trigger payment_identity_protect
before insert or update or delete on payment_identity
for each row execute function payment_identity_protect();

-- seed z existujúceho settings.iban (len ak je platný a nie demo)
insert into payment_identity (id, iban, beneficiary)
select true, s.value, coalesce(nullif((select value from settings where key = 'beneficiary'), ''), 'NÚSCH, a.s.')
from settings s
where s.key = 'iban' and iban_valid(s.value) and not iban_is_demo(s.value)
on conflict (id) do nothing;

-- zrkadlo musí sedieť (ak payment_identity existuje, settings sa jej prispôsobí)
update settings s set value = p.iban from payment_identity p where s.key = 'iban' and s.value <> p.iban;
update settings s set value = p.beneficiary from payment_identity p where s.key = 'beneficiary' and s.value <> p.beneficiary;

-- health_events (základ) — potrebujú ju payment_iban() a Fio
create table if not exists health_events (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  source text not null,
  ok     boolean not null,
  detail text not null default ''
);
create index if not exists health_events_at_idx on health_events (at desc);
alter table health_events enable row level security;
revoke all on health_events from public, anon, authenticated;

create or replace function health_event(p_source text, p_ok boolean, p_detail text default '')
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into health_events (source, ok, detail) values (left(p_source, 60), p_ok, left(coalesce(p_detail, ''), 500));
exception when others then null;
end $$;
revoke all on function health_event(text, boolean, text) from public, anon, authenticated;

-- payment_iban(): jediný zdroj IBAN-u pre e-maily, faktúry a pripomienky.
-- NULL = platobné údaje nie sú k dispozícii (fail-closed) + health event.
create or replace function payment_iban()
returns text
language plpgsql security definer set search_path = public as $$
declare v text; m text;
begin
  select iban into v from payment_identity where id;
  select value into m from settings where key = 'iban';
  if v is null or not iban_valid(v) or iban_is_demo(v) or m is distinct from v then
    if not exists (select 1 from health_events where source = 'payment_iban' and at > now() - interval '1 hour') then
      perform health_event('payment_iban', false,
        case when v is null then 'payment_identity je prázdna' else 'IBAN neplatný/demo alebo zrkadlo settings.iban nesedí' end);
    end if;
    return null;
  end if;
  return v;
end $$;
revoke all on function payment_iban() from public, anon, authenticated;

create or replace function payment_beneficiary()
returns text
language sql stable security definer set search_path = public as $$
  select case when payment_iban() is null then null else (select beneficiary from payment_identity where id) end;
$$;
revoke all on function payment_beneficiary() from public, anon, authenticated;

-- politiky settings: FOR ALL → oddelené; zápis len superadmin s MFA
drop policy if exists "nastavenia spravuje superadmin" on settings;
drop policy if exists "nastavenia spravuje personal" on settings;
drop policy if exists "nastavenia insert superadmin" on settings;
drop policy if exists "nastavenia update superadmin" on settings;
drop policy if exists "nastavenia delete superadmin" on settings;
create policy "nastavenia insert superadmin" on settings
  for insert to authenticated with check (my_role() = 'superadmin' and not protected_setting_key(key));
create policy "nastavenia update superadmin" on settings
  for update to authenticated using (my_role() = 'superadmin') with check (my_role() = 'superadmin');
create policy "nastavenia delete superadmin" on settings
  for delete to authenticated using (my_role() = 'superadmin' and not protected_setting_key(key));

do $$
begin
  if not exists (select 1 from payment_identity) then
    raise notice 'IBAN: payment_identity je PRÁZDNA (settings.iban nie je platný ostrý IBAN). Pacienti dostanú v e-maile „platobné údaje pošleme dodatočne". Nastavte: insert into payment_identity (iban, beneficiary) values (''SK…'', ''NÚSCH, a.s.'');';
  else
    raise notice 'IBAN: payment_identity = % (%).', (select iban from payment_identity), (select beneficiary from payment_identity);
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. E-MAILY / FAKTÚRY / PRIPOMIENKY ČÍTAJÚ IBAN LEN CEZ payment_iban()
--    (prepis v mieste — všetky funkcie v public okrem payment_iban())
-- ------------------------------------------------------------
do $mig$
declare
  r record;
  v_def text;
  v_new text;
  v_cnt int := 0;
begin
  for r in
    select p.oid, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
      and p.proname not in ('payment_iban', 'payment_identity_protect')
      and (p.prosrc ~ 'from\s+settings\s+where\s+key\s*=\s*''iban''' or p.prosrc ~ 's->>''iban''')
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def,
      'select\s+value\s+into\s+v_iban\s+from\s+settings\s+where\s+key\s*=\s*''iban''\s*;',
      'v_iban := payment_iban();', 'g');
    v_new := regexp_replace(v_new, 'coalesce\(s->>''iban'',\s*''''\)', 'coalesce(payment_iban(), '''')', 'g');
    -- chýbajúci IBAN: namiesto prázdneho poľa jasná veta
    v_new := replace(v_new, 'html_escape(coalesce(v_iban, ''''))',
      'case when v_iban is null then ''<i>platobné údaje vám pošleme dodatočne</i>'' else html_escape(v_iban) end');
    -- rezervačný e-mail: upozornenie proti podvodným „zmenám účtu"
    v_new := replace(v_new,
      'Termín je rezervovaný a bude potvrdený po prijatí platby.</p>',
      'Termín je rezervovaný a bude potvrdený po prijatí platby. <b>Platbu posielajte výlučne na IBAN uvedený v tomto e-maili</b> — pracovisko platobné údaje nikdy nemení telefonicky ani SMS.</p>');
    if v_new <> v_def then
      execute v_new;
      v_cnt := v_cnt + 1;
    end if;
  end loop;
  raise notice 'IBAN: % funkcií prepísaných na payment_iban().', v_cnt;
end $mig$;

do $$
declare v text;
begin
  select string_agg(proname, ', ') into v from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname not in ('payment_iban', 'payment_identity_protect')
    and (prosrc ~ 'from\s+settings\s+where\s+key\s*=\s*''iban''' or prosrc ~ 's->>''iban''');
  if v is not null then
    raise exception 'Vlna 8: funkcie % stále čítajú settings.iban priamo.', v;
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. VS UNIKÁTNY · CENA/VS/TYP NEMENNÉ · RUČNÉ „ZAPLATENÉ" LEN S DÔVODOM
-- ------------------------------------------------------------
create unique index if not exists orders_vs_uniq on orders (variable_symbol) where variable_symbol <> '';
create unique index if not exists adhoc_payments_vs_uniq on adhoc_payments (variable_symbol) where variable_symbol <> '';

-- guard v2: z API (session_user authenticator) sú finančné a identifikačné
-- polia nemenné pre VŠETKY roly (aj superadmina, aj SECURITY DEFINER funkcie);
-- paid/paid_at smie meniť len fio_process_request / mark_order_paid
-- (cez transakčný príznak app.paid_change). SQL editor/cron bez obmedzenia.
create or replace function guard_order_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if session_user in ('postgres', 'supabase_admin') then
    return NEW;
  end if;
  if NEW.id <> OLD.id
     or NEW.variable_symbol is distinct from OLD.variable_symbol
     or NEW.price is distinct from OLD.price
     or NEW.exam_type_id is distinct from OLD.exam_type_id
     or NEW.exam_label is distinct from OLD.exam_label
     or NEW.has_referral is distinct from OLD.has_referral
     or NEW.created_at is distinct from OLD.created_at then
    raise exception 'Cena, variabilný symbol a typ vyšetrenia sú po vytvorení objednávky nemenné.';
  end if;
  if coalesce(NEW.paid, false) <> coalesce(OLD.paid, false) or NEW.paid_at is distinct from OLD.paid_at then
    if current_setting('app.paid_change', true) is distinct from '1' then
      raise exception 'Platbu označuje párovanie Fio alebo funkcia mark_order_paid (s uvedením dôvodu).';
    end if;
  end if;
  return NEW;
end $$;
drop trigger if exists orders_guard_update on orders;
create trigger orders_guard_update
before update on orders
for each row execute function guard_order_update();

-- rovnaký princíp pre ad-hoc platby (zápis je aj tak len cez funkcie)
create or replace function guard_adhoc_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if session_user in ('postgres', 'supabase_admin') then return NEW; end if;
  if NEW.id <> OLD.id or NEW.variable_symbol is distinct from OLD.variable_symbol
     or NEW.amount is distinct from OLD.amount or NEW.created_at is distinct from OLD.created_at then
    raise exception 'Suma a variabilný symbol ad-hoc platby sú nemenné.';
  end if;
  if coalesce(NEW.paid, false) <> coalesce(OLD.paid, false) or NEW.paid_at is distinct from OLD.paid_at then
    if current_setting('app.paid_change', true) is distinct from '1' then
      raise exception 'Platbu označuje párovanie Fio alebo funkcia mark_adhoc_paid (s uvedením dôvodu).';
    end if;
  end if;
  return NEW;
end $$;
drop trigger if exists adhoc_guard_update on adhoc_payments;
create trigger adhoc_guard_update
before update on adhoc_payments
for each row execute function guard_adhoc_update();

-- Ručné označenie platby: superadmin alebo sestra, s MFA, s dôvodom
-- (≥ 10 znakov) → audit_log 'paid-manual' + kópia na copy_email.
create or replace function mark_order_paid(p_id text, p_paid boolean, p_reason text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_o      orders%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_who    text;
begin
  if my_role() not in ('superadmin', 'sestra') then
    raise exception 'Platbu môže ručne označiť len sestra alebo superadmin.';
  end if;
  if not mfa_ok() then
    raise exception 'Táto akcia vyžaduje prihlásenie s dvojfaktorovým overením (MFA).';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'Uveďte dôvod ručného označenia platby (10 – 500 znakov), napr. „hotovosť pri okienku, doklad č. 123".';
  end if;
  perform assert_order_id(p_id);
  select * into v_o from orders where upper(id) = upper(p_id) for update;
  if not found then
    raise exception 'Objednávka % neexistuje.', p_id;
  end if;
  if coalesce(v_o.paid, false) = coalesce(p_paid, false) then
    return false;
  end if;
  perform set_config('app.paid_change', '1', true);
  update orders set paid = p_paid, paid_at = case when p_paid then now() else null end where id = v_o.id;
  select coalesce(u.email::text, auth.uid()::text, '?') into v_who from auth.users u where u.id = auth.uid();
  insert into audit_log (user_id, order_id, action, detail)
  values (auth.uid(), v_o.id, 'paid-manual',
    (case when p_paid then 'ručne označené ako zaplatené' else 'ručné označenie platby zrušené' end) || ' · ' || coalesce(v_who, '?') || ' · dôvod: ' || v_reason);
  perform staff_copy_email('Ručné označenie platby',
    '<p><b>' || html_escape(v_o.patient_name) || '</b> · ' || html_escape(v_o.id) || ' · ' || replace(to_char(v_o.price, 'FM990D00'), '.', ',') || ' €<br>'
    || case when p_paid then 'označené ako <b>zaplatené</b>' else 'označenie platby <b>zrušené</b>' end
    || '<br>Kto: ' || html_escape(coalesce(v_who, '?')) || '<br>Dôvod: ' || html_escape(v_reason) || '</p>');
  return true;
end $$;
revoke all on function mark_order_paid(text, boolean, text) from public, anon;
grant execute on function mark_order_paid(text, boolean, text) to authenticated;

-- mark_adhoc_paid — rovnaké pravidlá (nový podpis s dôvodom; starý zrušený)
drop function if exists mark_adhoc_paid(text);
create or replace function mark_adhoc_paid(p_id text, p_reason text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_a adhoc_payments%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_who text;
begin
  if my_role() not in ('superadmin', 'sestra') then
    raise exception 'Platbu môže potvrdiť len personál.';
  end if;
  if not mfa_ok() then
    raise exception 'Táto akcia vyžaduje prihlásenie s dvojfaktorovým overením (MFA).';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'Uveďte dôvod ručného označenia platby (10 – 500 znakov).';
  end if;
  select * into v_a from adhoc_payments where id = p_id for update;
  if not found or v_a.paid then return false; end if;
  perform set_config('app.paid_change', '1', true);
  update adhoc_payments set paid = true, paid_at = now() where id = v_a.id;
  select coalesce(u.email::text, auth.uid()::text, '?') into v_who from auth.users u where u.id = auth.uid();
  insert into audit_log (user_id, order_id, action, detail)
  values (auth.uid(), v_a.id, 'paid-manual', 'ad-hoc ručne označené ako zaplatené · ' || coalesce(v_who, '?') || ' · dôvod: ' || v_reason);
  perform staff_copy_email('Ručné označenie ad-hoc platby',
    '<p><b>' || html_escape(v_a.item_name) || '</b> · ' || html_escape(v_a.id) || ' · ' || replace(to_char(v_a.amount, 'FM9990D00'), '.', ',') || ' €<br>Kto: '
    || html_escape(coalesce(v_who, '?')) || '<br>Dôvod: ' || html_escape(v_reason) || '</p>');
  return true;
end $$;
revoke all on function mark_adhoc_paid(text, text) from public, anon;
grant execute on function mark_adhoc_paid(text, text) to authenticated;

-- krátky interný e-mail na copy_email (best-effort, bez zdravotných údajov)
create or replace function staff_copy_email(p_subject text, p_html text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_key  text := app_secret('resend_api_key');
  v_to   text;
  v_from text;
  v_addrs jsonb;
begin
  select value into v_to from settings where key = 'copy_email';
  if coalesce(v_to, '') = '' or v_key like 'SEM\_%' then return; end if;
  select value into v_from from settings where key = 'mail_from';
  if v_from is null or v_from = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  select jsonb_agg(btrim(a)) into v_addrs from unnest(string_to_array(v_to, ',')) a where btrim(a) <> '';
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', v_addrs, 'subject', p_subject,
      'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">' || email_header()
        || '<h2 style="color:#003d7c">' || html_escape(p_subject) || '</h2>' || p_html
        || '<p style="font-size:12px;color:#64748b">Automatická správa (settings.copy_email).</p></div>')
  );
exception when others then null;
end $$;
revoke all on function staff_copy_email(text, text) from public, anon, authenticated;

-- fio_process_request: nastaví app.paid_change (prejde cez guard aj z API),
-- health event pri úspešnej odpovedi; logika párovania 1:1 z podappky-001
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
  v_status int;
begin
  perform set_config('app.paid_change', '1', true);

  select status_code into v_status from net._http_response where id = p_request_id;
  select content::jsonb into v_json
  from net._http_response
  where id = p_request_id and status_code = 200;

  if v_json is null then
    if v_status is not null and v_status <> 200 then
      perform health_event('fio', false, 'HTTP ' || v_status);
      update fio_requests set processed = true where request_id = p_request_id;
    elsif p_requested_at < now() - interval '1 hour' then
      perform health_event('fio', false, 'bez odpovede > 1 h');
      update fio_requests set processed = true where request_id = p_request_id;
    end if;
    return 0;
  end if;
  perform health_event('fio', true, 'odpoveď 200');

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

    -- 1) USG objednávka (VS je od vlny 8 unikátny)
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
      update fio_payments set matched_order_id = v_order.id,
        note = case when v_amt > v_order.price + 0.005 then 'spárované automaticky — vyššia suma (' || v_amt || ' z ' || v_order.price || ' €), preveriť' else 'spárované automaticky' end
      where tx_id = v_txid;
      v_cnt := v_cnt + 1;
      continue;
    end if;

    -- 2) ad-hoc platba
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
    perform health_event('fio-nesparovane', false, 'VS ' || v_vs || ' · ' || v_amt || ' ' || coalesce(nullif(v_cur, ''), 'EUR'));
  end loop;

  update fio_requests set processed = true where request_id = p_request_id;
  return v_cnt;
end $func$;
revoke all on function fio_process_request(bigint, timestamptz) from public, anon, authenticated;

-- fio_poll_guarded: + health event pri chybe
create or replace function fio_poll_guarded()
returns int
language plpgsql security definer set search_path = public as $$
declare v int := 0;
begin
  if not pg_try_advisory_lock(hashtext('fio_poll')) then
    return 0;
  end if;
  begin
    v := fio_poll();
  exception when others then
    perform pg_advisory_unlock(hashtext('fio_poll'));
    perform health_event('fio', false, 'fio_poll: ' || sqlerrm);
    raise;
  end;
  perform pg_advisory_unlock(hashtext('fio_poll'));
  return v;
end $$;
revoke all on function fio_poll_guarded() from public, anon, authenticated;

-- check_payments: cez chránený wrapper + MFA
create or replace function check_payments()
returns table (objednavka text, pacient text, termin text, cena numeric, vs text, zaplatene boolean, platba text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and my_role() not in ('superadmin', 'sestra') then
    raise exception 'Kontrola platieb je dostupná len pre superadmina a sestru.';
  end if;
  if not mfa_ok() then
    raise exception 'Táto akcia vyžaduje prihlásenie s dvojfaktorovým overením (MFA).';
  end if;
  perform fio_poll_guarded();
  return query
    select o.id, o.patient_name,
      to_char(o.slot_date, 'DD.MM.YYYY') || ' ' || to_char(o.slot_time, 'HH24:MI'),
      o.price, o.variable_symbol, o.paid,
      coalesce((
        select p.note || ' (' || replace(p.amount::text, '.', ',') || ' €, ' || to_char(p.received_at, 'DD.MM. HH24:MI') || ')'
        from fio_payments p
        where p.matched_order_id = o.id or (p.vs <> '' and p.vs = o.variable_symbol)
        order by p.received_at desc limit 1
      ), '— platba zatiaľ neprišla')
    from orders o
    where o.status <> 'rejected' and o.slot_date >= current_date
    order by o.slot_date, o.slot_time;
end $$;
revoke all on function check_payments() from public, anon;
grant execute on function check_payments() to authenticated;

-- ------------------------------------------------------------
-- 5. MFA (TOTP) — helpery; vynútenie prepína settings.mfa_enforce
--    ('off' = len infraštruktúra, 'on' = bez AAL2 personál nič nevidí)
-- ------------------------------------------------------------
create or replace function is_aal2()
returns boolean
language sql stable set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

create or replace function mfa_ok()
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if auth.uid() is null then return true; end if;  -- SQL editor / cron (nie API) — API anon odmietne my_role()
  if is_aal2() then return true; end if;
  select value into v from settings where key = 'mfa_enforce';
  return coalesce(v, 'off') <> 'on';
end $$;
grant execute on function is_aal2() to anon, authenticated;
grant execute on function mfa_ok() to anon, authenticated;

insert into settings (key, value)
select 'mfa_enforce', 'off' where not exists (select 1 from settings where key = 'mfa_enforce');

-- ------------------------------------------------------------
-- 6. PRÍLOHY — lekár vidí len prílohy svojich pacientov; mazanie len
--    sestra/superadmin; cesty príloh viazané na objednávku
-- ------------------------------------------------------------
create or replace function attachment_visible(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_folder text := split_part(coalesce(p_name, ''), '/', 1);
  v_role   text := my_role();
  v_doc    text;
begin
  if v_role in ('superadmin', 'sestra') then return true; end if;
  if v_role <> 'lekar' then return false; end if;
  if v_folder like 'USG-%' then
    select doctor into v_doc from orders where upper(id) = upper(v_folder);
  elsif v_folder like 'CT-%' then
    select doctor into v_doc from ct_orders where upper(id) = upper(v_folder);
  elsif v_folder like 'ANG-%' then
    select doctor into v_doc from angio_orders where upper(id) = upper(v_folder);
  else
    return false;
  end if;
  return coalesce(v_doc, '') <> '' and v_doc = my_doctor();
end $$;
revoke all on function attachment_visible(text) from public, anon;
grant execute on function attachment_visible(text) to authenticated;

drop policy if exists "prilohy citanie personal" on storage.objects;
create policy "prilohy citanie personal" on storage.objects
  for select to authenticated
  using (bucket_id = 'prilohy' and mfa_ok() and attachment_visible(name));

drop policy if exists "prilohy mazanie personal" on storage.objects;
create policy "prilohy mazanie personal" on storage.objects
  for delete to authenticated
  using (bucket_id = 'prilohy' and mfa_ok() and my_role() in ('superadmin', 'sestra'));

-- každá príloha v objednávke musí byť v priečinku tejto objednávky a existovať
create or replace function assert_attachments(p_order_id text, p_attachments jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare a jsonb; v_path text;
begin
  if p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then return; end if;
  for a in select * from jsonb_array_elements(p_attachments) loop
    v_path := a ->> 'path';
    if v_path is null then
      continue; -- demo/záložný formát bez cesty (dataUrl) — nič sa neukladá v storage
    end if;
    if v_path !~ ('^' || p_order_id || '/[^/]{1,120}$') then
      raise exception 'Príloha nepatrí k tejto objednávke.';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'prilohy' and name = v_path) then
      raise exception 'Príloha % sa nenašla — nahrajte ju znova.', split_part(v_path, '/', 2);
    end if;
  end loop;
end $$;
revoke all on function assert_attachments(text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 7. RATE-LIMITY — create_order / ct_create_order cez client_ip() (vlna 7)
--    + assert_attachments; IP limit 30/15 min na lookup/cancel/reschedule;
--    globálny OTP strop oddelený pre USG a angio; drop order_exists
-- ------------------------------------------------------------
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
  v_ip     text := client_ip();
begin
  if p_id !~ '^USG-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('create-ip:' || v_ip, 20);
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
  if p_birth_date is not null and (p_birth_date > current_date or p_birth_date < date '1900-01-01') then
    raise exception 'Zadajte platný dátum narodenia.';
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
  v_dur := greatest(coalesce(v_item.duration_slots, 2), 2) * 5;

  select count(*) into v_active
  from orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky. Ak potrebujete ďalší termín, napíšte SMS na 0949 000 677.', v_active;
  end if;

  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;
  perform assert_attachments(p_id, p_attachments);

  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  perform assert_referral_window(p_has_referral, p_slot_time);

  v_vs := nextval('vs_seq')::text;

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
  return v_vs;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

create or replace function ct_create_order(
  p_id text, p_exam_type_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time,
  p_attachments jsonb default '[]'::jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item ct_pricelist%rowtype;
  v_dur int;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
  v_ip text := client_ip();
  v_phone9 text;
  v_active int;
begin
  if p_id !~ '^CT-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('ct-create-ip:' || v_ip, 20);
  end if;

  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_insurance, '')) > 100
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;
  if p_birth_date is not null and (p_birth_date > current_date or p_birth_date < date '1900-01-01') then
    raise exception 'Zadajte platný dátum narodenia.';
  end if;
  v_phone9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;
  perform assert_attachments(p_id, p_attachments);

  select count(*) into v_active
  from ct_orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne CT objednávky.', v_active;
  end if;

  select * into v_item from ct_pricelist where id = p_exam_type_id and active = true;
  if not found then
    raise exception 'Vybrané CT vyšetrenie nie je dostupné.';
  end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;

  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from ct_open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  insert into ct_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance,
    phone, email, reason, slot_date, slot_time, doctor, duration_min, attachments)
  values (p_id, v_item.id, v_item.label, p_patient_name, p_birth_date, coalesce(p_insurance, ''),
    p_phone, coalesce(p_email, ''), coalesce(p_reason, ''), p_slot_date, p_slot_time,
    coalesce(v_doctor, ''), v_dur, coalesce(p_attachments, '[]'::jsonb));
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

-- angio_create_order: doplniť assert_attachments v mieste (telo z vlny 7 ostáva)
do $mig$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
  where p.proname = 'angio_create_order' and p.pronamespace = 'public'::regnamespace;
  if v_def is null then
    raise notice 'angio_create_order neexistuje — preskočené.';
  elsif position('assert_attachments' in v_def) > 0 then
    null;
  else
    v_new := replace(v_def,
      $o$    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;
$o$,
      $n$    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;
  perform assert_attachments(p_id, p_attachments);
$n$);
    if v_new = v_def then
      raise exception 'Vlna 8: angio_create_order má neočakávané telo — assert_attachments nepridané.';
    end if;
    execute v_new;
  end if;
end $mig$;

-- IP limit do pacientskych RPC (telo + limit na telefón ostáva)
create or replace function lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb; v_ip text := client_ip();
begin
  perform assert_order_id(p_id);
  if v_ip <> '' then perform check_rate_limit('lookup-ip:' || v_ip, 30); end if;
  perform check_lookup_limit('lookup:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));
  select to_jsonb(x) into result from (
    select o.id, o.status, o.status_note, o.has_referral, o.exam_label,
           o.exam_type_id, o.duration_min,
           o.price, o.slot_date, o.slot_time, o.doctor, o.paid
    from orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
  return result;
end $$;

create or replace function cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_when timestamptz;
  v_ip text := client_ip();
begin
  perform assert_order_id(p_id);
  if v_ip <> '' then perform check_rate_limit('cancel-ip:' || v_ip, 30); end if;
  perform check_lookup_limit('cancel:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));

  select ((o.slot_date + o.slot_time) at time zone 'Europe/Bratislava') into v_when
  from orders o
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');

  if v_when is not null and v_when - now() < interval '48 hours' then
    raise exception 'Do termínu zostáva menej ako 48 hodín — napíšte nám SMS s číslom objednávky na 0949 000 677.';
  end if;

  update orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

create or replace function patient_reschedule(p_id text, p_phone text, p_slot_date date, p_slot_time time)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
  v_ip text := client_ip();
begin
  perform assert_order_id(p_id);
  if v_ip <> '' then perform check_rate_limit('resched-ip:' || v_ip, 30); end if;
  perform check_lookup_limit('resched:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));

  select * into v_order from orders o
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  if not found then
    raise exception 'Objednávku sme nenašli alebo ju nemožno presunúť.';
  end if;

  if ((v_order.slot_date + v_order.slot_time) at time zone 'Europe/Bratislava') - now() < interval '48 hours' then
    raise exception 'Do termínu zostáva menej ako 48 hodín — napíšte nám SMS s číslom objednávky na 0949 000 677.';
  end if;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  perform assert_referral_window(v_order.has_referral, p_slot_time);

  for n in 0 .. (greatest(v_order.duration_min, 10) / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor
    from open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Vybraný čas už nie je dostupný. Vyberte iný.';
    end if;
    if n = 0 then
      v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Vybraný čas už nie je dostupný. Vyberte iný.';
    end if;
  end loop;

  if exists (
    select 1 from orders o
    where o.slot_date = p_slot_date and o.status <> 'rejected' and o.id <> v_order.id
      and int4range(
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int,
            (extract(hour from o.slot_time) * 60 + extract(minute from o.slot_time))::int + o.duration_min
          ) && int4range(
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int,
            (extract(hour from p_slot_time) * 60 + extract(minute from p_slot_time))::int + v_order.duration_min
          )
  ) then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
  end if;

  update orders set
    slot_date = p_slot_date,
    slot_time = p_slot_time,
    doctor = coalesce(v_doctor, ''),
    status_note = 'Presunuté pacientom z ' || to_char(v_order.slot_date, 'DD.MM.YYYY') || ' ' || to_char(v_order.slot_time, 'HH24:MI')
  where id = v_order.id;
  return true;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;

create or replace function ct_lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb; v_ip text := client_ip();
begin
  if coalesce(p_id, '') !~ '^CT-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then perform check_rate_limit('ctlookup-ip:' || v_ip, 30); end if;
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

create or replace function ct_cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int; v_ip text := client_ip();
begin
  if coalesce(p_id, '') !~ '^CT-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then perform check_rate_limit('ctcancel-ip:' || v_ip, 30); end if;
  perform check_lookup_limit('ctcancel:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));
  update ct_orders o set status = 'rejected', rejected_at = now()
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

grant execute on function create_order(text, text, text, numeric, boolean, text, text, text, text, date, text, text, text, date, time, text, jsonb) to anon, authenticated;
grant execute on function ct_create_order(text, text, text, date, text, text, text, text, date, time, jsonb) to anon, authenticated;
grant execute on function lookup_order(text, text) to anon, authenticated;
grant execute on function cancel_order(text, text) to anon, authenticated;
grant execute on function patient_reschedule(text, text, date, time) to anon, authenticated;
grant execute on function ct_lookup_order(text, text) to anon, authenticated;
grant execute on function ct_cancel_order(text, text) to anon, authenticated;

drop function if exists order_exists(text);

-- ------------------------------------------------------------
-- 8. OTP KRYPTOGRAFICKY BEZPEČNÝ + oddelený globálny strop
--    (prepis v mieste send_phone_otp a angio_send_otp)
-- ------------------------------------------------------------
do $mig$
declare
  r record; v_def text; v_new text;
begin
  for r in
    select p.oid, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('send_phone_otp', 'angio_send_otp')
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def,
      'v_code := lpad((floor(random() * 1000000))::int::text, 6, ''0'');',
      'v_code := lpad(((abs((''x'' || encode(app_random_bytes(4), ''hex''))::bit(32)::int::bigint)) % 1000000)::text, 6, ''0'');');
    v_new := replace(v_new,
      'v_salt := md5(random()::text || clock_timestamp()::text);',
      'v_salt := encode(app_random_bytes(16), ''hex'');');
    v_new := replace(v_new, 'check_rate_limit(''otp-global'', 60)',
      case when r.proname = 'send_phone_otp' then 'check_rate_limit(''otp-global-usg'', 60)' else 'check_rate_limit(''otp-global-angio'', 60)' end);
    if v_new <> v_def then execute v_new; end if;
    if position('random()' in v_new) > 0 then
      raise exception 'Vlna 8: % stále používa random().', r.proname;
    end if;
  end loop;
end $mig$;

-- ------------------------------------------------------------
-- 9. AUDIT — settings / staff_roles / pricelist / ct_orders / angio_orders;
--    superadmin nie je prideliteľný ani odoberateľný cez RPC
-- ------------------------------------------------------------
create or replace function audit_generic()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  j_old jsonb := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
  j_new jsonb := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;
  v_id  text;
  v_detail text := '';
  v_keys text[];
  k text;
begin
  case TG_TABLE_NAME
    when 'settings' then
      v_id := 'settings:' || coalesce(j_new ->> 'key', j_old ->> 'key');
      v_keys := array['value'];
    when 'staff_roles' then
      v_id := 'staff_role:' || coalesce(j_new ->> 'user_id', j_old ->> 'user_id');
      v_keys := array['role', 'doctor_name'];
    when 'pricelist' then
      v_id := 'pricelist:' || coalesce(j_new ->> 'id', j_old ->> 'id');
      v_keys := array['label', 'price_self', 'price_referral', 'active', 'duration_slots'];
    else
      v_id := coalesce(j_new ->> 'id', j_old ->> 'id');
      v_keys := array['status', 'slot_date', 'slot_time', 'doctor', 'exam_type_id'];
  end case;

  if TG_OP = 'UPDATE' then
    foreach k in array v_keys loop
      if (j_old -> k) is distinct from (j_new -> k) then
        v_detail := v_detail || case when v_detail = '' then '' else ' · ' end
          || k || ': ' || left(coalesce(j_old ->> k, '∅'), 60) || ' → ' || left(coalesce(j_new ->> k, '∅'), 60);
      end if;
    end loop;
    if v_detail = '' then return NEW; end if;
  elsif TG_OP = 'INSERT' then
    foreach k in array v_keys loop
      if j_new ? k then
        v_detail := v_detail || case when v_detail = '' then '' else ' · ' end || k || ': ' || left(coalesce(j_new ->> k, '∅'), 60);
      end if;
    end loop;
  else
    v_detail := 'zmazané · ' || left(coalesce(j_old ->> 'status', j_old ->> 'role', j_old ->> 'value', ''), 60);
  end if;

  if auth.uid() is null then
    v_detail := '[' || session_user || '] ' || v_detail;
  end if;
  insert into audit_log (user_id, order_id, action, detail)
  values (auth.uid(), left(v_id, 120), TG_TABLE_NAME || ':' || lower(TG_OP), left(v_detail, 1000));
  return coalesce(NEW, OLD);
exception when others then
  return coalesce(NEW, OLD);
end $$;

do $$
declare t text;
begin
  foreach t in array array['settings', 'staff_roles', 'pricelist', 'ct_orders', 'angio_orders'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists %I on %I', t || '_audit_generic', t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_generic()', t || '_audit_generic', t);
  end loop;
end $$;

-- list_staff: + stĺpec MFA (overený TOTP faktor)
drop function if exists list_staff();
create or replace function list_staff()
returns table (email text, role text, doctor_name text, mfa boolean)
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  return query
    select u.email::text,
           coalesce(r.role, '')::text,
           coalesce(r.doctor_name, '')::text,
           exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')
    from auth.users u
    left join staff_roles r on r.user_id = u.id
    order by u.email;
end $$;
revoke all on function list_staff() from public, anon;
grant execute on function list_staff() to authenticated;

create or replace function set_staff_role(p_email text, p_role text, p_doctor_name text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_cur text;
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  if not mfa_ok() then
    raise exception 'Táto akcia vyžaduje prihlásenie s dvojfaktorovým overením (MFA).';
  end if;
  if p_role not in ('sestra', 'lekar') then
    raise exception 'Rolu superadmin možno prideliť len v SQL editore Supabase (GO-LIVE.md → Správa superadminov).';
  end if;
  if p_role = 'lekar' and coalesce(trim(p_doctor_name), '') = '' then
    raise exception 'Pri role lekár vyberte meno lekára.';
  end if;
  select u.id into v_uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if not found then
    raise exception 'Konto % neexistuje. Najprv ho pozvite v Supabase (Authentication → Users → Invite user).', p_email;
  end if;
  select role into v_cur from staff_roles where user_id = v_uid;
  if v_cur = 'superadmin' then
    raise exception 'Rolu existujúceho superadmina nemožno meniť z aplikácie — len v SQL editore.';
  end if;
  insert into staff_roles (user_id, role, doctor_name)
  values (v_uid, p_role, case when p_role = 'lekar' then trim(p_doctor_name) else '' end)
  on conflict (user_id) do update
    set role = excluded.role, doctor_name = excluded.doctor_name;
end $$;

create or replace function remove_staff_role(p_email text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_cur text;
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  if not mfa_ok() then
    raise exception 'Táto akcia vyžaduje prihlásenie s dvojfaktorovým overením (MFA).';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then return; end if;
  select role into v_cur from staff_roles where user_id = v_uid;
  if v_cur = 'superadmin' then
    raise exception 'Superadmina nemožno odobrať z aplikácie — len v SQL editore.';
  end if;
  delete from staff_roles where user_id = v_uid;
end $$;
revoke all on function set_staff_role(text, text, text) from public, anon;
revoke all on function remove_staff_role(text) from public, anon;
grant execute on function set_staff_role(text, text, text) to authenticated;
grant execute on function remove_staff_role(text) to authenticated;

-- superadmin z API ani priamym zápisom do staff_roles (trigger; SQL editor prejde)
create or replace function staff_roles_protect()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if session_user in ('postgres', 'supabase_admin') then return coalesce(NEW, OLD); end if;
  if (TG_OP in ('INSERT', 'UPDATE') and NEW.role = 'superadmin')
     or (TG_OP in ('UPDATE', 'DELETE') and OLD.role = 'superadmin') then
    raise exception 'Rola superadmin sa spravuje výlučne v SQL editore Supabase.';
  end if;
  return coalesce(NEW, OLD);
end $$;
drop trigger if exists staff_roles_protect on staff_roles;
create trigger staff_roles_protect
before insert or update or delete on staff_roles
for each row execute function staff_roles_protect();

-- MFA kontrola do ďalších RPC personálu (vloží sa za prvý `begin`)
do $mig$
declare
  f text; v_def text; v_new text; v_oid oid;
begin
  foreach f in array array['reschedule_order', 'create_adhoc_payment', 'resend_adhoc_email', 'update_pricelist_order',
                           'ct_reschedule', 'angio_reschedule', 'doctor_monthly_stats', 'issue_missing_invoices', 'checkin_confirm'] loop
    for v_oid in select p.oid from pg_proc p
      where p.proname = f and p.pronamespace = 'public'::regnamespace and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
    loop
      v_def := pg_get_functiondef(v_oid);
      if position('mfa_ok()' in v_def) > 0 then continue; end if;
      v_new := regexp_replace(v_def, '\nbegin\n',
        E'\nbegin\n  if not mfa_ok() then raise exception \'Táto akcia vyžaduje prihlásenie s dvojfaktorovým overením (MFA).\'; end if;\n');
      if v_new = v_def then
        raise notice 'MFA: % — telo bez „begin" na začiatku riadku, preskočené.', f;
      else
        execute v_new;
      end if;
    end loop;
  end loop;
end $mig$;

-- ------------------------------------------------------------
-- 10. HEALTH — základ je v sekcii 2 (health_events, health_event());
--     čítanie pre personál cez RPC (bez priameho grantu na tabuľku)
-- ------------------------------------------------------------
create or replace function health_recent(p_hours int default 24)
returns table (at timestamptz, source text, ok boolean, detail text)
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'superadmin' or not mfa_ok() then
    raise exception 'Prehľad stavu systému je len pre superadmina (s MFA).';
  end if;
  return query select h.at, h.source, h.ok, h.detail from health_events h
    where h.at > now() - make_interval(hours => least(greatest(p_hours, 1), 24 * 90)) order by h.at desc limit 500;
end $$;
revoke all on function health_recent(int) from public, anon;
grant execute on function health_recent(int) to authenticated;

-- ------------------------------------------------------------
-- 11. mfa_ok() DO VŠETKÝCH POLITÍK, KTORÉ SA OPIERAJÚ O my_role()
--     (public aj storage) — generický, idempotentný prechod
-- ------------------------------------------------------------
do $mig$
declare
  r record; v_roles text; v_cnt int := 0; v_sql text;
begin
  for r in
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies
    where schemaname in ('public', 'storage')
      and (coalesce(qual, '') like '%my_role()%' or coalesce(with_check, '') like '%my_role()%')
      and coalesce(qual, '') not like '%mfa_ok()%'
      and coalesce(with_check, '') not like '%mfa_ok()%'
  loop
    select string_agg(quote_ident(x), ', ') into v_roles from unnest(r.roles) x;
    if v_roles is null or v_roles = '' then v_roles := 'public'; end if;
    v_sql := format('create policy %I on %I.%I as %s for %s to %s',
      r.policyname, r.schemaname, r.tablename, r.permissive, r.cmd, v_roles);
    if r.qual is not null then
      v_sql := v_sql || format(' using ((%s) and mfa_ok())', r.qual);
    end if;
    if r.with_check is not null then
      v_sql := v_sql || format(' with check ((%s) and mfa_ok())', r.with_check);
    end if;
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    execute v_sql;
    v_cnt := v_cnt + 1;
  end loop;
  raise notice 'MFA: % politík doplnených o mfa_ok().', v_cnt;
end $mig$;

-- záverečná kontrola
do $$
declare v text;
begin
  select string_agg(tablename || '.' || policyname, ', ') into v from pg_policies
  where schemaname in ('public', 'storage') and coalesce(qual, '') || coalesce(with_check, '') like '%my_role()%'
    and coalesce(qual, '') || coalesce(with_check, '') not like '%mfa_ok()%';
  if v is not null then raise exception 'Vlna 8: politiky bez mfa_ok(): %', v; end if;
  if not exists (select 1 from pg_trigger where tgname = 'settings_protect') then raise exception 'Vlna 8: chýba settings_protect'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'orders_guard_update') then raise exception 'Vlna 8: chýba orders_guard_update'; end if;
  if has_function_privilege('anon', 'app_secret(text)', 'execute') then raise exception 'Vlna 8: anon má app_secret'; end if;
  raise notice 'Vlna 8 — hotovo. MFA vynútenie je VYPNUTÉ (settings.mfa_enforce = off); zapnite po zápise faktorov: update settings set value = ''on'' where key = ''mfa_enforce'';';
end $$;

-- Diagnostika:
--   select name from vault.secrets;                              -- 4 kľúče
--   select * from payment_identity;                              -- ostrý IBAN
--   select tgname from pg_trigger where tgname in ('settings_protect','orders_guard_update','staff_roles_protect');
--   select * from health_events order by at desc limit 20;
--   select action, detail from audit_log order by at desc limit 20;
-- ============================================================
