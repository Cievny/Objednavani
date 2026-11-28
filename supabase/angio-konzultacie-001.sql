-- ============================================================
-- ANGIO-KONZULTACIE-001 (28. 11. 2026) — vyšetrenia v Angiologickej ambulancii č. 1
-- podľa tém z dotazníka konzultácií (Instagram)
--
-- Keď lekár pri konzultácii rozhodne „Pozvať k nám", pacient dostane odkaz
-- objednanie.cievny.sk/angio1/?v=<vyšetrenie> a v objednávaní má vyšetrenie
-- už vybrané. Pre témy, ktoré ambulancia doteraz nemala, pribúda 6 vyšetrení:
--
--   ang_k_tepny     bolesť nôh pri chôdzi – tepny dolných končatín
--   ang_k_karotidy  zúženie krčných tepien
--   ang_k_aneuryzma vydutina aorty alebo tepny
--   ang_k_renalne   zúženie obličkových tepien
--   ang_k_avm       cievna malformácia
--   ang_k_zily      stav po trombóze, dlhodobý opuch nohy
--
-- Ostatné témy idú na existujúce vyšetrenia (kŕčové žily → Konzultácia pred
-- RFA, rana → Zachráň nohu, panva → kompresia ciev v brušnej dutine, po zákroku
-- → kontrola po výkone / po RFA, iné → Prvé cievne vyšetrenie).
--
--  • bez žiadanky (ako Konzultácia pred RFA a Prvé cievne vyšetrenie), 20 minút;
--    názov, popis, dĺžku aj žiadanku zmeníte v správe ambulancie → Cenník;
--  • pridajú sa každému lekárovi, ktorý robí bežné vyšetrenia ambulancie (inak by
--    sa pre ne neponúkli termíny); lekár so zoznamom len „Zachráň nohu" ostáva bez zmeny;
--  • existujúce vyšetrenia a ich nastavenia sa nemenia (už pridané sa neprepíšu).
--
-- Idempotentné. Projekt „USG objednavanie".
-- ============================================================

do $$
begin
  if to_regclass('public.angio_pricelist') is null or not exists (
       select 1 from information_schema.columns where table_schema = 'public' and table_name = 'angio_pricelist' and column_name = 'requires_referral') then
    raise exception 'ANGIO-KONZULTACIE-001: chýba tabuľka vyšetrení ambulancie — ste v projekte „USG objednavanie"?';
  end if;
end $$;

-- 1. nové vyšetrenia (na koniec zoznamu; už existujúce sa nemenia)
with nove(id, label, description, instructions, ord) as (values
  ('ang_k_tepny', 'Bolesť nôh pri chôdzi – vyšetrenie tepien dolných končatín',
   'Ultrazvuk tepien nôh a meranie tlakov pri bolesti nôh pri chôdzi alebo v pokoji.',
   'Prineste si zoznam liekov a doterajšie nálezy a správy od lekára. Pohodlné oblečenie, nohy budeme vyšetrovať až po slabiny.', 1),
  ('ang_k_karotidy', 'Zúženie krčných tepien (karotíd) – posúdenie liečby',
   'Ultrazvuk krčných tepien a rozhodnutie o sledovaní, liekoch alebo zákroku.',
   'Prineste si zoznam liekov, doterajšie nálezy (ultrazvuk, CT, MR) a správy od neurológa, ak ich máte.', 2),
  ('ang_k_aneuryzma', 'Vydutina (aneuryzma) aorty alebo tepny – posúdenie liečby',
   'Ultrazvuk vydutiny a rozhodnutie o sledovaní alebo zákroku.',
   'Prineste si zoznam liekov a doterajšie nálezy; CT alebo MR vyšetrenie aj na CD, ak ho máte. Na ultrazvuk brucha príďte nalačno (4 hodiny nejesť).', 3),
  ('ang_k_renalne', 'Zúženie obličkových tepien – posúdenie liečby',
   'Ultrazvuk obličkových tepien pri ťažko liečiteľnom tlaku alebo zhoršovaní funkcie obličiek.',
   'Príďte nalačno (4 hodiny nejesť). Prineste si zoznam liekov, záznamy tlaku z domu, posledné výsledky krvi (kreatinín) a doterajšie nálezy.', 4),
  ('ang_k_avm', 'Cievna malformácia (AVM, žilová malformácia) – posúdenie liečby',
   'Ultrazvuk malformácie a plán ďalšej diagnostiky alebo liečby.',
   'Prineste si všetky doterajšie nálezy (ultrazvuk, MR, CT — aj na CD) a správy z liečby, ak ste už boli liečený/á.', 5),
  ('ang_k_zily', 'Stav po trombóze, dlhodobý opuch nohy – vyšetrenie žíl',
   'Ultrazvuk žíl nôh pri ťažkostiach po trombóze alebo pri dlhodobom opuchu.',
   'Prineste si zoznam liekov (aj na riedenie krvi — nevysadzujte ich) a správy o prekonanej trombóze.', 6)
)
insert into angio_pricelist (id, label, description, instructions, duration_slots, active, sort_order, requires_referral)
select n.id, n.label, n.description, n.instructions, 4, true, coalesce((select max(sort_order) from angio_pricelist), 0) + n.ord, false
from nove n
on conflict (id) do nothing;

