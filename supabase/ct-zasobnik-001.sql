-- ============================================================
-- CT-ZASOBNIK-001 (23. 11. 2026) — zásobník žiadostí o CT bez termínu
--
-- Termíny na ďalší mesiac sú známe až koncom mesiaca. Lekár preto môže
-- žiadosť o CT poslať aj BEZ termínu — ostane v zásobníku a CT pracovisko
-- jej termín pridelí, keď bude známy rozpis.
--
--  • ct_waitlist — žiadosti v zásobníku (rovnaké údaje ako žiadosť
--    s termínom + nepovinné „požadované obdobie").
--  • Lekár (stránka pre lekárov, heslo): ct_doctor_waitlist_add,
--    ct_doctor_waitlist_by_rc (pri r.č. vidí, že pacient v zásobníku je).
--  • CT pracovisko (sestra, superadmin): ct_waitlist_assign — pridelí
--    termín; vznikne potvrdená objednávka a pacient dostane rovnakú SMS
--    a e-mail ako pri potvrdení bežnej žiadosti. ct_waitlist_remove —
--    odstráni žiadosť (pacient o nej nevedel, nič sa mu neposiela).
--  • Pri zaradení príde personálu e-mail (ako pri žiadosti s termínom).
--  • Poriadok: žiadosť, ktorá čaká dlhšie ako 60 dní, sa každý pondelok
--    pripomenie e-mailom; po 90 dňoch sa zmaže aj s prílohami.
--  • Prílohy zásobníka sa nepovažujú za „súbory bez objednávky".
--
-- Idempotentné. Spúšťať PO ct-lekari-004, audit-vlna10-001 a zabezpecenie-001.
-- ============================================================

do $$
begin
  if to_regprocedure('ct_doctor_require(text)') is null or to_regprocedure('ct_rc_hash(text)') is null
     or to_regprocedure('attachment_purge_enqueue(text)') is null or to_regprocedure('staff_alert(text,text,text)') is null then
    raise exception 'CT-ZASOBNIK-001: chýbajú predchádzajúce skripty (ct-lekari-004, prilohy-mazanie-001) — ste v projekte „USG objednavanie"?';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'assert_attachments') not like '%zabezpecenie-001:priloha%' then
    raise exception 'CT-ZASOBNIK-001: spustite najprv zabezpecenie-001.sql.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. tabuľka
-- ------------------------------------------------------------
create table if not exists ct_waitlist (
  id             text primary key,            -- budúce číslo objednávky (CT-…); prílohy sú v úložisku pod <id>/
  created_at     timestamptz not null default now(),
  requested_by   text not null,
  exam_type_id   text not null,
  exam_label     text not null default '',
  duration_min   integer not null default 15,
  patient_name   text not null,
  birth_date     date,
  insurance      text not null default '',
  phone          text not null default '',
  email          text not null default '',
  reason         text not null default '',
  clinical       jsonb not null default '{}'::jsonb,
  attachments    jsonb not null default '[]'::jsonb,
  rc_hash        text not null default '',
  notify_patient boolean not null default true,
  prefer         text not null default ''     -- požadované obdobie (voľný text lekára)
);
create index if not exists ct_waitlist_rc_idx on ct_waitlist (rc_hash) where rc_hash <> '';

alter table ct_waitlist enable row level security;
-- čítať smie len CT personál; zápis výlučne cez funkcie nižšie
revoke all on ct_waitlist from anon, authenticated;
grant select on ct_waitlist to authenticated;
drop policy if exists "ct zasobnik citanie" on ct_waitlist;
create policy "ct zasobnik citanie" on ct_waitlist for select to authenticated
  using (my_role() in ('superadmin', 'sestra') and mfa_ok());

drop trigger if exists ct_waitlist_audit_generic on ct_waitlist;
create trigger ct_waitlist_audit_generic after insert or delete on ct_waitlist
  for each row execute function audit_generic();

