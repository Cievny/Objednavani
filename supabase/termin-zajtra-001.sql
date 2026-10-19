-- ============================================================
-- TERMÍN ZAJTRA 001 — pacient sa online objedná najskôr na nasledujúci deň
--
-- Prečo: pacientske RPC doteraz odmietali len časy, ktoré už uplynuli
-- („Vybraný termín už uplynul"), takže sa dalo objednať aj na dnes.
-- Pracovisko chce, aby online objednávka (aj presun termínu pacientom)
-- bola možná najskôr na nasledujúci deň. Personál v správe môže ďalej
-- objednávať aj na dnes (reschedule_order, angio_reschedule, ct_reschedule
-- a vkladanie zo správy sa nemenia).
--
-- Úprava v mieste (pg_get_functiondef + vloženie kontroly pred existujúcu
-- kontrolu uplynutého času) pre: create_order, ct_create_order,
-- angio_create_order, patient_reschedule, angio_patient_reschedule.
-- Ak sa v niektorej funkcii vzor nenájde, skript skončí chybou
-- (nič sa potichu nepreskočí). Idempotentné. Spúšťať PO audit-vlna9-001.sql.
-- ============================================================

do $$
declare
  r record; v_def text; v_new text; n int; total int := 0; v_fn text;
  v_marker text := 'najskôr na nasledujúci deň';
  v_pattern text := E'(\\n\\s*)(if \\(p_slot_date \\+ p_slot_time\\) at time zone ''Europe/Bratislava'' < now\\(\\) then)';
  v_check text := E'\\1if p_slot_date <= (now() at time zone ''Europe/Bratislava'')::date then\\1  raise exception ''Online sa dá objednať najskôr na nasledujúci deň. Pri akútnych ťažkostiach volajte 155, inak nám napíšte SMS na 0949 000 677.'';\\1end if;\\1\\2';
begin
  foreach v_fn in array array['create_order', 'ct_create_order', 'angio_create_order', 'patient_reschedule', 'angio_patient_reschedule'] loop
    n := 0;
    for r in
      select p.oid, p.oid::regprocedure as sig, p.prosrc
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = v_fn
    loop
      if r.prosrc like '%' || v_marker || '%' then
        raise notice 'TERMIN-ZAJTRA: % už má kontrolu, preskakujem.', r.sig; n := n + 1; continue;
      end if;
      v_def := pg_get_functiondef(r.oid);
      v_new := regexp_replace(v_def, v_pattern, v_check);
      if v_new = v_def then
        raise notice 'TERMIN-ZAJTRA: % nemá kontrolu uplynutého termínu (stará/iná verzia) — nemením.', r.sig;
        continue;
      end if;
      execute v_new;
      n := n + 1; total := total + 1;
    end loop;
    if n = 0 then
      raise exception 'TERMIN-ZAJTRA: % — nenašla sa žiadna verzia s kontrolou uplynutého termínu, upravte ručne.', v_fn;
    end if;
  end loop;
  raise notice 'TERMIN-ZAJTRA: kontrola doplnená do % funkcií.', total;
end $$;

-- kontrola
do $$
declare v text;
begin
  select string_agg(proname, ', ') into v from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('create_order', 'ct_create_order', 'angio_create_order', 'patient_reschedule', 'angio_patient_reschedule')
      and prosrc like '%Vybraný termín už uplynul%'
      and prosrc not like '%najskôr na nasledujúci deň%';
  if v is not null then raise exception 'TERMIN-ZAJTRA: bez kontroly: %', v; end if;
  select string_agg(proname, ', ') into v from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('reschedule_order', 'angio_reschedule', 'ct_reschedule')
      and prosrc like '%najskôr na nasledujúci deň%';
  if v is not null then raise exception 'TERMIN-ZAJTRA: kontrola sa omylom dostala do staff RPC: %', v; end if;
  raise notice 'TERMIN-ZAJTRA OK: pacient sa online objedná najskôr na nasledujúci deň (5 RPC), personál bez zmeny.';
end $$;
