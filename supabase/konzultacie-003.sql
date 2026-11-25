-- ============================================================
-- KONZULTACIE-003 (25. 11. 2026) — e-mail personálu pri KAŽDEJ novej žiadosti
--
-- Doteraz prišiel e-mail hneď len pri žiadosti s akútnymi príznakmi; ostatné
-- boli až v rannom súhrne. Po novom:
--  • každá nová žiadosť → e-mail „Konzultácie: nová žiadosť" (bez zdravotných
--    údajov, s počtom čakajúcich a tlačidlom do správy);
--  • aby schránku nezaplavil nápor z Instagramu, odíde najviac jeden takýto
--    e-mail za 15 minút — žiadosti, ktoré prídu medzitým, oznámi spoločný
--    e-mail hneď po uplynutí 15 minút (úloha beží každých 5 minút);
--  • žiadosť s akútnymi príznakmi má naďalej vlastný e-mail ihneď;
--  • ranný súhrn čakajúcich ostáva.
-- Adresy: správa → Konzultácie → „Upozornenia e-mailom"; prázdne = adresy
-- pracoviska ako pri ostatných upozorneniach.
--
-- Idempotentné. Spúšťať PO konzultacie-002.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('consult_finalize()') is null or to_regclass('public.consult_stats') is null then
    raise exception 'KONZULTACIE-003: najprv spustite konzultacie-002.sql (projekt „USG objednavanie").';
  end if;
end $$;

-- o ktorých žiadostiach už e-mail odišiel (žiadosti prijaté pred týmto skriptom sa už neoznamujú)
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consult_requests' and column_name = 'notified') then
    alter table consult_requests add column notified boolean not null default false;
    update consult_requests set notified = true;
  end if;
end $$;

-- e-mail o nových žiadostiach: najviac raz za 15 minút, vždy za všetky ešte neoznámené
create or replace function consult_notify_new()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_n int; v_wait int; v_urgent int;
begin
  select count(*) into v_n from consult_requests where status = 'new' and not notified;
  if v_n = 0 then return 0; end if;
  begin
    perform check_rate_limit('konz-new', 1);
  exception when others then
    return 0;   -- posledný e-mail odišiel pred menej než 15 minútami — pošle ho úloha neskôr
  end;
  select count(*), count(*) filter (where jsonb_array_length(flags) > 0) into v_wait, v_urgent from consult_requests where status = 'new';
  perform consult_mail_staff(
    case when v_n = 1 then 'Konzultácie: nová žiadosť' when v_n between 2 and 4 then 'Konzultácie: ' || v_n || ' nové žiadosti' else 'Konzultácie: ' || v_n || ' nových žiadostí' end,
    '<p>Vo formulári z Instagramu ' || case when v_n = 1 then 'prišla <b>nová žiadosť</b>' when v_n between 2 and 4 then 'prišli <b>' || v_n || ' nové žiadosti</b>' else 'prišlo <b>' || v_n || ' nových žiadostí</b>' end
    || ' o konzultáciu. V správe teraz čaká na posúdenie <b>' || v_wait || '</b>'
    || case when v_urgent > 0 then ', z toho <b>' || v_urgent || ' s označenými akútnymi príznakmi</b>' else '' end || '.</p>');
  update consult_requests set notified = true where status = 'new' and not notified;
  return v_n;
exception when others then
  begin perform health_event('trigger:consult_notify_new', false, left(sqlerrm, 300)); exception when others then null; end;
  return 0;
end $$;
revoke all on function consult_notify_new() from public, anon, authenticated;

-- verejné odoslanie žiadosti: rovnaké ako v konzultacie-001, navyše e-mail o každej novej žiadosti
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
      update consult_requests set notified = true where id = v_id;   -- o tejto žiadosti už e-mail odišiel
    end if;
  end if;
  -- každá nová žiadosť → e-mail personálu (bez zdravotných údajov; viac žiadostí naraz v jednom e-maile)
  perform consult_notify_new();
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function consult_submit(text, integer, text, jsonb, jsonb, text, text, text, text, boolean) from public;
grant execute on function consult_submit(text, integer, text, jsonb, jsonb, text, text, text, text, boolean) to anon, authenticated;

-- úloha každých 5 minút: potvrdenie odoslaných odpovedí + e-mail o žiadostiach, ktoré čakali na 15-minútový odstup
create or replace function consult_tick()
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform consult_finalize();
  perform consult_notify_new();
end $$;
revoke all on function consult_tick() from public, anon, authenticated;

do $$ begin perform cron.unschedule('konzultacie-odoslanie'); exception when others then null; end $$;
select cron.schedule('konzultacie-odoslanie', '*/5 * * * *', $$select consult_tick()$$);

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'consult_notify_new()', 'execute') or has_function_privilege('authenticated', 'consult_notify_new()', 'execute')
     or has_function_privilege('anon', 'consult_tick()', 'execute') then
    raise exception 'KONZULTACIE-003: vnútorné funkcie sú dostupné z aplikácie.';
  end if;
  if not has_function_privilege('anon', 'consult_submit(text,integer,text,jsonb,jsonb,text,text,text,text,boolean)', 'execute') then
    raise exception 'KONZULTACIE-003: verejné odoslanie žiadosti stratilo oprávnenie.';
  end if;
  if (select prosrc from pg_proc where proname = 'consult_submit') not like '%consult_notify_new()%' then
    raise exception 'KONZULTACIE-003: odoslanie žiadosti neposiela e-mail.';
  end if;
  if (select command from cron.job where jobname = 'konzultacie-odoslanie') not like '%consult_tick()%' then
    raise exception 'KONZULTACIE-003: úloha nie je naplánovaná.';
  end if;
  raise notice 'KONZULTACIE-003 OK.';
end $$;

-- výsledok (SQL editor ukáže tento riadok)
select 'KONZULTACIE-003 OK' as vysledok, 'e-mail pri každej novej žiadosti' as upozornenia,
       coalesce((select nullif(btrim(value), '') from settings where key = 'consult_notify_email'), 'adresy pracoviska') as kam;