-- ------------------------------------------------------------
-- 2. klinické údaje (rovnaké pravidlá ako pri žiadosti s termínom — ct_doctor_create_order)
-- ------------------------------------------------------------
create or replace function ct_clinical_clean(p_clinical jsonb)
returns jsonb
language plpgsql stable set search_path = public as $$
declare v_c jsonb := coalesce(p_clinical, '{}'::jsonb); v_clean jsonb; v_later boolean := false;
begin
  if jsonb_typeof(v_c) <> 'object' or length(v_c::text) > 1000 or jsonb_typeof(v_c -> 'contrast') is distinct from 'boolean' then
    raise exception 'Uveďte, či sa má podať kontrastná látka.';
  end if;
  v_clean := jsonb_build_object('contrast', (v_c ->> 'contrast')::boolean);
  if (v_c ->> 'contrast')::boolean then
    v_later := coalesce(v_c ->> 'labLater', '') = 'true';
    if not v_later then
      if coalesce(nullif(v_c ->> 'creatinine', '')::numeric, 0) <= 0 and coalesce(nullif(v_c ->> 'egfr', '')::numeric, 0) <= 0 then
        raise exception 'Pri kontrastnej látke uveďte kreatinín alebo eGFR, alebo označte, že pacient prinesie čerstvý výsledok.';
      end if;
      if nullif(v_c ->> 'labDate', '') is null or (v_c ->> 'labDate')::date > current_date or (v_c ->> 'labDate')::date < current_date - 365 then
        raise exception 'Uveďte dátum odberu kreatinínu / eGFR (najviac rok dozadu), alebo označte, že pacient prinesie čerstvý výsledok.';
      end if;
    end if;
    if coalesce(v_c ->> 'allergy', '') not in ('nie', 'ano', 'nevie') then
      raise exception 'Uveďte, či má pacient alergiu na jódovú kontrastnú látku.';
    end if;
    if jsonb_typeof(v_c -> 'metformin') is distinct from 'boolean' then
      raise exception 'Uveďte, či pacient užíva metformín.';
    end if;
    v_clean := v_clean || case when v_later
      then jsonb_build_object('labLater', true, 'allergy', v_c ->> 'allergy', 'metformin', (v_c ->> 'metformin')::boolean)
      else jsonb_strip_nulls(jsonb_build_object(
        'creatinine', nullif(v_c ->> 'creatinine', '')::numeric, 'egfr', nullif(v_c ->> 'egfr', '')::numeric,
        'labDate', v_c ->> 'labDate', 'allergy', v_c ->> 'allergy', 'metformin', (v_c ->> 'metformin')::boolean)) end;
  end if;
  return v_clean;
end $$;
revoke all on function ct_clinical_clean(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. e-mail personálu o novej žiadosti v zásobníku (nikdy nezablokuje zaradenie)
-- ------------------------------------------------------------
create or replace function ct_waitlist_notify_staff(w ct_waitlist)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_key text := app_secret('resend_api_key'); v_from text; v_to text; v_arr jsonb; v_ins text; v_subj text;
  row_fn text := '<tr><td style="color:#64748b;padding:4px 12px 4px 0;white-space:nowrap">%s</td><td>%s</td></tr>';
begin
  if v_key like 'SEM\_%' then return; end if;
  select string_agg(value, ',') into v_to from settings where key in ('copy_email', 'notify_email');
  select jsonb_agg(distinct a) into v_arr
    from (select lower(btrim(x)) as a from unnest(string_to_array(coalesce(v_to, ''), ',')) x) s
    where a <> '' and a like '%@%';
  if v_arr is null then return; end if;
  select value into v_from from settings where key = 'mail_from';
  if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  v_ins := case w.insurance when '25' then '25 – VšZP' when '24' then '24 – Dôvera' when '27' then '27 – Union' else coalesce(w.insurance, '') end;
  v_subj := 'Žiadosť lekára do zásobníka — CT pracovisko — ' || w.id;
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', v_arr, 'subject', v_subj,
      'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">'
        || '<h2 style="color:#003d7c">' || html_escape(v_subj) || '</h2>'
        || '<p>Lekár ' || html_escape(w.requested_by) || ' žiada o CT <b>bez konkrétneho termínu</b>. Žiadosť čaká v zásobníku — termín jej pridelíte v správe CT, keď bude známy rozpis. Pacient dostane správu až po pridelení termínu.</p>'
        || '<table style="font-size:14px;border-collapse:collapse">'
        || format(row_fn, 'Pacient', '<b>' || html_escape(w.patient_name) || '</b>')
        || format(row_fn, 'Dátum narodenia', coalesce(to_char(w.birth_date, 'DD.MM.YYYY'), '—'))
        || format(row_fn, 'Poisťovňa', html_escape(v_ins))
        || format(row_fn, 'Telefón', html_escape(w.phone))
        || format(row_fn, 'E-mail', html_escape(w.email))
        || format(row_fn, 'Vyšetrenie', html_escape(w.exam_label))
        || format(row_fn, 'Požadované obdobie', case when w.prefer <> '' then '<b>' || html_escape(w.prefer) || '</b>' else '—' end)
        || case when w.reason <> '' then format(row_fn, 'Klinická otázka', html_escape(left(w.reason, 500))) else '' end
        || format(row_fn, 'Prílohy', jsonb_array_length(w.attachments)::text)
        || format(row_fn, 'Číslo žiadosti', html_escape(w.id))
        || '</table>'
        || '<p style="margin-top:16px"><a href="https://objednanie.cievny.sk/sprava/#/ct" style="display:inline-block;background:#2B46A2;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:10px">Otvoriť správu CT</a></p>'
        || '<p style="font-size:12px;color:#64748b;margin-top:14px">Automatická správa zo systému objednávania. Adresy príjemcov: nastavenia copy_email a notify_email.</p>'
        || '</div>'));
