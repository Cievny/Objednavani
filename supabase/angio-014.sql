-- ============================================================
-- ANGIO-014 — e-mail personálu pri novej objednávke (angio aj CT)
--
-- Prečo: triggery angio_notify_trigger / ct_notify_trigger posielajú e-mail
-- len pacientovi. Personál sa o novej angio/CT objednávke nedozvedel
-- (USG posiela na notify_email). Navyše settings.copy_email nebol nastavený.
--
--  • settings.copy_email = lukas.vincze@nusch.sk (len ak je prázdny;
--    chránený kľúč — meniť sa dá len v SQL editore)
--  • clinic_notify_staff(): trigger pre angio_orders a ct_orders —
--    pri NOVEJ objednávke a pri ZRUŠENÍ PACIENTOM (status → rejected bez
--    prihláseného personálu) pošle e-mail na copy_email + notify_email
--    (viac adries oddelených čiarkou, bez duplicít) cez Resend;
--    kľúč z Vaultu (app_secret), všetky hodnoty cez html_escape
--  • chyby doručenia neblokujú objednávku (ako ostatné notifikácie)
--
-- Idempotentné. Spúšťať PO audit-vlna8-001.sql.
-- ============================================================

do $$
begin
  if to_regprocedure('app_secret(text)') is null or to_regprocedure('html_escape(text)') is null then
    raise exception 'ANGIO-014: chýbajú pomocné funkcie — spustite najprv audit-vlna8-001.sql.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. kópia pre personál (len ak ešte nie je nastavená)
-- ------------------------------------------------------------
insert into settings (key, value) values ('copy_email', 'lukas.vincze@nusch.sk')
on conflict (key) do update set value = excluded.value
where coalesce(settings.value, '') = '';

-- ------------------------------------------------------------
-- 2. trigger funkcia
-- ------------------------------------------------------------
create or replace function clinic_notify_staff()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  j        jsonb := to_jsonb(NEW);
  jo       jsonb := case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end;
  v_kind   text;
  v_key    text := app_secret('resend_api_key');
  v_from   text;
  v_to     text;
  v_arr    jsonb;
  v_clinic text;
  v_link   text;
  v_termin text;
  v_subj   text;
  v_lead   text;
  v_att    int := 0;
  v_ins    text;
  v_html   text;
  row_fn   text;
