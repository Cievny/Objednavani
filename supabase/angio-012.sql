-- ============================================================
-- ANGIO 012 — „Zachráň nohu": edukačný text „Viac o vyšetrení"
--   (podľa odporúčaní ESC 2024, ACC/AHA 2024, IWGDF/ESVS/SVS 2023,
--   zostručnené pre pacienta). Nahrádza about pri položke s id
--   ang_vnwtrvq2 (náhradne podľa názvu „ZACHRÁŇ NOHU"). Idempotentné.
--   Text sa dá kedykoľvek upraviť v Správa → Angio → Nastavenia.
-- ============================================================
update angio_pricelist
set about = $t$Kedy nečakať na termín a volať 155:
- Náhla silná bolesť nohy, noha je bledá alebo chladná, necítite ju alebo ňou nevládzete hýbať.
- Čierny prst alebo čierna časť chodidla.
- Rana s horúčkou, zimnicou alebo rýchlo sa šíriacim začervenaním.
Pre koho je vyšetrenie:
- Rana na nohe, ktorá sa nehojí viac ako 2 týždne.
- Vred na nohe alebo zmena farby prsta či chodidla.
- Bolesť nohy v pokoji, najmä v noci, ktorá sa zmierni po spustení nohy z postele.
- Najmä ak máte cukrovku, fajčíte alebo ste už mali cievny zákrok.
Čo si priniesť:
- Fotku rany z mobilu, ak máte, aj staršie, nech vidíme vývoj.
- Zoznam všetkých liekov a správy od lekára.
- Lieky nevysadzujte sami, o riedení krvi a liekoch na cukrovku rozhodneme spolu.
- Povedzte nám o alergii na kontrastnú látku alebo jód.
Ako vyšetrenie prebieha:
- Rozhovor, vyšetrenie nohy a hmatanie pulzov.
- Meranie tlakov na nohe manžetou, pri cukrovke aj na prste.
- Ultrazvuk ciev nôh.
- Hneď na mieste sa dozviete ďalší postup: podrobnejšie zobrazenie ciev, zákrok alebo liečba rany. Vyšetrenie trvá približne 15 až 20 minút.
Prečo neodkladať:
Pri nehojacej sa rane rozhoduje čas. Väčšine amputácií pri cukrovke predchádza vred, ktorý sa nehojí. Včasné ošetrenie ciev výrazne zvyšuje šancu, že sa rana zahojí a noha sa zachráni.
Podľa odporúčaní ESC 2024, ACC/AHA 2024 a IWGDF/ESVS/SVS 2023.$t$
where id = 'ang_vnwtrvq2' or label ~* 'zachr[áa][ňn] nohu';
-- Kontrola: select id, label, left(about, 60) from angio_pricelist where label ~* 'zachr';
