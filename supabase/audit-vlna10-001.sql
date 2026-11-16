-- ============================================================
-- AUDIT-VLNA10-001 — opravy z veľkého auditu (16. 11. 2026)
--
-- Vznikol po incidente „objednávka sa nedá zrušiť" (prilohy-mazanie-001).
-- Rieši ďalšie miesta, kde systém robil niečo zle alebo potichu zlyhával:
--
--  1  STARÉ TERMÍNY: otvorené bunky termínov sa nikdy nemazali (USG 748
--     riadkov od júla). API vracia najviac 1000 riadkov na požiadavku —
--     po prekročení by časť dní pacientom aj personálu potichu zmizla.
--     → purge_past_slots() denne zmaže bunky staršie ako 14 dní.
--     (Stránky od v130 navyše načítavajú termíny po stránkach.)
--  2  PLATBY: tlačidlo „Skontrolovať platby" volalo dopyt do banky, ktorý
--     čaká 8 s — presne limit pre personál → spadlo na časový limit a
--     nechalo zamknutú kontrolu, takže automatické párovanie platieb
--     stálo, kým sa spojenie nezavrelo. → tlačidlo už len číta stav
--     (banka sa kontroluje automaticky každú minútu), zámok sa uvoľní vždy.
--  3  CT: verejná funkcia ct_create_order dovoľovala komukoľvek vytvoriť
--     CT objednávku bez hesla pre lekárov. → prístup zrušený.
--  4  FAKTÚRY: „Vystaviť chýbajúce faktúry" nemohol spustiť nikto
--     (chýbalo oprávnenie). → superadmin už môže.
--  5  PRIPOMIENKY: posielali sa aj na DNEŠNÉ termíny s textom „zajtra"
--     (pacient ju dostal o 16:00 po vyšetrení). → už len deň vopred.
--  6  PRIPOMIENKY PO PRESUNE: po presune termínu sa pripomienka už
--     neposlala (príznak „odoslané" ostal). → presun do budúcnosti ho vynuluje.
--  7  CT: keď CT pracovisko ZAMIETLO žiadosť lekára o presun už
--     potvrdeného termínu, pacient sa nedozvedel, že termín neplatí.
--     → dostane SMS aj e-mail o zrušení (s pôvodným termínom).
--  8  E-MAILY: chyba pri skladaní e-mailu (USG, CT) by zablokovala celú
--     zmenu objednávky — rovnaký typ chyby ako pri prílohách. → chyba sa
--     zapíše do stavu systému a zmena objednávky prejde.
--  9  STRÁŽCA: hlási aj chyby zapísané do stavu systému a každú hodinu
--     kontroluje, či e-mailová / SMS brána nevracia chyby.
-- 10  Zaradenie príloh na zmazanie už nezlyhá potichu (zapíše sa chyba).
-- 11  CT: pri zrušení sa vymažú aj klinické údaje (kontrast, kreatinín)
--     a odtlačok rodného čísla.
-- 12  USG: e-mail „termín potvrdený" netvrdí „platbu sme prijali", keď
--     objednávka zaplatená nie je.
-- 13  USG: keď sa zruší ZAPLATENÁ objednávka, pacient dostal prísľub
--     vrátenia platby do 7 pracovných dní, ale personál sa to nedozvedel
--     a záznam sa po 7 dňoch zmazal. → e-mail „vrátiť platbu" personálu.
-- 14  ANGIO pripomienka (posiela sa o 16:00 deň vopred) ponúkala zmenu /
--     zrušenie online „najneskôr 24 hodín vopred" — vtedy to už nejde.
--     → ak ostáva menej ako 24 h, pripomienka pýta SMS na 0949 000 677.
-- 15  SMS: číslo zadané ako „+421 0949 …" (nula navyše) sa prekladalo
--     na neplatné číslo a SMS sa stratila. → opravené.
-- 16  E-maily angiológie a CT mali v hlavičke „Objednávanie na USG".
-- 17  ANGIO: online zrušenie vyžaduje telefónne číslo (ako USG a CT).
-- 18  STRÁŽCA hlási aj chýbajúci / nečitateľný kľúč k e-mailovej službe,
--     SMS bráne alebo banke (doteraz by všetko potichu prestalo chodiť).
-- 19  Jednorazové SMS kódy staršie ako deň sa mažú každú noc.
--
-- Idempotentné. Spúšťať PO prilohy-mazanie-001.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('system_watchdog()') is null or to_regclass('public.attachment_purge_queue') is null then
    raise exception 'AUDIT-VLNA10-001: spustite najprv prilohy-mazanie-001.sql (a ste v projekte „USG objednavanie"?).';
  end if;
end $$;

-- pomôcka: úprava existujúcej funkcie na mieste (raz — podľa značky)
create or replace function pg_temp.av10_patch(p_fn text, p_pattern text, p_repl text, p_marker text, p_flags text default '')
returns void language plpgsql as $f$
declare r record; v_def text; v_new text; n int := 0;
begin
  for r in select p.oid, p.prosrc from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = p_fn loop
    n := n + 1;
    if strpos(r.prosrc, p_marker) > 0 then continue; end if;
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, p_pattern, p_repl, p_flags);
    if v_new = v_def then
      raise exception 'AUDIT-VLNA10-001: vo funkcii % sa nenašlo miesto na úpravu (%).', p_fn, p_marker;
    end if;
    execute v_new;
  end loop;
  if n = 0 then raise exception 'AUDIT-VLNA10-001: funkcia % neexistuje.', p_fn; end if;
