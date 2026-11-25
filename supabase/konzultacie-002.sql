-- ============================================================
-- KONZULTACIE-002 (25. 11. 2026) — po vybavení sa žiadosť IHNEĎ a natrvalo maže
--
-- Požiadavka (GDPR): hneď po vybavení konzultácie nesmú v systéme ostať
-- žiadne citlivé údaje.
--
--  • Vybavenie bez odoslania zo systému (Instagram, „vybaviť bez odoslania"):
--    riadok žiadosti sa zmaže v tej istej chvíli.
--  • Vybavenie s odpoveďou cez SMS / e-mail: zdravotné údaje (odpovede,
--    príznaky, popis, iniciály, rok narodenia, kraj) sa zmažú v tej istej
--    chvíli. Kontakt a text odpovede ostávajú len dovtedy, kým brána
--    nepotvrdí prijatie správy (spravidla sekundy, kontrola každých 5 minút)
--    — potom sa zmaže celý riadok. Keby brána správu odmietla, odpoveď by sa
--    inak stratila: žiadosť sa vráti lekárovi ako „neodoslaná" (len kontakt
--    a text odpovede), aby ju poslal znova alebo zavrel; najdlhšie 7 dní.
--  • Ostáva len anonymný počet (deň, téma, rozhodnutie, spôsob odpovede)
--    v tabuľke consult_stats — bez iniciál, roku, kontaktu, textu.
--  • Žiadosť sa už nedá „vrátiť medzi nevybavené" (nie je čo vrátiť);
--    interná poznámka zaniká. Text odpovede sa po odoslaní neuchováva.
--  • Nevybavené žiadosti sa mažú najneskôr po 90 dňoch (bez zmeny).
--
-- Idempotentné. Spúšťať PO konzultacie-001.sql.
-- ============================================================

do $$
begin
  if to_regclass('public.consult_requests') is null
     or to_regprocedure('consult_submit(text,integer,text,jsonb,jsonb,text,text,text,text,boolean)') is null
     or to_regprocedure('consult_mail_staff(text,text)') is null or to_regprocedure('sms_plain(text)') is null then
    raise exception 'KONZULTACIE-002: najprv spustite konzultacie-001.sql (projekt „USG objednavanie").';
  end if;
  if to_regclass('net._http_response') is null then
    raise exception 'KONZULTACIE-002: chýba rozšírenie pg_net (tabuľka odpovedí brán).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. anonymná štatistika vybavených žiadostí
-- ------------------------------------------------------------
create table if not exists consult_stats (
  id         bigint generated always as identity primary key,
  done_on    date not null default ((now() at time zone 'Europe/Bratislava')::date),
  topic      text not null default '',
  outcome    text not null default '',      -- ustav | angiolog | obvodny | akutne | ine
  channel    text not null default '',      -- sms | email | instagram
  reply_sent boolean not null default false, -- odpoveď odišla zo systému
  wait_days  integer not null default 0     -- koľko dní žiadosť čakala
);
create index if not exists consult_stats_done_idx on consult_stats (done_on);
alter table consult_stats enable row level security;
revoke all on consult_stats from public, anon, authenticated;
grant select on consult_stats to authenticated;
drop policy if exists "konzultacie statistika citanie" on consult_stats;
create policy "konzultacie statistika citanie" on consult_stats for select to authenticated
  using (my_role() in ('superadmin', 'sestra', 'lekar') and mfa_ok());

-- ------------------------------------------------------------
-- 2. tabuľka žiadostí: len nevybavené (+ krátko „odosiela sa" / „neodoslané")
-- ------------------------------------------------------------
alter table consult_requests add column if not exists send_req bigint;                      -- číslo požiadavky na bránu (pg_net)
alter table consult_requests add column if not exists sent_at timestamptz;
alter table consult_requests add column if not exists send_error text not null default '';

-- žiadosti vybavené ešte podľa konzultacie-001 → anonymný počet, riadok zmazať
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consult_requests' and column_name = 'done_at') then
    execute $q$
      insert into consult_stats (done_on, topic, outcome, channel, reply_sent, wait_days)
      select (coalesce(done_at, now()) at time zone 'Europe/Bratislava')::date, topic, outcome, contact_type, reply_sent,
             greatest(0, extract(day from coalesce(done_at, now()) - created_at)::int)
      from consult_requests where status = 'done'
    $q$;
    execute $q$ delete from consult_requests where status = 'done' $q$;
  end if;
end $$;

alter table consult_requests drop constraint if exists consult_status_chk;
alter table consult_requests add constraint consult_status_chk check (status in ('new', 'sending', 'failed'));
alter table consult_requests drop column if exists reply_sent;
alter table consult_requests drop column if exists staff_note;
alter table consult_requests drop column if exists done_at;
alter table consult_requests drop column if exists done_by;

-- ------------------------------------------------------------
-- 3. lekár: rozhodnutie a odpoveď → mazanie
-- ------------------------------------------------------------
drop function if exists consult_resolve(text, text, text, boolean, text);
drop function if exists consult_reopen(text);

