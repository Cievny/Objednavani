-- ============================================================
-- CT-LEKARI-004 — žiadosť lekára o presun CT termínu viazaná na rodné číslo
--                 + pokyn „prineste čerstvý kreatinín" aj v e-mailoch pacientovi
--
-- Lekár pri žiadosti o CT zadá rodné číslo pacienta (zo žiadanky sa
-- vyplní samo). V databáze sa NEUKLADÁ samotné rodné číslo, len jeho
-- odtlačok (SHA-256 s tajným kľúčom v tabuľke ct_rc_key, ktorú API
-- nevidí) — stačí na overenie, z odtlačku sa r.č. spätne nezistí.
--
-- Na stránke pre lekárov (záložka „Presun termínu") lekár zadá r.č.
-- pacienta → uvidí len budúce CT termíny tohto pacienta objednané cez
-- stránku (žiadny zoznam ostatných) → vyberie nový voľný termín.
-- Nový termín sa hneď rezervuje, pôvodný sa uvoľní a objednávka je
-- opäť „nová" s poznámkou, odkiaľ sa presúva — CT pracovisko ju
-- potvrdí (pacient dostane SMS / e-mail s novým termínom až po
-- potvrdení). Personál dostane e-mail „Žiadosť lekára o presun termínu".
--
--  1  ct_rc_key (tajný kľúč), ct_orders.rc_hash, ct_rc_hash()
--  2  ct_doctor_create_order + p_birth_number (nepovinný — stará verzia
--     stránky funguje ďalej, kým sa nenasadí nová)
--  3  RPC ct_doctor_find_by_rc, ct_doctor_request_move (anon s platným
--     prihlásením lekára; obmedzenie počtu pokusov)
--  4  e-mail personálu pri žiadosti o presun; odtlačok r.č. sa zmaže
--     spolu so žiadankou po termíne (ct_purge_orders)
--  5  CT s kontrastom bez aktuálneho kreatinínu (lekár ho nemusí zadať):
--     pokyn priniesť čerstvý výsledok kreatinínu aj v e-maile pacientovi
--     (rezervácia / potvrdenie / presun) a v e-mailovej pripomienke deň
--     vopred — SMS ho obsahujú už od ct-lekari-002
--
-- Idempotentné. Spúšťať PO ct-lekari-002.sql. Ak by ste neskôr znova
-- spustili ct-lekari-001 alebo 002, spustite potom znova aj tento skript.
-- ============================================================

do $$
begin
  if to_regprocedure('ct_doctor_require(text)') is null then
    raise exception 'CT-LEKARI-004: spustite najprv ct-lekari-001.sql a ct-lekari-002.sql.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'ct_doctor_create_order' and prosrc like '%labLater%') then
    raise exception 'CT-LEKARI-004: spustite najprv ct-lekari-002.sql.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. tajný kľúč a odtlačok rodného čísla
-- ------------------------------------------------------------
create table if not exists ct_rc_key (
  id  int primary key default 1 check (id = 1),
  key text not null
);
alter table ct_rc_key enable row level security;
revoke all on ct_rc_key from public, anon, authenticated;
insert into ct_rc_key (id, key)
  values (1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (id) do nothing;

alter table ct_orders add column if not exists rc_hash text not null default '';
create index if not exists ct_orders_rc_hash_idx on ct_orders (rc_hash) where rc_hash <> '';

-- r.č. (s lomkou alebo bez) → odtlačok; neplatný tvar → chyba
create or replace function ct_rc_hash(p_rc text)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v text := regexp_replace(coalesce(p_rc, ''), '[[:space:]/]', '', 'g');
  k text;
begin
  if v !~ '^[0-9]{9,10}$' then
    raise exception 'Rodné číslo zadajte v tvare RRMMDD/XXXX.';
  end if;
  if length(v) = 10 and v::bigint % 11 <> 0 and not (left(v, 9)::bigint % 11 = 10 and right(v, 1) = '0') then
    raise exception 'Rodné číslo nie je platné (nesedí kontrolný súčet).';
  end if;
  select key into k from ct_rc_key where id = 1;
  if k is null then raise exception 'CT-LEKARI-004: chýba kľúč — spustite skript znova.'; end if;
  return encode(sha256(convert_to(k || ':' || v, 'UTF8')), 'hex');
end $$;
revoke all on function ct_rc_hash(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. žiadosť lekára o CT termín — s rodným číslom
-- ------------------------------------------------------------
drop function if exists ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean);

create or replace function ct_doctor_create_order(
  p_token text, p_id text, p_requested_by text, p_exam_type_id text,
  p_patient_name text, p_birth_date date, p_insurance text, p_phone text, p_email text,
  p_indication text, p_clinical jsonb, p_slot_date date, p_slot_time time,
  p_attachments jsonb, p_notify boolean, p_birth_number text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_item ct_pricelist%rowtype; v_dur int; v_doctor text; v_cell_doctor text; n int; v_cell time;
  v_ip text := client_ip();
  v_c jsonb := coalesce(p_clinical, '{}'::jsonb);
  v_clean jsonb;
  v_later boolean := false;
  v_notify boolean := coalesce(p_notify, true);
  v_rc text := '';
begin
  perform ct_doctor_require(p_token);
  if v_ip <> '' then perform check_rate_limit('ct-doc-create:' || v_ip, 30); end if;
  if p_id !~ '^CT-[A-Z0-9-]{4,40}$' then raise exception 'Neplatné číslo objednávky.'; end if;
  if length(btrim(coalesce(p_requested_by, ''))) not between 3 and 200 then
    raise exception 'Zadajte meno objednávajúceho lekára a kontakt (klapku).';
  end if;
  perform staff_order_validate(p_patient_name, p_phone, p_email, p_birth_date, p_indication, p_slot_date, p_slot_time);
  if length(btrim(coalesce(p_indication, ''))) < 5 then raise exception 'Napíšte klinickú otázku / indikáciu k CT.'; end if;
  -- ct-lekari-004: rodné číslo → len odtlačok (na žiadosť o presun)
  if nullif(btrim(coalesce(p_birth_number, '')), '') is not null then v_rc := ct_rc_hash(p_birth_number); end if;

  -- kontrastná látka
  if jsonb_typeof(v_c) <> 'object' or length(v_c::text) > 1000 or jsonb_typeof(v_c -> 'contrast') is distinct from 'boolean' then
    raise exception 'Uveďte, či sa má podať kontrastná látka.';
  end if;
  v_clean := jsonb_build_object('contrast', (v_c ->> 'contrast')::boolean);
  if (v_c ->> 'contrast')::boolean then
    -- ct-lekari-002: bez čerstvého výsledku môže lekár označiť, že ho pacient prinesie na vyšetrenie
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

  -- žiadanka (príloha) povinná
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) not between 1 and 3 then
    raise exception 'Priložte žiadanku (1 až 3 súbory).';
  end if;
  perform assert_attachments(p_id, p_attachments);

  select * into v_item from ct_pricelist where id = p_exam_type_id and active = true;
  if not found then raise exception 'Vybrané CT vyšetrenie nie je dostupné.'; end if;
  v_dur := greatest(coalesce(v_item.duration_slots, 3), 1) * 5;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;
  for n in 0 .. (v_dur / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from ct_open_slots s where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v_dur;
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;

  insert into ct_orders (id, exam_type_id, exam_label, patient_name, birth_date, insurance, phone, email, reason,
    slot_date, slot_time, doctor, duration_min, attachments, status, requested_by, clinical, notify_patient,
    reminder_sent_at, sms_reminder_sent_at, rc_hash)
  values (p_id, v_item.id, v_item.label, btrim(p_patient_name), p_birth_date, coalesce(p_insurance, ''),
    btrim(p_phone), coalesce(btrim(p_email), ''), btrim(p_indication),
    p_slot_date, p_slot_time, coalesce(v_doctor, ''), v_dur, p_attachments, 'new', btrim(p_requested_by), v_clean, v_notify,
    case when v_notify then null else now() end, case when v_notify then null else now() end, v_rc);
  return p_id;
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
revoke all on function ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean, text) from public;
grant execute on function ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. presun: vyhľadanie podľa r.č. a žiadosť o nový termín
-- ------------------------------------------------------------
-- budúce CT termíny pacienta s daným r.č. (len objednané cez stránku s r.č.)
create or replace function ct_doctor_find_by_rc(p_token text, p_birth_number text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ip text := client_ip(); v_h text;
begin
  perform ct_doctor_require(p_token);
  -- nenájdené vracia [] (nie chybu), aby sa pokusy počítali
  perform check_rate_limit('ct-doc-rc:' || coalesce(nullif(v_ip, ''), 'bez-ip'), 60);
  perform check_rate_limit('ct-doc-rc-s:' || p_token, 15);
  v_h := ct_rc_hash(p_birth_number);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'exam_type_id', o.exam_type_id, 'exam_label', o.exam_label, 'patient_name', o.patient_name,
      'slot_date', o.slot_date, 'slot_time', to_char(o.slot_time, 'HH24:MI'), 'duration_min', o.duration_min,
      'status', o.status, 'notify', o.notify_patient) order by o.slot_date, o.slot_time)
    from ct_orders o
    where o.rc_hash = v_h and o.status in ('new', 'confirmed')
      and (o.slot_date + o.slot_time) at time zone 'Europe/Bratislava' > now()), '[]'::jsonb);