end $f$;

-- ------------------------------------------------------------
-- 1. staré otvorené termíny
-- ------------------------------------------------------------
create or replace function purge_past_slots()
returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; m int;
begin
  delete from open_slots where slot_date < current_date - 14;        get diagnostics m = row_count; n := n + m;
  delete from angio_open_slots where slot_date < current_date - 14;  get diagnostics m = row_count; n := n + m;
  delete from ct_open_slots where slot_date < current_date - 14;     get diagnostics m = row_count; n := n + m;
  -- (19) jednorazové SMS kódy staršie ako deň (doteraz sa mazali len pri poslaní ďalšieho kódu)
  delete from phone_verifications where created_at < now() - interval '1 day';
  return n;
end $$;
revoke all on function purge_past_slots() from public, anon, authenticated;
do $$ begin perform cron.unschedule('slots-cleanup'); exception when others then null; end $$;
select cron.schedule('slots-cleanup', '35 1 * * *', $$select purge_past_slots()$$);

-- ------------------------------------------------------------
-- 2. platby: zámok na úrovni transakcie, tlačidlo bez čakania na banku
-- ------------------------------------------------------------
create or replace function fio_poll_guarded()
returns integer
language plpgsql security definer set search_path = public as $$
declare v int := 0;
begin
  -- zámok platí len do konca transakcie → uvoľní sa aj pri prerušení dopytu (audit-vlna10)
  if not pg_try_advisory_xact_lock(hashtext('fio_poll')) then
    return 0;
  end if;
  begin
    v := fio_poll();
  exception when others then
    perform health_event('fio', false, 'fio_poll: ' || sqlerrm);
    raise;
  end;
  return v;
end $$;
revoke all on function fio_poll_guarded() from public, anon, authenticated;

do $$
begin
  perform pg_temp.av10_patch('check_payments',
    E'\\n[ \\t]*perform fio_poll_guarded\\(\\);',
    E'\n  -- audit-vlna10: banku kontroluje automatická úloha každú minútu; tu sa už len číta stav',
    'audit-vlna10: banku');
end $$;

-- ------------------------------------------------------------
-- 3. CT: verejné vytvorenie objednávky bez hesla lekárov — zrušené
-- ------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'ct_create_order' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4. chýbajúce faktúry: superadmin ich vie vystaviť (funkcia si rolu overuje sama)
-- ------------------------------------------------------------
grant execute on function issue_missing_invoices() to authenticated;

