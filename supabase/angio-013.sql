-- ============================================================
-- ANGIO-013 — „Zavolajte mi späť" (spätné volania pre pacientov,
-- ktorí nezvládnu online objednanie)
--
--  • tabuľka angio_callbacks: meno, telefón, kedy volať, stav
--    (new → called / booked / unreachable / closed), poznámka personálu
--  • RPC angio_request_callback(meno, telefón, kedy, zdroj) — volá
--    pacient bez prihlásenia; limity podľa IP (IPv6 po /64) a telefónu;
--    rovnaké číslo s otvorenou žiadosťou za 24 h sa neukladá znova,
--    odpoveď je však vždy rovnaká (nič neprezradí o cudzom čísle)
--  • notifikácia: SMS na mobil pracoviska (settings
--    'angio_callback_sms_to', nastavuje superadmin v Správa → Angio →
--    Nastavenia) cez BulkGate + e-mail na copy_email/notify_email
--    cez Resend. Kľúče z Vaultu (app_secret, audit vlna 8).
--    Strop notifikácií 20 / 15 min — pri prekročení sa žiadosť uloží,
--    len sa nepošle SMS/e-mail (pacient nikdy nie je odmietnutý).
--  • personál: superadmin a sestra menia stav a poznámku, lekár číta
--    (RLS + mfa_ok()), mazať smie len superadmin; audit_generic
--  • retencia: IP sa maže po 7 dňoch, žiadosti po 90 dňoch
--
-- Idempotentné. Spúšťať PO audit-vlna8-001.sql (audit vlna 9 = opravy
-- po kontrole: limity, orákulum duplicity, povolené znaky mena, granty).
-- ============================================================

-- ------------------------------------------------------------
-- 0. preflight — pomocné funkcie z predchádzajúcich skriptov
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('app_secret(text)') is null or to_regprocedure('mfa_ok()') is null
     or to_regprocedure('html_escape(text)') is null or to_regprocedure('check_rate_limit(text,int)') is null
     or to_regprocedure('client_ip()') is null or to_regprocedure('sms_number(text)') is null
     or to_regprocedure('my_role()') is null then
    raise exception 'ANGIO-013: chýbajú pomocné funkcie — spustite najprv audit-vlna8-001.sql (a staršie skripty).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. tabuľka