end $$;
revoke all on function ct_doctor_find_by_rc(text, text) from public;
grant execute on function ct_doctor_find_by_rc(text, text) to anon, authenticated;

-- žiadosť o presun: nový termín sa rezervuje, objednávka je opäť „nová" (potvrdí CT pracovisko)
create or replace function ct_doctor_request_move(
  p_token text, p_id text, p_birth_number text, p_requested_by text, p_note text,
  p_slot_date date, p_slot_time time)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v ct_orders%rowtype; v_doctor text; v_cell_doctor text; n int; v_cell time;
  v_ip text := client_ip();
  v_note text;
begin
  perform ct_doctor_require(p_token);
  perform check_rate_limit('ct-doc-move:' || coalesce(nullif(v_ip, ''), 'bez-ip'), 30);
  if length(btrim(coalesce(p_requested_by, ''))) not between 3 and 200 then
    raise exception 'Zadajte meno lekára, ktorý žiada presun, a kontakt (klapku).';
  end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'Dôvod presunu je príliš dlhý (najviac 300 znakov).'; end if;
  select * into v from ct_orders
    where id = coalesce(p_id, '') and rc_hash <> '' and rc_hash = ct_rc_hash(p_birth_number)
    for update;
  if not found or v.status not in ('new', 'confirmed')
     or (v.slot_date + v.slot_time) at time zone 'Europe/Bratislava' <= now() then
    raise exception 'Pre toto rodné číslo sa budúci CT termín nenašiel. Presun vybaví CT pracovisko.';
  end if;
  if p_slot_date is null or p_slot_time is null then raise exception 'Vyberte nový termín.'; end if;
  if p_slot_date = v.slot_date and p_slot_time = v.slot_time then
    raise exception 'Vyberte iný termín, než je súčasný.';
  end if;
  if (p_slot_date + p_slot_time) at time zone 'Europe/Bratislava' < now() then
    raise exception 'Vybraný termín už uplynul. Vyberte neskorší čas.';
  end if;
  for n in 0 .. (greatest(v.duration_min, 5) / 5 - 1) loop
    v_cell := p_slot_time + (n * 5) * interval '1 minute';
    select s.doctor into v_cell_doctor from ct_open_slots s where s.slot_date = p_slot_date and s.slot_time = v_cell;
    if not found then
      raise exception 'Toto vyšetrenie trvá % min a vybraný začiatok nemá dosť otvorených termínov za sebou. Vyberte iný čas.', v.duration_min;
    end if;
    if n = 0 then v_doctor := v_cell_doctor;
    elsif v_cell_doctor is distinct from v_doctor then
      raise exception 'Nadväzujúce termíny patria inému lekárovi. Vyberte iný čas.';
    end if;
  end loop;
  v_note := left('Žiadosť o presun z ' || to_char(v.slot_date, 'DD.MM.YYYY') || ' ' || to_char(v.slot_time, 'HH24:MI')
    || ' — ' || btrim(p_requested_by) || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 500);
  update ct_orders set
    slot_date = p_slot_date, slot_time = p_slot_time, doctor = coalesce(v_doctor, ''),
    status = 'new', status_note = v_note, arrived_at = null,
    reminder_sent_at = case when notify_patient then null else reminder_sent_at end,
    sms_reminder_sent_at = case when notify_patient then null else sms_reminder_sent_at end
  where id = v.id;
  return jsonb_build_object('id', v.id, 'slot_date', p_slot_date, 'slot_time', to_char(p_slot_time, 'HH24:MI'),
    'notify', v.notify_patient, 'exam_label', v.exam_label, 'patient_name', v.patient_name);