-- ------------------------------------------------------------
-- 5. pripomienky len deň vopred (nie v deň termínu s textom „zajtra")
-- ------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['send_reminders', 'send_angio_reminders', 'send_angio_sms_reminders', 'send_ct_reminders'] loop
    perform pg_temp.av10_patch(f,
      'slot_date between current_date and current_date \+ 1',
      'slot_date = current_date + 1',
      'slot_date = current_date + 1');
  end loop;
end $$;

-- ------------------------------------------------------------
-- 6. po presune termínu poslať pripomienku znova
-- ------------------------------------------------------------
create or replace function usg_reminder_reset()
returns trigger language plpgsql as $$
begin
  if (NEW.slot_date is distinct from OLD.slot_date or NEW.slot_time is distinct from OLD.slot_time)
     and NEW.notify_patient is not false and NEW.reminder_sent_at is not null
     and NEW.slot_date > current_date then
    NEW.reminder_sent_at := null;
  end if;
  return NEW;
exception when others then
  return NEW;
end $$;
create or replace function clinic_reminder_reset()
returns trigger language plpgsql as $$
begin
  if (NEW.slot_date is distinct from OLD.slot_date or NEW.slot_time is distinct from OLD.slot_time)
     and NEW.notify_patient is not false and NEW.slot_date > current_date then
    NEW.reminder_sent_at := null;
    NEW.sms_reminder_sent_at := null;
  end if;
  return NEW;
exception when others then
  return NEW;
end $$;
revoke all on function usg_reminder_reset() from public, anon, authenticated;
revoke all on function clinic_reminder_reset() from public, anon, authenticated;
drop trigger if exists orders_reminder_reset on orders;
create trigger orders_reminder_reset before update of slot_date, slot_time on orders
  for each row execute function usg_reminder_reset();
drop trigger if exists angio_orders_reminder_reset on angio_orders;
create trigger angio_orders_reminder_reset before update of slot_date, slot_time on angio_orders
  for each row execute function clinic_reminder_reset();
drop trigger if exists ct_orders_reminder_reset on ct_orders;
create trigger ct_orders_reminder_reset before update of slot_date, slot_time on ct_orders
  for each row execute function clinic_reminder_reset();

-- ------------------------------------------------------------
-- 7. CT: zamietnutá žiadosť o presun potvrdeného termínu → pacient dostane zrušenie
-- ------------------------------------------------------------
do $$
begin
  -- e-mail: nemlčať, keď rušená „nová" objednávka je žiadosť o presun (pacient mal potvrdený pôvodný termín)
  perform pg_temp.av10_patch('ct_notify_trigger',
    E'\\(TG_OP = ''UPDATE'' and OLD\\.status = ''new'' and NEW\\.status = ''rejected''\\)',
    E'(TG_OP = ''UPDATE'' and OLD.status = ''new'' and NEW.status = ''rejected'' and coalesce(OLD.status_note, '''') not like ''Žiadosť o presun z %'')',
    'not like ''Žiadosť o presun z %''');
  -- e-mail: v takom prípade uviesť pôvodný termín (ten pacient pozná)
  perform pg_temp.av10_patch('ct_notify_trigger',
    E'(v_termin := to_char\\(NEW\\.slot_date, ''DD\\.MM\\.YYYY''\\) \\|\\| '' o '' \\|\\| to_char\\(NEW\\.slot_time, ''HH24:MI''\\);)',
    E'\\1\n  -- audit-vlna10:povodny-termin\n'
    || E'  if TG_OP = ''UPDATE'' then\n'
    || E'    if NEW.status = ''rejected'' and OLD.status = ''new'' and coalesce(OLD.status_note, '''') like ''Žiadosť o presun z %'' then\n'
    || E'      v_termin := coalesce(regexp_replace(substring(OLD.status_note from ''Žiadosť o presun z ([0-9]{2}[.][0-9]{2}[.][0-9]{4} [0-9]{2}:[0-9]{2})''), '' '', '' o ''), v_termin);\n'
    || E'    end if;\n'
    || E'  end if;',
    'audit-vlna10:povodny-termin');
  -- e-mail: dôvod zrušenia (píše personál) bezpečne do HTML
  perform pg_temp.av10_patch('ct_notify_trigger',
    E''' '' \\|\\| NEW\\.status_note else',
    E''' '' || html_escape(NEW.status_note) else',
    'html_escape(NEW.status_note)');
  -- SMS: to isté
  perform pg_temp.av10_patch('ct_notify_sms',
    E'and \\(OLD\\.status = ''confirmed'' or coalesce\\(NEW\\.requested_by, ''''\\) = ''''\\) then',
    E'and (OLD.status = ''confirmed'' or coalesce(NEW.requested_by, '''') = '''' or coalesce(OLD.status_note, '''') like ''Žiadosť o presun z %'') then',
    'like ''Žiadosť o presun z %''');
  perform pg_temp.av10_patch('ct_notify_sms',
    E'(v_termin := to_char\\(NEW\\.slot_date, ''DD\\.MM\\.YYYY''\\) \\|\\| '' o '' \\|\\| to_char\\(NEW\\.slot_time, ''HH24:MI''\\);)',
    E'\\1\n  -- audit-vlna10:povodny-termin\n'
    || E'  if TG_OP = ''UPDATE'' then\n'
    || E'    if NEW.status = ''rejected'' and OLD.status = ''new'' and coalesce(OLD.status_note, '''') like ''Žiadosť o presun z %'' then\n'
    || E'      v_termin := coalesce(regexp_replace(substring(OLD.status_note from ''Žiadosť o presun z ([0-9]{2}[.][0-9]{2}[.][0-9]{4} [0-9]{2}:[0-9]{2})''), '' '', '' o ''), v_termin);\n'
    || E'    end if;\n'
    || E'  end if;',
    'audit-vlna10:povodny-termin');
end $$;

-- ------------------------------------------------------------
-- 8. chyba pri skladaní e-mailu nesmie zablokovať zmenu objednávky
-- ------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['notify_order_emails', 'ct_notify_trigger'] loop
    perform pg_temp.av10_patch(f,
      E'\\nend \\$function\\$\\s*$',
      E'\nexception when others then\n'
      || E'  -- audit-vlna10:handler (chyba e-mailu sa zapíše do stavu systému, zmena objednávky prejde)\n'
      || E'  perform health_event(''trigger:' || f || E''', false, left(sqlerrm, 300));\n'
      || E'  return coalesce(NEW, OLD);\n'
      || E'end $function$\n',
      'audit-vlna10:handler');
  end loop;
