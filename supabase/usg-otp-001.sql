-- ============================================================
-- USG OTP 001 — overenie telefónneho čísla SMS kódom v platenom (USG)
-- objednávaní
--   • pacient si pred odoslaním objednávky nechá poslať 6-miestny kód
--     (send_phone_otp), zadá ho (verify_phone_otp); trigger na orders
--     objednávku bez overeného čísla odmietne (overenie platí 30 min,
--     je jednorazové, viaže sa na číslo)
--   • zapína sa v settings: usg_sms_verify = 'on' / 'off'
--     (Správa → Nastavenia platby → Overovanie telefónu; verejne čitateľný kľúč)
--   • personál (prihlásený) overenie nepotrebuje
--   • ochrany rovnaké ako pri angio: 3 SMS / 15 min na číslo, 10 / 15 min
--     na IP, 60 / 15 min celkovo, 5 pokusov na kód, kód 10 min, len hash
--   Nezávislé od angio-005 (tabuľka phone_verifications sa vytvorí, ak
--   ešte nie je). KĽÚČE NETREBA VKLADAŤ: BulkGate kľúče sa prevezmú
--   z notify_order_sms. Idempotentné. Spúšťať PO audit-vlna7-001.
-- ============================================================

-- 1. verejný kľúč nastavenia (rovnaký zoznam ako angio-005 + usg_sms_verify)
drop policy if exists "settings verejne citanie" on settings;
create policy "settings verejne citanie" on settings
  for select using (key in ('iban', 'beneficiary', 'referral_from', 'slot_base_min', 'angio_common_notes', 'angio_sms_verify', 'usg_sms_verify'));

-- 2. tabuľka overení (spoločná s angio)
create table if not exists phone_verifications (
  id bigserial primary key,
  phone text not null,
  salt text not null,
  code_hash text not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz,
  token text unique,
  token_expires_at timestamptz,
  used_at timestamptz
);
create index if not exists phone_verifications_phone_idx on phone_verifications (phone, created_at desc);
alter table phone_verifications enable row level security;
revoke all on table phone_verifications from public, anon, authenticated;

-- 3. odoslanie kódu (kľúče z notify_order_sms)
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
    raise notice 'USG OTP: BulkGate kľúče nie sú nastavené — overovanie ostane vypnuté (usg_sms_verify = off).';
  end if;

  insert into settings (key, value)
  select 'usg_sms_verify', case when v_id like 'SEM\_%' or v_tok like 'SEM\_%' then 'off' else 'on' end
  where not exists (select 1 from settings where key = 'usg_sms_verify');

  execute format($def$
create or replace function send_phone_otp(p_phone text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_app_id    text := %L;
  v_app_token text := %L;
  v_number text;
  v_ip     text := client_ip();
  v_code   text;
  v_salt   text;
begin
  if v_app_id like 'SEM_%%' then
    raise exception 'Overovanie SMS nie je nastavené. Kontaktujte pracovisko.';
  end if;
  v_number := sms_number(p_phone);
  if length(v_number) < 11 or length(v_number) > 15 then
    raise exception 'Zadajte platné telefónne číslo (napr. 0949 123 456).';
  end if;
  if v_ip <> '' then perform check_rate_limit('otp-ip:' || v_ip, 10); end if;
  perform check_rate_limit('otp-phone:' || v_number, 3);
  perform check_rate_limit('otp-global', 60);

  delete from phone_verifications where created_at < now() - interval '1 day';
  v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  v_salt := md5(random()::text || clock_timestamp()::text);
  insert into phone_verifications (phone, salt, code_hash, expires_at)
  values (v_number, v_salt, md5(v_salt || v_code), now() + interval '10 minutes');

  perform net.http_post(
    url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'application_id', v_app_id, 'application_token', v_app_token,
      'number', v_number,
      'text', 'NUSCH: Vas overovaci kod: ' || v_code || '. Plati 10 minut. Nikomu ho neposielajte.',
      'unicode', false, 'sender_id', 'gText', 'sender_id_value', 'NUSCH')
  );
end $fn$;
$def$, v_id, v_tok);
end $mig$;
revoke all on function send_phone_otp(text) from public;
grant execute on function send_phone_otp(text) to anon, authenticated;

-- 4. overenie kódu ({ok:true, token} / {ok:false, error})
create or replace function verify_phone_otp(p_phone text, p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_number text := sms_number(p_phone);
  v_ip     text := client_ip();
  r        phone_verifications%rowtype;
  v_token  text;
begin
  if v_ip <> '' then perform check_rate_limit('otp-verify-ip:' || v_ip, 30); end if;
  select * into r from phone_verifications
  where phone = v_number and verified_at is null and expires_at > now()
  order by created_at desc limit 1
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Kód vypršal alebo nebol odoslaný. Pošlite si nový kód.');
  end if;
  if r.attempts >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Príliš veľa nesprávnych pokusov. Pošlite si nový kód.');
  end if;
  if md5(r.salt || regexp_replace(coalesce(p_code, ''), '\D', '', 'g')) <> r.code_hash then
    update phone_verifications set attempts = attempts + 1 where id = r.id;
    return jsonb_build_object('ok', false, 'error', 'Nesprávny kód. Skúste znova.');
  end if;
  v_token := gen_random_uuid()::text;
  update phone_verifications
  set verified_at = now(), token = v_token, token_expires_at = now() + interval '30 minutes'
  where id = r.id;
  return jsonb_build_object('ok', true, 'token', v_token);
end $$;
revoke all on function verify_phone_otp(text, text) from public;
grant execute on function verify_phone_otp(text, text) to anon, authenticated;

-- 5. trigger: objednávka USG bez overeného čísla neprejde (pacient bez prihlásenia)
create or replace function orders_require_phone_verification()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_on  text;
  v_id  bigint;
begin
  select value into v_on from settings where key = 'usg_sms_verify';
  if coalesce(v_on, 'off') <> 'on' then return NEW; end if;
  if my_role() in ('superadmin', 'sestra', 'lekar') then return NEW; end if;
  select id into v_id from phone_verifications
  where phone = sms_number(NEW.phone)
    and verified_at is not null and used_at is null and token_expires_at > now()
  order by verified_at desc limit 1
  for update;
  if v_id is null then
    raise exception 'Telefónne číslo nie je overené. Nechajte si poslať SMS kód a zadajte ho.';
  end if;
  update phone_verifications set used_at = now() where id = v_id;
  return NEW;
end $$;
drop trigger if exists orders_require_phone_verification on orders;
create trigger orders_require_phone_verification
before insert on orders
for each row execute function orders_require_phone_verification();

-- Diagnostika:
--   select value from settings where key = 'usg_sms_verify';
-- ============================================================