exception
  when exclusion_violation then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
end $$;
revoke all on function ct_doctor_request_move(text, text, text, text, text, date, time) from public;
grant execute on function ct_doctor_request_move(text, text, text, text, text, date, time) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. e-mail personálu pri žiadosti o presun; mazanie odtlačku r.č.
-- ------------------------------------------------------------
create or replace function pg_temp.ctl4_patch(p_fn text, p_pattern text, p_repl text, p_marker text)
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
      raise exception 'CT-LEKARI-004: vo funkcii % sa nenašlo miesto na úpravu (%).', p_fn, p_marker;
    end if;
    execute v_new;
  end loop;
  if n = 0 then raise exception 'CT-LEKARI-004: funkcia % neexistuje.', p_fn; end if;
end $f$;

do $$
begin
  -- presun lekárom (bez prihláseného personálu, objednávka opäť „nová", iný termín)
  perform pg_temp.ctl4_patch('clinic_notify_staff',
    E'(v_kind := ''cancel'';[^\\n]*\\n)',
    E'\\1  -- ct-lekari-004:presun (lekár žiada presun termínu)\n'
    || E'  elsif TG_OP = ''UPDATE'' and auth.uid() is null and (j ->> ''status'') = ''new'' and coalesce(j ->> ''requested_by'', '''') <> ''''\n'
    || E'        and ((j ->> ''slot_date'') is distinct from (jo ->> ''slot_date'') or (j ->> ''slot_time'') is distinct from (jo ->> ''slot_time'')) then\n'
    || E'    v_kind := ''move'';\n',
    'ct-lekari-004:presun');
  perform pg_temp.ctl4_patch('clinic_notify_staff',
    E'(\\r?\\n[ \\t]*else[ \\t]*\\r?\\n[ \\t]*v_subj := ''Pacient zrušil objednávku)',
    E'\n  elsif v_kind = ''move'' then\n'
    || E'    v_subj := ''Žiadosť lekára o presun termínu — '' || v_clinic || '' — '' || (j ->> ''id'') || '' — '' || v_termin;\n'
    || E'    v_lead := html_escape(coalesce(j ->> ''status_note'', '''')) || ''. Nový termín je rezervovaný a pôvodný uvoľnený — potvrďte ho, presuňte alebo zrušte v správe CT. Pacient dostane správu až po potvrdení.'';'
    || E'\\1',
    'o presun termínu — ');
  -- odtlačok r.č. zmazať spolu so žiadankou a klinickými údajmi po termíne
  perform pg_temp.ctl4_patch('ct_purge_orders',
    E'clinical = ''\\{\\}''::jsonb where id = r\\.id',
    E'clinical = ''{}''::jsonb, rc_hash = '''' where id = r.id',
    'rc_hash = ''''');
  perform pg_temp.ctl4_patch('ct_purge_orders',
    E'or clinical <> ''\\{\\}''::jsonb\\)',
    E'or clinical <> ''{}''::jsonb or rc_hash <> '''')',
    'or rc_hash <> ''''');
  -- 5. pokyn priniesť čerstvý kreatinín v e-mailoch pacientovi
  perform pg_temp.ctl4_patch('ct_notify_trigger',
    '(Príďte prosím 15 minút pred termínom\. Pod Krásnou hôrkou 1, Bratislava\.</p>'' else '''' end)',
    '\1' || E'\n' || '    || case when NEW.status <> ''rejected'' and coalesce(NEW.clinical ->> ''labLater'', '''') = ''true'' then '
      || '''<p style="font-size:14px;background:#fff7ed;border-left:4px solid #f59e0b;padding:8px 12px;margin:12px 0">'
      || '<b>Prineste si na vyšetrenie čerstvý výsledok kreatinínu</b> (z odberu krvi) — je potrebný pred CT s kontrastnou látkou.</p>'' else '''' end',
    'labLater');
  perform pg_temp.ctl4_patch('send_ct_reminders',
    '(Prineste si žiadanku a predchádzajúce nálezy\.</p>'')',
    '\1' || E'\n' || '      || case when coalesce(r.clinical ->> ''labLater'', '''') = ''true'' then '
      || '''<p style="font-size:14px;background:#fff7ed;border-left:4px solid #f59e0b;padding:8px 12px;margin:12px 0">'
      || '<b>Prineste si čerstvý výsledok kreatinínu</b> (z odberu krvi) — je potrebný pred CT s kontrastnou látkou.</p>'' else '''' end',
    'labLater');
end $$;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean)') is not null then
    raise exception 'CT-LEKARI-004: stará verzia ct_doctor_create_order stále existuje.';
  end if;
  if (select count(*) from pg_proc where proname = 'ct_doctor_create_order') <> 1 then
    raise exception 'CT-LEKARI-004: ct_doctor_create_order má viac verzií.';
  end if;
  if not has_function_privilege('anon', 'ct_doctor_create_order(text, text, text, text, text, date, text, text, text, text, jsonb, date, time, jsonb, boolean, text)', 'execute')
     or not has_function_privilege('anon', 'ct_doctor_find_by_rc(text, text)', 'execute')
     or not has_function_privilege('anon', 'ct_doctor_request_move(text, text, text, text, text, date, time)', 'execute') then
    raise exception 'CT-LEKARI-004: anon nemá EXECUTE na funkcie pre lekárov.';
  end if;
  if has_function_privilege('anon', 'ct_rc_hash(text)', 'execute') or has_table_privilege('anon', 'ct_rc_key', 'select')
     or has_table_privilege('authenticated', 'ct_rc_key', 'select') then
    raise exception 'CT-LEKARI-004: kľúč r.č. je dostupný cez API.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'clinic_notify_staff' and prosrc like '%ct-lekari-004:presun%'
                   and prosrc like '%o presun termínu — %') then
    raise exception 'CT-LEKARI-004: e-mail personálu pri presune chýba.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'ct_purge_orders' and prosrc like '%rc_hash = ''''%') then
    raise exception 'CT-LEKARI-004: mazanie odtlačku r.č. chýba.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'ct_notify_trigger' and prosrc like '%labLater%')
     or not exists (select 1 from pg_proc where proname = 'send_ct_reminders' and prosrc like '%labLater%') then
    raise exception 'CT-LEKARI-004: pokyn o kreatiníne v e-mailoch pacientovi chýba.';
  end if;
  raise notice 'CT-LEKARI-004 OK.';
end $$;