end $$;

-- ------------------------------------------------------------
-- 9. strážca: chyby zo stavu systému + hodinová kontrola e-mailovej / SMS brány
-- ------------------------------------------------------------
create or replace function system_watchdog()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_fail text; v_jobs int := 0; v_q int := 0; v_old int := 0; v_bad text; v_badn int := 0; v_sec text;
begin
  begin
    select string_agg(x.jobname || ' (' || x.n || '×): ' || x.msg, E'\n' order by x.jobname), count(*)
      into v_fail, v_jobs
    from (
      select j.jobname, count(*) as n, left(regexp_replace(max(d.return_message), '\s+', ' ', 'g'), 220) as msg
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where d.status = 'failed' and d.start_time > now() - interval '26 hours'
      group by j.jobname) x;
  exception when others then
    v_fail := 'Strážca nevie čítať históriu úloh: ' || sqlerrm; v_jobs := 1;
  end;
  select count(*), count(*) filter (where queued_at < now() - interval '24 hours') into v_q, v_old from attachment_purge_queue;
  -- chyby, ktoré systém zachytil a zapísal (e-mailové triggery, mazanie príloh, zaraďovanie do radu)
  select string_agg(y.source || ' (' || y.n || '×): ' || y.detail, E'\n' order by y.source), coalesce(sum(y.n), 0)
    into v_bad, v_badn
  from (
    select h.source, count(*) as n, left(max(h.detail), 200) as detail
    from health_events h
    where not h.ok and h.at > now() - interval '26 hours'
      and (h.source like 'trigger:%' or h.source in ('prilohy-purge', 'prilohy-enqueue'))
    group by h.source) y;

  -- (18) kľúče k e-mailovej službe, SMS bráne a banke: bez nich funkcie potichu nič neposielajú
  select string_agg(k.label, ', ') into v_sec
  from (values ('resend_api_key', 'e-maily (Resend)'), ('bulkgate_app_id', 'SMS (BulkGate – ID)'),
               ('bulkgate_app_token', 'SMS (BulkGate – token)'), ('fio_token', 'banka (Fio)')) k(name, label)
  where app_secret(k.name) like 'SEM\_%';

  perform health_event('watchdog', coalesce(v_jobs, 0) = 0 and v_old = 0 and v_badn = 0 and v_sec is null,
    'zlyhané úlohy: ' || coalesce(v_jobs, 0) || ', prílohy v rade: ' || v_q || ' (dlhšie ako 24 h: ' || v_old || '), zachytené chyby: ' || v_badn
    || case when v_sec is not null then ', chýbajúce kľúče: ' || v_sec else '' end);
  if v_sec is not null then
    perform staff_alert('kluce', 'Objednávanie NÚSCH: chýba kľúč k službe — ' || v_sec,
      '<p><b>Systém nevie prečítať prístupový kľúč: ' || html_escape(v_sec) || '.</b> '
      || 'Kým sa to neopraví, príslušné správy sa neposielajú (potvrdenia, pripomienky, SMS kódy) alebo sa nepárujú platby. '
      || 'Treba to dať skontrolovať správcovi systému (Supabase → Vault).</p>');
  end if;
  if coalesce(v_jobs, 0) > 0 then
    perform staff_alert('cron', 'Objednávanie NÚSCH: zlyhala automatická nočná úloha',
      '<p><b>Za posledných 24 hodín zlyhala automatická úloha systému</b> (mazanie starých údajov, pripomienky alebo párovanie platieb). '
      || 'Treba to dať skontrolovať správcovi systému.</p><pre style="white-space:pre-wrap;font-size:12px;background:#f4f6f8;padding:8px;border-radius:6px">'
      || html_escape(v_fail) || '</pre>');
  end if;
  if v_old > 0 then
    perform staff_alert('prilohy', 'Objednávanie NÚSCH: prílohy čakajú na zmazanie dlhšie ako 24 hodín',
      '<p><b>' || v_old || ' súborov príloh (žiadanky, správy) čaká na zmazanie dlhšie ako 24 hodín.</b> '
      || 'Mazanie zabezpečuje funkcia purge-prilohy; treba to dať skontrolovať správcovi systému.</p>');
  end if;
  if v_badn > 0 then
    perform staff_alert('zachytene', 'Objednávanie NÚSCH: systém zachytil chybu pri automatickej činnosti',
      '<p><b>Za posledných 24 hodín systém zachytil ' || v_badn || ' chýb</b> (odosielanie e-mailov pri zmene objednávky alebo mazanie príloh). '
      || 'Objednávky fungujú ďalej, ale treba to dať skontrolovať správcovi systému.</p><pre style="white-space:pre-wrap;font-size:12px;background:#f4f6f8;padding:8px;border-radius:6px">'
      || html_escape(v_bad) || '</pre>');
  end if;
  return jsonb_build_object('failed_jobs', coalesce(v_jobs, 0), 'queue', v_q, 'queue_older_24h', v_old, 'caught_errors', v_badn, 'missing_keys', coalesce(v_sec, ''));
