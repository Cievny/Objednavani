-- ============================================================
-- AUDIT VLNA 5 — 002
--
-- #4 (STREDNÉ, bezpečnostná regresia): najnovší emaily-storna-001
-- predefinoval cancel_order a nechtiac vypustil hardening z
-- audit-vlny 3:
--   • rate-limit sa kľúčoval na `p_id` (útočník ho ovláda,
--     neobmedzená dĺžka) namiesto telefónu → bloatenie
--     lookup_attempts a oslabená ochrana proti hádaniu ID,
--   • vypadol assert_order_id() (validácia formátu čísla).
-- lookup_order aj patient_reschedule hardening majú — cancel_order
-- ho týmto dostáva späť. Storno správanie (48 h, e-mail cez trigger)
-- ostáva nezmenené.
--
-- Idempotentné. Bez kľúčov. Spúšťať PO emaily-storna-001.
-- ============================================================

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
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');

  if v_when is not null and v_when - now() < interval '48 hours' then
    raise exception 'Do termínu zostáva menej ako 48 hodín — napíšte nám SMS s číslom objednávky na 0949 000 677.';
  end if;

  update orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

grant execute on function cancel_order(text, text) to anon, authenticated;
-- ============================================================
