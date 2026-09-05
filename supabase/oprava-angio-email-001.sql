-- ============================================================
-- OPRAVA ANGIO E-MAIL 001 — angio e-maily neodchádzajú
--
-- Príčina: angio-001 prevzal Resend kľúč z ct_notify_trigger. Ak CT
-- e-maily nikdy neboli nastavené (v ct_notify_trigger ostal placeholder
-- SEM_VLOZTE_RESEND_KLUC), angio si prevzal placeholder a e-maily sa
-- potichu vypli. Reálny kľúč je v USG funkcii notify_order_emails.
--
-- Tento skript nájde reálny Resend kľúč v ľubovoľnej existujúcej funkcii
-- (prednostne notify_order_emails) a dosadí ho do angio_notify_trigger
-- a send_angio_reminders. To isté urobí pre BulkGate kľúče (SMS + OTP)
-- z notify_order_sms, ak by angio SMS funkcie mali placeholder.
-- Telá funkcií sa nemenia, mení sa len hodnota kľúča.
-- Na konci vypíše diagnostiku (posledný výsledok v SQL editore).
-- Idempotentné, bez ručného vkladania kľúčov.
-- ============================================================

do $mig$
declare
  r        record;
  v_key    text;
  v_src    text := '';
  v_id     text;
  v_tok    text;
  v_body   text;
  v_ret    text;
  fn       text;
begin
  -- 1. Resend kľúč: prednostne notify_order_emails, inak ktorákoľvek funkcia s reálnym kľúčom
  for r in
    select proname, substring(prosrc from 'v_key\s+text\s*:=\s*''([^'']*)''') as k
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and prosrc ~ 'v_key\s+text\s*:=\s*'''
    order by case proname when 'notify_order_emails' then 0 when 'notify_order_email' then 1 when 'ct_notify_trigger' then 2 else 3 end
  loop
    if r.k is not null and r.k not like 'SEM\_%' and length(r.k) > 10 then
      v_key := r.k; v_src := r.proname; exit;
    end if;
  end loop;

  if v_key is null then
    raise notice 'Resend kľúč sa nenašiel v žiadnej funkcii — e-maily nefungujú ani pre USG. Vložte kľúč do notify_order_emails a spustite skript znova.';
  else
    foreach fn in array array['angio_notify_trigger', 'send_angio_reminders'] loop
      select prosrc, pg_get_function_result(oid) into v_body, v_ret
      from pg_proc where proname = fn and pronamespace = 'public'::regnamespace;
      if v_body is null then
        raise notice 'Funkcia % neexistuje — najprv spustite angio-001 (a angio-003/004).', fn;
        continue;
      end if;
      if v_body ~ ('v_key\s+text\s*:=\s*''' || v_key || '''') then
        raise notice '% už má správny kľúč (zdroj %).', fn, v_src;
        continue;
      end if;
      v_body := regexp_replace(v_body, 'v_key\s+text\s*:=\s*''[^'']*''', 'v_key text := ' || quote_literal(v_key));
      execute format('create or replace function %I() returns %s language plpgsql security definer set search_path = public as %L', fn, v_ret, v_body);
      raise notice '% — kľúč dosadený zo zdroja %.', fn, v_src;
    end loop;
  end if;

  -- 2. BulkGate kľúče (SMS + OTP) z notify_order_sms, ak angio funkcie majú placeholder
  select substring(prosrc from 'v_app_id\s+text\s*:=\s*''([^'']*)'''),
         substring(prosrc from 'v_app_token\s+text\s*:=\s*''([^'']*)''')
  into v_id, v_tok
  from pg_proc where proname = 'notify_order_sms' and pronamespace = 'public'::regnamespace;
  if v_id is not null and v_id not like 'SEM\_%' and v_tok is not null and v_tok not like 'SEM\_%' then
    foreach fn in array array['angio_notify_sms', 'send_angio_sms_reminders', 'angio_send_otp'] loop
      select prosrc, pg_get_function_result(oid) into v_body, v_ret
      from pg_proc where proname = fn and pronamespace = 'public'::regnamespace;
      if v_body is null then continue; end if;
      if v_body !~ 'v_app_id\s+text\s*:=\s*''SEM_' then continue; end if;
      v_body := regexp_replace(v_body, 'v_app_id\s+text\s*:=\s*''[^'']*''',    'v_app_id text := ' || quote_literal(v_id));
      v_body := regexp_replace(v_body, 'v_app_token\s+text\s*:=\s*''[^'']*''', 'v_app_token text := ' || quote_literal(v_tok));
      if fn = 'angio_send_otp' then
        execute format('create or replace function %I(p_phone text) returns %s language plpgsql security definer set search_path = public as %L', fn, v_ret, v_body);
      else
        execute format('create or replace function %I() returns %s language plpgsql security definer set search_path = public as %L', fn, v_ret, v_body);
      end if;
      raise notice '% — BulkGate kľúče dosadené z notify_order_sms.', fn;
    end loop;
  end if;
end $mig$;

revoke all on function send_angio_reminders() from public, anon, authenticated;
do $$ begin
  revoke all on function send_angio_sms_reminders() from public, anon, authenticated;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- Diagnostika (výsledok tohto selectu sa zobrazí v SQL editore)
-- ------------------------------------------------------------
with f as (
  select proname, substring(prosrc from 'v_key\s+text\s*:=\s*''([^'']*)''') as k,
         substring(prosrc from 'v_app_id\s+text\s*:=\s*''([^'']*)''') as a
  from pg_proc where pronamespace = 'public'::regnamespace
)
select 'angio_notify_trigger — Resend kľúč' as kontrola,
       case when k is null then 'FUNKCIA CHÝBA (spustite angio-001)' when k like 'SEM\_%' then 'PLACEHOLDER — e-maily vypnuté' else 'OK (' || left(k, 6) || '…)' end as stav
from (select k from f where proname = 'angio_notify_trigger' union all select null limit 1) x
union all
select 'notify_order_emails (USG) — Resend kľúč',
       case when k is null then 'FUNKCIA CHÝBA' when k like 'SEM\_%' then 'PLACEHOLDER' else 'OK' end
from (select k from f where proname = 'notify_order_emails' union all select null limit 1) x
union all
select 'trigger angio_orders_notify',
       case when exists (select 1 from pg_trigger where tgname = 'angio_orders_notify') then 'OK' else 'CHÝBA (spustite angio-001)' end
union all
select 'angio_notify_sms — BulkGate kľúč',
       case when a is null then 'FUNKCIA CHÝBA (angio-002)' when a like 'SEM\_%' then 'PLACEHOLDER — SMS vypnuté' else 'OK' end
from (select a from f where proname = 'angio_notify_sms' union all select null limit 1) x
union all
select 'settings.mail_from (odosielateľ)', coalesce((select value from settings where key = 'mail_from'), '— (použije sa onboarding@resend.dev)')
union all
select 'posledné odpovede Resend/BulkGate (net._http_response)',
       coalesce((select string_agg(id || ': ' || coalesce(status_code::text, '?') || ' ' || left(coalesce(content::text, ''), 120), ' | ' order by id desc)
                 from (select id, status_code, content from net._http_response order by id desc limit 5) z), 'žiadne');
-- ============================================================
