-- ============================================================
-- KONZULTACIE-001 (25. 11. 2026) — triáž žiadostí o konzultáciu z Instagramu
--
-- Verejný formulár (objednanie.cievny.sk/konzultacia) NEDÁVA termín: človek
-- uvedie len iniciály, rok narodenia, ťažkosti (pár otázok + voľný text) a
-- kontakt na odpoveď (SMS, e-mail alebo Instagram). Lekár v správe vidí
-- žiadosti zoradené podľa návrhu zaradenia (akútne / ústav / rajónny
-- angiológ / obvodný lekár) a odpovie šablónou alebo vlastným textom.
--
--  • consult_requests — žiadosti (bez mena, bez rodného čísla, bez IP).
--  • consult_submit   — verejné odoslanie: kontrola údajov, súhlas, limity
--    proti zneužitiu (IP, kontakt, denný strop), ochrana pred robotmi.
--    Zaradenie sa do databázy neukladá — počíta ho stránka z odpovedí.
--  • consult_resolve  — lekár (superadmin, lekár): rozhodnutie + odpoveď;
--    SMS (bez diakritiky) alebo e-mail odíde zo systému, pri Instagrame
--    odpovie lekár sám.
--  • Akútne príznaky: pacient dostane pokyn hneď na obrazovke; personálu
--    príde e-mail (bez zdravotných údajov). Raz denne súhrn čakajúcich.
--  • Poriadok: vybavené žiadosti sa mažú po 30 dňoch, všetky po 90 dňoch.
--  • Príjem sa dá vypnúť v správe (consult_set_open) — formulár to oznámi.
--
-- Idempotentné. Spúšťať PO audit-vlna10-001.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('bot_guard(text)') is null or to_regprocedure('check_rate_limit(text,integer)') is null
     or to_regprocedure('sms_number(text)') is null or to_regprocedure('email_header()') is null or to_regprocedure('staff_alert(text,text,text)') is null then
    raise exception 'KONZULTACIE-001: chýbajú predchádzajúce skripty — ste v projekte „USG objednavanie"?';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. tabuľka
-- ------------------------------------------------------------
create table if not exists consult_requests (
  id           text primary key,              -- KON-XXXXXXXX
  created_at   timestamptz not null default now(),
  initials     text not null,                 -- „J. K." — nie meno
  birth_year   integer not null,
  region       text not null default '',
  topic        text not null,
  answers      jsonb not null default '{}'::jsonb,   -- odpovede na doplňujúce otázky
  flags        jsonb not null default '[]'::jsonb,   -- akútne príznaky označené pacientom
  note         text not null default '',             -- voľný popis ťažkostí
  contact_type text not null,                 -- sms | email | instagram
  contact      text not null,
  status       text not null default 'new',   -- new | done
  outcome      text not null default '',      -- rozhodnutie lekára: ustav | angiolog | obvodny | akutne | ine
  reply_text   text not null default '',
  reply_sent   boolean not null default false,
  staff_note   text not null default '',
  done_at      timestamptz,
  done_by      text not null default '',
  constraint consult_contact_type_chk check (contact_type in ('sms', 'email', 'instagram')),
  constraint consult_status_chk check (status in ('new', 'done'))
);
create index if not exists consult_requests_status_idx on consult_requests (status, created_at);

alter table consult_requests enable row level security;
revoke all on consult_requests from anon, authenticated;
grant select on consult_requests to authenticated;
drop policy if exists "konzultacie citanie" on consult_requests;
create policy "konzultacie citanie" on consult_requests for select to authenticated
  using (my_role() in ('superadmin', 'sestra', 'lekar') and mfa_ok());

drop trigger if exists consult_requests_audit_generic on consult_requests;
create trigger consult_requests_audit_generic after update or delete on consult_requests
  for each row execute function audit_generic();

