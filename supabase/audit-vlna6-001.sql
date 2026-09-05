-- ============================================================
-- AUDIT VLNA 6 — 001  (bezpečnostné opravy nad stavom v74)
--
-- KRITICKÉ (K1): check-in RPC vydával na základe samotného telefónu
--   číslo objednávky + typ vyšetrenia + lekára → únik zdravotného
--   údaja a eskalácia na cancel_order. Tu zúžené na minimum
--   (len čas termínu a či pacient prišiel) + IP rate-limit.
-- STREDNÉ (S3): kanonické znovu-definovanie cancel_order a
--   ct_orders UPDATE politiky (WITH CHECK), aby boli posledným
--   slovom bez ohľadu na poradie starších skriptov.
-- NÍZKE: storage upload viazaný na existujúcu objednávku;
--   fio_poll chránený advisory lockom proti súbehu.
--
-- Idempotentné. Spúšťať PO všetkých predchádzajúcich skriptoch
-- (vyžaduje check_rate_limit, assert_order_id, orders, ct_orders,
--  fio_poll). Žiadne kľúče sa nevkladajú.
-- ============================================================

-- ------------------------------------------------------------
-- Pomocná: klientská IP z hlavičiek (rovnaký vzor ako create_order)
-- ------------------------------------------------------------
create or replace function client_ip()
returns text language plpgsql stable set search_path = public as $$
declare v_ip text := '';
begin
  begin
    v_ip := split_part(coalesce((current_setting('request.headers', true))::json ->> 'x-forwarded-for', ''), ',', 1);
  exception when others then
    v_ip := '';
  end;
  return v_ip;
end $$;

