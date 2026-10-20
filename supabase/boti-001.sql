-- ============================================================
-- BOTI-001 — ochrana formulárov pred botmi (v113)
--
--  1  bot_guard(scope): serverová kontrola pri žiadosti o SMS kód (USG,
--     angio) a pri „Zavolajte mi späť". Prehliadač posiela hlavičky
--       x-nusch-hp   = obsah neviditeľného poľa (človek ho nevyplní)
--       x-nusch-ms   = koľko ms bol formulár otvorený pred odoslaním
--       x-nusch-pass = jednorazový preukaz z Cloudflare Turnstile (ak je zapnutý)
--     Režim settings.bot_guard: 'log' (predvolené — len zapisuje do
--     health_events), 'on' (podozrivé požiadavky odmietne), 'off'.
--     settings.turnstile_enforce = 'on' vyžaduje platný preukaz Turnstile
--     (zapnúť až po nastavení kľúčov Cloudflare a nasadení Edge Function).
--  2  Denný strop overovacích SMS (settings.otp_daily_max, predvolene 300
--     za 24 h spolu USG + angio), nižšie 15-min stropy (60 → 30) a e-mail
--     personálu pri 80 % stropu; pri spätných volaniach e-mail pri 40
--     žiadostiach za 24 h. Upozornenie najviac raz za 12 h na typ.
--  3  human_passes: preukazy vydané Edge Function turnstile-pass po
--     overení tokenu Turnstile (platnosť 20 min, max. 6 použití).
--  4  health_events: mazanie po 90 dňoch (nález auditu UX 1).
--
-- Bez kľúčov v súbore. Idempotentné. Spúšťať PO angio-015.sql.
-- ============================================================

-- ------------------------------------------------------------
-- nastavenia (len ak ešte nie sú)
-- ------------------------------------------------------------
insert into settings (key, value) values ('bot_guard', 'log') on conflict (key) do nothing;
insert into settings (key, value) values ('turnstile_enforce', 'off') on conflict (key) do nothing;
insert into settings (key, value) values ('otp_daily_max', '300') on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 3. preukazy Turnstile
-- ------------------------------------------------------------
create table if not exists human_passes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  uses int not null default 0
);
alter table human_passes enable row level security;
revoke all on table human_passes from public, anon, authenticated;

-- ------------------------------------------------------------
-- upozornenie personálu e-mailom (Resend), najviac raz za 12 h na typ
-- ------------------------------------------------------------
create or replace function staff_alert(p_kind text, p_subject text, p_html text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_key text := app_secret('resend_api_key');
  v_from text; v_to text; v_arr jsonb;
begin
  if exists (select 1 from health_events where source = 'alert:' || p_kind and at > now() - interval '12 hours') then return; end if;
  perform health_event('alert:' || p_kind, false, left(p_subject, 400));
  if v_key like 'SEM\_%' then return; end if;
  select string_agg(value, ',') into v_to from settings where key in ('copy_email', 'notify_email');
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
      'html', '<div style="font-family:Arial,sans-serif;max-width:560px;color:#1F2A37">' || p_html
        || '<p style="font-size:12px;color:#5B6977;margin-top:14px">Automatické upozornenie systému objednávania (ochrana pred zneužitím).</p></div>'));
exception when others then
  null; -- upozornenie nesmie zablokovať pacienta
