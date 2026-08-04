-- ============================================================
-- AUDIT VLNA 5 — 004  (RLS hygiena: WITH CHECK na UPDATE)
--
-- Bezpečnostný nález: UPDATE politiky na orders aj ct_orders mali
-- len USING (kontrola zdrojového riadku), bez WITH CHECK (kontrola
-- výsledného riadku). Lekár tak mohol na SVOJOM riadku prepísať
-- pole `doctor` na iného lekára a „vysunúť" riadok zo svojho
-- rozsahu. Finančné polia už chráni guard_order_update; toto
-- uzatvára aj integritu priradenia.
--
-- WITH CHECK zrkadlí USING: superadmin/sestra plný prístup,
-- lekár smie zapísať len riadok, ktorý ostáva jemu (doctor = my_doctor()).
--
-- Idempotentné. Bez kľúčov. Spúšťať PO audit-vlna4-001 a ct-002.
-- ============================================================

drop policy if exists "objednavky update" on orders;
create policy "objednavky update" on orders
  for update using (
    my_role() in ('superadmin', 'sestra')
    or (my_role() = 'lekar' and doctor = my_doctor())
  )
  with check (
    my_role() in ('superadmin', 'sestra')
    or (my_role() = 'lekar' and doctor = my_doctor())
  );

drop policy if exists "ct objednavky update" on ct_orders;
create policy "ct objednavky update" on ct_orders
  for update using (
    my_role() in ('superadmin', 'sestra')
    or (my_role() = 'lekar' and doctor = my_doctor())
  )
  with check (
    my_role() in ('superadmin', 'sestra')
    or (my_role() = 'lekar' and doctor = my_doctor())
  );
-- ============================================================
