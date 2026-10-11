-- ============================================================
-- ANGIO 011 — jasnejšia veta o orientačnom termíne v spoločných pokynoch
--   (e-mail). Na stránke objednávania je rovnaké upozornenie od v94.
--   Nahrádza len poslednú odrážku; ostatné pokyny ostávajú. Idempotentné.
-- ============================================================
update settings
set value = regexp_replace(value, E'(^|\\n)[^\\n]*orientačn[^\\n]*', E'\\1Termín vyšetrenia je orientačný. Vzhľadom na charakter nášho ústavu – špecializovaného pracoviska najvyššieho typu – môže byť potrebné prednostne ošetriť akútneho pacienta a váš čas sa môže posunúť. Ďakujeme za pochopenie; o plánovaných zmenách vás vopred informujeme e-mailom a SMS.')
where key = 'angio_common_notes' and value ~ 'orientačn' and value not like '%charakter nášho ústavu%';
-- Kontrola: select value from settings where key = 'angio_common_notes';
