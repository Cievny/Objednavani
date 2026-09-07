-- ============================================================
-- ANGIO 010 — kratšie e-maily: popis vyšetrenia na stránku, pokyny do e-mailu
--   • nový stĺpec angio_pricelist.about — dlhší popis vyšetrenia (čo to je,
--     pre koho, trvanie, priebeh); pacient ho vidí na stránke po rozkliknutí
--     „Viac o vyšetrení" (v89), do e-mailu NEJDE
--   • angio_pricelist.instructions — odteraz len praktické pokyny
--     (Čo priniesť, Príprava, Kontraindikácie, Upozornenie…) → e-mail
--   • existujúce texty sa rozdelia automaticky (angio_split_instructions):
--     úvodný text + sekcie Pre koho / Trvanie / Priebeh / Čo vás čaká /
--     Po vyšetrení / Výsledky / Kedy sa objednať → about; ostatné → instructions
--     Opravuje aj chybu formátovača, keď riadok zoznamu začínajúci slovom
--     „Výsledky" rozbil zoznam „Čo priniesť".
--   • formátovač angio_autoformat_instructions v2 (v zozname sa riadok
--     s pokračujúcim textom už neberie ako nadpis)
--   • spoločné pokyny: kratšie znenie (len ak sú v pôvodnom znení; pôvodné
--     sa uloží do settings.angio_common_notes_backup)
--   Zálohy: instructions_backup (ak ešte nie je), about_backup netreba.
--   Idempotentné. Spúšťať PO angio-006 (a angio-texty-format-001, ak bol).
-- ============================================================

alter table angio_pricelist add column if not exists about text not null default '';
alter table angio_pricelist add column if not exists instructions_backup text;

