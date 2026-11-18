-- ============================================================
-- ZABEZPECENIE-001 (18. 11. 2026) — dve veci z auditu
--
--  1  ŽIADANKA: povinnú žiadanku sa dalo obísť vlastným programom —
--     stačilo poslať „prílohu" bez nahratého súboru. → príloha bez
--     súboru v úložisku sa odmietne (stránka také prílohy neposiela);
--     obmedzená je aj veľkosť zoznamu príloh.
--  2  CT PRE LEKÁROV: overenie „nie som robot" (Cloudflare Turnstile)
--     pri zadaní spoločného hesla. Formuláre pacientov sa nemenia.
--     Zapína ho superadmin v Správe CT → Prístup pre lekárov; po spustení
--     tohto skriptu ostáva VYPNUTÉ. Výsledok overenia v prehliadačoch
--     lekárov sa zapisuje vždy, aby bolo pred zapnutím vidieť, či
--     v nemocničnej sieti prechádza. Vypnúť ho vie aj sestra (poistka,
--     keby sa lekári nevedeli prihlásiť).
--
-- Idempotentné. Spúšťať PO audit-vlna10-001.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('ct_doctor_login(text)') is null or to_regclass('public.human_passes') is null
     or to_regprocedure('assert_attachments(text,jsonb)') is null then
    raise exception 'ZABEZPECENIE-001: chýbajú predchádzajúce skripty (ct-lekari-001) — ste v projekte „USG objednavanie"?';
  end if;
end $$;

-- pomôcka: úprava existujúcej funkcie na mieste (raz — podľa značky)
create or replace function pg_temp.zab_patch(p_fn text, p_pattern text, p_repl text, p_marker text)
returns void language plpgsql as $f$
declare r record; v_def text; v_new text; n int := 0;
begin
  for r in select p.oid, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = p_fn loop
    n := n + 1;
    if strpos(r.prosrc, p_marker) > 0 then continue; end if;
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, p_pattern, p_repl);
    if v_new = v_def then
      raise exception 'ZABEZPECENIE-001: vo funkcii % sa nenašlo miesto na úpravu (%).', p_fn, p_marker;
    end if;
    execute v_new;
  end loop;
  if n = 0 then raise exception 'ZABEZPECENIE-001: funkcia % neexistuje.', p_fn; end if;
end $f$;

-- ------------------------------------------------------------
-- 1. žiadanka: príloha musí byť naozaj nahratý súbor tejto objednávky
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.zab_patch('assert_attachments',
    E'if v_path is null then\\s*continue;[^\\n]*\\n\\s*end if;',
    E'if jsonb_typeof(a) <> ''object'' or coalesce(v_path, '''') = '''' then -- zabezpecenie-001:priloha\n      raise exception ''Prílohu sa nepodarilo nahrať — nahrajte ju, prosím, znova.'';\n    end if;',
    'zabezpecenie-001:priloha');
  perform pg_temp.zab_patch('assert_attachments',
    E'(if p_attachments is null or jsonb_typeof\\(p_attachments\\) <> ''array'' then return; end if;)',
    E'\\1\n  if octet_length(p_attachments::text) > 8000 then -- zabezpecenie-001:velkost\n    raise exception ''Neplatný zoznam príloh.'';\n  end if;',
    'zabezpecenie-001:velkost');
end $$;

-- ------------------------------------------------------------
-- 2. CT pre lekárov: overenie „nie som robot" pri hesle
-- ------------------------------------------------------------
-- true = prihlásenie môže pokračovať. Preukaz vydáva Edge Function turnstile-pass
-- (platí 20 minút, najviac 6 použití); prehliadač ho posiela v hlavičke x-nusch-pass.
create or replace function ct_login_human_ok()
returns boolean
language plpgsql security definer set search_path = public as $$
declare h json; v_tsh text; v_pass text; v_n int;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  if h is null then return true; end if; -- SQL editor
  -- stav overenia v prehliadači lekára (ok / pending / err:… / timeout) — zapisuje sa vždy
  v_tsh := left(coalesce(h ->> 'x-nusch-ts', ''), 60);
  if v_tsh not in ('', 'idle') then
    perform health_event('turnstile:ct-login', v_tsh = 'ok', v_tsh);
  end if;
  if coalesce((select value from settings where key = 'ct_login_turnstile'), 'off') <> 'on' then
    return true;
  end if;
  v_pass := coalesce(h ->> 'x-nusch-pass', '');
  update human_passes set uses = uses + 1
    where id::text = v_pass and created_at > now() - interval '20 minutes' and uses < 6;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform health_event('bot-guard:ct-login', false,
      'chýba alebo neplatný preukaz Turnstile (' || coalesce(nullif(v_tsh, ''), 'bez stavu') || ')');
    return false;
  end if;
  return true;