-- ------------------------------------------------------------
create table if not exists angio_callbacks (
  id          text primary key,
  patient_name text not null,
  phone       text not null,          -- normalizované (sms_number), napr. 421949123456
  phone_raw   text not null default '',
  pref        text not null default '',  -- '' | 'dopoludnia' | 'popoludni'
  source      text not null default 'angio1',
  status      text not null default 'new' check (status in ('new', 'called', 'booked', 'unreachable', 'closed')),
  status_note text not null default '',
  order_id    text,
  ip          text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create index if not exists angio_callbacks_status_idx on angio_callbacks (status, created_at desc);
create index if not exists angio_callbacks_phone_idx on angio_callbacks (phone, created_at desc);

alter table angio_callbacks enable row level security;
-- žiadne predvolené práva (ani TRUNCATE/TRIGGER); RLS nižšie zužuje na personál
revoke all on angio_callbacks from public, anon, authenticated;
grant select, update, delete on angio_callbacks to authenticated;

drop policy if exists "spatne volania citanie personal" on angio_callbacks;
create policy "spatne volania citanie personal" on angio_callbacks
  for select to authenticated
  using (my_role() in ('superadmin', 'sestra', 'lekar') and mfa_ok());

drop policy if exists "spatne volania update personal" on angio_callbacks;
create policy "spatne volania update personal" on angio_callbacks
  for update to authenticated
  using (my_role() in ('superadmin', 'sestra') and mfa_ok())
  with check (my_role() in ('superadmin', 'sestra') and mfa_ok());

drop policy if exists "spatne volania delete superadmin" on angio_callbacks;
create policy "spatne volania delete superadmin" on angio_callbacks
  for delete to authenticated
  using (my_role() = 'superadmin' and mfa_ok());

-- personál cez API môže meniť len stav, poznámku a číslo objednávky
create or replace function angio_callbacks_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    NEW.patient_name := OLD.patient_name; NEW.phone := OLD.phone; NEW.phone_raw := OLD.phone_raw;
    NEW.pref := OLD.pref; NEW.source := OLD.source; NEW.ip := OLD.ip; NEW.created_at := OLD.created_at;
    NEW.id := OLD.id;
  end if;
  NEW.status_note := left(coalesce(NEW.status_note, ''), 500);
  NEW.order_id := left(coalesce(NEW.order_id, ''), 40);
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  return NEW;
end $$;
revoke all on function angio_callbacks_guard() from public, anon, authenticated;
drop trigger if exists angio_callbacks_guard on angio_callbacks;
create trigger angio_callbacks_guard before update on angio_callbacks
  for each row execute function angio_callbacks_guard();

-- audit zmien (audit_generic z vlny 8: generická vetva sleduje 'status', meno ani telefón nezapisuje)
do $$ begin
  if to_regprocedure('audit_generic()') is not null then
    drop trigger if exists angio_callbacks_audit_generic on angio_callbacks;
    create trigger angio_callbacks_audit_generic after insert or update or delete on angio_callbacks
      for each row execute function audit_generic();
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. RPC pre pacienta
-- ------------------------------------------------------------
create or replace function angio_request_callback(p_name text, p_phone text, p_pref text default '', p_source text default 'angio1')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name    text;
  v_number  text;
  v_pref    text := case when coalesce(p_pref, '') in ('dopoludnia', 'popoludni') then p_pref else '' end;
  v_source  text := case when coalesce(p_source, '') ~ '^[a-z0-9-]{1,40}$' then p_source else 'angio1' end;
  v_ip      text := client_ip();
  v_ipkey   text;
  v_id      text;
  v_notify  boolean := true;
  v_sms_to  text;
  v_app_id  text := app_secret('bulkgate_app_id');
  v_app_tok text := app_secret('bulkgate_app_token');
  v_key     text := app_secret('resend_api_key');
  v_from    text;
  v_to      text;
  v_to_arr  jsonb;
  v_pref_sk text;
  v_html    text;
  v_head    text;
begin
  -- meno: len písmená, medzera, bodka, pomlčka, apostrof (do SMS od „NUSCH" nesmie ísť odkaz ani číslo)
  v_name := regexp_replace(coalesce(p_name, ''), '[^[:alpha:] ''-]', ' ', 'g');
  v_name := left(btrim(regexp_replace(v_name, '\s+', ' ', 'g')), 120);
  if length(v_name) < 3 or v_name !~ '[[:alpha:]]{2,}' then
    raise exception 'Zadajte prosím meno a priezvisko.';
  end if;

  -- telefón: normalizácia na 421…; „+421 0949…" → 421949…; po normalizácii nesmie začínať nulou
  v_number := sms_number(p_phone);
  if v_number like '4210%' then v_number := '421' || substr(v_number, 5); end if;
  if v_number like '0%' or length(v_number) < 11 or length(v_number) > 15 then
    raise exception 'Zadajte platné telefónne číslo (napr. 0949 123 456).';
  end if;

  -- limity: IP (IPv6 po /64) a telefón; globálny strop neodmieta pacienta (len notifikácie nižšie)
  v_ipkey := case when v_ip like '%:%' then array_to_string((string_to_array(v_ip, ':'))[1:4], ':') else v_ip end;
  if v_ipkey <> '' then perform check_rate_limit('callback-ip:' || v_ipkey, 5); end if;
  perform check_rate_limit('callback-phone:' || v_number, 2);

  -- otvorená žiadosť s rovnakým číslom za posledných 24 h → neukladať znova,
  -- odpoveď je rovnaká ako pri novej (nikto nezistí, či cudzie číslo žiadalo o hovor)
  if exists (select 1 from angio_callbacks
             where phone = v_number and status = 'new' and created_at > now() - interval '24 hours') then
    return jsonb_build_object('ok', true);
  end if;

  v_id := 'ZV-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
  insert into angio_callbacks (id, patient_name, phone, phone_raw, pref, source, ip)
  values (v_id, v_name, v_number, left(coalesce(p_phone, ''), 40), v_pref, v_source, v_ip);

  -- strop notifikácií pre celé pracovisko (ochrana mobilu/inboxu pred zaplavením)
  begin
    perform check_rate_limit('callback-notify', 20);
  exception when others then
    v_notify := false;
  end;
  if not v_notify then
    return jsonb_build_object('ok', true);
  end if;

  v_pref_sk := case v_pref when 'dopoludnia' then 'dopoludnia' when 'popoludni' then 'popoludní' else 'kedykoľvek' end;

  -- SMS na mobil pracoviska (bez diakritiky, 1 segment)
  select value into v_sms_to from settings where key = 'angio_callback_sms_to';
  v_sms_to := sms_number(coalesce(v_sms_to, ''));
  if length(v_sms_to) between 11 and 15 and v_app_id not like 'SEM\_%' and v_app_tok not like 'SEM\_%' then
    begin
      perform net.http_post(
        url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'application_id', v_app_id, 'application_token', v_app_tok,
          'number', v_sms_to,
          'text', 'NUSCH spatne volanie: ' || left(translate(v_name, 'áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽěřůĚŘŮ', 'aacdeillnoorstuyzAACDEILLNOORSTUYZeruERU'), 40)
            || ', tel. +' || v_number || ', volat ' || translate(v_pref_sk, 'íľ', 'il') || '. Sprava: objednanie.cievny.sk/sprava',
          'unicode', false, 'sender_id', 'gText', 'sender_id_value', 'NUSCH')
      );
    exception when others then null;
    end;
  end if;

  -- e-mail personálu (kópia objednávok, inak hlavný notifikačný e-mail; viac adries oddelených čiarkou)
  select value into v_to from settings where key = 'copy_email';
  if coalesce(v_to, '') = '' then select value into v_to from settings where key = 'notify_email'; end if;
  select jsonb_agg(btrim(a)) into v_to_arr from unnest(string_to_array(coalesce(v_to, ''), ',')) a where btrim(a) <> '';
  if v_to_arr is not null and v_key not like 'SEM\_%' then
    select value into v_from from settings where key = 'mail_from';
    if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
    v_head := case when v_source = 'zachrannohu' then 'Zachráň nohu' else 'Angiologická ambulancia č. 1' end;
    v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
      || '<h2 style="color:#003d7c">Žiadosť o spätné volanie — ' || v_head || '</h2>'
      || '<p>Pacient nezvládol online objednanie a prosí o zavolanie.</p>'
      || '<table style="font-size:14px;border-collapse:collapse">'
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Meno</td><td><b>' || html_escape(v_name) || '</b></td></tr>'
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Telefón</td><td><b>+' || v_number || '</b></td></tr>'
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Kedy volať</td><td>' || v_pref_sk || '</td></tr>'
      || '<tr><td style="color:#64748b;padding:4px 12px 4px 0">Číslo žiadosti</td><td>' || v_id || '</td></tr>'
      || '</table>'
      || '<p style="font-size:13px;margin-top:14px">Pri hovore si overte, že volaný o žiadosť naozaj stojí. Stav zmeníte v Správa → Angiologická ambulancia č. 1 → Spätné volania.</p>'
      || '</div>';
    begin
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', v_to_arr,
          'subject', 'Spätné volanie ' || v_id || ' (' || v_pref_sk || ')', 'html', v_html)
      );
    exception when others then null;
    end;
  end if;

  return jsonb_build_object('ok', true);
