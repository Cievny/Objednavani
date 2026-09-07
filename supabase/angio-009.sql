-- ============================================================
-- ANGIO 009 — výrazné tlačidlo „Zmeniť / zrušiť termín" v e-mailoch (v2)
--   v2: tlačidlo ako tabuľka s bgcolor + <font color> (Apple Mail a Outlook
--   zahadzujú background na <a> — text bol biely na bielom) + textový odkaz;
--   ak už bola spustená v1, tlačidlo sa vymení
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
    if position('<font color="#ffffff">Zmeniť / zrušiť termín</font>' in v_body) > 0 then
      raise notice '% už má tlačidlo.', fn;
      continue;
    end if;
    -- staršia verzia tlačidla (len <a> s background) → vymeniť za tabuľkovú
    if position('Zmeniť / zrušiť termín</a><br>' in v_body) > 0 then
      v_body := regexp_replace(v_body,
        '<a href="https://objednanie\.cievny\.sk/#/angio1/objednavka/'' \|\| html_escape\((NEW|r)\.id\) \|\| ''" style="display:inline-block;margin:10px 0 8px;padding:10px 16px;background:#2B46A2;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold">Zmeniť / zrušiť termín</a><br>',
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 6px"><tr><td bgcolor="#2B46A2" style="background-color:#2B46A2;border-radius:8px;padding:10px 18px"><a href="https://objednanie.cievny.sk/#/angio1/objednavka/'' || html_escape(\1.id) || ''" style="color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block"><font color="#ffffff">Zmeniť / zrušiť termín</font></a></td></tr></table><div style="font-size:12px;color:#64748b;margin-bottom:6px">Alebo otvorte: <a href="https://objednanie.cievny.sk/#/angio1/objednavka/'' || html_escape(\1.id) || ''" style="color:#2B46A2">objednanie.cievny.sk/#/angio1/objednavka/'' || html_escape(\1.id) || ''</a></div>');
      if position('<font color="#ffffff">Zmeniť / zrušiť termín</font>' in v_body) > 0 then
        execute format('create or replace function %I(%s) returns %s language plpgsql security definer set search_path = public as %L', fn, v_args, v_ret, v_body);
        raise notice '% — tlačidlo vymenené za verziu pre Apple Mail / Outlook.', fn;
      else
        raise notice '% — staré tlačidlo sa nepodarilo vymeniť.', fn;
      end if;
      continue;
    end if;
    idexpr := case when fn = 'angio_notify_trigger' then 'NEW.id' else 'r.id' end;
    -- blok vložený do reťazca v tele funkcie (sme vnútri '…' literálu, preto ' || … || ')
    cta := '<div style="margin:16px 0 4px;padding:12px 14px;background:#FFF7E6;border:1px solid #F5C26B;border-radius:8px;font-size:14px">'
        || '<b>Potrebujete zmeniť alebo zrušiť termín?</b><br>Vybavte to prosím online, najneskôr 24 hodín vopred:<br>'
        -- „nepriestrelné" tlačidlo: tabuľka s bgcolor + font color (Apple Mail / Outlook zahadzujú background na <a>)
        || '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 6px"><tr><td bgcolor="#2B46A2" style="background-color:#2B46A2;border-radius:8px;padding:10px 18px">'
        || '<a href="https://objednanie.cievny.sk/#/angio1/objednavka/'' || html_escape(' || idexpr || ') || ''" '
        || 'style="color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block"><font color="#ffffff">Zmeniť / zrušiť termín</font></a></td></tr></table>'
        || '<div style="font-size:12px;color:#64748b;margin-bottom:6px">Alebo otvorte: <a href="https://objednanie.cievny.sk/#/angio1/objednavka/'' || html_escape(' || idexpr || ') || ''" style="color:#2B46A2">objednanie.cievny.sk/#/angio1/objednavka/'' || html_escape(' || idexpr || ') || ''</a></div>'
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
