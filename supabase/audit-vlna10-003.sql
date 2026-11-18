-- ============================================================
-- AUDIT-VLNA10-003 — oprava strážcu brán (18. 11. 2026)
--
-- Hodinová kontrola e-mailovej / SMS brány (http-watch z audit-vlna10-001)
-- počítala aj chybové odpovede BANKY. Fio máva krátke výpadky — 18. 11.
-- o 16:58 päť minút vracala chybu 500 a strážca poslal planý poplach
-- „e-mailová alebo SMS brána vracia chyby", hoci e-maily aj SMS chodili.
--
--  1  Odpovede banky sa do kontroly e-mailov a SMS už nepočítajú.
--  2  Banka má vlastnú kontrolu: upozornenie príde až vtedy, keď od nej
--     6 hodín neprišla žiadna úspešná odpoveď (typicky vypršaný prístupový
--     kľúč do Fio banky) — vtedy sa platby naozaj nepárujú.
--
-- Idempotentné. Spúšťať PO audit-vlna10-001.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('system_http_watch()') is null or to_regclass('public.fio_requests') is null then
    raise exception 'AUDIT-VLNA10-003: spustite najprv audit-vlna10-001.sql (a ste v projekte „USG objednavanie"?).';
  end if;
end $$;

create or replace function system_http_watch()
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int := 0; v_txt text; v_last timestamptz;
begin
  -- 1. e-mailová (Resend) a SMS brána (BulkGate): chybové odpovede za poslednú hodinu.
  --    Odpovede sa v databáze držia len pár hodín, preto hodinová kontrola. Banka sa
  --    sem nepočíta (audit-vlna10-003:banka) — krátke výpadky Fio sú bežné.
  begin
    select count(*), string_agg(distinct coalesce(r.status_code::text, 'bez odpovede') || ': ' || left(regexp_replace(coalesce(r.content, r.error_msg, ''), '\s+', ' ', 'g'), 160), E'\n')
      into v_n, v_txt
    from net._http_response r
    where r.created > now() - interval '65 minutes'
      and r.status_code >= 400   -- vypršania spojenia (bez kódu) sa nehlásia
      and coalesce(r.content, '') not like '%Requested function was not found%'
      and not exists (select 1 from fio_requests f where f.request_id = r.id);
  exception when others then
    v_n := 0;
  end;
  if v_n > 0 then
    perform health_event('http', false, left(v_n || ' chybných odpovedí: ' || v_txt, 480));
    perform staff_alert('http', 'Objednávanie NÚSCH: e-mailová alebo SMS brána vracia chyby',
      '<p><b>Za poslednú hodinu ' || v_n || ' odoslaní e-mailu alebo SMS skončilo chybou.</b> '
      || 'Pacienti nemuseli dostať potvrdenie, pripomienku alebo SMS kód. Skontrolujte kredit SMS brány a stav e-mailovej služby.</p>'
      || '<pre style="white-space:pre-wrap;font-size:12px;background:#f4f6f8;padding:8px;border-radius:6px">' || html_escape(left(v_txt, 800)) || '</pre>');
  end if;

  -- 2. banka: žiadna úspešná odpoveď dlhšie ako 6 hodín → platby sa nepárujú
  begin
    if app_secret('fio_token') not like 'SEM\_%' then
      select max(at) into v_last from health_events where source = 'fio' and ok;
      if v_last is not null and v_last < now() - interval '6 hours' then
        perform health_event('banka', false, 'bez úspešnej odpovede od ' || to_char(v_last at time zone 'Europe/Bratislava', 'DD.MM. HH24:MI'));
        perform staff_alert('banka', 'Objednávanie NÚSCH: banka neodpovedá — platby sa nepárujú',
          '<p><b>Od ' || to_char(v_last at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI')
          || ' neprišla z banky (Fio) žiadna úspešná odpoveď.</b> Prijaté platby sa zatiaľ automaticky nepárujú s objednávkami.</p>'
          || '<p>Najčastejšia príčina je vypršaný prístupový kľúč (token) do Fio banky: vytvorte nový v internetbankingu Fio '
          || 'a uložte ho v Supabase (Vault → fio_token). Po obnovení spojenia sa platby za posledné dni dopárujú samy.</p>');
      end if;
    end if;
  exception when others then
    null;
  end;
  return v_n;
end $$;
revoke all on function system_http_watch() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'system_http_watch' and prosrc like '%audit-vlna10-003:banka%') then
    raise exception 'AUDIT-VLNA10-003: oprava strážcu sa neaplikovala.';
  end if;
  if has_function_privilege('anon', 'system_http_watch()', 'execute') then
    raise exception 'AUDIT-VLNA10-003: system_http_watch je dostupná cez API.';
  end if;
  raise notice 'AUDIT-VLNA10-003 OK.';
end $$;
