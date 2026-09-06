-- ============================================================
-- ANGIO 008 — zmeny a zrušenia termínov prednostne online
--   Pacient mení/ruší termín sám cez systém (odkaz v e-maili alebo
--   „Už máte objednávku?" na stránke). Telefón/SMS len v naozaj nutných
--   prípadoch — pracovisko sa ozve späť.
--   • e-maily (potvrdenie, zmena, pripomienka): pätička s odkazom
--     „spravovať objednávku" (https://objednanie.cievny.sk/#/angio1/objednavka/<ID>)
--   • SMS pripomienka: „Zmena/zrusenie online cez odkaz v e-maili."
--   • angio_patient_reschedule: hláška pri < 24 h
--   • spoločné pokyny: bod o zrušení/presune doplnený o online postup
--     (len ak je v pôvodnom znení)
--   Telá funkcií sa upravujú v mieste (kľúče ostávajú). Idempotentné.
--   Spúšťať PO angio-007 (a audit-vlna7-001, ak bol spustený).
-- ============================================================

do $mig$
declare
  fn      text;
  v_body  text;
  v_ret   text;
  v_args  text;
  changed boolean;
  v_new_foot_new text := $s$Vyšetrenie je bez poplatku.</p><p style="margin:6px 0 0">Zmenu alebo zrušenie termínu vybavte prosím online: <a href="https://objednanie.cievny.sk/#/angio1/objednavka/' || html_escape(NEW.id) || '" style="color:#2B46A2;font-weight:bold">spravovať objednávku</a> (číslo objednávky + telefón, najneskôr 24 hodín vopred). Telefón/SMS 0949 000 677 len v naozaj nutných prípadoch – ozveme sa vám späť.</p>$s$;
  v_new_foot_rem text := $s$Vyšetrenie je bez poplatku.</p><p style="margin:6px 0 0">Zmenu alebo zrušenie termínu vybavte prosím online: <a href="https://objednanie.cievny.sk/#/angio1/objednavka/' || html_escape(r.id) || '" style="color:#2B46A2;font-weight:bold">spravovať objednávku</a> (číslo objednávky + telefón, najneskôr 24 hodín vopred). Telefón/SMS 0949 000 677 len v naozaj nutných prípadoch – ozveme sa vám späť.</p>$s$;
begin
  foreach fn in array array['angio_notify_trigger', 'send_angio_reminders', 'send_angio_sms_reminders', 'angio_patient_reschedule'] loop
    select prosrc, pg_get_function_result(oid), pg_get_function_arguments(oid) into v_body, v_ret, v_args
    from pg_proc where proname = fn and pronamespace = 'public'::regnamespace;
    if v_body is null then
      raise notice '% neexistuje — preskočené (spustite najprv angio-001…007).', fn;
      continue;
    end if;
    changed := false;

    if fn = 'angio_notify_trigger' and position('Kontakt/zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p>' in v_body) > 0 then
      v_body := replace(v_body, 'Vyšetrenie je bez poplatku. Kontakt/zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p>', v_new_foot_new);
      changed := true;
    end if;
    if fn = 'send_angio_reminders' and position('Zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p>' in v_body) > 0 then
      v_body := replace(v_body, 'Vyšetrenie je bez poplatku. Zrušenie: SMS na 0949 000 677 (uveďte číslo objednávky).</p>', v_new_foot_rem);
      changed := true;
    end if;
    if fn = 'send_angio_sms_reminders' and position('Zrusenie: SMS na 0949 000 677.' in v_body) > 0 then
      v_body := replace(v_body, 'Zrusenie: SMS na 0949 000 677.', 'Zmena/zrusenie online cez odkaz v e-maili.');
      changed := true;
    end if;
    if fn = 'angio_patient_reschedule' and position('Napíšte nám SMS na 0949 000 677 (uveďte číslo objednávky).' in v_body) > 0 then
      v_body := replace(v_body, 'Napíšte nám SMS na 0949 000 677 (uveďte číslo objednávky).', 'V naozaj nutnom prípade nám napíšte SMS na 0949 000 677 (uveďte číslo objednávky) – ozveme sa vám späť.');
      changed := true;
    end if;

    if not changed then
      raise notice '% — už upravené alebo neočakávané telo, bez zmeny.', fn;
      continue;
    end if;
    execute format('create or replace function %I(%s) returns %s language plpgsql security definer set search_path = public as %L', fn, v_args, v_ret, v_body);
    raise notice '% — texty upravené (zmeny/zrušenia online).', fn;
  end loop;
end $mig$;

revoke all on function send_angio_reminders() from public, anon, authenticated;
do $$ begin revoke all on function send_angio_sms_reminders() from public, anon, authenticated; exception when others then null; end $$;

-- spoločné pokyny: bod o zrušení/presune (len ak je v pôvodnom znení)
update settings set value = replace(value,
  'Ak nemôžete prísť, zrušte alebo presuňte termín aspoň 24 hodín vopred – uvoľníte miesto inému pacientovi.',
  'Ak nemôžete prísť, zrušte alebo presuňte termín online (odkaz v e-maili alebo „Už máte objednávku?" na stránke) aspoň 24 hodín vopred – uvoľníte miesto inému pacientovi. Telefón/SMS len v naozaj nutných prípadoch – ozveme sa vám späť.')
where key = 'angio_common_notes'
  and position('Ak nemôžete prísť, zrušte alebo presuňte termín aspoň 24 hodín vopred – uvoľníte miesto inému pacientovi.' in value) > 0;
-- ============================================================
