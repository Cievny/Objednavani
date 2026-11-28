-- ============================================================
-- DOTAZNIK-001 (28. 11. 2026) — dotazník pred vyšetrením
-- (chronická panvová bolesť) k objednávke Angiologickej ambulancie č. 1
--
-- Personál pri potvrdení objednávky RUČNE pošle pacientke odkaz na dotazník
-- (SMS + e-mail, prípadne QR kód na vytlačenie). Pacientka ho vyplní doma bez
-- prihlásenia; odkaz nesie len náhodný kľúč — formulár nezobrazuje meno ani
-- iné údaje z objednávky a odpovede sa po odoslaní už nedajú prečítať.
--
--  • angio_questionnaires — odpovede BEZ mena, telefónu a e-mailu; väzba na
--    objednávku len číslom objednávky (ANG-…). Tabuľka nemá žiadne priame
--    oprávnenia — všetko ide cez funkcie nižšie.
--  • ČÍTAŤ odpovede smie len lekár, ku ktorému je pacientka objednaná
--    (staff_roles.doctor_name = angio_orders.doctor); pri objednávke bez lekára
--    len superadmin. Sestra vidí len stav (poslaný / vyplnený), nie obsah.
--    Každé otvorenie odpovedí sa zapíše do audit_log (kto, kedy, ktorá objednávka).
--  • Vyplniť sa dá najneskôr v deň vyšetrenia a len raz.
--  • Mazanie: 7 dní po termíne (ako prílohy a dôvod návštevy v angio_purge_orders),
--    pri zrušenej objednávke alebo nedostavení sa deň po termíne; zmazanie
--    objednávky zmaže aj dotazník.
--  • Zaradenie, vyhodnotenie a text anamnézy počíta stránka správy z odpovedí
--    (src/dotaznikData.js); databáza ich neukladá.
--
-- Idempotentné. Spúšťať PO konzultacie-001.sql (používa sms_plain) a audit-vlna10-001.sql.
-- ============================================================

do $$
begin
  if to_regclass('public.angio_orders') is null or to_regprocedure('check_rate_limit(text,integer)') is null
     or to_regprocedure('sms_number(text)') is null or to_regprocedure('email_header()') is null
     or to_regprocedure('app_secret(text)') is null or to_regprocedure('mfa_ok()') is null
     or to_regprocedure('sms_plain(text)') is null or to_regprocedure('client_ip()') is null
     or to_regprocedure('staff_display_name()') is null or to_regprocedure('html_escape(text)') is null then
    raise exception 'DOTAZNIK-001: chýbajú predchádzajúce skripty (konzultacie-001, audit-vlna10-001, rucne-001) — ste v projekte „USG objednavanie"?';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. tabuľka
-- ------------------------------------------------------------
create table if not exists angio_questionnaires (
  order_id     text primary key references angio_orders(id) on delete cascade,
  kind         text not null default 'panva',
  token        text not null unique,          -- náhodný kľúč v odkaze (32 hex znakov)
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  sent_by      text not null default '',
  sent_via     text not null default '',      -- „sms, e-mail" | „" (len odkaz / QR)
  submitted_at timestamptz,
  answers      jsonb,
  constraint angio_q_kind_chk check (kind in ('panva')),
  constraint angio_q_token_chk check (token ~ '^[0-9a-f]{32}$')
);

alter table angio_questionnaires enable row level security;
revoke all on angio_questionnaires from public, anon, authenticated;
-- zámerne žiadne politiky: priamy select/insert/update/delete nemá nikto okrem
-- vlastníka databázy; pacient aj personál pristupujú len cez funkcie nižšie.

-- ------------------------------------------------------------
-- 2. oprávnenia (pomocné)
-- ------------------------------------------------------------
-- smie personál s dotazníkom k objednávke pracovať (poslať, vidieť stav)?
create or replace function angio_q_can_manage(p_doctor text)
returns boolean
language sql stable security definer set search_path = public as $$
  select mfa_ok() and (my_role() in ('superadmin', 'sestra')
    or (my_role() = 'lekar' and coalesce(p_doctor, '') <> '' and p_doctor = my_doctor()));
