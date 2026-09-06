-- ============================================================
-- ANGIO — automatické sformátovanie uložených pokynov k vyšetreniam
--   Prejde angio_pricelist.instructions a upraví text tak, aby ho
--   e-mail (angio-006) zobrazil štruktúrovane:
--     • rozpozná nadpisy sekcií na začiatku riadku (Pre koho, Trvanie,
--       Čo priniesť, Príprava, Priebeh, Po vyšetrení, Upozornenie, …)
--       a urobí z nich riadok „Nadpis:" (text za nadpisom ide na nový riadok)
--     • v sekciách Čo priniesť / Príprava / Kontraindikácie / Ako sa
--       pripraviť dá každému riadku odrážku „- " (ak ju nemá); prázdny
--       riadok hneď za nadpisom sa vynechá
--     • prázdne riadky ostávajú (odsek), ostatný text sa nemení
--   Pôvodné znenie sa uloží do angio_pricelist.instructions_backup
--   (len prvýkrát) — vrátiť späť:
--     update angio_pricelist set instructions = instructions_backup
--       where instructions_backup is not null;
--   Na konci vypíše upravené texty (výsledok v SQL editore).
--   Idempotentné (druhé spustenie už nič nezmení).
-- ============================================================

create or replace function angio_autoformat_instructions(p_text text)
returns text
language plpgsql immutable as $$
declare
  l        text;
  t        text;
  low      text;
  kw       text;
  m        text[];
  rest     text;
  out_l    text[] := '{}';
  list_on  boolean := false;
  -- nadpisy sekcií (malé písmená, bez diakritiky aj s ňou); tie s * zapínajú odrážky
  heads    text[] := array[
    'pre koho', 'komu je určené', 'komu je urcene',
    'trvanie', 'dĺžka vyšetrenia', 'dlzka vysetrenia',
    'čo priniesť*', 'co priniest*', 'čo si priniesť*', 'co si priniest*', 'čo so sebou*', 'co so sebou*',
    'príprava*', 'priprava*', 'ako sa pripraviť*', 'ako sa pripravit*', 'príprava na vyšetrenie*', 'priprava na vysetrenie*',
    'kontraindikácie*', 'kontraindikacie*',
    'čo vás čaká', 'co vas caka', 'priebeh', 'priebeh vyšetrenia', 'priebeh vysetrenia', 'čo vyšetrenie zahŕňa', 'co vysetrenie zahrna',
    'po vyšetrení', 'po vysetreni', 'výsledok', 'vysledok', 'výsledky', 'vysledky',
    'kedy sa objednať', 'kedy sa objednat', 'objednanie', 'objednávanie', 'objednavanie',
    'upozornenie', 'dôležité', 'dolezite', 'poznámka', 'poznamka', 'cieľ vyšetrenia', 'ciel vysetrenia', 'kde', 'miesto'
  ];
  h        text;
  hk       text;
  hlist    boolean;
  matched  boolean;
  after_head boolean := false;  -- práve bol vypísaný nadpis bez textu
begin
  if coalesce(p_text, '') = '' then return p_text; end if;
  for l in select regexp_split_to_table(p_text, E'\r?\n') loop
    t := btrim(l);
    if t = '' then
      if after_head then continue; end if;   -- prázdny riadok hneď za nadpisom vynechať (zoznam pokračuje)
      out_l := array_append(out_l, '');
      list_on := false;
      continue;
    end if;
    after_head := false;
    -- už hotová odrážka
    if t ~ '^[-*•]\s+' then
      out_l := array_append(out_l, ('- ' || btrim(regexp_replace(t, '^[-*•]\s+', ''))));
      continue;
    end if;
    low := lower(t);
    matched := false;
    foreach h in array heads loop
      hlist := right(h, 1) = '*';
      hk := rtrim(h, '*');
      -- nadpis na začiatku riadku, za ním koniec / dvojbodka / pomlčka / medzera
      if low = hk or low ~ ('^' || hk || '\s*[:–-]') or (low ~ ('^' || hk || '\s+') and length(hk) >= 4) then
        rest := btrim(substr(t, length(hk) + 1));
        rest := btrim(regexp_replace(rest, '^[:–-]\s*', ''));
        kw := substr(t, 1, length(hk));
        kw := upper(left(kw, 1)) || substr(kw, 2);
        if hk in ('trvanie', 'dĺžka vyšetrenia', 'dlzka vysetrenia', 'kde', 'miesto') and rest <> '' and length(rest) <= 40 then
          out_l := array_append(out_l, (kw || ': ' || rest));       -- krátky údaj v jednom riadku
          list_on := false;
        else
          out_l := array_append(out_l, (kw || ':'));
          list_on := hlist;
          if rest <> '' then
            out_l := array_append(out_l, (case when list_on then '- ' else '' end || rest));
          else
            after_head := true;
          end if;
        end if;
        matched := true;
        exit;
      end if;
    end loop;
    if matched then continue; end if;
    -- iný riadok končiaci dvojbodkou = nadpis (odrážky nezapína)
    if t ~ ':$' and length(t) <= 60 then
      out_l := array_append(out_l, t);
      list_on := false;
      after_head := true;
      continue;
    end if;
    out_l := array_append(out_l, (case when list_on then '- ' else '' end || t));
  end loop;
  return btrim(array_to_string(out_l, E'\n'), E'\n');
end $$;

alter table angio_pricelist add column if not exists instructions_backup text;
update angio_pricelist set instructions_backup = instructions
where instructions_backup is null and coalesce(instructions, '') <> '';

update angio_pricelist set instructions = angio_autoformat_instructions(instructions)
where coalesce(instructions, '') <> '';

select id, label, instructions from angio_pricelist order by sort_order;
-- ============================================================