-- ------------------------------------------------------------
-- 2. pomôcky
-- ------------------------------------------------------------
-- text do SMS: bez diakritiky a bez znakov mimo základnej abecedy
create or replace function sms_plain(p_text text)
returns text
language sql immutable set search_path = public as $$
  select btrim(regexp_replace(regexp_replace(
    translate(replace(replace(coalesce(p_text, ''), '…', '...'), E'\n', ' '),
      'áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽěřůĚŘŮöüÖÜ„“”‚‘’–—', 'aacdeillnoorstuyzAACDEILLNOORSTUYZeruERUouOU"""''''''--'),
    '[^\x20-\x7E]', '', 'g'), '\s+', ' ', 'g'));
$$;

-- adresy pre upozornenia o konzultáciách: settings.consult_notify_email, inak copy_email + notify_email
create or replace function consult_mail_staff(p_subject text, p_html text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_key text := app_secret('resend_api_key'); v_from text; v_to text; v_arr jsonb;
begin
  if v_key like 'SEM\_%' then return; end if;
  select nullif(btrim(value), '') into v_to from settings where key = 'consult_notify_email';
  if v_to is null then select string_agg(value, ',') into v_to from settings where key in ('copy_email', 'notify_email'); end if;
  select jsonb_agg(distinct a) into v_arr
    from (select lower(btrim(x)) as a from unnest(string_to_array(coalesce(v_to, ''), ',')) x) s
    where a <> '' and a like '%@%';
  if v_arr is null then return; end if;
  select value into v_from from settings where key = 'mail_from';
  if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', v_arr, 'subject', p_subject,
      'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
        || '<h2 style="color:#003d7c">' || html_escape(p_subject) || '</h2>' || p_html
        || '<p style="margin-top:16px"><a href="https://objednanie.cievny.sk/sprava/#/konzultacie" style="display:inline-block;background:#2B46A2;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Otvoriť konzultácie</a></p>'
        || '<p style="font-size:12px;color:#64748b;margin-top:14px">Automatická správa zo systému objednávania. Zdravotné údaje žiadosti sú len v správe, nie v tomto e-maile.</p></div>'));
exception when others then
  begin perform health_event('trigger:consult_mail_staff', false, left(sqlerrm, 300)); exception when others then null; end;
end $$;
revoke all on function consult_mail_staff(text, text) from public, anon, authenticated;

-- je príjem žiadostí zapnutý? (funkcia chýba = skript ešte nebol spustený)
create or replace function consult_ready()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value from settings where key = 'consult_form'), 'on') <> 'off';
$$;
revoke all on function consult_ready() from public;
grant execute on function consult_ready() to anon, authenticated;

-- ------------------------------------------------------------
-- 3. verejné odoslanie žiadosti
-- ------------------------------------------------------------
create or replace function consult_submit(
  p_initials text, p_birth_year integer, p_topic text, p_answers jsonb, p_flags jsonb, p_note text,
  p_contact_type text, p_contact text, p_region text default '', p_consent boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ip text := client_ip(); v_ipkey text;
  v_let text; v_initials text; v_contact text; v_type text := coalesce(p_contact_type, '');
  v_answers jsonb := coalesce(p_answers, '{}'::jsonb); v_flags jsonb := coalesce(p_flags, '[]'::jsonb);
  v_note text := btrim(coalesce(p_note, '')); v_region text := btrim(coalesce(p_region, ''));
  v_year int := extract(year from (now() at time zone 'Europe/Bratislava'))::int;
  v_id text; r record; v_n int; v_notify boolean := true;
begin
  if not consult_ready() then
    raise exception 'Príjem žiadostí je momentálne pozastavený. Skúste to, prosím, neskôr.';
  end if;
  if p_consent is not true then raise exception 'Bez súhlasu so spracovaním údajov žiadosť nemôžeme prijať.'; end if;

  -- iniciály: 1 až 4 písmená (nie celé meno)
  v_let := regexp_replace(coalesce(p_initials, ''), '[^[:alpha:]]', '', 'g');
  if length(v_let) not between 1 and 4 then raise exception 'Zadajte len iniciály (napr. J. K.), nie celé meno.'; end if;
  select string_agg(upper(ch) || '.', ' ' order by n) into v_initials from regexp_split_to_table(v_let, '') with ordinality as t(ch, n);
  if p_birth_year is null or p_birth_year not between 1900 and v_year then raise exception 'Zadajte rok narodenia (napr. 1958).'; end if;
  if coalesce(p_topic, '') !~ '^[a-z_]{2,20}$' then raise exception 'Vyberte, čo vás trápi.'; end if;
  if length(v_region) > 40 then v_region := ''; end if;
  if length(v_note) > 1500 then raise exception 'Popis je príliš dlhý (najviac 1500 znakov).'; end if;

  -- odpovede: plochý objekt krátkych hodnôt; akútne príznaky: zoznam kódov
  if jsonb_typeof(v_answers) <> 'object' or octet_length(v_answers::text) > 2000 or (select count(*) from jsonb_object_keys(v_answers)) > 15 then
    raise exception 'Odpovede sa nepodarilo spracovať. Obnovte, prosím, stránku a skúste to znova.';
  end if;
  for r in select key, value from jsonb_each(v_answers) loop
    if r.key !~ '^[a-z_0-9]{1,30}$' or jsonb_typeof(r.value) <> 'string' or (r.value #>> '{}') !~ '^[a-z0-9_]{1,20}$' then
      raise exception 'Odpovede sa nepodarilo spracovať. Obnovte, prosím, stránku a skúste to znova.';
    end if;
  end loop;
  if jsonb_typeof(v_flags) <> 'array' or jsonb_array_length(v_flags) > 8
     or exists (select 1 from jsonb_array_elements(v_flags) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^rf_[a-z]{2,20}$') then
    raise exception 'Odpovede sa nepodarilo spracovať. Obnovte, prosím, stránku a skúste to znova.';
  end if;
  if v_answers = '{}'::jsonb and length(v_note) < 10 then
    raise exception 'Opíšte, prosím, svoje ťažkosti aspoň niekoľkými slovami.';
  end if;

  -- kontakt na odpoveď
  if v_type = 'sms' then
    v_contact := sms_number(p_contact);
    if v_contact like '0%' or length(v_contact) not between 11 and 15 then raise exception 'Zadajte platné číslo mobilu (napr. 0949 123 456).'; end if;
    v_contact := '+' || v_contact;
  elsif v_type = 'email' then
    v_contact := lower(btrim(coalesce(p_contact, '')));
    if length(v_contact) > 254 or v_contact !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Zadajte platný e-mail.'; end if;
  elsif v_type = 'instagram' then
    v_contact := lower(regexp_replace(btrim(coalesce(p_contact, '')), '^(https?://)?(www\.)?instagram\.com/|^@|/+$', '', 'gi'));
    if v_contact !~ '^[a-z0-9._]{1,30}$' then raise exception 'Zadajte svoje meno na Instagrame (napr. @meno).'; end if;
  else
    raise exception 'Vyberte, kam vám máme odpovedať.';
  end if;

  -- limity proti zneužitiu: adresa (IPv6 po /64), kontakt, denný strop, roboty
  v_ipkey := case when v_ip like '%:%' then array_to_string((string_to_array(v_ip, ':'))[1:4], ':') else v_ip end;
  if v_ipkey <> '' then perform check_rate_limit('konz-ip:' || v_ipkey, 5); end if;
  perform check_rate_limit('konz-k:' || md5(v_type || v_contact), 3);
  perform bot_guard('konzultacia');
  select count(*) into v_n from consult_requests where created_at > now() - interval '24 hours';
  if v_n >= 300 then
    perform staff_alert('konz-max', 'Konzultácie: dosiahnutý denný strop žiadostí (300)',
      '<p>Za posledných 24 hodín prišlo 300 žiadostí o konzultáciu. Ďalšie sa dočasne neprijímajú — môže ísť o zneužitie formulára.</p>');
    raise exception 'Formulár je dočasne nedostupný. Skúste to, prosím, zajtra.';
  end if;
  -- rovnaký kontakt s 3 nevybavenými žiadosťami za 24 h → ďalšiu neukladať (odpoveď rovnaká ako pri prijatej)
  if (select count(*) from consult_requests where contact_type = v_type and contact = v_contact and status = 'new' and created_at > now() - interval '24 hours') >= 3 then
    return jsonb_build_object('ok', true);
  end if;

  v_id := 'KON-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
  insert into consult_requests (id, initials, birth_year, region, topic, answers, flags, note, contact_type, contact)
  values (v_id, v_initials, p_birth_year, v_region, p_topic, v_answers, v_flags, v_note, v_type, v_contact);

  -- akútne príznaky → e-mail personálu hneď (bez zdravotných údajov; strop proti zaplaveniu)
  if jsonb_array_length(v_flags) > 0 then
    begin perform check_rate_limit('konz-notify', 10); exception when others then v_notify := false; end;
    if v_notify then
      perform consult_mail_staff('Konzultácia ' || v_id || ': pacient označil akútne príznaky',
        '<p>Vo formulári z Instagramu prišla žiadosť, v ktorej pacient označil <b>akútne príznaky</b>. Na obrazovke dostal pokyn vyhľadať lekára ihneď (155 / pohotovosť). Pozrite si ju, prosím, čo najskôr.</p>');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function consult_submit(text, integer, text, jsonb, jsonb, text, text, text, text, boolean) from public;
grant execute on function consult_submit(text, integer, text, jsonb, jsonb, text, text, text, text, boolean) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. lekár: rozhodnutie a odpoveď
-- ------------------------------------------------------------
create or replace function consult_resolve(p_id text, p_outcome text, p_reply text default '', p_send boolean default false, p_staff_note text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c consult_requests%rowtype; v_reply text := btrim(coalesce(p_reply, '')); v_sent text := null; v_sms text;
  v_app_id text; v_app_tok text; v_key text; v_from text;
begin
  if my_role() not in ('superadmin', 'lekar') or not mfa_ok() then raise exception 'Odpovedať na konzultácie môže len lekár.'; end if;
  if coalesce(p_outcome, '') not in ('ustav', 'angiolog', 'obvodny', 'akutne', 'ine') then raise exception 'Vyberte rozhodnutie.'; end if;
  if length(v_reply) > 2000 or length(coalesce(p_staff_note, '')) > 1000 then raise exception 'Text je príliš dlhý.'; end if;
  select * into c from consult_requests where id = p_id for update;
  if not found then raise exception 'Žiadosť sa nenašla (mohla byť medzičasom zmazaná).'; end if;

  if p_send is true and c.contact_type in ('sms', 'email') then
    if length(v_reply) < 10 then raise exception 'Napíšte odpoveď pacientovi.'; end if;
    if c.contact_type = 'sms' then
      v_app_id := app_secret('bulkgate_app_id'); v_app_tok := app_secret('bulkgate_app_token');
      if v_app_id like 'SEM\_%' or v_app_tok like 'SEM\_%' then raise exception 'SMS brána nie je nastavená — odpoveď sa nedá odoslať.'; end if;
      v_sms := 'NUSCH: ' || sms_plain(v_reply);
      if length(v_sms) > 459 then raise exception 'SMS je príliš dlhá (% znakov, najviac 450). Skráťte ju.', length(v_sms) - 7; end if;
      perform net.http_post(
        url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('application_id', v_app_id, 'application_token', v_app_tok,
          'number', ltrim(c.contact, '+'), 'text', v_sms, 'unicode', false, 'sender_id', 'gText', 'sender_id_value', 'NUSCH'));
      v_sent := 'sms';
    else
      v_key := app_secret('resend_api_key');
      if v_key like 'SEM\_%' then raise exception 'E-mailová služba nie je nastavená — odpoveď sa nedá odoslať.'; end if;
      select value into v_from from settings where key = 'mail_from';
      if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(c.contact),
          'subject', 'Odpoveď na vašu žiadosť o konzultáciu — NÚSCH',
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">' || email_header()
            || '<h2 style="color:#003d7c">Odpoveď na vašu žiadosť o konzultáciu</h2>'
            || '<p style="font-size:15px;line-height:1.5">' || replace(html_escape(v_reply), E'\n', '<br>') || '</p>'
            || '<p style="font-size:12px;color:#64748b;margin-top:18px;border-top:1px solid #e2e8f0;padding-top:10px">Odpoveď vychádza len z údajov, ktoré ste uviedli vo formulári, a nenahrádza lekárske vyšetrenie. '
            || 'Pri náhlom zhoršení stavu volajte 155. Číslo žiadosti: ' || html_escape(c.id) || '.</p></div>'));
      v_sent := 'email';
    end if;
  end if;

  update consult_requests set status = 'done', outcome = p_outcome, reply_text = v_reply,
    reply_sent = (v_sent is not null) or (reply_sent and v_sent is null and reply_text = v_reply),
    staff_note = btrim(coalesce(p_staff_note, '')), done_at = now(), done_by = coalesce(nullif(staff_display_name(), ''), 'lekár')
  where id = c.id;
  return jsonb_build_object('ok', true, 'sent', v_sent);
end $$;
revoke all on function consult_resolve(text, text, text, boolean, text) from public, anon;
grant execute on function consult_resolve(text, text, text, boolean, text) to authenticated;

-- vrátiť žiadosť medzi nevybavené (omyl)
create or replace function consult_reopen(p_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if my_role() not in ('superadmin', 'lekar') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  update consult_requests set status = 'new', done_at = null where id = p_id and status = 'done';
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function consult_reopen(text) from public, anon;
grant execute on function consult_reopen(text) to authenticated;

-- zapnúť / pozastaviť príjem žiadostí (napr. pri veľkom nápore z Instagramu)
create or replace function consult_set_open(p_on boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if my_role() not in ('superadmin', 'lekar') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  insert into settings (key, value) values ('consult_form', case when coalesce(p_on, true) then 'on' else 'off' end)
    on conflict (key) do update set value = excluded.value;
  return coalesce(p_on, true);
end $$;
revoke all on function consult_set_open(boolean) from public, anon;
grant execute on function consult_set_open(boolean) to authenticated;

-- ------------------------------------------------------------
-- 5. denný súhrn a mazanie
-- ------------------------------------------------------------
create or replace function consult_digest()
returns int
language plpgsql security definer set search_path = public as $$
declare v_new int; v_urgent int; v_old int;
begin
  select count(*), count(*) filter (where jsonb_array_length(flags) > 0), count(*) filter (where created_at < now() - interval '3 days')
    into v_new, v_urgent, v_old from consult_requests where status = 'new';
  if v_new > 0 then
    perform consult_mail_staff('Konzultácie: ' || v_new || ' žiadostí čaká na posúdenie',
      '<p>V správe čaká <b>' || v_new || '</b> žiadostí o konzultáciu z Instagramu'
      || case when v_urgent > 0 then ', z toho <b>' || v_urgent || ' s označenými akútnymi príznakmi</b>' else '' end
      || case when v_old > 0 then '; ' || v_old || ' čaká dlhšie ako 3 dni' else '' end || '.</p>');
  end if;
  return v_new;
end $$;
revoke all on function consult_digest() from public, anon, authenticated;

create or replace function consult_purge()
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  delete from consult_requests
  where (status = 'done' and done_at < now() - interval '30 days') or created_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function consult_purge() from public, anon, authenticated;

do $$ begin perform cron.unschedule('konzultacie-suhrn'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('konzultacie-cleanup'); exception when others then null; end $$;
select cron.schedule('konzultacie-suhrn', '5 6 * * *', $$select consult_digest()$$);
select cron.schedule('konzultacie-cleanup', '40 1 * * *', $$select consult_purge()$$);

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.consult_requests'::regclass) then
    raise exception 'KONZULTACIE-001: tabuľka consult_requests nemá zapnutú ochranu riadkov.';
  end if;
  if has_table_privilege('anon', 'public.consult_requests', 'select') or has_table_privilege('authenticated', 'public.consult_requests', 'insert')
     or has_table_privilege('authenticated', 'public.consult_requests', 'update') or has_table_privilege('authenticated', 'public.consult_requests', 'delete') then
    raise exception 'KONZULTACIE-001: tabuľka consult_requests má širšie oprávnenia, než má mať.';
  end if;
  if has_function_privilege('anon', 'consult_resolve(text,text,text,boolean,text)', 'execute') or has_function_privilege('anon', 'consult_set_open(boolean)', 'execute')
     or has_function_privilege('anon', 'consult_purge()', 'execute') or has_function_privilege('anon', 'consult_mail_staff(text,text)', 'execute') then
    raise exception 'KONZULTACIE-001: funkcie personálu sú dostupné bez prihlásenia.';
  end if;
  if sms_plain('Ďakujeme — „odporúčame“ vyšetrenie…') <> 'Dakujeme - "odporucame" vysetrenie...' then
    raise exception 'KONZULTACIE-001: prevod textu do SMS nefunguje správne (%).', sms_plain('Ďakujeme — „odporúčame“ vyšetrenie…');
  end if;
  if (select count(*) from cron.job where jobname in ('konzultacie-suhrn', 'konzultacie-cleanup')) <> 2 then
    raise exception 'KONZULTACIE-001: úlohy nie sú naplánované.';
  end if;
  raise notice 'KONZULTACIE-001 OK. Príjem žiadostí: %.', case when consult_ready() then 'zapnutý' else 'pozastavený' end;
end $$;

-- výsledok (SQL editor ukáže tento riadok)
select 'KONZULTACIE-001 OK' as vysledok, case when consult_ready() then 'zapnutý' else 'pozastavený' end as prijem_ziadosti;
