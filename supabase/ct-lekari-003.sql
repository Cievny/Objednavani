-- ============================================================
-- CT-LEKARI-003 — stránka CT pre lekárov len na objednanie
--
-- Lekári so spoločným heslom už nevidia prehľad objednaných CT pacientov
-- (záložka „Objednaní pacienti" odstránená vo v124). Funkcia, ktorá ho
-- poskytovala, sa ruší, aby zoznam pacientov nebol dostupný ani priamo
-- cez API so spoločným heslom.
--
-- Idempotentné. Spúšťať PO ct-lekari-001.sql.
-- ============================================================

drop function if exists ct_doctor_list(text);

do $$
begin
  if to_regprocedure('ct_doctor_list(text)') is not null then
    raise exception 'CT-LEKARI-003: ct_doctor_list stále existuje.';
  end if;
  raise notice 'CT-LEKARI-003 OK.';
end $$;