end $$;
revoke all on function system_watchdog() from public, anon, authenticated;

-- každú hodinu: nevracia e-mailová (Resend) alebo SMS brána (BulkGate) chyby?
-- (odpovede sa v databáze držia len pár hodín, preto hodinová kontrola)
create or replace function system_http_watch()
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int := 0; v_txt text;
begin
  begin
    select count(*), string_agg(distinct coalesce(r.status_code::text, 'bez odpovede') || ': ' || left(regexp_replace(coalesce(r.content, r.error_msg, ''), '\s+', ' ', 'g'), 160), E'\n')
      into v_n, v_txt
    from net._http_response r
    where r.created > now() - interval '65 minutes'
      and r.status_code >= 400   -- vypršania spojenia (bez kódu) sa nehlásia: banka občas neodpovie
      and coalesce(r.content, '') not like '%Requested function was not found%';
  exception when others then
    return 0;
  end;
  if v_n > 0 then
    perform health_event('http', false, left(v_n || ' chybných odpovedí: ' || v_txt, 480));
    perform staff_alert('http', 'Objednávanie NÚSCH: e-mailová alebo SMS brána vracia chyby',
      '<p><b>Za poslednú hodinu ' || v_n || ' odoslaní (e-mail, SMS alebo banka) skončilo chybou.</b> '
      || 'Pacienti nemuseli dostať potvrdenie, pripomienku alebo SMS kód. Skontrolujte kredit SMS brány a stav e-mailovej služby.</p>'
      || '<pre style="white-space:pre-wrap;font-size:12px;background:#f4f6f8;padding:8px;border-radius:6px">' || html_escape(left(v_txt, 800)) || '</pre>');
  end if;
  return v_n;
end $$;
revoke all on function system_http_watch() from public, anon, authenticated;
do $$ begin perform cron.unschedule('http-watch'); exception when others then null; end $$;
select cron.schedule('http-watch', '7 * * * *', $$select system_http_watch()$$);

-- ------------------------------------------------------------
-- 10. zaradenie príloh na zmazanie: zlyhanie zapísať (nie potichu vrátiť 0)
-- ------------------------------------------------------------
create or replace function attachment_purge_enqueue(p_order_id text)
returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if p_order_id is null or length(p_order_id) < 5 then return 0; end if;
  insert into attachment_purge_queue (path)
  select o.name from storage.objects o
  where o.bucket_id = 'prilohy'
    and upper(left(o.name, length(p_order_id) + 1)) = upper(p_order_id) || '/'
  on conflict (bucket, path) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform attachment_purge_kick(); end if;
  return n;