-- 2. lekári: nové vyšetrenia každému, kto robí bežné vyšetrenia ambulancie
--    (zoznam obsahuje aspoň jedno vyšetrenie okrem „Zachráň nohu"); prázdny zoznam = robí všetko
do $$
declare
  v_doc jsonb; v_new jsonb := '["ang_k_tepny","ang_k_karotidy","ang_k_aneuryzma","ang_k_renalne","ang_k_avm","ang_k_zily"]'::jsonb;
  v_out jsonb := '[]'::jsonb; d jsonb; ids jsonb; x jsonb; v_zn text;
begin
  select value::jsonb into v_doc from settings where key = 'angio_doctors';
  if v_doc is null or jsonb_typeof(v_doc) <> 'array' then
    raise notice 'ANGIO-KONZULTACIE-001: zoznam lekárov nie je nastavený — nové vyšetrenia robí každý lekár.';
    return;
  end if;
  select id into v_zn from angio_pricelist where id = 'ang_vnwtrvq2' or label ~* 'zachr[áa][ňn] nohu' order by (id = 'ang_vnwtrvq2') desc limit 1;
  for d in select * from jsonb_array_elements(v_doc) loop
    ids := coalesce(d -> 'examTypeIds', '[]'::jsonb);
    if jsonb_typeof(ids) = 'array' and jsonb_array_length(ids) > 0
       and exists (select 1 from jsonb_array_elements_text(ids) e where e is distinct from v_zn) then
      for x in select * from jsonb_array_elements(v_new) loop
        if not ids @> jsonb_build_array(x) then ids := ids || jsonb_build_array(x); end if;
      end loop;
      d := jsonb_set(d, '{examTypeIds}', ids);
    end if;
    v_out := v_out || jsonb_build_array(d);
  end loop;
  if v_out is distinct from v_doc then
    update settings set value = v_out::text where key = 'angio_doctors';
  end if;
end $$;

notify pgrst, 'reload schema';

-- výsledok (SQL editor ukáže tento riadok)
select 'ANGIO-KONZULTACIE-001 OK' as vysledok,
       (select count(*) from angio_pricelist where id like 'ang\_k\_%' and active) as nove_vysetrenia_aktivne,
       (select count(*) from jsonb_array_elements(coalesce((select value::jsonb from settings where key = 'angio_doctors'), '[]'::jsonb)) d
         where d -> 'examTypeIds' @> '["ang_k_tepny"]'::jsonb) as lekari_s_novymi_vysetreniami;