-- ------------------------------------------------------------
-- 1. Formátovač v2 (oprava: v zozname riadok s textom za kľúčovým slovom
--    nie je nadpis — nadpis je len samostatné slovo alebo riadok s „:")
-- ------------------------------------------------------------
create or replace function angio_autoformat_instructions(p_text text)
returns text
language plpgsql immutable as $$
declare
  l        text;
  t        text;
  low      text;
  kw       text;
  rest     text;
  out_l    text[] := '{}';
  list_on  boolean := false;
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
  after_head boolean := false;
begin
  if coalesce(p_text, '') = '' then return p_text; end if;
  for l in select regexp_split_to_table(p_text, E'\r?\n') loop
    t := btrim(l);
    if t = '' then
      if after_head then continue; end if;
      out_l := array_append(out_l, '');
      list_on := false;
      continue;
    end if;
    after_head := false;
    if t ~ '^[-*•]\s+' then
      out_l := array_append(out_l, ('- ' || btrim(regexp_replace(t, '^[-*•]\s+', ''))));
      continue;
    end if;
    low := lower(t);
    matched := false;
    foreach h in array heads loop
      hlist := right(h, 1) = '*';
      hk := rtrim(h, '*');
      -- v zozname je nadpisom len samostatné slovo alebo riadok s dvojbodkou/pomlčkou;
      -- mimo zoznamu aj „Pre koho Pacienti…" (text hneď za kľúčovým slovom)
      if low = hk or low ~ ('^' || hk || '\s*[:–-]') or (not list_on and low ~ ('^' || hk || '\s+') and length(hk) >= 4) then
        rest := btrim(substr(t, length(hk) + 1));
        rest := btrim(regexp_replace(rest, '^[:–-]\s*', ''));
        kw := substr(t, 1, length(hk));
        kw := upper(left(kw, 1)) || substr(kw, 2);
        if hk in ('trvanie', 'dĺžka vyšetrenia', 'dlzka vysetrenia', 'kde', 'miesto') and rest <> '' and length(rest) <= 40 then
          out_l := array_append(out_l, (kw || ': ' || rest));
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

-- ------------------------------------------------------------
-- 2. Rozdelenie textu: about (stránka) / instructions (e-mail)
-- ------------------------------------------------------------
create or replace function angio_split_instructions(p_text text, out o_about text, out o_instr text)
language plpgsql immutable as $$
declare
  lines    text[];
  i        int;
  n        int;
  t        text;
  low      text;
  nxt      text;
  j        int;
  target   text := 'about';   -- kam ide aktuálna sekcia
  list_sec boolean := false;  -- aktuálna sekcia je zoznam (e-mail)
  a_l      text[] := '{}';
  m_l      text[] := '{}';
  mail_heads text[] := array['čo priniesť','co priniest','čo si priniesť','co si priniest','čo so sebou','co so sebou',
    'príprava','priprava','ako sa pripraviť','ako sa pripravit','kontraindikácie','kontraindikacie',
    'upozornenie','dôležité','dolezite','poznámka','poznamka','kde','miesto'];
  is_head  boolean;
  is_mail  boolean;
  h        text;
  found_head boolean := false;
begin
  o_about := ''; o_instr := '';
  if coalesce(p_text, '') = '' then return; end if;
  lines := regexp_split_to_array(p_text, E'\r?\n');
  n := coalesce(array_length(lines, 1), 0);
  i := 1;
  while i <= n loop
    t := btrim(lines[i]);
    low := lower(t);
    if t = '' then
      if target = 'about' then a_l := array_append(a_l, ''); else m_l := array_append(m_l, ''); end if;
      i := i + 1; continue;
    end if;
    -- nadpis: riadok s „:" na konci (≤60) alebo jednoriadkové „Trvanie: 30 min"
    is_head := (t ~ ':$' and length(t) <= 60 and t !~ '^[-*•]\s') or low ~ '^(trvanie|dĺžka vyšetrenia|dlzka vysetrenia)\s*:';
    if is_head then
      found_head := true;
      -- oprava rozbitého zoznamu: nadpis, za ktorým nasleduje riadok začínajúci malým písmenom,
      -- vnútri zoznamu → v skutočnosti položka zoznamu („Výsledky:" + „predchádzajúcich…")
      nxt := ''; j := i + 1;
      while j <= n and btrim(lines[j]) = '' loop j := j + 1; end loop;
      if j <= n then nxt := btrim(lines[j]); end if;
      if list_sec and t ~ ':$' and nxt <> '' and nxt ~ '^[[:lower:]]' then
        m_l := array_append(m_l, '- ' || rtrim(t, ':') || ' ' || regexp_replace(nxt, '^[-*•]\s+', ''));
        i := j + 1; continue;
      end if;
      is_mail := false;
      foreach h in array mail_heads loop
        if low = h || ':' or low ~ ('^' || h || '\s*[:–-]') then is_mail := true; exit; end if;
      end loop;
      if is_mail then
        target := 'mail';
        list_sec := low !~ '^(upozornenie|dôležité|dolezite|poznámka|poznamka|kde|miesto)';
        m_l := array_append(m_l, t);
      else
        target := 'about'; list_sec := false;
        a_l := array_append(a_l, t);
      end if;
      i := i + 1; continue;
    end if;
    if target = 'about' then
      a_l := array_append(a_l, t);
    else
      m_l := array_append(m_l, case when list_sec and t !~ '^[-*•]\s' then '- ' || t else t end);
    end if;
    i := i + 1;
  end loop;
  -- text bez nadpisov (napr. jedna veta „Prineste si žiadanku…") je praktický pokyn a ostáva v e-maili
  if not found_head then
    o_about := ''; o_instr := btrim(p_text, E'\n'); return;
  end if;
  o_about := btrim(regexp_replace(array_to_string(a_l, E'\n'), E'\n{3,}', E'\n\n', 'g'), E'\n');
  o_instr := btrim(regexp_replace(array_to_string(m_l, E'\n'), E'\n{3,}', E'\n\n', 'g'), E'\n');
end $$;

-- migrácia existujúcich textov (len tam, kde about ešte nie je vyplnený)
update angio_pricelist set instructions_backup = instructions
where instructions_backup is null and coalesce(instructions, '') <> '';

update angio_pricelist p set
  about = s.o_about,
  instructions = s.o_instr
from (select id, (angio_split_instructions(instructions)).* from angio_pricelist) s
where s.id = p.id and p.about = '' and coalesce(p.instructions, '') <> '' and s.o_about <> '';

-- ------------------------------------------------------------
-- 3. Kratšie spoločné pokyny (len ak sú v pôvodnom znení)
-- ------------------------------------------------------------
do $$
declare
  cur text;
  v2  text := E'Príďte 10 minút pred termínom, so sebou kartičku poistenca a doklad totožnosti.\nAk nemôžete prísť, zrušte alebo presuňte termín online (odkaz v e-maili alebo „Už máte objednávku?" na stránke) aspoň 24 hodín vopred – uvoľníte miesto inému pacientovi. Telefón/SMS len v naozaj nutných prípadoch – ozveme sa vám späť.\nPoložky označené „po dohovore" sa neobjednávajú priamo online – najprv nás kontaktujte, dohodneme vhodný termín a prípravu.\nVyšetrenia nalačno objednávame prednostne na ranné hodiny.\nAk užívate lieky na riedenie krvi, nikdy ich nevysadzujte sami – o postupe rozhodneme spolu.\nČas termínu je orientačný. Sme špecializované pracovisko najvyššieho typu – termín sa výnimočne môže posunúť pre akútny zákrok. O plánovaných zmenách termínu vás vždy vopred informujeme e-mailom a SMS.';
  v1  text := E'Príďte 10 minút pred termínom, so sebou kartičku poistenca a doklad totožnosti.\nAk nemôžete prísť, zrušte alebo presuňte termín aspoň 24 hodín vopred – uvoľníte miesto inému pacientovi.\nPoložky označené „po dohovore" sa neobjednávajú priamo online – najprv nás kontaktujte, dohodneme vhodný termín a prípravu.\nVyšetrenia nalačno objednávame prednostne na ranné hodiny.\nAk užívate lieky na riedenie krvi, nikdy ich nevysadzujte sami – o postupe rozhodneme spolu.\nČas termínu je orientačný. Sme špecializované pracovisko najvyššieho typu – termín sa výnimočne môže posunúť pre akútny zákrok. O plánovaných zmenách termínu vás vždy vopred informujeme e-mailom a SMS.';
  v3  text := E'Príďte 10 minút vopred s kartičkou poistenca a dokladom totožnosti.\nZmena alebo zrušenie termínu: online, najneskôr 24 hodín vopred (tlačidlo v e-maili). Telefón/SMS len v naozaj nutných prípadoch – ozveme sa späť.\nPoložky „po dohovore" objednávame až po dohode s nami.\nVyšetrenia nalačno dávame prednostne na ráno.\nLieky na riedenie krvi nikdy nevysadzujte sami – o postupe rozhodneme spolu.\nČas termínu je orientačný – ako pracovisko najvyššieho typu ho výnimočne posunieme pre akútny zákrok; o zmenách vás informujeme vopred.';
begin
  select value into cur from settings where key = 'angio_common_notes';
  if cur is not null and cur in (v1, v2) then
    insert into settings (key, value) values ('angio_common_notes_backup', cur)
      on conflict (key) do update set value = excluded.value;
    update settings set value = v3 where key = 'angio_common_notes';
    raise notice 'Spoločné pokyny skrátené (pôvodné v angio_common_notes_backup).';
  else
    raise notice 'Spoločné pokyny majú vlastné znenie — nezmenené.';
  end if;
end $$;

select id, label, about, instructions from angio_pricelist order by sort_order;
-- ============================================================
