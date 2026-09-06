-- ============================================================
-- ANGIO 009 — výrazné tlačidlo „Zmeniť / zrušiť termín" v e-mailoch
--   V potvrdení, zmene termínu aj pripomienke pribudne hneď pod tabuľkou
--   s termínom zvýraznený blok s tlačidlom (odkaz #/angio1/objednavka/<ID>)
--   a vetou, že telefón/SMS je len pre naozaj nutné prípady.
--   Pätička sa skráti na „Vyšetrenie je bez poplatku." (bez duplicity).
--   Funguje s angio-008 aj bez neho. Telá funkcií sa menia v mieste,
--   kľúče ostávajú. Idempotentné. Spúšťať PO angio-004.
-- ============================================================

do $mig$
declare
  fn      text;
  v_body  text;
  v_ret   text;
  v_args  text;
  idexpr  text;
  cta     text;
  changed boolean;
begin
  foreach fn in array array['angio_notify_trigger', 'send_angio_reminders'] loop
    select prosrc, pg_get_function_result(oid), pg_get_function_arguments(oid) into v_body, v_ret, v_args
    from pg_proc where proname = fn and pronamespace = 'public'::regnamespace;
    if v_body is null then
      raise notice '% neexistuje — preskočené (spustite najprv angio-001…004).', fn;
      continue;
    end if;
    if position('Zmeniť / zrušiť termín' in v_body) > 0 then
      raise notice '% už má tlačidlo.', fn;
      continue;
    end if;
    idexpr := case when fn = 'angio_notify_trigger' then 'NEW.id' else 'r.id' end;
    -- blok vložený do reťazca v tele funkcie (sme vnútri '…' literálu, preto ' || … || ')
    cta := '<div style="margin:16px 0 4px;padding:12px 14px;background:#FFF7E6;border:1px solid #F5C26B;border-radius:8px;font-size:14px">'
        || '<b>Potrebujete zmeniť alebo zrušiť termín?</b><br>Vybavte to prosím online, najneskôr 24 hodín vopred:<br>'
        || '<a href="https://objednanie.cievny.sk/#/angio1/objednavka/'' || html_escape(' || idexpr || ') || ''" '
        || 'style="display:inline-block;margin:10px 0 8px;padding:10px 16px;background:#2B46A2;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold">Zmeniť / zrušiť termín</a><br>'
        || '<span style="font-size:12px;color:#64748b">Telefón/SMS 0949 000 677 len v naozaj nutných prípadoch – ozveme sa vám späť.</span></div>';
    changed := false;
    if fn = 'angio_notify_trigger' and position($t$|| '</table>'$t$ in v_body) > 0 then
      v_body := replace(v_body, $t$|| '</table>'$t$,
        $t$|| '</table>'
    || case when NEW.status <> 'rejected' then '$t$ || cta || $t$' else '' end$t$);
      changed := true;
    elsif fn = 'send_angio_reminders' and position($t$|| '</table>'$t$ in v_body) > 0 then
      v_body := replace(v_body, $t$|| '</table>'$t$, $t$|| '</table>' || '$t$ || cta || $t$'$t$);
      changed := true;
    end if;
    -- pätička: krátka (bez duplicity s blokom)
    v_body := regexp_replace(v_body,
      'Vyšetrenie je bez poplatku\. (Kontakt/zrušenie|Zrušenie): SMS na 0949 000 677 \(uveďte číslo objednávky\)\.</p>',
      'Vyšetrenie je bez poplatku.</p>');
    v_body := regexp_replace(v_body,
      'Vyšetrenie je bez poplatku\.</p><p style="margin:6px 0 0">Zmenu alebo zrušenie termínu vybavte prosím online:.*?ozveme sa vám späť\.</p>',
      'Vyšetrenie je bez poplatku.</p>');
    if not changed then
      raise notice '% — neočakávané telo, tlačidlo nepridané.', fn;
      continue;
    end if;
    execute format('create or replace function %I(%s) returns %s language plpgsql security definer set search_path = public as %L', fn, v_args, v_ret, v_body);
    raise notice '% — pridané tlačidlo Zmeniť / zrušiť termín.', fn;
  end loop;
end $mig$;

revoke all on function send_angio_reminders() from public, anon, authenticated;
-- ============================================================
