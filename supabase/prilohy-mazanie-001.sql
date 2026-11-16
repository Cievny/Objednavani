-- ============================================================
-- PRILOHY-MAZANIE-001 — oprava rušenia objednávok s prílohou + mazanie
--                       príloh cez Storage API + nočný strážca úloh
--
-- PROBLÉM (zistené 16. 11. 2026): Supabase zakázal mazať súbory priamym
-- SQL z tabuľky storage.objects („Direct deletion from storage tables is
-- not allowed. Use the Storage API instead."). Naše funkcie to robili,
-- preto:
--   • objednávka s prílohou sa v angiologickej ambulancii a na CT nedala
--     ZRUŠIŤ — ani pacientom cez web, ani personálom;
--   • nočné mazanie starých údajov (angio-cleanup, ct-cleanup) padalo od
--     septembra 2026 — osobné údaje a prílohy po lehote sa nemazali;
--   • pri USG sa chyba potichu ignorovala — objednávky sa mazali, ale
--     súbory príloh ostávali v úložisku.
--
-- RIEŠENIE:
--  1  attachment_purge_queue — rad súborov na zmazanie. Funkcie
--     purge_order_files / angio_purge_order_files / ct_purge_order_files /
--     purge_orphan_attachments už nič nemažú priamo, len zaradia súbory
--     do radu (nikdy nezlyhajú → zrušenie objednávky vždy prejde).
--  2  Edge Function purge-prilohy (supabase/functions/purge-prilohy)
--     rad vybaví: súbory zmaže cez Storage API (naozaj, aj z disku).
--     Databáza ju zavolá hneď po zaradení súboru a každú noc o 02:45 UTC.
--     Kým funkcia nie je nasadená, súbory len čakajú v rade (nič sa nestratí).
--  3  system_watchdog() — každé ráno skontroluje, či v noci nezlyhala
--     niektorá automatická úloha a či prílohy nečakajú na zmazanie dlhšie
--     ako 24 h; ak áno, pošle e-mail (staff_alert) a zapíše do stavu systému.
--
-- Idempotentné. Dá sa spustiť hneď; netreba pred ním nič iné.
-- ============================================================

do $$
begin
  if to_regprocedure('health_event(text, boolean, text)') is null or to_regprocedure('staff_alert(text, text, text)') is null
     or to_regprocedure('html_escape(text)') is null then
    raise exception 'PRILOHY-MAZANIE-001: chýba health_event / staff_alert / html_escape — ste v správnom projekte (USG objednavanie)?';
  end if;
  if to_regclass('storage.objects') is null or to_regclass('public.angio_orders') is null or to_regclass('public.ct_orders') is null then
    raise exception 'PRILOHY-MAZANIE-001: chýbajú tabuľky objednávok — ste v správnom projekte (USG objednavanie)?';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. rad súborov na zmazanie
-- ------------------------------------------------------------
create table if not exists attachment_purge_queue (
  id              bigint generated always as identity primary key,
  bucket          text not null default 'prilohy',
  path            text not null,
  queued_at       timestamptz not null default now(),
  attempts        int not null default 0,
  last_attempt_at timestamptz,
  last_error      text not null default '',
  unique (bucket, path)
);
alter table attachment_purge_queue enable row level security;
revoke all on attachment_purge_queue from public, anon, authenticated;

-- adresa Edge Function, ktorá rad vybavuje (verejná adresa projektu)
create or replace function attachment_purge_url()
returns text language sql immutable as $$
  select 'https://cfavtobowqevetlumktt.supabase.co/functions/v1/purge-prilohy'::text
$$;
revoke all on function attachment_purge_url() from public, anon, authenticated;

-- zavolá Edge Function (asynchrónne, po potvrdení transakcie); najviac raz za transakciu
create or replace function attachment_purge_kick()
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.purge_kicked', true), '') = '1' then return; end if;
  perform set_config('app.purge_kicked', '1', true);
  perform net.http_post(
    url := attachment_purge_url(),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb);
exception when others then
  null;
end $$;
revoke all on function attachment_purge_kick() from public, anon, authenticated;

-- zaradí všetky súbory objednávky do radu; nikdy nezlyhá
create or replace function attachment_purge_enqueue(p_order_id text)
returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if p_order_id is null or length(p_order_id) < 5 then return 0; end if;
  insert into attachment_purge_queue (path)
  select o.name from storage.objects o
  where o.bucket_id = 'prilohy'
    and upper(left(o.name, length(p_order_id) + 1)) = upper(p_order_id) || '/'
  on conflict (bucket, path) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform attachment_purge_kick(); end if;
  return n;
exception when others then
  return 0;
end $$;
revoke all on function attachment_purge_enqueue(text) from public, anon, authenticated;

-- pôvodné funkcie: už len zaradia do radu (rušenie objednávky ani nočné mazanie na nich nespadne)
create or replace function purge_order_files(p_order_id text)
returns void language plpgsql security definer set search_path = public as $$
begin perform attachment_purge_enqueue(p_order_id); end $$;
revoke all on function purge_order_files(text) from public, anon, authenticated;

create or replace function angio_purge_order_files(p_order_id text)
returns void language plpgsql security definer set search_path = public as $$
begin perform attachment_purge_enqueue(p_order_id); end $$;
revoke all on function angio_purge_order_files(text) from public, anon, authenticated;

create or replace function ct_purge_order_files(p_order_id text)
returns void language plpgsql security definer set search_path = public as $$
begin perform attachment_purge_enqueue(p_order_id); end $$;
revoke all on function ct_purge_order_files(text) from public, anon, authenticated;

-- súbory bez objednávky (nedokončené objednanie, zmazaná objednávka) staršie ako 1 deň
create or replace function purge_orphan_attachments()
returns integer
language plpgsql security definer set search_path = public as $$
declare v int := 0;
begin
  insert into attachment_purge_queue (path)
  select o.name from storage.objects o
  where o.bucket_id = 'prilohy'
    and o.created_at < now() - interval '1 day'
    and upper(split_part(o.name, '/', 1)) not in (
      select upper(id) from orders
      union all select upper(id) from ct_orders
      union all select upper(id) from angio_orders)
  on conflict (bucket, path) do nothing;
  get diagnostics v = row_count;
  if v > 0 then perform attachment_purge_kick(); end if;
  return v;
exception when others then
  return 0;
end $$;
revoke all on function purge_orphan_attachments() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. rozhranie pre Edge Function purge-prilohy (len service_role)
-- ------------------------------------------------------------
-- vráti dávku súborov na zmazanie (hotové — už neexistujúce — najprv z radu vyradí)
create or replace function attachment_purge_take(p_limit int default 200)
returns table (bucket text, path text)
language plpgsql security definer set search_path = public as $$
begin
  delete from attachment_purge_queue q
  where not exists (select 1 from storage.objects o where o.bucket_id = q.bucket and o.name = q.path);
  return query
    update attachment_purge_queue q
       set attempts = q.attempts + 1, last_attempt_at = now()
     where q.id in (select x.id from attachment_purge_queue x order by x.attempts, x.queued_at
                    limit least(greatest(coalesce(p_limit, 200), 1), 500))
    returning q.bucket, q.path;
end $$;
revoke all on function attachment_purge_take(int) from public, anon, authenticated;
grant execute on function attachment_purge_take(int) to service_role;

-- po pokuse o zmazanie: čo v úložisku už nie je, vyradí z radu; zvyšku zapíše chybu
create or replace function attachment_purge_settle(p_error text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_done int := 0; v_left int := 0; v_err text := left(coalesce(p_error, ''), 300);
begin
  delete from attachment_purge_queue q
  where not exists (select 1 from storage.objects o where o.bucket_id = q.bucket and o.name = q.path);
  get diagnostics v_done = row_count;
  if v_err <> '' then
    update attachment_purge_queue set last_error = v_err where last_attempt_at > now() - interval '10 minutes';
  end if;
  select count(*) into v_left from attachment_purge_queue;
  if v_done > 0 or v_err <> '' then
    perform health_event('prilohy-purge', v_err = '', 'zmazané ' || v_done || ', v rade ' || v_left
      || case when v_err <> '' then ' · ' || v_err else '' end);
  end if;
  return jsonb_build_object('deleted', v_done, 'remaining', v_left);
end $$;
revoke all on function attachment_purge_settle(text) from public, anon, authenticated;
grant execute on function attachment_purge_settle(text) to service_role;

-- ------------------------------------------------------------
-- 3. nočný strážca: zlyhané automatické úlohy a prílohy čakajúce na zmazanie
-- ------------------------------------------------------------
create or replace function system_watchdog()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_fail text; v_jobs int := 0; v_q int := 0; v_old int := 0;
begin
  begin
    select string_agg(x.jobname || ' (' || x.n || '×): ' || x.msg, E'\n' order by x.jobname), count(*)
      into v_fail, v_jobs
    from (
      select j.jobname, count(*) as n, left(regexp_replace(max(d.return_message), '\s+', ' ', 'g'), 220) as msg
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where d.status = 'failed' and d.start_time > now() - interval '26 hours'
      group by j.jobname) x;
  exception when others then
    v_fail := 'Strážca nevie čítať históriu úloh: ' || sqlerrm; v_jobs := 1;
  end;
  select count(*), count(*) filter (where queued_at < now() - interval '24 hours') into v_q, v_old from attachment_purge_queue;

  perform health_event('watchdog', coalesce(v_jobs, 0) = 0 and v_old = 0,
    'zlyhané úlohy: ' || coalesce(v_jobs, 0) || ', prílohy v rade: ' || v_q || ' (dlhšie ako 24 h: ' || v_old || ')');
  if coalesce(v_jobs, 0) > 0 then
    perform staff_alert('cron', 'Objednávanie NÚSCH: zlyhala automatická nočná úloha',
      '<p><b>Za posledných 24 hodín zlyhala automatická úloha systému</b> (mazanie starých údajov, pripomienky alebo párovanie platieb). '
      || 'Treba to dať skontrolovať správcovi systému.</p><pre style="white-space:pre-wrap;font-size:12px;background:#f4f6f8;padding:8px;border-radius:6px">'
      || html_escape(v_fail) || '</pre>');
  end if;
  if v_old > 0 then
    perform staff_alert('prilohy', 'Objednávanie NÚSCH: prílohy čakajú na zmazanie dlhšie ako 24 hodín',
      '<p><b>' || v_old || ' súborov príloh (žiadanky, správy) čaká na zmazanie dlhšie ako 24 hodín.</b> '
      || 'Mazanie zabezpečuje funkcia purge-prilohy; treba to dať skontrolovať správcovi systému.</p>');
  end if;
  return jsonb_build_object('failed_jobs', coalesce(v_jobs, 0), 'queue', v_q, 'queue_older_24h', v_old);
end $$;
revoke all on function system_watchdog() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. plánovanie
-- ------------------------------------------------------------
do $$ begin perform cron.unschedule('prilohy-purge'); exception when others then null; end $$;
select cron.schedule('prilohy-purge', '45 2 * * *', $$select attachment_purge_kick()$$);
do $$ begin perform cron.unschedule('system-watchdog'); exception when others then null; end $$;
select cron.schedule('system-watchdog', '30 5 * * *', $$select system_watchdog()$$);

-- súbory bez objednávky zaradiť hneď (zmažú sa, len čo beží Edge Function)
select purge_orphan_attachments();

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
declare f text; v_q int;
begin
  foreach f in array array['purge_order_files', 'angio_purge_order_files', 'ct_purge_order_files', 'purge_orphan_attachments'] loop
    if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = f and prosrc ~* 'delete\s+from\s+storage\.objects') then
      raise exception 'PRILOHY-MAZANIE-001: funkcia % stále maže priamo zo storage.objects.', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'attachment_purge_take(int)', 'execute') or has_function_privilege('authenticated', 'attachment_purge_take(int)', 'execute')
     or has_function_privilege('anon', 'attachment_purge_settle(text)', 'execute') or has_function_privilege('anon', 'attachment_purge_enqueue(text)', 'execute')
     or has_function_privilege('anon', 'system_watchdog()', 'execute') or has_table_privilege('anon', 'attachment_purge_queue', 'select')
     or has_table_privilege('authenticated', 'attachment_purge_queue', 'select') then
    raise exception 'PRILOHY-MAZANIE-001: rad príloh alebo jeho funkcie sú dostupné cez API.';
  end if;
  if not has_function_privilege('service_role', 'attachment_purge_take(int)', 'execute')
     or not has_function_privilege('service_role', 'attachment_purge_settle(text)', 'execute') then
    raise exception 'PRILOHY-MAZANIE-001: service_role nemá prístup k radu príloh.';
  end if;
  if (select count(*) from cron.job where jobname in ('prilohy-purge', 'system-watchdog')) <> 2 then
    raise exception 'PRILOHY-MAZANIE-001: úlohy prilohy-purge / system-watchdog nie sú naplánované.';
  end if;
  select count(*) into v_q from attachment_purge_queue;
  raise notice 'PRILOHY-MAZANIE-001 OK. Súborov v rade na zmazanie: %.', v_q;
end $$;