exception when others then
  perform health_event('prilohy-enqueue', false, left(coalesce(p_order_id, '') || ': ' || sqlerrm, 300));
  return 0;
end $$;
revoke all on function attachment_purge_enqueue(text) from public, anon, authenticated;

create or replace function purge_orphan_attachments()
returns integer
language plpgsql security definer set search_path = public as $$
declare v int := 0;
begin
  insert into attachment_purge_queue (path)
  select o.name from storage.objects o
  where o.bucket_id = 'prilohy'
    and o.created_at < now() - interval '1 day'
    and upper(split_part(o.name, '/', 1)) not in (
      select upper(id) from orders
      union all select upper(id) from ct_orders
      union all select upper(id) from angio_orders)
  on conflict (bucket, path) do nothing;
  get diagnostics v = row_count;
  if v > 0 then perform attachment_purge_kick(); end if;
  return v;
exception when others then
  perform health_event('prilohy-enqueue', false, left('siroty: ' || sqlerrm, 300));
  return 0;
end $$;
revoke all on function purge_orphan_attachments() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 11. CT: pri zrušení vymazať aj klinické údaje a odtlačok r.č.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.av10_patch('ct_scrub_trigger',
    E'(NEW\\.reason := '''';)',
    E'\\1\n    NEW.clinical := ''{}''::jsonb; NEW.rc_hash := ''''; -- audit-vlna10:klinicke',
    'audit-vlna10:klinicke');
end $$;

-- ------------------------------------------------------------
-- 12. USG: „platbu sme prijali" len keď je objednávka naozaj zaplatená
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.av10_patch('notify_order_emails',
    E'''<p>Platbu sme prijali a termín vyšetrenia je záväzne potvrdený\\.</p>''',
    E'case when NEW.paid or coalesce(NEW.price, 0) = 0 then ''<p>Platbu sme prijali a termín vyšetrenia je záväzne potvrdený.</p>'' else ''<p>Termín vyšetrenia je potvrdený.</p>'' end /* audit-vlna10:platba */',
    'audit-vlna10:platba');
end $$;

-- ------------------------------------------------------------
-- 13. USG: zrušená ZAPLATENÁ objednávka → personál dostane e-mail „vrátiť platbu"
-- ------------------------------------------------------------
create or replace function usg_refund_notice()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_key text; v_from text; v_to text; v_arr jsonb; v_price text;
begin
  if not (OLD.status <> 'rejected' and NEW.status = 'rejected' and NEW.paid and coalesce(NEW.price, 0) > 0) then
    return NEW;
  end if;
  v_price := replace(to_char(NEW.price, 'FM990D00'), '.', ',') || ' €';
  perform health_event('vratit-platbu', true, NEW.id || ': ' || v_price);
  v_key := app_secret('resend_api_key');
  if v_key like 'SEM\_%' then return NEW; end if;
  select string_agg(value, ',') into v_to from settings where key in ('copy_email', 'notify_email');
  select jsonb_agg(distinct a) into v_arr
    from (select lower(btrim(x)) as a from unnest(string_to_array(coalesce(v_to, ''), ',')) x) s
    where a <> '' and a like '%@%';
  if v_arr is null then return NEW; end if;
  select value into v_from from settings where key = 'mail_from';
  if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', v_arr,
      'subject', 'USG: vrátiť platbu ' || v_price || ' — zrušená zaplatená objednávka ' || NEW.id,
      'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
        || email_header()
        || '<h2 style="color:#003d7c">Treba vrátiť platbu</h2>'
        || '<p>Zaplatená objednávka USG bola zrušená. Pacientovi sme e-mailom prisľúbili vrátenie platby '
        || '<b>do 7 pracovných dní</b> prevodom na účet, z ktorého platba prišla.</p>'
        || '<table style="border-collapse:collapse;font-size:14px">'
        || '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Suma</td><td><b>' || v_price || '</b></td></tr>'
        || '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Variabilný symbol</td><td><b>' || html_escape(coalesce(NEW.variable_symbol, '')) || '</b></td></tr>'
        || '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Objednávka</td><td>' || html_escape(NEW.id) || '</td></tr>'
        || '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Pacient</td><td>' || html_escape(coalesce(NEW.patient_name, '')) || '</td></tr>'
        || '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Vyšetrenie</td><td>' || html_escape(coalesce(NEW.exam_label, '')) || '</td></tr>'
        || '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Termín</td><td>' || to_char(NEW.slot_date, 'DD.MM.YYYY') || ' o ' || to_char(NEW.slot_time, 'HH24:MI') || '</td></tr>'
        || '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Zaplatené</td><td>' || coalesce(to_char(NEW.paid_at at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI'), '—') || '</td></tr>'
        || '<tr><td style="padding:3px 12px 3px 0;color:#64748b">Dôvod zrušenia</td><td>' || html_escape(coalesce(nullif(NEW.status_note, ''), '—')) || '</td></tr>'
        || '</table>'
        || '<p style="font-size:13px">Platbu nájdete v banke podľa variabilného symbolu. Dobropis vystavil systém automaticky (Faktúry).</p>'
        || '<p style="font-size:13px;color:#64748b">Záznam objednávky sa z aplikácie zmaže 7 dní po zrušení — tento e-mail si odložte, kým platbu nevrátite.</p>'
        || '</div>'));
  return NEW;