-- ------------------------------------------------------------
-- K1a. checkin_lookup — vracia LEN čas termínu a stav príchodu.
--   Bez čísla objednávky, typu vyšetrenia a lekára (zdravotný údaj).
--   Rate-limit na telefón AJ na IP (proti enumerácii cez čísla).
-- ------------------------------------------------------------
create or replace function checkin_lookup(p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_phone9 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_today  date := (now() at time zone 'Europe/Bratislava')::date;
  v_ip     text := client_ip();
  result   jsonb;
begin
  if length(v_phone9) < 9 then
    raise exception 'Zadajte celé telefónne číslo.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('checkin-ip:' || v_ip, 40);
  end if;
  perform check_lookup_limit('checkin:' || v_phone9);

  select coalesce(jsonb_agg(t.x order by t.x->>'slot_time'), '[]'::jsonb) into result
  from (
    select jsonb_build_object('slot_time', o.slot_time, 'arrived_at', o.arrived_at) as x
    from orders o
    where o.slot_date = v_today and o.status in ('new', 'confirmed')
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9
    union all
    select jsonb_build_object('slot_time', c.slot_time, 'arrived_at', c.arrived_at)
    from ct_orders c
    where c.slot_date = v_today and c.status in ('new', 'confirmed')
      and right(regexp_replace(c.phone, '\D', '', 'g'), 9) = v_phone9
  ) t;
  return result;
end $$;

revoke all on function checkin_lookup(text) from public, anon, authenticated;
grant execute on function checkin_lookup(text) to anon, authenticated;

-- ------------------------------------------------------------
-- K1b. checkin_confirm — potvrdí príchod LEN podľa telefónu
--   (bez čísla objednávky): označí všetky dnešné aktívne objednávky
--   daného telefónu (USG aj CT). Idempotentné. Nová signatúra (text).
--   Dvojargumentová verzia ostáva ako spätne kompatibilný shim, kým
--   je nasadená staršia pacientska stránka (zdieľaná DB) — číslo
--   objednávky ignoruje a potvrdzuje podľa telefónu.
-- ------------------------------------------------------------
create or replace function checkin_confirm(p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_phone9 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_today  date := (now() at time zone 'Europe/Bratislava')::date;
  v_ip     text := client_ip();
  v_n      int  := 0;
  v_m      int  := 0;
begin
  if length(v_phone9) < 9 then
    raise exception 'Zadajte celé telefónne číslo.';
  end if;
  if v_ip <> '' then
    perform check_rate_limit('checkin-ip:' || v_ip, 40);
  end if;
  perform check_lookup_limit('checkin:' || v_phone9);

  update orders o set arrived_at = coalesce(o.arrived_at, now())
  where o.slot_date = v_today and o.status in ('new', 'confirmed')
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  get diagnostics v_n = row_count;

  update ct_orders c set arrived_at = coalesce(c.arrived_at, now())
  where c.slot_date = v_today and c.status in ('new', 'confirmed')
    and right(regexp_replace(c.phone, '\D', '', 'g'), 9) = v_phone9;
  get diagnostics v_m = row_count;

  return (v_n + v_m) > 0;
end $$;

revoke all on function checkin_confirm(text) from public, anon, authenticated;
grant execute on function checkin_confirm(text) to anon, authenticated;

-- spätne kompatibilný shim pre staršiu pacientsku stránku (v74),
-- ktorá volá checkin_confirm(p_id, p_phone) — id sa ignoruje
create or replace function checkin_confirm(p_id text, p_phone text)
returns boolean
language sql security definer set search_path = public as $$
  select checkin_confirm(p_phone);
$$;
revoke all on function checkin_confirm(text, text) from public, anon, authenticated;
grant execute on function checkin_confirm(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- S3a. cancel_order — kanonická definícia (assert_order_id +
--   rate-limit na TELEFÓN). Posledné slovo bez ohľadu na poradie.
-- ------------------------------------------------------------
create or replace function cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_when timestamptz;
begin
  perform assert_order_id(p_id);
  perform check_lookup_limit('cancel:' || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9));

  select ((o.slot_date + o.slot_time) at time zone 'Europe/Bratislava') into v_when
  from orders o
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');

  if v_when is not null and v_when - now() < interval '48 hours' then
    raise exception 'Do termínu zostáva menej ako 48 hodín — napíšte nám SMS s číslom objednávky na 0949 000 677.';
  end if;

  update orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- ------------------------------------------------------------
-- S3b. ct_orders UPDATE — USING aj WITH CHECK (lekár nesmie
--   vysunúť riadok mimo svojho rozsahu / prepísať lekára)
-- ------------------------------------------------------------
drop policy if exists "ct objednavky update" on ct_orders;
create policy "ct objednavky update" on ct_orders
  for update to authenticated
  using (my_role() in ('superadmin', 'sestra') or (my_role() = 'lekar' and doctor = my_doctor()))
  with check (my_role() in ('superadmin', 'sestra') or (my_role() = 'lekar' and doctor = my_doctor()));

-- ------------------------------------------------------------
-- N. Storage upload viazaný na EXISTUJÚCU objednávku
-- ------------------------------------------------------------
create or replace function order_exists(p_id text)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from orders    where id = p_id)
      or exists (select 1 from ct_orders where id = p_id);
$$;
revoke all on function order_exists(text) from public;
grant execute on function order_exists(text) to anon, authenticated;

-- OPRAVA (oprava-prilohy-001): upload NESMIE vyžadovať existujúcu
-- objednávku — aplikácia nahráva prílohy PRED create_order. Namiesto
-- toho: tvar cesty, max 3 súbory na priečinok, IP limit; osirelé
-- priečinky čistí purge_orphan_attachments.
create or replace function upload_allowed(p_name text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_ip     text := client_ip();
  v_folder text := split_part(p_name, '/', 1);
begin
  if p_name !~ '^(USG|CT|ANG)-[A-Za-z0-9-]{4,40}/[^/]{1,120}$' then
    return false;
  end if;
  if (select count(*) from storage.objects
      where bucket_id = 'prilohy' and name like v_folder || '/%') >= 3 then
    return false;
  end if;
  if v_ip <> '' then
    perform check_rate_limit('upload-ip:' || v_ip, 30);
  end if;
  return true;
end $$;
revoke all on function upload_allowed(text) from public;
grant execute on function upload_allowed(text) to anon, authenticated;

drop policy if exists "prilohy upload" on storage.objects;
create policy "prilohy upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'prilohy' and upload_allowed(name));

-- ------------------------------------------------------------
-- N. fio_poll — poistka proti súbehu (advisory lock).
--   Cron volá wrapper; ak predchádzajúci beh ešte prebieha,
--   nový sa preskočí (netočí sa druhá pg_sleep + súbežné http).
-- ------------------------------------------------------------
create or replace function fio_poll_guarded()
returns int
language plpgsql security definer set search_path = public as $$
declare v int := 0;
begin
  if not pg_try_advisory_lock(hashtext('fio_poll')) then
    return 0; -- predchádzajúci beh ešte prebieha
  end if;
  begin
    v := fio_poll();
  exception when others then
    perform pg_advisory_unlock(hashtext('fio_poll'));
    raise;
  end;
  perform pg_advisory_unlock(hashtext('fio_poll'));
  return v;
end $$;
revoke all on function fio_poll_guarded() from public, anon, authenticated;

-- preplánovať cron na chránenú verziu (ak pg_cron existuje)
do $$
begin
  perform cron.unschedule('fio-parovanie');
exception when others then null;
end $$;
do $$
begin
  perform cron.schedule('fio-parovanie', '* * * * *', $q$select fio_poll_guarded()$q$);
exception when others then null;
end $$;
