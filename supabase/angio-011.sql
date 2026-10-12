-- ============================================================
-- ANGIO 011 — jasnejšia veta o orientačnom termíne v spoločných pokynoch
--   (e-mail). Na stránke objednávania je rovnaké upozornenie od v94.
--   Nahrádza len poslednú odrážku; ostatné pokyny ostávajú. Idempotentné.
-- ============================================================
update settings
set value = regexp_replace(value, E'(^|\\n)[^\\n]*orientačn[^\\n]*', E'\\1Čas termínu je orientačný – ako pracovisko najvyššieho typu musíme niekedy prednostne ošetriť akútneho pacienta. Ďakujeme za pochopenie.')
where key = 'angio_common_notes' and value ~ 'orientačn' and value not like '%Ďakujeme za pochopenie%';
-- Kontrola: select value from settings where key = 'angio_common_notes';
