-- ============================================================
-- RETENTION 001 — automatický výmaz, štatistika, rate-limiting,
-- auditný log. Implementuje záväzky z dokumentov:
--   „Informácie o spracúvaní osobných údajov" a
--   „Postup k implementácii" (časť 3 — Technická implementácia).
--
-- Lehoty (dané dokumentmi, nemeniť bez súhlasu DPO):
--   - vykonané objednávky (done): výmaz do 7 dní po vyšetrení
--   - zrušené/nevyužité (rejected, noshow, new po termíne):
--       prílohy + údaje zo žiadanky ihneď, celý záznam 28 dní
--       od termínu
--   - technické logy (HTTP odpovede, pokusy o lookup, audit,
--     logy cronu): 90 dní
--
-- Zálohy: free plán Supabase automatické zálohy nemá. Pri
-- prechode na Pro nastaviť retenciu 7 dní (Settings → Database
-- → Backups) — presne toľko sľubuje verejný text. Po každej
-- obnove zo zálohy spustiť ručne: select purge_orders();
--
-- Skript je idempotentný — možno ho spúšťať opakovane.
-- ============================================================

create extension if not exists pg_cron;

-- ------------------------------------------------------------
-- 1. Anonymná štatistika (recitál 26 GDPR — bez identifikátorov)
--    Napĺňa sa výhradne pri výmaze objednávky; obsahuje len
--    dátum termínu, typ vyšetrenia a konečný stav.
-- ------------------------------------------------------------
create table if not exists usg_stats (
  day date not null,
  exam_type_id text not null,
  status text not null,
  cnt int not null default 0,
  primary key (day, exam_type_id, status)
);
alter table usg_stats enable row level security;
drop policy if exists "statistiku cita personal" on usg_stats;
create policy "statistiku cita personal" on usg_stats
  for select using (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 2. Auditný log operácií personálu (90 dní)
--    Trigger zaznamená každú zmenu stavu/platby/termínu vrátane
--    identity prihláseného používateľa (auth.uid()).
-- ------------------------------------------------------------
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  order_id text,
  action text not null,
  detail text not null default ''
);
alter table audit_log enable row level security;
drop policy if exists "audit cita personal" on audit_log;
create policy "audit cita personal" on audit_log
  for select using (auth.role() = 'authenticated');

create or replace function audit_orders()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'UPDATE' then
    if OLD.status is distinct from NEW.status then
      insert into audit_log (user_id, order_id, action, detail)
      values (auth.uid(), NEW.id, 'status', OLD.status || ' → ' || NEW.status);
    end if;
    if OLD.paid is distinct from NEW.paid then
      insert into audit_log (user_id, order_id, action, detail)
      values (auth.uid(), NEW.id, 'paid', case when NEW.paid then 'zaplatené' else 'platba zrušená' end);
    end if;
    if OLD.slot_date is distinct from NEW.slot_date or OLD.slot_time is distinct from NEW.slot_time then
      insert into audit_log (user_id, order_id, action, detail)
      values (auth.uid(), NEW.id, 'reschedule',
        OLD.slot_date || ' ' || OLD.slot_time || ' → ' || NEW.slot_date || ' ' || NEW.slot_time);
    end if;
  elsif TG_OP = 'INSERT' then
    insert into audit_log (user_id, order_id, action, detail)
    values (auth.uid(), NEW.id, 'created', NEW.exam_type_id);
  end if;
  return NEW;
end $$;

drop trigger if exists orders_audit on orders;
create trigger orders_audit
after insert or update on orders
for each row execute function audit_orders();

