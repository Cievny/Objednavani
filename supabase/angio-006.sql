-- ============================================================
-- ANGIO 006 — štruktúrované pokyny v e-maili
--   Pokyny typu vyšetrenia (angio_pricelist.instructions) sa v e-maili
--   doteraz zobrazovali ako holý text. Odteraz sa jednoduché formátovanie
--   z Nastavení prenesie do e-mailu:
--     • prázdny riadok            → nový odsek
--     • riadok končiaci „:"       → tučný nadpis (napr. „Čo priniesť:")
--       (alebo riadok začínajúci „# ")
--     • riadok začínajúci „- ", „* " alebo „• " → odrážka
--     • ostatné riadky            → bežný text
--   Telá angio_notify_trigger a send_angio_reminders sa nemenia, len sa
--   v nich výraz replace(html_escape(v_instr), E'\n', '<br>') nahradí
--   volaním angio_instr_html(v_instr) — kľúče ostávajú.
-- Idempotentné. Spúšťať PO angio-004.
-- ============================================================

create or replace function angio_instr_html(p_text text)
returns text
language plpgsql immutable as $$
declare
  l       text;
  t       text;
  v_out   text := '';
  in_list boolean := false;
begin
  if coalesce(p_text, '') = '' then return ''; end if;
  for l in select regexp_split_to_table(p_text, E'\r?\n') loop
    t := btrim(l);
    if t = '' then
      if in_list then v_out := v_out || '</ul>'; in_list := false; end if;
      v_out := v_out || '<div style="height:8px"></div>';
    elsif t ~ '^[-*•]\s+' then
      if not in_list then v_out := v_out || '<ul style="margin:2px 0 4px;padding-left:20px">'; in_list := true; end if;
      v_out := v_out || '<li style="margin:2px 0">' || html_escape(regexp_replace(t, '^[-*•]\s+', '')) || '</li>';
    elsif t ~ '^#\s+' or (t ~ ':$' and length(t) <= 60) then
      if in_list then v_out := v_out || '</ul>'; in_list := false; end if;
      v_out := v_out || '<div style="margin-top:6px"><b>' || html_escape(regexp_replace(t, '^#\s+', '')) || '</b></div>';
    else
      if in_list then v_out := v_out || '</ul>'; in_list := false; end if;
      v_out := v_out || html_escape(t) || '<br>';
    end if;
  end loop;
  if in_list then v_out := v_out || '</ul>'; end if;
  -- zbytočný <br> na konci
  v_out := regexp_replace(v_out, '<br>$', '');
  return v_out;
end $$;

do $mig$
declare
  fn     text;
  v_body text;
  v_ret  text;
  v_old  text := $x$replace(html_escape(v_instr), E'\n', '<br>')$x$;
begin
  foreach fn in array array['angio_notify_trigger', 'send_angio_reminders'] loop
    select prosrc, pg_get_function_result(oid) into v_body, v_ret
    from pg_proc where proname = fn and pronamespace = 'public'::regnamespace;
    if v_body is null then
      raise notice '% neexistuje — najprv spustite angio-001/003/004.', fn;
      continue;
    end if;
    if position(v_old in v_body) = 0 then
      if position('angio_instr_html(v_instr)' in v_body) > 0 then
        raise notice '% už používa angio_instr_html.', fn;
      else
        raise notice '% má neočakávané telo — spustite najprv angio-004 a potom tento skript znova.', fn;
      end if;
      continue;
    end if;
    v_body := replace(v_body, v_old, 'angio_instr_html(v_instr)');
    execute format('create or replace function %I() returns %s language plpgsql security definer set search_path = public as %L', fn, v_ret, v_body);
    raise notice '% — pokyny sa posielajú formátované.', fn;
  end loop;
end $mig$;

revoke all on function send_angio_reminders() from public, anon, authenticated;
-- ============================================================