exception when others then
  begin perform health_event('trigger:ct_waitlist_notify_staff', false, left(sqlerrm, 300)); exception when others then null; end;
end $$;
revoke all on function ct_waitlist_notify_staff(ct_waitlist) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. lekár: zaradiť žiadosť do zásobníka (bez termínu)
-- ------------------------------------------------------------
-- stránka pre lekárov sa pýta, či má zásobník ponúknuť (funkcia chýba = skript ešte nebol spustený);
-- vypnúť sa dá v SQL editore: insert into settings (key, value) values ('ct_waitlist', 'off') on conflict (key) do update set value = 'off';
create or replace function ct_waitlist_ready()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value from settings where key = 'ct_waitlist'), 'on') <> 'off';
$$;
revoke all on function ct_waitlist_ready() from public;
grant execute on function ct_waitlist_ready() to anon, authenticated;

create or replace function ct_doctor_waitlist_add(
  p_token text, p_id text, p_requested_by text, p_exam_type_id text,
  p_patient_name text, p_birth_date date, p_insurance text, p_phone text, p_email text,
  p_indication text, p_clinical jsonb, p_attachments jsonb,
  p_notify boolean default true, p_birth_number text default null, p_prefer text default '')
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item ct_pricelist%rowtype; v_ip text := client_ip(); v_clean jsonb; v_rc text := ''; v_old timestamptz;
  w ct_waitlist%rowtype;
  v_tomorrow date := (now() at time zone 'Europe/Bratislava')::date + 1;
begin
  perform ct_doctor_require(p_token);
  if v_ip <> '' then perform check_rate_limit('ct-doc-create:' || v_ip, 30); end if;
  if not ct_waitlist_ready() then raise exception 'Zásobník je momentálne vypnutý — vyberte termín alebo kontaktujte CT pracovisko.'; end if;
  if p_id !~ '^CT-[A-Z0-9-]{4,40}$' then raise exception 'Neplatné číslo objednávky.'; end if;
  if exists (select 1 from ct_orders where id = p_id) or exists (select 1 from ct_waitlist where id = p_id) then
    raise exception 'Žiadosť s týmto číslom už existuje — odošlite ju, prosím, znova.';
  end if;
  if length(btrim(coalesce(p_requested_by, ''))) not between 3 and 200 then
    raise exception 'Zadajte meno objednávajúceho lekára a kontakt (klapku).';
  end if;
  -- termín sa neurčuje; kontrolujú sa len údaje pacienta (dátum a čas sú tu zástupné)
  perform staff_order_validate(p_patient_name, p_phone, p_email, p_birth_date, p_indication, v_tomorrow, time '08:00');
  if length(btrim(coalesce(p_indication, ''))) < 5 then raise exception 'Napíšte klinickú otázku / indikáciu k CT.'; end if;
  if length(coalesce(p_prefer, '')) > 200 then raise exception 'Požadované obdobie je príliš dlhé (najviac 200 znakov).'; end if;
  if nullif(btrim(coalesce(p_birth_number, '')), '') is not null then v_rc := ct_rc_hash(p_birth_number); end if;
  v_clean := ct_clinical_clean(p_clinical);

  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) not between 1 and 3 then
    raise exception 'Priložte žiadanku (1 až 3 súbory).';
  end if;
  perform assert_attachments(p_id, p_attachments);

  select * into v_item from ct_pricelist where id = p_exam_type_id and active = true;
  if not found then raise exception 'Vybrané CT vyšetrenie nie je dostupné.'; end if;

  if v_rc <> '' then
    select created_at into v_old from ct_waitlist where rc_hash = v_rc and exam_type_id = v_item.id limit 1;
    if found then
      raise exception 'Tento pacient už s týmto vyšetrením v zásobníku je (žiadosť z %). Ak treba niečo zmeniť, kontaktujte CT pracovisko.',
        to_char(v_old at time zone 'Europe/Bratislava', 'DD.MM.YYYY');
    end if;
  end if;

  insert into ct_waitlist (id, requested_by, exam_type_id, exam_label, duration_min, patient_name, birth_date, insurance,
    phone, email, reason, clinical, attachments, rc_hash, notify_patient, prefer)
  values (p_id, btrim(p_requested_by), v_item.id, v_item.label, greatest(coalesce(v_item.duration_slots, 3), 1) * 5,
    btrim(p_patient_name), p_birth_date, coalesce(p_insurance, ''), btrim(p_phone), coalesce(btrim(p_email), ''),
    btrim(p_indication), v_clean, p_attachments, v_rc, coalesce(p_notify, true), btrim(coalesce(p_prefer, '')))
  returning * into w;
  perform ct_waitlist_notify_staff(w);
  return p_id;