create or replace function consult_resolve(p_id text, p_outcome text, p_reply text default '', p_send boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c consult_requests%rowtype; v_reply text := btrim(coalesce(p_reply, '')); v_sms text; v_req bigint;
  v_app_id text; v_app_tok text; v_key text; v_from text;
begin
  if my_role() not in ('superadmin', 'lekar') or not mfa_ok() then raise exception 'Odpovedať na konzultácie môže len lekár.'; end if;
  if coalesce(p_outcome, '') not in ('ustav', 'angiolog', 'obvodny', 'akutne', 'ine') then raise exception 'Vyberte rozhodnutie.'; end if;
  if length(v_reply) > 2000 then raise exception 'Text je príliš dlhý.'; end if;
  select * into c from consult_requests where id = p_id for update;
  if not found then raise exception 'Žiadosť sa nenašla (už bola vybavená a zmazaná).'; end if;
  if c.status = 'sending' then raise exception 'Odpoveď na túto žiadosť sa práve odosiela.'; end if;

  if p_send is true and c.contact_type in ('sms', 'email') then
    if length(v_reply) < 10 then raise exception 'Napíšte odpoveď pacientovi.'; end if;
    if c.contact_type = 'sms' then
      v_app_id := app_secret('bulkgate_app_id'); v_app_tok := app_secret('bulkgate_app_token');
      if v_app_id like 'SEM\_%' or v_app_tok like 'SEM\_%' then raise exception 'SMS brána nie je nastavená — odpoveď sa nedá odoslať.'; end if;
      v_sms := 'NUSCH: ' || sms_plain(v_reply);
      if length(v_sms) > 459 then raise exception 'SMS je príliš dlhá (% znakov, najviac 450). Skráťte ju.', length(v_sms) - 7; end if;
      select net.http_post(
        url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('application_id', v_app_id, 'application_token', v_app_tok,
          'number', ltrim(c.contact, '+'), 'text', v_sms, 'unicode', false, 'sender_id', 'gText', 'sender_id_value', 'NUSCH')) into v_req;
    else
      v_key := app_secret('resend_api_key');
      if v_key like 'SEM\_%' then raise exception 'E-mailová služba nie je nastavená — odpoveď sa nedá odoslať.'; end if;
      select value into v_from from settings where key = 'mail_from';
      if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
      select net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(c.contact),
          'subject', 'Odpoveď na vašu žiadosť o konzultáciu — NÚSCH',
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">' || email_header()
            || '<h2 style="color:#003d7c">Odpoveď na vašu žiadosť o konzultáciu</h2>'
            || '<p style="font-size:15px;line-height:1.5">' || replace(html_escape(v_reply), E'\n', '<br>') || '</p>'
            || '<p style="font-size:12px;color:#64748b;margin-top:18px;border-top:1px solid #e2e8f0;padding-top:10px">Odpoveď vychádza len z údajov, ktoré ste uviedli vo formulári, a nenahrádza lekárske vyšetrenie. '
            || 'Pri náhlom zhoršení stavu volajte 155. Údaje z vášho dotazníka po odoslaní tejto odpovede mažeme.</p></div>')) into v_req;
    end if;
    -- zdravotné údaje preč hneď; kontakt a text odpovede len do potvrdenia brány (consult_finalize)
    update consult_requests set status = 'sending', outcome = p_outcome, reply_text = v_reply, send_req = v_req, sent_at = now(), send_error = '',
      initials = '', birth_year = 0, region = '', answers = '{}'::jsonb, flags = '[]'::jsonb, note = ''
    where id = c.id;
    return jsonb_build_object('ok', true, 'sent', c.contact_type);
  end if;

  -- bez odoslania zo systému (Instagram, alebo lekár odpovedal inak): zmazať hneď
  insert into consult_stats (topic, outcome, channel, reply_sent, wait_days)
  values (c.topic, p_outcome, c.contact_type, false, greatest(0, extract(day from now() - c.created_at)::int));
  delete from consult_requests where id = c.id;
  return jsonb_build_object('ok', true, 'sent', null);
end $$;
revoke all on function consult_resolve(text, text, text, boolean) from public, anon;
grant execute on function consult_resolve(text, text, text, boolean) to authenticated;

