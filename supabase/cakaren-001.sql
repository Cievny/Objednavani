-- ============================================================
-- Čakáreň — QR check-in pacienta („Som tu")
-- Spustiť v Supabase SQL editore PO všetkých predchádzajúcich
-- skriptoch (vyžaduje check_lookup_limit z audit-vlna3-001.sql).
--
-- Pacient naskenuje QR na stojane pred ambulanciou, zadá telefón
-- a potvrdí príchod. Personál vidí pri objednávke „V ČAKÁRNI od HH:MM".
-- Párovanie podľa telefónu (posledných 9 číslic) — rovnaký mechanizmus
-- ako overenie/storno objednávky, s rovnakým rate-limitom.
-- ============================================================

-- 1. Čas príchodu pacienta do čakárne
alter table orders add column if not exists arrived_at timestamptz;
alter table ct_orders add column if not exists arrived_at timestamptz;

-- ------------------------------------------------------------
-- 2. checkin_lookup — dnešné objednávky pacienta (USG aj CT)
--    Vracia len minimum údajov na potvrdenie príchodu
--    (bez mena, e-mailu a ceny — pacient ich už pozná).
-- ------------------------------------------------------------
create or replace function checkin_lookup(p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_phone9 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_today date := (now() at time zone 'Europe/Bratislava')::date;
  result jsonb;
begin
  if length(v_phone9) < 9 then
    raise exception 'Zadajte celé telefónne číslo.';
  end if;
  perform check_lookup_limit('checkin:' || v_phone9);

  select coalesce(jsonb_agg(t.x order by t.x->>'slot_time'), '[]'::jsonb) into result
  from (
    select jsonb_build_object(
      'kind', 'usg',
      'id', o.id,
      'exam_label', o.exam_label,
      'slot_time', o.slot_time,
      'doctor', o.doctor,
      'arrived_at', o.arrived_at
    ) as x
    from orders o
    where o.slot_date = v_today
      and o.status in ('new', 'confirmed')
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9
    union all
    select jsonb_build_object(
      'kind', 'ct',
      'id', c.id,
      'exam_label', coalesce(nullif(c.exam_label, ''), 'CT vyšetrenie'),
      'slot_time', c.slot_time,
      'doctor', c.doctor,
      'arrived_at', c.arrived_at
    )
    from ct_orders c
    where c.slot_date = v_today
      and c.status in ('new', 'confirmed')
      and right(regexp_replace(c.phone, '\D', '', 'g'), 9) = v_phone9
  ) t;
  return result;
end $$;

revoke all on function checkin_lookup(text) from public, anon, authenticated;
grant execute on function checkin_lookup(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. checkin_confirm — zapíše príchod (idempotentné: prvý čas ostáva)
-- ------------------------------------------------------------
create or replace function checkin_confirm(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_phone9 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_today date := (now() at time zone 'Europe/Bratislava')::date;
  v_count int := 0;
begin
  if coalesce(p_id, '') !~ '^(USG|CT)-[A-Za-z0-9-]{4,40}$' then
    raise exception 'Neplatné číslo objednávky.';
  end if;
  if length(v_phone9) < 9 then
    raise exception 'Zadajte celé telefónne číslo.';
  end if;
  perform check_lookup_limit('checkin:' || v_phone9);

  if upper(p_id) like 'CT-%' then
    update ct_orders o set arrived_at = coalesce(o.arrived_at, now())
    where upper(o.id) = upper(p_id)
      and o.slot_date = v_today
      and o.status in ('new', 'confirmed')
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  else
    update orders o set arrived_at = coalesce(o.arrived_at, now())
    where upper(o.id) = upper(p_id)
      and o.slot_date = v_today
      and o.status in ('new', 'confirmed')
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9) = v_phone9;
  end if;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

revoke all on function checkin_confirm(text, text) from public, anon, authenticated;
grant execute on function checkin_confirm(text, text) to anon, authenticated;