end $$;
revoke all on function ct_doctor_waitlist_add(text, text, text, text, text, date, text, text, text, text, jsonb, jsonb, boolean, text, text) from public;
grant execute on function ct_doctor_waitlist_add(text, text, text, text, text, date, text, text, text, text, jsonb, jsonb, boolean, text, text) to anon, authenticated;

-- lekár: je pacient s týmto r.č. v zásobníku? (nenájdené vracia [], aby sa pokusy počítali)
create or replace function ct_doctor_waitlist_by_rc(p_token text, p_birth_number text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ip text := client_ip(); v_h text;
begin
  perform ct_doctor_require(p_token);
  perform check_rate_limit('ct-doc-rcw:' || coalesce(nullif(v_ip, ''), 'bez-ip'), 60);
  perform check_rate_limit('ct-doc-rcw-s:' || p_token, 15);
  v_h := ct_rc_hash(p_birth_number);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', w.id, 'exam_label', w.exam_label, 'patient_name', w.patient_name,
      'created_at', w.created_at, 'prefer', w.prefer) order by w.created_at)
    from ct_waitlist w where w.rc_hash = v_h), '[]'::jsonb);
end $$;
revoke all on function ct_doctor_waitlist_by_rc(text, text) from public;
grant execute on function ct_doctor_waitlist_by_rc(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 5. CT pracovisko: prideliť termín / odstrániť žiadosť
-- ------------------------------------------------------------
-- Pridelením vznikne objednávka v stave „potvrdená" — pacient dostane tú istú SMS a e-mail
-- ako pri potvrdení bežnej žiadosti lekára (vrátane pokynu o kreatiníne).
create or replace function ct_waitlist_assign(p_id text, p_slot_date date, p_slot_time time)
returns text
language plpgsql security definer set search_path = public as $$
declare w ct_waitlist%rowtype; v_doctor text;
begin
  if my_role() not in ('superadmin', 'sestra') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  select * into w from ct_waitlist where id = p_id for update;
  if not found then
    raise exception 'Žiadosť už v zásobníku nie je — termín jej medzičasom pridelil niekto iný alebo bola odstránená.';
  end if;
  perform staff_order_validate(w.patient_name, w.phone, w.email, w.birth_date, w.reason, p_slot_date, p_slot_time);
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;
  select s.doctor into v_doctor from ct_open_slots s where s.slot_date = p_slot_date and s.slot_time = p_slot_time;

  -- najprv ako žiadosť (bez správ), hneď nato potvrdenie → pacient dostane „termín je potvrdený"
  insert into ct_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance, phone, email, reason,
    slot_date, slot_time, doctor, duration_min, attachments, status, requested_by, created_by, clinical, notify_patient,
    reminder_sent_at, sms_reminder_sent_at, rc_hash, created_at)
  values (w.id, w.exam_type_id, w.exam_label, w.patient_name, w.birth_date, w.insurance, w.phone, w.email, w.reason,
    p_slot_date, p_slot_time, coalesce(v_doctor, ''), w.duration_min, w.attachments, 'new', w.requested_by,
    coalesce(nullif(staff_display_name(), ''), 'CT pracovisko'), w.clinical, w.notify_patient,
    case when w.notify_patient then null else now() end, case when w.notify_patient then null else now() end, w.rc_hash, w.created_at);
  update ct_orders set status = 'confirmed' where id = w.id;
  delete from ct_waitlist where id = w.id;
  return w.id;
exception
  when exclusion_violation then
    raise exception 'V tomto čase je už objednaný iný pacient. Vyberte iný čas.';
end $$;
revoke all on function ct_waitlist_assign(text, date, time) from public, anon;
grant execute on function ct_waitlist_assign(text, date, time) to authenticated;