$$;
revoke all on function angio_q_can_manage(text) from public, anon, authenticated;

-- smie čítať odpovede? len vyšetrujúci lekár (pri objednávke bez lekára superadmin)
create or replace function angio_q_can_read(p_doctor text)
returns boolean
language sql stable security definer set search_path = public as $$
  select mfa_ok() and (
    (coalesce(p_doctor, '') <> '' and my_role() in ('superadmin', 'lekar') and p_doctor = my_doctor())
    or (coalesce(p_doctor, '') = '' and my_role() = 'superadmin'));
$$;
revoke all on function angio_q_can_read(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. personál: stav a odoslanie
-- ------------------------------------------------------------
create or replace function angio_q_status(p_order_id text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o angio_orders%rowtype; q angio_questionnaires%rowtype;
begin
  select * into o from angio_orders where id = p_order_id;
  if not found then raise exception 'Objednávka sa nenašla.'; end if;
  if not angio_q_can_manage(o.doctor) and not angio_q_can_read(o.doctor) then raise exception 'Nedostatočné oprávnenie.'; end if;
  select * into q from angio_questionnaires where order_id = o.id;
  if not found then
    return jsonb_build_object('exists', false, 'can_read', angio_q_can_read(o.doctor), 'can_send', angio_q_can_manage(o.doctor));
  end if;
  return jsonb_build_object('exists', true, 'kind', q.kind,
    'sent_at', q.sent_at, 'sent_by', q.sent_by, 'sent_via', q.sent_via, 'submitted_at', q.submitted_at,
    -- kľúč len kým nie je vyplnené (na opätovné zobrazenie QR / odkazu); potom už netreba
    'token', case when q.submitted_at is null then q.token else null end,
    'can_read', angio_q_can_read(o.doctor), 'can_send', angio_q_can_manage(o.doctor));
end $$;
revoke all on function angio_q_status(text) from public, anon;
grant execute on function angio_q_status(text) to authenticated;

-- vytvorí (alebo znovu použije) odkaz a voliteľne ho pošle SMS a e-mailom.
-- p_base: adresa pacientskej stránky — len ostrá alebo beta (iné sa ignorujú).
create or replace function angio_q_send(p_order_id text, p_base text default '', p_send boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o angio_orders%rowtype; q angio_questionnaires%rowtype;
  v_base text := case when coalesce(p_base, '') ~ '^https://objednanie\.cievny\.sk/(beta/)?$' then p_base else 'https://objednanie.cievny.sk/' end;
  v_link text; v_via text[] := '{}'; v_skip text := '';
  v_app_id text; v_app_tok text; v_key text; v_from text; v_number text; v_sms text; v_termin text;
begin
  select * into o from angio_orders where id = p_order_id for update;
  if not found then raise exception 'Objednávka sa nenašla.'; end if;
  if not angio_q_can_manage(o.doctor) then raise exception 'Dotazník môže poslať sestra, správca alebo lekár, ku ktorému je pacient objednaný.'; end if;
  if o.status not in ('new', 'confirmed') then raise exception 'Dotazník sa posiela len k aktívnej objednávke.'; end if;
  if o.slot_date < (now() at time zone 'Europe/Bratislava')::date then raise exception 'Termín už prebehol.'; end if;
  perform check_rate_limit('dotaznik-send:' || o.id, 6);

  select * into q from angio_questionnaires where order_id = o.id for update;
  if found and q.submitted_at is not null then raise exception 'Pacientka dotazník už vyplnila.'; end if;
  if not found then
    insert into angio_questionnaires (order_id, token) values (o.id, replace(gen_random_uuid()::text, '-', ''))
    returning * into q;
  end if;
  v_link := v_base || '#/angio1/dotaznik/' || q.token;
  v_termin := to_char(o.slot_date, 'DD.MM.YYYY');

  if p_send is true then
    if o.notify_patient is false then
      v_skip := 'Pacient má vypnuté správy (SMS a e-maily) — odkaz sa neposlal. Použite QR kód alebo odkaz.';
    else
      -- SMS
      v_app_id := app_secret('bulkgate_app_id'); v_app_tok := app_secret('bulkgate_app_token');
      v_number := sms_number(o.phone);
      if v_app_id not like 'SEM\_%' and v_app_tok not like 'SEM\_%' and length(v_number) >= 11 then
        v_sms := 'NUSCH: Pred vysetrenim v angiologickej amb. c. 1 (' || v_termin || ') prosime vyplnte dotaznik (cca 10 min): ' || v_link;
        perform net.http_post(
          url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('application_id', v_app_id, 'application_token', v_app_tok,
            'number', v_number, 'text', sms_plain(v_sms), 'unicode', false, 'sender_id', 'gText', 'sender_id_value', 'NUSCH'));
        v_via := v_via || 'SMS'::text;
      end if;
      -- e-mail
      v_key := app_secret('resend_api_key');
      if v_key not like 'SEM\_%' and coalesce(o.email, '') like '%@%' then
        select value into v_from from settings where key = 'mail_from';
        if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
        perform net.http_post(
          url := 'https://api.resend.com/emails',
          headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
          body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(o.email),
            'subject', 'Dotazník pred vyšetrením ' || v_termin || ' — Angiologická ambulancia č. 1',
            'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">' || email_header()
              || '<h2 style="color:#003d7c">Dotazník pred vyšetrením</h2>'
              || '<p style="font-size:15px;line-height:1.5">Dobrý deň, pred vaším vyšetrením v Angiologickej ambulancii č. 1 dňa <b>' || v_termin || '</b> vás prosíme o vyplnenie dotazníka. '
              || 'Trvá približne 10 minút a lekárovi pomôže pripraviť sa na vyšetrenie.</p>'
              || '<p style="margin:18px 0"><a href="' || html_escape(v_link) || '" style="display:inline-block;background:#0057B8;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">Vyplniť dotazník</a></p>'
              || '<p style="font-size:13px;color:#475569;line-height:1.5">Dotazník sa nepýta na meno ani rodné číslo. Odpovede uvidí len lekár, ktorý vás vyšetrí. '
              || 'Vyplniť ho môžete najneskôr v deň vyšetrenia a len raz. Ak sa vám ho nepodarí vyplniť, nič sa nedeje — prejdeme ho spolu pri vyšetrení.</p>'
              || '<p style="font-size:12px;color:#64748b;margin-top:18px;border-top:1px solid #e2e8f0;padding-top:10px">Číslo objednávky: ' || html_escape(o.id)
              || '. Pri náhlom zhoršení stavu volajte 155.</p></div>'));
        v_via := v_via || 'e-mail'::text;
      end if;
      if cardinality(v_via) = 0 then v_skip := 'SMS ani e-mail sa nedali poslať (chýba kontakt alebo nie je nastavená brána). Použite QR kód alebo odkaz.'; end if;
    end if;
  end if;

  update angio_questionnaires set
    sent_at = case when cardinality(v_via) > 0 then now() else sent_at end,
    sent_by = case when cardinality(v_via) > 0 then coalesce(nullif(staff_display_name(), ''), my_role()) else sent_by end,
    sent_via = case when cardinality(v_via) > 0 then array_to_string(v_via, ', ') else sent_via end
  where order_id = o.id returning * into q;

  return jsonb_build_object('ok', true, 'token', q.token, 'link', v_link,
    'sent_via', array_to_string(v_via, ', '), 'warning', v_skip, 'sent_at', q.sent_at);
end $$;
revoke all on function angio_q_send(text, text, boolean) from public, anon;
grant execute on function angio_q_send(text, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 4. lekár: odpovede (každé čítanie sa zapíše do audit_log)
-- ------------------------------------------------------------
create or replace function angio_q_get(p_order_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o angio_orders%rowtype; q angio_questionnaires%rowtype;
begin
  select * into o from angio_orders where id = p_order_id;
  if not found then raise exception 'Objednávka sa nenašla.'; end if;
  if not angio_q_can_read(o.doctor) then raise exception 'Odpovede z dotazníka vidí len lekár, ku ktorému je pacientka objednaná.'; end if;
  select * into q from angio_questionnaires where order_id = o.id;
  if not found or q.submitted_at is null then raise exception 'Dotazník zatiaľ nie je vyplnený.'; end if;
  insert into audit_log (user_id, order_id, action, detail)
  values (auth.uid(), o.id, 'angio_questionnaires:read', 'otvorené odpovede z dotazníka');
  return jsonb_build_object('order_id', o.id, 'kind', q.kind, 'submitted_at', q.submitted_at, 'answers', q.answers,
    'birth_year', extract(year from o.birth_date)::int, 'slot_date', o.slot_date);
end $$;
revoke all on function angio_q_get(text) from public, anon;
grant execute on function angio_q_get(text) to authenticated;

-- ------------------------------------------------------------
-- 5. pacientka: otvorenie a odoslanie (bez prihlásenia, len s kľúčom)
-- ------------------------------------------------------------
create or replace function angio_q_open(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare q angio_questionnaires%rowtype; o angio_orders%rowtype; v_ip text := client_ip();
begin
  if v_ip <> '' then perform check_rate_limit('dotaznik-ip:' || v_ip, 40); end if;
  if coalesce(p_token, '') !~ '^[0-9a-f]{32}$' then return jsonb_build_object('state', 'invalid'); end if;
  select * into q from angio_questionnaires where token = p_token;
  if not found then return jsonb_build_object('state', 'invalid'); end if;
  select * into o from angio_orders where id = q.order_id;
  if q.submitted_at is not null then return jsonb_build_object('state', 'submitted'); end if;
  if o.status not in ('new', 'confirmed') or o.slot_date < (now() at time zone 'Europe/Bratislava')::date then
    return jsonb_build_object('state', 'expired');
  end if;
  -- len dátum vyšetrenia (nech pacientka vie, že ide o jej termín) — žiadne meno ani kontakt
  return jsonb_build_object('state', 'open', 'kind', q.kind, 'slot_date', o.slot_date);
end $$;
revoke all on function angio_q_open(text) from public;
grant execute on function angio_q_open(text) to anon, authenticated;

-- kontrola tvaru odpovedí: plochý objekt s krátkymi kľúčmi; hodnoty číslo, text
-- (≤ 1500 znakov), zoznam čísel alebo malý objekt (škály, tabuľka liečby)
create or replace function angio_q_answers_ok(p jsonb)
returns boolean
language plpgsql immutable set search_path = public as $$
declare r record; s record; t text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 20000 then return false; end if;
  if (select count(*) from jsonb_object_keys(p)) > 120 then return false; end if;
  for r in select key, value from jsonb_each(p) loop
    if r.key !~ '^[a-z][a-z0-9]{0,9}$' then return false; end if;
    t := jsonb_typeof(r.value);
    if t = 'string' then
      if length(r.value #>> '{}') > 1500 then return false; end if;
    elsif t = 'array' then
      if jsonb_array_length(r.value) > 20 or exists (select 1 from jsonb_array_elements(r.value) e where jsonb_typeof(e) <> 'number') then return false; end if;
    elsif t = 'object' then
      for s in select key, value from jsonb_each(r.value) loop
        if s.key !~ '^[0-9]{1,2}$' then return false; end if;
        if jsonb_typeof(s.value) not in ('number', 'object') then return false; end if;
        if jsonb_typeof(s.value) = 'object' and octet_length(s.value::text) > 1000 then return false; end if;
      end loop;
    elsif t not in ('number', 'boolean', 'null') then
      return false;
    end if;
  end loop;
  return true;
end $$;
revoke all on function angio_q_answers_ok(jsonb) from public, anon, authenticated;

create or replace function angio_q_submit(p_token text, p_answers jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare q angio_questionnaires%rowtype; o angio_orders%rowtype; v_ip text := client_ip();
begin
  if v_ip <> '' then perform check_rate_limit('dotaznik-ip:' || v_ip, 40); end if;
  if coalesce(p_token, '') !~ '^[0-9a-f]{32}$' then raise exception 'Odkaz na dotazník je neplatný.'; end if;
  select * into q from angio_questionnaires where token = p_token for update;
  if not found then raise exception 'Odkaz na dotazník je neplatný.'; end if;
  if q.submitted_at is not null then raise exception 'Dotazník už bol odoslaný. Ďakujeme.'; end if;
  select * into o from angio_orders where id = q.order_id;
  if o.status not in ('new', 'confirmed') or o.slot_date < (now() at time zone 'Europe/Bratislava')::date then
    raise exception 'Dotazník sa už nedá vyplniť (termín prebehol alebo bol zrušený). Prejdeme ho spolu pri vyšetrení.';
  end if;
  if not angio_q_answers_ok(p_answers) then
    raise exception 'Odpovede sa nepodarilo spracovať. Obnovte, prosím, stránku a skúste to znova.';
  end if;
  update angio_questionnaires set answers = p_answers, submitted_at = now() where order_id = q.order_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function angio_q_submit(text, jsonb) from public;
grant execute on function angio_q_submit(text, jsonb) to anon, authenticated;

-- ------------------------------------------------------------
-- 6. mazanie
-- ------------------------------------------------------------
create or replace function angio_q_purge()
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  delete from angio_questionnaires q using angio_orders o
  where o.id = q.order_id and (
    o.slot_date <= current_date - 7
    or (o.slot_date < current_date and o.status in ('new', 'rejected', 'noshow'))
    or (o.status = 'rejected' and q.submitted_at is null)
  );
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function angio_q_purge() from public, anon, authenticated;

do $$ begin perform cron.unschedule('dotaznik-cleanup'); exception when others then null; end $$;
select cron.schedule('dotaznik-cleanup', '50 1 * * *', $$select angio_q_purge()$$);

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.angio_questionnaires'::regclass) then
    raise exception 'DOTAZNIK-001: tabuľka angio_questionnaires nemá zapnutú ochranu riadkov.';
  end if;
  if has_table_privilege('anon', 'public.angio_questionnaires', 'select') or has_table_privilege('authenticated', 'public.angio_questionnaires', 'select')
     or has_table_privilege('authenticated', 'public.angio_questionnaires', 'insert') or has_table_privilege('authenticated', 'public.angio_questionnaires', 'update')
     or has_table_privilege('authenticated', 'public.angio_questionnaires', 'delete') then
    raise exception 'DOTAZNIK-001: tabuľka angio_questionnaires má priame oprávnenia — nemá mať žiadne.';
  end if;
  if has_function_privilege('anon', 'angio_q_get(text)', 'execute') or has_function_privilege('anon', 'angio_q_send(text,text,boolean)', 'execute')
     or has_function_privilege('anon', 'angio_q_status(text)', 'execute') or has_function_privilege('anon', 'angio_q_purge()', 'execute') then
    raise exception 'DOTAZNIK-001: funkcie personálu sú dostupné bez prihlásenia.';
  end if;
  if not angio_q_answers_ok('{"q1":3,"q2":[0,4],"q3":{"0":5,"2":7},"q30":{"1":{"t":true,"d":"ibuprofen","e":1}},"q24":"LSK 2019"}'::jsonb)
     or angio_q_answers_ok('{"Q1":"x"}'::jsonb) or angio_q_answers_ok('[1,2]'::jsonb) then
    raise exception 'DOTAZNIK-001: kontrola tvaru odpovedí nefunguje správne.';
  end if;
  if (select count(*) from cron.job where jobname = 'dotaznik-cleanup') <> 1 then
    raise exception 'DOTAZNIK-001: úloha mazania nie je naplánovaná.';
  end if;
  raise notice 'DOTAZNIK-001 OK.';
end $$;

select 'DOTAZNIK-001 OK' as vysledok;