-- ------------------------------------------------------------
-- 3. Okamžitý výmaz príloh a údajov zo žiadanky pri zrušení
--    (verejný text: „prílohy a údaje zo žiadanky sa vymazávajú
--    bezodkladne pri zrušení objednávky")
-- ------------------------------------------------------------
create or replace function purge_order_files(p_order_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from storage.objects
  where bucket_id = 'prilohy' and name like p_order_id || '/%';
end $$;

create or replace function scrub_on_cancel()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.status = 'rejected' and OLD.status <> 'rejected' then
    perform purge_order_files(NEW.id);
    -- druhý UPDATE v tom istom riadku by spustil triggre znova;
    -- preto čistíme priamo v prebiehajúcom UPDATE (BEFORE trigger)
    NEW.attachments := '[]'::jsonb;
    NEW.reason := '';
    NEW.referrer_name := '';
    NEW.referrer_facility := '';
  end if;
  return NEW;
end $$;

drop trigger if exists orders_scrub_on_cancel on orders;
create trigger orders_scrub_on_cancel
before update on orders
for each row execute function scrub_on_cancel();

-- ------------------------------------------------------------
-- 4. Rate-limiting overovania objednávky (číslo + telefón)
--    Max 10 pokusov za 15 minút na jedno číslo objednávky.
-- ------------------------------------------------------------
create table if not exists lookup_attempts (
  key text primary key,
  window_start timestamptz not null default now(),
  attempts int not null default 0
);
alter table lookup_attempts enable row level security; -- žiadne politiky = prístup len cez funkcie

create or replace function check_lookup_limit(p_key text)
returns void
language plpgsql security definer set search_path = public as $$
declare v lookup_attempts%rowtype;
begin
  select * into v from lookup_attempts where key = p_key for update;
  if not found then
    insert into lookup_attempts (key, attempts) values (p_key, 1)
    on conflict (key) do update set attempts = lookup_attempts.attempts + 1;
    return;
  end if;
  if v.window_start < now() - interval '15 minutes' then
    update lookup_attempts set window_start = now(), attempts = 1 where key = p_key;
    return;
  end if;
  if v.attempts >= 10 then
    raise exception 'Priveľa pokusov o overenie. Skúste to znova o 15 minút.';
  end if;
  update lookup_attempts set attempts = attempts + 1 where key = p_key;
end $$;

-- lookup_order/cancel_order — rovnaká logika ako doteraz + limit
create or replace function lookup_order(p_id text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform check_lookup_limit('lookup:' || upper(coalesce(p_id, '')));
  select to_jsonb(x) into result from (
    select o.id, o.status, o.status_note, o.has_referral, o.exam_label,
           o.price, o.slot_date, o.slot_time, o.doctor, o.paid
    from orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
  return result;
end $$;

create or replace function cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  perform check_lookup_limit('cancel:' || upper(coalesce(p_id, '')));
  update orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- ------------------------------------------------------------
-- 5. Denný výmaz podľa lehôt + zápis do anonymnej štatistiky
-- ------------------------------------------------------------
create or replace function purge_orders()
returns table (deleted_done int, deleted_old int, scrubbed int)
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_done int := 0;
  v_old int := 0;
  v_scrub int := 0;
begin
  -- a) prílohy a údaje zo žiadanky:
  --    - nevyužité/zrušené: ihneď po termíne
  --    - ostatné (aj keď personál nezmenil stav): najneskôr 7 dní
  --      po termíne — poistka, nech sľub z verejného textu platí
  --      aj pri zabudnutom kliknutí
  for r in
    select id from orders
    where (attachments <> '[]'::jsonb or reason <> '' or referrer_name <> '')
      and (
        (slot_date < current_date and status in ('new', 'rejected', 'noshow'))
        or slot_date <= current_date - 7
      )
  loop
    perform purge_order_files(r.id);
    update orders set attachments = '[]'::jsonb, reason = '', referrer_name = '', referrer_facility = ''
    where id = r.id;
    v_scrub := v_scrub + 1;
  end loop;

  -- b) vykonané objednávky: výmaz najneskôr 7 dní po vyšetrení (+ štatistika)
  for r in
    select id, slot_date, exam_type_id, status from orders
    where status = 'done' and slot_date <= current_date - 7
  loop
    perform purge_order_files(r.id);
    insert into usg_stats (day, exam_type_id, status, cnt) values (r.slot_date, r.exam_type_id, r.status, 1)
    on conflict (day, exam_type_id, status) do update set cnt = usg_stats.cnt + 1;
    delete from orders where id = r.id;
    v_done := v_done + 1;
  end loop;

  -- c) zrušené / nevyužité / nepotvrdené po termíne: výmaz 28 dní od termínu
  for r in
    select id, slot_date, exam_type_id, status from orders
    where slot_date < current_date - 28 and status <> 'done'
  loop
    perform purge_order_files(r.id);
    insert into usg_stats (day, exam_type_id, status, cnt) values (r.slot_date, r.exam_type_id, r.status, 1)
    on conflict (day, exam_type_id, status) do update set cnt = usg_stats.cnt + 1;
    delete from orders where id = r.id;
    v_old := v_old + 1;
  end loop;

  -- d) technické logy: 90 dní
  delete from audit_log where at < now() - interval '90 days';
  delete from lookup_attempts where window_start < now() - interval '90 days';
  begin
    delete from net._http_response where created < now() - interval '90 days';
  exception when others then null; -- tabuľka pg_net sa môže líšiť podľa verzie
  end;
  begin
    delete from cron.job_run_details where end_time < now() - interval '90 days';
  exception when others then null;
  end;

  return query select v_done, v_old, v_scrub;
end $$;

revoke all on function purge_orders() from public, anon, authenticated;
revoke all on function purge_order_files(text) from public, anon, authenticated;
revoke all on function check_lookup_limit(text) from public, anon, authenticated;

-- denne o 01:00 UTC
do $$
begin
  perform cron.unschedule('usg-cleanup');
exception when others then null;
end $$;
select cron.schedule('usg-cleanup', '0 1 * * *', $$select * from purge_orders()$$);

-- ------------------------------------------------------------
-- Diagnostika:
--   select * from cron.job;                        -- jobs usg-cleanup + usg-reminders
--   select * from purge_orders();                  -- ručné spustenie (vráti počty)
--   select * from usg_stats order by day desc;     -- anonymná štatistika
--   select * from audit_log order by at desc limit 20;
-- Po obnove zo zálohy VŽDY spustiť: select * from purge_orders();
-- ============================================================