end $$;
revoke all on function staff_alert(text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 1. kontrola botov podľa hlavičiek
-- ------------------------------------------------------------
create or replace function bot_guard(p_scope text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  h json; v_mode text; v_ts text; v_hp text; v_ms int; v_pass text; v_ok int; v_why text := '';
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  if h is null then return; end if; -- SQL editor, cron
  select coalesce((select value from settings where key = 'bot_guard'), 'log') into v_mode;
  select coalesce((select value from settings where key = 'turnstile_enforce'), 'off') into v_ts;
  if v_mode = 'off' and v_ts <> 'on' then return; end if;

  v_hp := coalesce(h ->> 'x-nusch-hp', '');
  v_ms := nullif(regexp_replace(coalesce(h ->> 'x-nusch-ms', ''), '\D', '', 'g'), '')::int;
  if v_hp <> '' then v_why := 'vyplnené skryté pole'; end if;
  if v_ms is null then v_why := v_why || case when v_why = '' then '' else ', ' end || 'chýba čas formulára';
  elsif v_ms < 2500 then v_why := v_why || case when v_why = '' then '' else ', ' end || 'odoslané za ' || v_ms || ' ms'; end if;

  if v_why <> '' and v_mode in ('log', 'on') then
    perform health_event('bot-guard:' || p_scope, false, v_why);
    if v_mode = 'on' then
      raise exception 'Žiadosť sa nepodarilo overiť. Obnovte, prosím, stránku a skúste to znova.';
    end if;
  end if;

  if v_ts = 'on' then
    delete from human_passes where created_at < now() - interval '1 day';
    v_pass := coalesce(h ->> 'x-nusch-pass', '');
    update human_passes set uses = uses + 1
      where id::text = v_pass and created_at > now() - interval '20 minutes' and uses < 6;
    get diagnostics v_ok = row_count;
    if v_ok = 0 then
      perform health_event('bot-guard:' || p_scope, false, 'chýba alebo neplatný preukaz Turnstile');
      raise exception 'Overenie, že nie ste robot, vypršalo. Obnovte, prosím, stránku a skúste to znova.';
    end if;
  end if;
end $$;
revoke all on function bot_guard(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. denný strop overovacích SMS + upozornenie pri 80 %
-- ------------------------------------------------------------
create or replace function otp_daily_guard(p_scope text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_max int; v_n int;
begin
  select coalesce(nullif(regexp_replace((select value from settings where key = 'otp_daily_max'), '\D', '', 'g'), '')::int, 300) into v_max;
  select count(*) into v_n from phone_verifications where created_at > now() - interval '24 hours';
  -- odmietnutie (raise) zruší celú transakciu vrátane e-mailu, preto sa upozornenie
  -- na strop posiela pri POSLEDNEJ ešte povolenej SMS, nie pri odmietnutej
  if v_n >= v_max then
    raise exception 'Overovanie SMS je dočasne nedostupné. Skúste to prosím neskôr alebo nám nechajte číslo — zavoláme vám.';
  end if;
  if v_n + 1 >= v_max then
    perform staff_alert('otp-max', 'Objednávanie: dosiahnutý denný strop overovacích SMS (' || v_max || ')',
      '<p>Za posledných 24 hodín systém odoslal <b>' || v_max || '</b> overovacích SMS kódov, čo je denný strop. Ďalšie kódy sa dočasne neposielajú — pacienti nemôžu dokončiť online objednávku, kým neuplynie 24 hodín od prvých kódov.</p><p>Ak ide o útok, nechajte strop tak; ak o skutočný záujem, zvýšte <code>otp_daily_max</code> v nastaveniach (SQL editor).</p>');
    return;
  end if;
  if v_n + 1 >= (v_max * 8) / 10 then -- vrátane práve odosielanej SMS
    perform staff_alert('otp-80', 'Objednávanie: neobvykle veľa overovacích SMS (' || v_n || ' za 24 h)',
      '<p>Za posledných 24 hodín bolo odoslaných <b>' || v_n || '</b> overovacích SMS kódov, denný strop je ' || v_max || '. Môže ísť o zneužitie formulára (náklady na SMS). Skontrolujte správu objednávok.</p>');
  end if;
end $$;
revoke all on function otp_daily_guard(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- napojenie do send_phone_otp, angio_send_otp, angio_request_callback
-- ------------------------------------------------------------
do $$
declare r record; v_def text; v_new text;
begin
  for r in select p.oid, p.oid::regprocedure as sig, p.proname, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('send_phone_otp', 'angio_send_otp') loop
    if r.prosrc like '%bot_guard(%' then continue; end if;
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def,
      '(perform check_rate_limit\(''otp-global-(usg|angio)'', )60(\);)',
      E'\\130\\3\n  perform bot_guard(''otp-\\2'');\n  perform otp_daily_guard(''\\2'');');
    if v_new = v_def then raise exception 'BOTI-001: % — nenašiel sa globálny limit, upravte ručne.', r.sig; end if;
    execute v_new;
    raise notice 'BOTI-001: % — kontrola botov + denný strop.', r.sig;
  end loop;

  for r in select p.oid, p.oid::regprocedure as sig, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'angio_request_callback' loop
    if r.prosrc like '%bot_guard(%' then continue; end if;
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def,
      '(\n(\s*)perform check_rate_limit\(''callback-phone:'' \|\| v_number, 2\);)',
      E'\\1\n\\2perform bot_guard(''callback'');\n\\2if (select count(*) from angio_callbacks where created_at > now() - interval ''24 hours'') >= 40 then\n\\2  perform staff_alert(''callback-40'', ''Objednávanie: neobvykle veľa žiadostí o spätné zavolanie'', ''<p>Za posledných 24 hodín prišlo 40 a viac žiadostí „Zavolajte mi späť“. Môže ísť o zneužitie formulára — skontrolujte zoznam v správe (záložka Spätné volania).</p>'');\n\\2end if;');
    if v_new = v_def then raise exception 'BOTI-001: % — nenašiel sa limit na číslo, upravte ručne.', r.sig; end if;
    execute v_new;
    raise notice 'BOTI-001: % — kontrola botov + upozornenie.', r.sig;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4. health_events: mazanie po 90 dňoch (cez existujúcu nočnú úlohu)
-- ------------------------------------------------------------
create or replace function purge_health_events()
returns void
language sql security definer set search_path = public as $$
  delete from health_events where at < now() - interval '90 days';
  delete from human_passes where created_at < now() - interval '1 day';
$$;
revoke all on function purge_health_events() from public, anon, authenticated;
do $$
begin
  if to_regclass('cron.job') is null then return; end if;
  if not exists (select 1 from cron.job where jobname = 'health-events-cleanup') then
    perform cron.schedule('health-events-cleanup', '23 4 * * *', 'select purge_health_events()');
  end if;
end $$;

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
declare c int;
begin
  select count(*) into c from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('send_phone_otp', 'angio_send_otp', 'angio_request_callback') and prosrc like '%bot_guard(%';
  if c < 3 then raise exception 'BOTI-001: kontrola botov je len v % z 3 funkcií', c; end if;
  select count(*) into c from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('send_phone_otp', 'angio_send_otp') and prosrc like '%otp_daily_guard(%' and prosrc like '%, 30);%';
  if c < 2 then raise exception 'BOTI-001: denný strop / nižší limit chýba v % funkciách', 2 - c; end if;
  if has_function_privilege('anon', 'bot_guard(text)', 'execute') then raise exception 'BOTI-001: anon má EXECUTE na bot_guard'; end if;
  raise notice 'BOTI-001 OK (bot_guard = %, turnstile_enforce = %).',
    (select value from settings where key = 'bot_guard'), (select value from settings where key = 'turnstile_enforce');
end $$;