exception when others then
  begin perform health_event('trigger:usg_refund_notice', false, left(sqlerrm, 300)); exception when others then null; end;
  return NEW;
end $$;
revoke all on function usg_refund_notice() from public, anon, authenticated;
drop trigger if exists orders_refund_notice on orders;
create trigger orders_refund_notice after update of status on orders
  for each row execute function usg_refund_notice();

-- ------------------------------------------------------------
-- 14. ANGIO pripomienka: menej ako 24 h do termínu → online zmena už nejde, pýtať SMS
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.av10_patch('send_angio_reminders',
    E'Vybavte to prosím online, najneskôr 24 hodín vopred:<br>',
    E''' || case when (r.slot_date + r.slot_time) at time zone ''Europe/Bratislava'' < now() + interval ''24 hours'' then ''Online to už nie je možné (do termínu ostáva menej ako 24 hodín). Napíšte nám prosím SMS s číslom objednávky '' || html_escape(r.id) || '' na 0949 000 677, aby sme termín mohli ponúknuť inému pacientovi. Objednávku si pozriete tu:'' else ''Vybavte to prosím online, najneskôr 24 hodín vopred:'' end /* audit-vlna10:pripomienka24 */ || ''<br>',
    'audit-vlna10:pripomienka24');
  perform pg_temp.av10_patch('send_angio_reminders',
    E'<font color="#ffffff">Zmeniť / zrušiť termín</font>',
    E'<font color="#ffffff">'' || case when (r.slot_date + r.slot_time) at time zone ''Europe/Bratislava'' < now() + interval ''24 hours'' then ''Zobraziť objednávku'' else ''Zmeniť / zrušiť termín'' end /* audit-vlna10:pripomienka-tlacidlo */ || ''</font>',
    'audit-vlna10:pripomienka-tlacidlo');
  perform pg_temp.av10_patch('send_angio_reminders',
    E'<span style="font-size:12px;color:#64748b">Telefón/SMS 0949 000 677 len v naozaj nutných prípadoch[^<]*</span>',
    E''' || case when (r.slot_date + r.slot_time) at time zone ''Europe/Bratislava'' < now() + interval ''24 hours'' then '''' else ''\\&'' end /* audit-vlna10:pripomienka-pozn */ || ''',
    'audit-vlna10:pripomienka-pozn');
  perform pg_temp.av10_patch('send_angio_sms_reminders',
    E''' Zmena/zrusenie online cez odkaz v e-maili\\.''',
    E'case when (r.slot_date + r.slot_time) at time zone ''Europe/Bratislava'' < now() + interval ''24 hours'' then '' Ak nepridete, napiste SMS na 0949 000 677.'' else '' Zmena/zrusenie online cez odkaz v e-maili.'' end /* audit-vlna10:pripomienka24 */',
    'audit-vlna10:pripomienka24');
end $$;

-- ------------------------------------------------------------
-- 15. SMS: „+421 0949 …" / „00421 0949 …" (nula navyše za predvoľbou) → platné číslo
-- ------------------------------------------------------------
create or replace function sms_number(p_phone text)
returns text
language sql immutable set search_path = public as $$
  select case
    when d like '4210%' and length(d) = 13 then '421' || substring(d from 5)
    when d like '421%' then d
    when d like '0%'   then '421' || substring(d from 2)
    when length(d) = 9 and d like '9%' then '421' || d
    else d
  end
  from (select case when d0 like '00%' then substring(d0 from 3) else d0 end as d
        from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d0) x) y;