end $$;
revoke all on function ct_login_human_ok() from public, anon, authenticated;

-- bez platného preukazu sa heslo vôbec neoveruje (vracia sa chyba, nie výnimka —
-- pokus sa tak započíta do limitu a zapíše do stavu systému)
do $$
begin
  perform pg_temp.zab_patch('ct_doctor_login',
    E'(perform check_rate_limit\\(''ct-doc-login:''[^\\n]*\\n)',
    E'\\1  if not ct_login_human_ok() then -- zabezpecenie-001:robot\n    return jsonb_build_object(''ok'', false, ''robot'', true, ''error'', ''Overenie, že nie ste robot, sa nepodarilo. Ak sa dole na stránke zobrazilo políčko na overenie, zaškrtnite ho a skúste to znova. Ak to pretrváva, kontaktujte CT pracovisko.'');\n  end if;\n',
    'zabezpecenie-001:robot');
end $$;

-- zapnutie: len superadmin; vypnutie: aj sestra (poistka)
create or replace function ct_set_login_robot_check(p_on boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_on boolean := coalesce(p_on, false);
begin
  if not mfa_ok() or my_role() not in ('superadmin', 'sestra') or (v_on and my_role() <> 'superadmin') then
    raise exception 'Overenie „nie som robot" môže zapnúť len superadmin (vypnúť aj sestra).';
  end if;
  insert into settings (key, value) values ('ct_login_turnstile', case when v_on then 'on' else 'off' end)
    on conflict (key) do update set value = excluded.value;
  return v_on;
end $$;
revoke all on function ct_set_login_robot_check(boolean) from public, anon;
grant execute on function ct_set_login_robot_check(boolean) to authenticated;

-- Správa CT: stav prepínača + výsledky overenia za 14 dní
do $$
begin
  perform pg_temp.zab_patch('ct_doctor_password_info',
    E'''activeSessions'', \\(select count\\(\\*\\) from ct_doctor_sessions where expires_at > now\\(\\)\\)\\);',
    E'''activeSessions'', (select count(*) from ct_doctor_sessions where expires_at > now()),\n'
    || E'    ''robotCheck'', coalesce((select value from settings where key = ''ct_login_turnstile''), ''off'') = ''on'', -- zabezpecenie-001:info\n'
    || E'    ''robotOk'', (select count(*) from health_events where source = ''turnstile:ct-login'' and ok and at > now() - interval ''14 days''),\n'
    || E'    ''robotFail'', (select count(*) from health_events where source = ''turnstile:ct-login'' and not ok and at > now() - interval ''14 days''),\n'
    || E'    ''robotBlocked'', (select count(*) from health_events where source = ''bot-guard:ct-login'' and at > now() - interval ''14 days''));',
    'zabezpecenie-001:info');
end $$;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'assert_attachments'
        and prosrc like '%zabezpecenie-001:priloha%' and prosrc like '%zabezpecenie-001:velkost%') <> 1 then
    raise exception 'ZABEZPECENIE-001: kontrola príloh sa neaplikovala.';
  end if;
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ct_doctor_login' and prosrc like '%zabezpecenie-001:robot%')
     or not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ct_doctor_password_info' and prosrc like '%zabezpecenie-001:info%') then
    raise exception 'ZABEZPECENIE-001: úprava prihlásenia lekárov sa neaplikovala.';
  end if;
  if has_function_privilege('anon', 'ct_login_human_ok()', 'execute') or has_function_privilege('anon', 'ct_set_login_robot_check(boolean)', 'execute') then
    raise exception 'ZABEZPECENIE-001: servisné funkcie sú dostupné bez prihlásenia.';
  end if;
  raise notice 'ZABEZPECENIE-001 OK. Overenie „nie som robot" pri hesle lekárov: %.',
    case when coalesce((select value from settings where key = 'ct_login_turnstile'), 'off') = 'on' then 'ZAPNUTÉ' else 'vypnuté (zapína sa v Správe CT)' end;
end $$;