begin
  if v_key like 'SEM\_%' then return NEW; end if;

  if TG_OP = 'INSERT' then
    v_kind := 'new';
  elsif TG_OP = 'UPDATE' and auth.uid() is null
        and (j ->> 'status') = 'rejected' and coalesce(jo ->> 'status', '') <> 'rejected' then
    v_kind := 'cancel';   -- zrušenie z pacientskej stránky (bez prihláseného personálu)
  else
    return NEW;
  end if;

  -- príjemcovia: copy_email + notify_email, čiarkou oddelené, bez duplicít
  select string_agg(value, ',') into v_to from settings where key in ('copy_email', 'notify_email');
  select jsonb_agg(distinct a) into v_arr
    from (select lower(btrim(x)) as a from unnest(string_to_array(coalesce(v_to, ''), ',')) x) s
    where a <> '' and a like '%@%';
  if v_arr is null then return NEW; end if;

  select value into v_from from settings where key = 'mail_from';
  if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;

  v_clinic := case TG_TABLE_NAME when 'angio_orders' then 'Angiologická ambulancia č. 1'
                                 when 'ct_orders' then 'CT pracovisko' else TG_TABLE_NAME end;
  v_link   := case TG_TABLE_NAME when 'angio_orders' then 'https://objednanie.cievny.sk/sprava/#/angio1'
                                 when 'ct_orders' then 'https://objednanie.cievny.sk/sprava/#/ct'
                                 else 'https://objednanie.cievny.sk/sprava/' end;
  v_termin := coalesce(to_char((j ->> 'slot_date')::date, 'DD.MM.YYYY'), '?') || ' o ' || coalesce(left(j ->> 'slot_time', 5), '?');
  v_ins    := case j ->> 'insurance' when '25' then '25 – VšZP' when '24' then '24 – Dôvera' when '27' then '27 – Union' else coalesce(j ->> 'insurance', '') end;
  if jsonb_typeof(j -> 'attachments') = 'array' then v_att := jsonb_array_length(j -> 'attachments'); end if;

  if v_kind = 'new' then
    v_subj := 'Nová objednávka — ' || v_clinic || ' — ' || (j ->> 'id') || ' — ' || v_termin;
    v_lead := 'Pacient sa objednal online.';
  else
    v_subj := 'Pacient zrušil objednávku — ' || v_clinic || ' — ' || (j ->> 'id') || ' — ' || v_termin;
    v_lead := 'Pacient zrušil svoju objednávku cez stránku. Termín je opäť voľný.';
  end if;

  row_fn := '<tr><td style="color:#64748b;padding:4px 12px 4px 0;white-space:nowrap">%s</td><td>%s</td></tr>';
  v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
    || '<h2 style="color:#003d7c">' || html_escape(v_subj) || '</h2>'
    || '<p>' || v_lead || '</p>'
    || '<table style="font-size:14px;border-collapse:collapse">'
    || format(row_fn, 'Pacient', '<b>' || html_escape(coalesce(j ->> 'patient_name', '')) || '</b>')
    || format(row_fn, 'Dátum narodenia', coalesce(to_char((j ->> 'birth_date')::date, 'DD.MM.YYYY'), '—'))
    || format(row_fn, 'Poisťovňa', html_escape(v_ins))
    || format(row_fn, 'Telefón', html_escape(coalesce(j ->> 'phone', '')))
    || format(row_fn, 'E-mail', html_escape(coalesce(j ->> 'email', '')))
    || format(row_fn, 'Vyšetrenie', html_escape(coalesce(j ->> 'exam_label', '')))
    || format(row_fn, 'Termín', '<b>' || v_termin || '</b>')
    || case when coalesce(j ->> 'doctor', '') <> '' then format(row_fn, 'Lekár', html_escape(j ->> 'doctor')) else '' end
    || case when coalesce(j ->> 'reason', '') <> '' then format(row_fn, 'Dôvod / poznámka', html_escape(left(j ->> 'reason', 500))) else '' end
    || format(row_fn, 'Prílohy', v_att::text)
    || format(row_fn, 'Číslo objednávky', html_escape(j ->> 'id'))
    || '</table>'
    || '<p style="margin-top:16px"><a href="' || v_link || '" style="display:inline-block;background:#2B46A2;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Otvoriť správu objednávok</a></p>'
    || '<p style="font-size:12px;color:#64748b;margin-top:14px">Automatická správa zo systému objednávania. Adresy príjemcov: nastavenia copy_email a notify_email.</p>'
    || '</div>';

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', v_arr, 'subject', v_subj, 'html', v_html)
  );
  return NEW;
exception when others then
  return NEW;
end $$;
revoke all on function clinic_notify_staff() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. triggery
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['angio_orders', 'ct_orders'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists %I on %I', t || '_notify_staff', t);
    execute format('create trigger %I after insert or update of status on %I for each row execute function clinic_notify_staff()', t || '_notify_staff', t);
  end loop;
end $$;

-- kontrola
do $$
declare v text; n int;
begin
  select value into v from settings where key = 'copy_email';
  if coalesce(v, '') = '' then raise exception 'ANGIO-014: copy_email ostal prázdny'; end if;
  select count(*) into n from pg_trigger where tgname in ('angio_orders_notify_staff', 'ct_orders_notify_staff');
  if n = 0 then raise exception 'ANGIO-014: triggery sa nevytvorili'; end if;
  if has_function_privilege('anon', 'clinic_notify_staff()', 'execute') then raise exception 'ANGIO-014: anon má EXECUTE na trigger funkcii'; end if;
  raise notice 'ANGIO-014 OK: e-mail personálu pri novej objednávke/zrušení → % (+ notify_email). Triggerov: %.', v, n;
end $$;
