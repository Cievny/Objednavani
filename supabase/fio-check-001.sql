-- ============================================================
-- FIO CHECK 001 — ručná kontrola „over všetky platby teraz"
--
-- Použitie v SQL editore:
--   select * from check_payments();
--
-- Funkcia najprv spustí párovanie (fio_poll) a potom vráti
-- prehľad všetkých aktívnych objednávok so stavom platby.
-- Kvôli asynchrónnej komunikácii s bankou platí: prvé spustenie
-- spáruje to, čo už je stiahnuté, a vyžiada čerstvé dáta; ak
-- čakáte na platbu z poslednej chvíle, spustite o pol minúty
-- ešte raz.
--
-- Automatické párovanie beží ďalej samo každých 5 minút —
-- toto je len kontrola na požiadanie.
-- ============================================================

create or replace function check_payments()
returns table (
  objednavka text,
  pacient text,
  termin text,
  cena numeric,
  vs text,
  zaplatene boolean,
  platba text
)
language plpgsql security definer set search_path = public as $$
begin
  if my_role() not in ('superadmin', 'sestra') then
    raise exception 'Kontrola platieb je dostupná len pre superadmina a sestru.';
  end if;

  perform fio_poll();

  return query
    select
      o.id,
      o.patient_name,
      to_char(o.slot_date, 'DD.MM.YYYY') || ' ' || to_char(o.slot_time, 'HH24:MI'),
      o.price,
      o.variable_symbol,
      o.paid,
      coalesce((
        select p.note || ' (' || replace(p.amount::text, '.', ',') || ' €, '
               || to_char(p.received_at, 'DD.MM. HH24:MI') || ')'
        from fio_payments p
        where p.matched_order_id = o.id
           or (p.vs <> '' and p.vs = o.variable_symbol)
        order by p.received_at desc
        limit 1
      ), '— platba zatiaľ neprišla')
    from orders o
    where o.status <> 'rejected' and o.slot_date >= current_date
    order by o.slot_date, o.slot_time;
end $$;

revoke all on function check_payments() from public, anon;
grant execute on function check_payments() to authenticated;