$$;

-- ------------------------------------------------------------
-- 16. hlavička e-mailov: spoločná pre USG, angiológiu aj CT
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.av10_patch('email_header', E'Objednávanie na USG', E'Online objednávanie na vyšetrenie', 'Online objednávanie na vyšetrenie');
end $$;

-- ------------------------------------------------------------
-- 17. ANGIO: online zrušenie len s telefónnym číslom (ako USG a CT)
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.av10_patch('angio_cancel_order',
    E'(raise exception ''Neplatné číslo objednávky\\.'';\\s*end if;)',
    E'\\1\n  if length(regexp_replace(coalesce(p_phone, ''''), ''[^0-9]'', '''', ''g'')) < 9 then -- audit-vlna10:telefon\n    raise exception ''Zadajte telefónne číslo, na ktoré je objednávka vedená.'';\n  end if;',
    'audit-vlna10:telefon');
end $$;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
declare f text;
begin
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'ct_create_order'
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception 'AUDIT-VLNA10-001: ct_create_order je stále dostupná cez API.';
  end if;
  if not has_function_privilege('authenticated', 'issue_missing_invoices()', 'execute') then
    raise exception 'AUDIT-VLNA10-001: issue_missing_invoices nie je dostupná personálu.';
  end if;
  foreach f in array array['send_reminders', 'send_angio_reminders', 'send_angio_sms_reminders', 'send_ct_reminders'] loop
    if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = f and prosrc like '%between current_date and current_date + 1%') then
      raise exception 'AUDIT-VLNA10-001: % stále posiela pripomienky aj na dnešné termíny.', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'check_payments' and prosrc like '%perform fio_poll_guarded()%')
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'fio_poll_guarded' and prosrc like '%pg_try_advisory_lock(%') then
    raise exception 'AUDIT-VLNA10-001: kontrola platieb stále používa starý zámok.';
  end if;
  if (select count(*) from pg_trigger where tgname in ('orders_reminder_reset', 'angio_orders_reminder_reset', 'ct_orders_reminder_reset') and not tgisinternal) <> 3 then
    raise exception 'AUDIT-VLNA10-001: chýbajú triggery na obnovenie pripomienky po presune.';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('notify_order_emails', 'ct_notify_trigger') and prosrc like '%audit-vlna10:handler%') <> 2 then
    raise exception 'AUDIT-VLNA10-001: e-mailové triggery nemajú ochranu pred chybou.';
  end if;
  if (select count(*) from cron.job where jobname in ('slots-cleanup', 'http-watch')) <> 2 then
    raise exception 'AUDIT-VLNA10-001: úlohy slots-cleanup / http-watch nie sú naplánované.';
  end if;
  if has_function_privilege('anon', 'purge_past_slots()', 'execute') or has_function_privilege('anon', 'system_http_watch()', 'execute') then
    raise exception 'AUDIT-VLNA10-001: nové servisné funkcie sú dostupné cez API.';
  end if;
  if sms_number('+421 0949 000 677') <> '421949000677' or sms_number('00421 0949 000 677') <> '421949000677'
     or sms_number('0949 000 677') <> '421949000677' or sms_number('+421949000677') <> '421949000677'
     or sms_number('949000677') <> '421949000677' or sms_number('00420 777 123 456') <> '420777123456' then
    raise exception 'AUDIT-VLNA10-001: sms_number neprekladá čísla správne.';
  end if;
  if email_header() like '%Objednávanie na USG%' then
    raise exception 'AUDIT-VLNA10-001: hlavička e-mailov je stále „Objednávanie na USG".';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'orders_refund_notice' and not tgisinternal) then
    raise exception 'AUDIT-VLNA10-001: chýba oznámenie personálu o vrátení platby.';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('send_angio_reminders', 'send_angio_sms_reminders') and prosrc like '%audit-vlna10:pripomienka24%') <> 2
     or not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'angio_cancel_order' and prosrc like '%audit-vlna10:telefon%') then
    raise exception 'AUDIT-VLNA10-001: úpravy angiologickej pripomienky / zrušenia sa neaplikovali.';
  end if;
  raise notice 'AUDIT-VLNA10-001 OK. Staré termíny na zmazanie dnes v noci: %.',
    (select count(*) from open_slots where slot_date < current_date - 14)
    + (select count(*) from angio_open_slots where slot_date < current_date - 14)
    + (select count(*) from ct_open_slots where slot_date < current_date - 14);
end $$;