create or replace function ct_waitlist_remove(p_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if my_role() not in ('superadmin', 'sestra') or not mfa_ok() then raise exception 'Nedostatočné oprávnenie.'; end if;
  delete from ct_waitlist where id = p_id;
  get diagnostics v_n = row_count;
  if v_n > 0 then perform attachment_purge_enqueue(p_id); end if;
  return v_n > 0;
end $$;
revoke all on function ct_waitlist_remove(text) from public, anon;
grant execute on function ct_waitlist_remove(text) to authenticated;

-- ------------------------------------------------------------
-- 6. poriadok: pripomenutie po 60 dňoch (pondelky), zmazanie po 90 dňoch
-- ------------------------------------------------------------
create or replace function ct_purge_waitlist()
returns int
language plpgsql security definer set search_path = public as $$
declare r record; v_del int := 0; v_old int := 0;
begin
  for r in select id from ct_waitlist where created_at < now() - interval '90 days' loop
    perform attachment_purge_enqueue(r.id);
    delete from ct_waitlist where id = r.id;
    v_del := v_del + 1;
  end loop;
  select count(*) into v_old from ct_waitlist where created_at < now() - interval '60 days';
  if v_old > 0 and extract(isodow from (now() at time zone 'Europe/Bratislava')) = 1 then
    perform staff_alert('ct-zasobnik', 'CT zásobník: ' || v_old || ' žiadostí čaká na termín dlhšie ako 60 dní',
      '<p><b>V zásobníku CT čaká ' || v_old || ' žiadostí dlhšie ako 60 dní.</b> Prideľte im termín alebo ich odstráňte '
      || '(správa CT → Zásobník). Žiadosť, ktorá čaká 90 dní, systém zmaže aj s prílohami.</p>');
  end if;
  if v_del > 0 then perform health_event('ct-zasobnik', false, v_del || ' žiadostí zmazaných po 90 dňoch bez termínu'); end if;
  return v_del;
end $$;
revoke all on function ct_purge_waitlist() from public, anon, authenticated;
do $$ begin perform cron.unschedule('ct-zasobnik-cleanup'); exception when others then null; end $$;
select cron.schedule('ct-zasobnik-cleanup', '25 1 * * *', $$select ct_purge_waitlist()$$);

-- ------------------------------------------------------------
-- 7. prílohy zásobníka nie sú „súbory bez objednávky" (inak by ich nočné mazanie po dni zmazalo)
-- ------------------------------------------------------------
do $$
declare r record; v_def text; v_new text;
begin
  select p.oid, p.prosrc into r from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'purge_orphan_attachments';
  if not found then raise exception 'CT-ZASOBNIK-001: funkcia purge_orphan_attachments neexistuje.'; end if;
  if strpos(r.prosrc, 'from ct_waitlist') = 0 then
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, E'(union all select upper\\(id\\) from angio_orders)', E'\\1\n      union all select upper(id) from ct_waitlist');
    if v_new = v_def then raise exception 'CT-ZASOBNIK-001: vo funkcii purge_orphan_attachments sa nenašlo miesto na úpravu.'; end if;
    execute v_new;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.ct_waitlist'::regclass) then
    raise exception 'CT-ZASOBNIK-001: tabuľka ct_waitlist nemá zapnutú ochranu riadkov.';
  end if;
  if has_table_privilege('anon', 'public.ct_waitlist', 'select') or has_table_privilege('authenticated', 'public.ct_waitlist', 'insert')
     or has_table_privilege('authenticated', 'public.ct_waitlist', 'delete') then
    raise exception 'CT-ZASOBNIK-001: tabuľka ct_waitlist má širšie oprávnenia, než má mať.';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'purge_orphan_attachments') not like '%from ct_waitlist%' then
    raise exception 'CT-ZASOBNIK-001: prílohy zásobníka nie sú chránené pred nočným mazaním.';
  end if;
  if has_function_privilege('anon', 'ct_waitlist_assign(text,date,time)', 'execute') or has_function_privilege('anon', 'ct_waitlist_remove(text)', 'execute')
     or has_function_privilege('anon', 'ct_purge_waitlist()', 'execute') or has_function_privilege('anon', 'ct_clinical_clean(jsonb)', 'execute') then
    raise exception 'CT-ZASOBNIK-001: funkcie personálu sú dostupné bez prihlásenia.';
  end if;
  if not exists (select 1 from cron.job where jobname = 'ct-zasobnik-cleanup') then
    raise exception 'CT-ZASOBNIK-001: nočná úloha ct-zasobnik-cleanup nie je naplánovaná.';
  end if;
  raise notice 'CT-ZASOBNIK-001 OK. V zásobníku: % žiadostí.', (select count(*) from ct_waitlist);
end $$;
