-- ============================================================
-- ANGIO 005 — overenie telefónneho čísla SMS kódom (OTP)
--   • pacient si pred odoslaním objednávky nechá poslať 6-miestny kód
--     (angio_send_otp), zadá ho (angio_verify_otp) a dostane dočasný
--     token; angio_create_order objednávku bez platného tokenu odmietne
--   • zapína sa v settings: angio_sms_verify = 'on' / 'off'
--     (Nastavenia → Overovanie telefónu; verejne čitateľný kľúč)
--   • ochrany: 3 SMS / 15 min na číslo, 10 / 15 min na IP, 5 pokusov
--     na kód, kód platí 10 min, token 30 min, jednorazový;
--     kódy sa ukladajú len ako hash (md5 + soľ)
--   • personál (prihlásený) overenie nepotrebuje
--
-- KĽÚČE NETREBA VKLADAŤ: BulkGate kľúče sa prevezmú z angio_notify_sms
-- (angio-002). Ak sú tam placeholdery, overovanie ostane vypnuté.
-- Idempotentné. Spúšťať PO angio-001 … angio-004.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nastavenie (verejne čitateľné, aby pacientska stránka vedela,
--    či má overenie zobraziť)
-- ------------------------------------------------------------
drop policy if exists "settings verejne citanie" on settings;
create policy "settings verejne citanie" on settings
  for select using (key in ('iban', 'beneficiary', 'referral_from', 'slot_base_min', 'angio_common_notes', 'angio_sms_verify'));

-- ------------------------------------------------------------
-- 2. Tabuľka overení (bez politík — prístup len cez funkcie nižšie)
-- ------------------------------------------------------------
create table if not exists phone_verifications (
  id bigserial primary key,
  phone text not null,                 -- normalizované číslo (sms_number)
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

-- ------------------------------------------------------------
-- 3. Odoslanie a overenie kódu
-- ------------------------------------------------------------
do $mig$
declare
  src   text;
  v_id  text;
  v_tok text;
begin
  select prosrc into src from pg_proc
  where proname = 'angio_notify_sms' and pronamespace = 'public'::regnamespace;
  v_id  := coalesce(substring(src from 'v_app_id\s+text\s*:=\s*''([^'']*)'''),    'SEM_VLOZTE_APPLICATION_ID');
  v_tok := coalesce(substring(src from 'v_app_token\s+text\s*:=\s*''([^'']*)'''), 'SEM_VLOZTE_APPLICATION_TOKEN');
  if v_id like 'SEM\_%' or v_tok like 'SEM\_%' then
    raise notice 'ANGIO OTP: BulkGate kľúče nie sú nastavené — overovanie SMS ostane vypnuté (angio_sms_verify = off). Po doplnení kľúčov spustite skript znova.';
  end if;

  -- východiskový stav: zapnuté len ak sú kľúče reálne; existujúcu hodnotu nemení
  insert into settings (key, value)
  select 'angio_sms_verify', case when v_id like 'SEM\_%' or v_tok like 'SEM\_%' then 'off' else 'on' end
  where not exists (select 1 from settings where key = 'angio_sms_verify');

  execute format($def$
create or replace function angio_send_otp(p_phone text)
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
revoke all on function angio_send_otp(text) from public;
grant execute on function angio_send_otp(text) to anon, authenticated;

-- Overenie kódu. Nesprávny kód NEvyhadzuje výnimku (aby sa počítadlo pokusov
-- uložilo) — vracia {ok:false, error:'…'}; správny kód vracia {ok:true, token:'…'}.
create or replace function angio_verify_otp(p_phone text, p_code text)
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
revoke all on function angio_verify_otp(text, text) from public;
grant execute on function angio_verify_otp(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. angio_create_order — nový parameter p_verify_token
--    (starý podpis sa zruší, aby RPC nebolo nejednoznačné)
-- ------------------------------------------------------------
drop function if exists angio_create_order(text, text, text, date, text, text, text, text, date, time, jsonb);

create or replace function angio_create_order(
  p_id text, p_exam_type_id text, p_patient_name text, p_birth_date date, p_insurance text,
  p_phone text, p_email text, p_reason text, p_slot_date date, p_slot_time time,
  p_attachments jsonb default '[]'::jsonb,
  p_verify_token text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item angio_pricelist%rowtype;
  v_dur int;
  v_doctor text;
  v_cell_doctor text;
  n int;
  v_cell time;
  v_ip text := client_ip();
  v_phone9 text;
  v_active int;
  v_verify text;
  v_ver phone_verifications%rowtype;
begin
  if p_id !~ '^ANG-[A-Z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('angio-create-ip:' || v_ip, 20);
  end if;
  if length(coalesce(p_patient_name, '')) not between 3 and 200
     or length(coalesce(p_reason, '')) > 2000
     or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_insurance, '')) > 100
     or length(coalesce(p_phone, '')) > 30 then
    raise exception 'Niektorý z údajov je príliš dlhý alebo chýba meno pacienta.';
  end if;
  v_phone9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  if length(v_phone9) < 9 then
    raise exception 'Zadajte platné telefónne číslo.';
  end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 3 then
    raise exception 'Priložiť možno najviac 3 súbory.';
  end if;

  -- overenie telefónu SMS kódom (pacient bez prihlásenia; personál nie)
  select value into v_verify from settings where key = 'angio_sms_verify';
  if coalesce(v_verify, 'off') = 'on' and my_role() not in ('superadmin', 'sestra', 'lekar') then
    select * into v_ver from phone_verifications
    where token = p_verify_token and phone = sms_number(p_phone)
      and verified_at is not null and used_at is null and token_expires_at > now()
    for update;
    if not found then
      raise exception 'Telefónne číslo nie je overené. Nechajte si poslať SMS kód a zadajte ho.';
    end if;
    update phone_verifications set used_at = now() where id = v_ver.id;
  end if;

  select count(*) into v_active
  from angio_orders o
  where o.status <> 'rejected'
    and o.slot_date >= current_date
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  if v_active >= 3 and v_phone9 <> '917911202' then
    raise exception 'Na toto telefónne číslo už evidujeme % aktívne objednávky.', v_active;
  end if;

  select * into v_item from angio_pricelist where id = p_exam_type_id and active = true;
  if not found then
    raise exception 'Vybraný typ vyšetrenia nie je dostupný.';
  end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;

  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;

  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from angio_open_slots s
    where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  insert into angio_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance,
    phone, email, reason, slot_date, slot_time, doctor, duration_min, attachments)
  values (p_id, v_item.id, v_item.label, p_patient_name, p_birth_date, coalesce(p_insurance, ''),
    p_phone, coalesce(p_email, ''), coalesce(p_reason, ''), p_slot_date, p_slot_time,
    coalesce(v_doctor, ''), v_dur, coalesce(p_attachments, '[]'::jsonb));
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
revoke all on function angio_create_order(text, text, text, date, text, text, text, text, date, time, jsonb, text) from public;
grant execute on function angio_create_order(text, text, text, date, text, text, text, text, date, time, jsonb, text) to anon, authenticated;

-- Diagnostika:
--   select value from settings where key = 'angio_sms_verify';
--   select phone, attempts, created_at, verified_at, used_at from phone_verifications order by id desc limit 10;
-- ============================================================
