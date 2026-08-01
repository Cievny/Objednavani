-- ============================================================
-- AUDIT VLNA 4 (001) — stredné a nízke nálezy
--
--  1. settings: verejne (anon) čitateľné len necitlivé kľúče;
--     e-maily lekárov (v kľúči doctors) sa už anonymne nevystavujú.
--     Pacientovi sa zoznam lekárov (bez e-mailov) servíruje cez
--     SECURITY DEFINER funkciu public_doctors().
--  2. orders: rola „lekar" už NEMÁ DELETE (mazať smie len sestra/
--     superadmin) a nemôže si sama označiť platbu ani meniť cenu
--     (guard trigger). Mazanie sa navyše loguje do audit_log.
--  3. Osirelé prílohy (nahraté, keď create_order zlyhal) sa denne
--     upratujú (purge_orphan_attachments + cron).
--  4. Backfill orders.duration_min pre staré objednávky (proti
--     dvojitému bookingu, keď mali default 5).
--
-- Bez kľúčov. Idempotentné. Spúšťať PO audit-vlna3-001.
-- ============================================================

-- ------------------------------------------------------------
-- 1. settings — verejný whitelist + plný prístup pre personál
-- ------------------------------------------------------------
drop policy if exists "nastavenia cita ktokolvek" on settings;
drop policy if exists "settings verejne citanie" on settings;
drop policy if exists "settings personal citanie" on settings;
create policy "settings verejne citanie" on settings
  for select using (key in ('iban', 'beneficiary', 'referral_from', 'slot_base_min'));
create policy "settings personal citanie" on settings
  for select to authenticated using (my_role() in ('superadmin', 'sestra', 'lekar'));

-- zoznam lekárov pre pacienta bez e-mailov (meno, miesto, vyšetrenia)
create or replace function public_doctors()
returns jsonb
language sql security definer stable set search_path = public as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object(
        'name', d->>'name',
        'location', coalesce(d->>'location', ''),
        'examTypeIds', coalesce(d->'examTypeIds', '[]'::jsonb)))
     from jsonb_array_elements(
        coalesce((select value from settings where key = 'doctors'), '[]')::jsonb) d),
    '[]'::jsonb);
$$;
grant execute on function public_doctors() to anon, authenticated;

-- ------------------------------------------------------------
-- 2. orders — granulárne RLS + guard trigger pre rolu lekar
-- ------------------------------------------------------------
drop policy if exists "objednavky spravuje personal" on orders;
drop policy if exists "objednavky podla roly" on orders;
drop policy if exists "objednavky select" on orders;
drop policy if exists "objednavky insert" on orders;
drop policy if exists "objednavky update" on orders;
drop policy if exists "objednavky delete" on orders;

create policy "objednavky select" on orders
  for select using (
    my_role() in ('superadmin', 'sestra')
    or (my_role() = 'lekar' and doctor = my_doctor())
  );
create policy "objednavky insert" on orders
  for insert with check (my_role() in ('superadmin', 'sestra'));
create policy "objednavky update" on orders
  for update using (
    my_role() in ('superadmin', 'sestra')
    or (my_role() = 'lekar' and doctor = my_doctor())
  );
-- mazať smie len sestra a superadmin (lekár nie — proti nezvratnej strate)
create policy "objednavky delete" on orders
  for delete using (my_role() in ('superadmin', 'sestra'));

-- lekár si nesmie sám potvrdiť platbu ani meniť cenu (to je úloha
-- sestry/superadmina); presun rieši SECURITY DEFINER reschedule_order
create or replace function guard_order_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if my_role() = 'lekar' then
    if coalesce(NEW.paid, false) <> coalesce(OLD.paid, false) then
      raise exception 'Platbu potvrdzuje sestra alebo superadmin.';
    end if;
    if NEW.price is distinct from OLD.price then
      raise exception 'Cenu môže meniť len sestra alebo superadmin.';
    end if;
  end if;
  return NEW;
end $$;
drop trigger if exists orders_guard_update on orders;
create trigger orders_guard_update
before update on orders
for each row execute function guard_order_update();

-- mazanie objednávky nech nezostane bez stopy v audite
create or replace function audit_order_delete()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (user_id, order_id, action, detail)
  values (auth.uid(), OLD.id, 'deleted', OLD.status || ' · ' || OLD.slot_date);
  return OLD;
end $$;
drop trigger if exists orders_audit_delete on orders;
create trigger orders_audit_delete
after delete on orders
for each row execute function audit_order_delete();

-- ------------------------------------------------------------
-- 3. Osirelé prílohy — súbory bez zodpovedajúcej objednávky
--    (napr. keď create_order po nahratí zlyhal) sa denne mažú
-- ------------------------------------------------------------
create or replace function purge_orphan_attachments()
returns int
language plpgsql security definer set search_path = public as $$
declare v int := 0;
begin
  begin
    with del as (
      delete from storage.objects o
      where o.bucket_id = 'prilohy'
        and o.created_at < now() - interval '1 day'
        and split_part(o.name, '/', 1) not in (select id from orders)
      returning 1
    )
    select count(*) into v from del;
  exception when others then
    v := 0; -- prípadný chýbajúci prístup k storage.objects nesmie zhodiť cron
  end;
  return v;
end $$;
revoke all on function purge_orphan_attachments() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('usg-orphan-attachments');
exception when others then null;
end $$;
select cron.schedule('usg-orphan-attachments', '30 2 * * *', $$select purge_orphan_attachments()$$);

-- ------------------------------------------------------------
-- 4. Backfill orders.duration_min (proti dvojitému bookingu)
-- ------------------------------------------------------------
update orders o
set duration_min = greatest(coalesce(p.duration_slots, 2), 2) * 5
from pricelist p
where p.id = o.exam_type_id and coalesce(o.duration_min, 0) < 10;
-- objednávky, ktorých vyšetrenie už v cenníku nie je → aspoň 10 min
update orders set duration_min = 10 where coalesce(duration_min, 0) < 10;

-- Kontrola po spustení:
--   select public_doctors();
--   select relname from pg_policies where tablename = 'orders';  -- 4 politiky
--   select count(*) from orders where duration_min < 10;         -- 0
-- ============================================================