end $$;
revoke all on function angio_request_callback(text, text, text, text) from public;
grant execute on function angio_request_callback(text, text, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. nastavenie mobilu pracoviska (prázdne = SMS sa neposiela)
-- ------------------------------------------------------------
insert into settings (key, value) select 'angio_callback_sms_to', ''
  where not exists (select 1 from settings where key = 'angio_callback_sms_to');

-- ------------------------------------------------------------
-- 4. upratovanie: IP po 7 dňoch, žiadosti po 90 dňoch
-- ------------------------------------------------------------
create or replace function purge_angio_callbacks()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update angio_callbacks set ip = '' where ip <> '' and created_at < now() - interval '7 days';
  delete from angio_callbacks
    where (status <> 'new' and updated_at < now() - interval '90 days')
       or (status = 'new' and created_at < now() - interval '90 days');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function purge_angio_callbacks() from public, anon, authenticated;
do $$ begin perform cron.unschedule('angio-callbacks-cleanup'); exception when others then null; end $$;
do $$ begin perform cron.schedule('angio-callbacks-cleanup', '41 3 * * *', $q$select purge_angio_callbacks()$q$); exception when others then null; end $$;

-- kontrola
do $$
declare v_cron boolean;
begin
  if to_regclass('public.angio_callbacks') is null then raise exception 'angio_callbacks chýba'; end if;
  if to_regprocedure('angio_request_callback(text,text,text,text)') is null then raise exception 'RPC chýba'; end if;
  if has_table_privilege('anon', 'public.angio_callbacks', 'select') then raise exception 'anon nesmie čítať angio_callbacks'; end if;
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = ''angio-callbacks-cleanup'')' into v_cron;
    if not v_cron then raise warning 'ANGIO-013: cron úloha angio-callbacks-cleanup sa nenaplánovala (pg_cron?).'; end if;
  end if;
  raise notice 'ANGIO-013 OK: spätné volania pripravené. Mobil pre SMS nastavte v Správa → Angio → Nastavenia → Spätné volania.';
end $$;