-- potvrdenie odoslania: brána správu prijala → zmazať riadok; odmietla → vrátiť lekárovi ako „neodoslané"
create or replace function consult_finalize()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  c record; v_code int; v_timeout boolean; v_has boolean; v_done int := 0; v_fail int := 0;
begin
  if auth.uid() is not null and (my_role() not in ('superadmin', 'sestra', 'lekar') or not mfa_ok()) then
    raise exception 'Nedostatočné oprávnenie.';
  end if;
  for c in select * from consult_requests where status = 'sending' order by sent_at for update skip locked loop
    select status_code, coalesce(timed_out, false) into v_code, v_timeout from net._http_response where id = c.send_req;
    v_has := found;
    if v_has and v_code between 200 and 299 and not v_timeout then
      insert into consult_stats (topic, outcome, channel, reply_sent, wait_days)
      values (c.topic, c.outcome, c.contact_type, true, greatest(0, extract(day from coalesce(c.sent_at, now()) - c.created_at)::int));
      delete from consult_requests where id = c.id;
      v_done := v_done + 1;
    elsif v_has or c.sent_at < now() - interval '15 minutes' then
      update consult_requests set status = 'failed',
        send_error = case when not v_has then 'brána odoslanie nepotvrdila' when v_timeout then 'brána neodpovedala včas' else 'brána správu odmietla (kód ' || coalesce(v_code::text, '?') || ')' end
      where id = c.id;
      v_fail := v_fail + 1;
    end if;
  end loop;
  if v_fail > 0 then
    perform consult_mail_staff('Konzultácie: odpoveď pacientovi sa nepodarilo odoslať',
      '<p>Pri <b>' || v_fail || '</b> ' || case when v_fail = 1 then 'konzultácii' else 'konzultáciách' end
      || ' brána odpoveď (SMS alebo e-mail) neprijala. Žiadosť je v správe označená ako <b>neodoslaná</b> — pošlite odpoveď znova, alebo ju zavrite.</p>');
  end if;
  return v_done;
end $$;
revoke all on function consult_finalize() from public, anon;
grant execute on function consult_finalize() to authenticated;

-- ------------------------------------------------------------
-- 4. denný súhrn a mazanie
-- ------------------------------------------------------------
create or replace function consult_digest()
returns int
language plpgsql security definer set search_path = public as $$
declare v_new int; v_urgent int; v_old int; v_failed int;
begin
  select count(*) filter (where status = 'new'), count(*) filter (where status = 'new' and jsonb_array_length(flags) > 0),
         count(*) filter (where status = 'new' and created_at < now() - interval '3 days'), count(*) filter (where status = 'failed')
    into v_new, v_urgent, v_old, v_failed from consult_requests;
  if v_new > 0 or v_failed > 0 then
    perform consult_mail_staff('Konzultácie: ' || v_new || ' žiadostí čaká na posúdenie',
      '<p>V správe čaká <b>' || v_new || '</b> žiadostí o konzultáciu z Instagramu'
      || case when v_urgent > 0 then ', z toho <b>' || v_urgent || ' s označenými akútnymi príznakmi</b>' else '' end
      || case when v_old > 0 then '; ' || v_old || ' čaká dlhšie ako 3 dni' else '' end || '.'
      || case when v_failed > 0 then ' Pri <b>' || v_failed || '</b> sa odpoveď nepodarilo odoslať.' else '' end || '</p>');
  end if;
  return v_new;
end $$;
revoke all on function consult_digest() from public, anon, authenticated;

create or replace function consult_purge()
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform consult_finalize();
  delete from consult_requests
  where created_at < now() - interval '90 days'                           -- nevybavené: najdlhšie 90 dní
     or (status = 'failed' and sent_at < now() - interval '7 days');     -- neodoslané odpovede: najdlhšie 7 dní
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function consult_purge() from public, anon, authenticated;

do $$ begin perform cron.unschedule('konzultacie-odoslanie'); exception when others then null; end $$;
select cron.schedule('konzultacie-odoslanie', '*/5 * * * *', $$select consult_finalize()$$);

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consult_requests'
             and column_name in ('reply_sent', 'staff_note', 'done_at', 'done_by')) then
    raise exception 'KONZULTACIE-002: staré stĺpce vybavených žiadostí ostali.';
  end if;
  if exists (select 1 from consult_requests where status not in ('new', 'sending', 'failed')) then
    raise exception 'KONZULTACIE-002: v tabuľke ostali vybavené žiadosti.';
  end if;
  if to_regprocedure('consult_reopen(text)') is not null or to_regprocedure('consult_resolve(text,text,text,boolean,text)') is not null then
    raise exception 'KONZULTACIE-002: staré funkcie ostali.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.consult_stats'::regclass)
     or has_table_privilege('anon', 'public.consult_stats', 'select') or has_table_privilege('authenticated', 'public.consult_stats', 'insert') then
    raise exception 'KONZULTACIE-002: tabuľka consult_stats má širšie oprávnenia, než má mať.';
  end if;
  if has_function_privilege('anon', 'consult_resolve(text,text,text,boolean)', 'execute') or has_function_privilege('anon', 'consult_finalize()', 'execute') then
    raise exception 'KONZULTACIE-002: funkcie personálu sú dostupné bez prihlásenia.';
  end if;
  if (select count(*) from cron.job where jobname in ('konzultacie-suhrn', 'konzultacie-cleanup', 'konzultacie-odoslanie')) <> 3 then
    raise exception 'KONZULTACIE-002: úlohy nie sú naplánované.';
  end if;
  raise notice 'KONZULTACIE-002 OK.';
end $$;

-- výsledok (SQL editor ukáže tento riadok)
select 'KONZULTACIE-002 OK' as vysledok, 'po vybavení sa žiadosť ihneď maže' as mazanie,
       (select count(*) from consult_requests) as nevybavene_ziadosti, (select count(*) from consult_stats) as anonymne_pocty;
