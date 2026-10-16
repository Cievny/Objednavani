# Program Zachráň nohu — odpovede na dotazník (praktik.ai)

*Stav k 16. 10. 2026. Odpovede opisujú skutočné fungovanie podľa kódu aplikácie (vetva `beta`, v107) a podľa nastavení živej databázy (kontrola na čítanie 16. 10. 2026). Kde sa ostrá prevádzka (`main`, v102) líši od bety, je to označené. Bez hesiel, kľúčov a údajov pacientov. Príklady správ sú so zástupnými hodnotami v `{zložených zátvorkách}`.*

**Značky:** **[UŽ FUNGUJE]** = v ostrej prevádzke · **[LEN BETA]** = hotové, nasadené na `objednanie.cievny.sk/beta/`, do ostrej po schválení · **[PLÁNUJEME]** = zatiaľ nie je · **neviem — preverí NÚSCH / technik** = mimo kódu, doplní prevádzkovateľ.

---

## A. Účel programu a zodpovedné subjekty

**1. Čo program poskytuje.** Štyri veci: (a) verejnú informačnú stránku o nehojacej sa rane na nohe a zlom prekrvení (čísla, vysvetlenie, priebeh vyšetrenia, čo bude po ňom, kedy volať 155, mýty, zdroje); (b) orientačný samotest so 4 otázkami áno/nie, vyhodnocovaný len v prehliadači; (c) formulár „Zavolajte mi späť" (meno + telefón), po ktorom personál Angiologickej ambulancie č. 1 pacientovi zavolá a termín dohodne telefonicky; (d) priame online objednanie na vyšetrenie „ZACHRÁŇ NOHU – Rýchle zhodnotenie rany na dolnej končatine" (15 min, bez žiadanky) s výberom termínu v kalendári, potvrdením e-mailom a SMS, pripomienkou a možnosťou termín online zmeniť alebo zrušiť. Ďalšie služby (napr. telemedicína, chat) program neposkytuje. Všetko **[UŽ FUNGUJE]**.

**2. Bez poplatku; podmienky účasti.** Áno, všetky služby programu sú pre pacienta bez poplatku; ide o zdravotnú starostlivosť hradenú z verejného zdravotného poistenia. Formulár nemá žiadne podmienky účasti (vek, poisťovňa, diagnóza sa nekontrolujú); poisťovňu pacient len vyberie (VšZP, Dôvera, Union, „Iná / bez poistenia"). Obsahovo je program určený ľuďom s ranou na nohe, ktorá sa nehojí dlhšie ako 2 týždne, alebo s rizikovými faktormi; samotest to pacientovi pomôže posúdiť, ale nič mu nebráni objednať sa aj bez neho. Postup pri pacientoch bez verejného poistenia: **neviem — preverí NÚSCH**.

**3. Kto program zastrešuje.** Národný ústav srdcových a cievnych chorôb, a.s., Pod Krásnou hôrkou 1, Bratislava — **Angiologická ambulancia č. 1** (uvedené v hlavičke stránky, v pätičke aj v e-mailoch). Iný organizátor ani partner (poisťovňa, farmaceutická firma, občianske združenie) v programe nie je. Odborné zdroje sú verejné odporúčania ESC 2024, ACC/AHA 2024, IWGDF/ESVS/SVS 2023 a AHA 2024.

**4. Úloha FiveV s. r. o.** Vývoj aplikácie, jej nasadenie (hosting na GitHub Pages), správa databázového projektu Supabase a jeho skriptov, napojenie na odosielanie e-mailov (Resend) a SMS (BulkGate), technická podpora a bezpečnostné audity. FiveV nepoužíva údaje na vlastné účely; prístup k údajom má len v rozsahu technickej správy (správca databázy) a podľa pokynov NÚSCH. Kto konkrétne vlastní a platí účty u dodávateľov — pozri bod 34 (na potvrdenie).

**5. Kto schvaľuje konečné texty.** **neviem — preverí NÚSCH.** Návrh: vedenie Angiologickej ambulancie č. 1 (odborný obsah), zodpovedná osoba NÚSCH (DPO) a právne oddelenie NÚSCH (opis a GDPR text), technický správca FiveV (vecná správnosť technickej časti). V aplikácii je dnes text označený ako „NÁVRH — čaká na schválenie právnym oddelením a DPO".

## B. Web a dostupné funkcie

**6. Adresy.**
- **Aktívne:** `https://objednanie.cievny.sk/zachrannohu/` (krátka adresa, presmeruje na `https://objednanie.cievny.sk/#/angio1/zachrannohu`); bežné objednávanie do ambulancie `https://objednanie.cievny.sk/#/angio1` (tam je tiež formulár „Zavolajte mi späť"); správa objednávky z e-mailu `https://objednanie.cievny.sk/#/angio1/objednavka/{ID}`; právne texty `…/#/podmienky` a `…/#/osobne-udaje`; správa pre personál `https://objednanie.cievny.sk/sprava/` (samostatná zostava aplikácie, len po prihlásení).
- **Skúšobná:** `https://objednanie.cievny.sk/beta/…` — rovnaká aplikácia v novšej verzii, zdieľa tú istú databázu, označená štítkom „beta" a vylúčená z vyhľadávačov (noindex).
- **Plánované:** doména `zachrannohu.sk` ako presmerovanie na krátku adresu vyššie (registrátor Websupport; nastavenie na strane NÚSCH ešte nie je urobené). **[PLÁNUJEME]**

**7. Aktívne funkcie.** Informačná stránka ✔, samotest ✔, „Zavolajte mi späť" ✔ (v ostrej od 13. 10. 2026), priamy výber termínu ✔, nahratie prílohy ✔ (nepovinné, lebo vyšetrenie nevyžaduje žiadanku), správa alebo zrušenie objednávky ✔ (online cez číslo objednávky a telefón). Iné: overenie telefónu SMS kódom pri objednávke ✔ (zapnuté), pripomienky e-mailom a SMS deň vopred ✔. **[LEN BETA]**: povinné políčko „Oboznámil/a som sa s podmienkami…" v objednávke, veta s odkazom na informácie o údajoch pod formulárom „Zavolajte mi späť", rozšírené právne texty.

**8. Spoločná databáza a administrácia.** Áno. Program používa ten istý databázový projekt a tú istú správu ako objednávanie na USG a CT, ale údaje sú v **samostatných tabuľkách**: objednávky ambulancie (`angio_orders`) a žiadosti o zavolanie (`angio_callbacks`), oddelene od USG (`orders`) a CT (`ct_orders`). Žiadosť nesie značku zdroja „zachrannohu" alebo „angio1". V správe ich vidí len personál s prístupom k Angiologickej ambulancii č. 1: role **správca (superadmin)** a **sestra** všetko; **lekár** len objednávky, kde je uvedený ako vyšetrujúci, a žiadosti o zavolanie len na čítanie. Pravidlá sú vynútené v databáze (Row Level Security), nie len v rozhraní.

**9. Iný kontakt než web.** Na stránke je uvedené číslo **0949 000 677** (SMS; „zavoláme späť"), v e-mailoch adresa pracoviska. Program je stavaný tak, aby pacient, ktorý nezvláda web, nechal číslo cez formulár alebo poslal SMS. Kto služobný mobil a e-maily obsluhuje (sestra ambulancie? v akých hodinách?) a či je možné osobné objednanie v ambulancii: **neviem — preverí NÚSCH**.

## C. Formulár „Zavolajte mi späť"

**10. Polia.** Len dve: **Meno a priezvisko** (povinné, jedno pole) a **Telefónne číslo** (povinné). Žiadna poznámka, e-mail ani zdravotné údaje. Voľba „kedy volať" bola v prvej verzii, od v102 je odstránená (server ju ešte pozná, posiela sa prázdna).

**11. Čo sa uloží automaticky.** Číslo žiadosti (ZV-xxxxxxxx), čas odoslania, **IP adresa** odosielateľa (na ochranu pred zneužitím; po 7 dňoch sa vymaže), zdrojová stránka („zachrannohu" alebo „angio1"), telefónne číslo aj v normalizovanom tvare (421…). Neukladá sa výsledok samotestu, identifikátor prehliadača ani zariadenia, user-agent ani cookie.

**12. Po odoslaní.** Návštevník vidí: „Ďakujeme, {meno}. Žiadosť sme prijali. Zavoláme vám na číslo {telefón} najneskôr nasledujúci pracovný deň. Telefón majte prosím pri sebe." a upozornenie, že pri náhlom zhoršení má volať 155. Žiadosť sa uloží do databázy (Supabase, región EÚ). Personál dostane: **SMS** na služobný mobil nastavený v správe (text: `NUSCH spatne volanie: {meno bez diakritiky}, tel. +{číslo}, volat kedykolvek. Sprava: objednanie.cievny.sk/sprava`) a **e-mail** na adresu pre kópie objednávok (predmet „Spätné volanie ZV-… (kedykoľvek)", obsah: meno, telefón, číslo žiadosti, zdroj, pokyn overiť žiadosť pri hovore). Ochrana: ak príde viac než 20 žiadostí za 15 minút, žiadosti sa uložia, ale upozornenia sa neposielajú (ochrana proti zahlteniu SMS). Rovnaké číslo s nevybavenou žiadosťou za posledných 24 h sa druhýkrát neuloží; návštevník dostane rovnaké poďakovanie.

**13. Kto volá a kedy.** Stránka sľubuje hovor **najneskôr nasledujúci pracovný deň**. Kto volá (sestra / lekár ambulancie), koľko pokusov sa robí a čo nasleduje pri nedostupnom pacientovi: **neviem — preverí NÚSCH**. Systém to podporuje stavmi „Nová → Volané → Objednaný / Nedovolali sme sa → Uzavreté"; odporúčame interný postup napr. 2 pokusy v dvoch rôznych dňoch, potom SMS a stav „Nedovolali sme sa".

**14. Čo personál zapisuje.** V rozhraní: **stav** (Nová, Volané, Objednaný, Nedovolali sme sa, Uzavreté) a **voľnú poznámku** (do 500 znakov; návod v poli: „napr. objednaný na 20.10. 9:00, číslo objednávky"). Systém sám dopĺňa čas poslednej zmeny a identifikátor konta personálu, ktoré zmenu urobilo. Pole na číslo vytvorenej objednávky existuje v databáze, ale rozhranie ho zatiaľ nepoužíva (personál ho píše do poznámky). Zdravotné ťažkosti sa do poznámky písať nemajú (nie je na to pole ani pokyn); samotná objednávka vzniká až v objednávacom formulári. Návrh: do interného postupu výslovne uviesť „do poznámky nepísať zdravotné údaje".

**15. Nahrávanie hovorov.** Objednávkový systém hovory nerealizuje, nenahráva ani neprepisuje. Či telefónna ústredňa NÚSCH alebo služobný mobil hovory nahráva: **neviem — preverí NÚSCH** (podľa našich informácií nie).

## D. Priame online objednanie

**16. Výber termínu.** Pacient si sám vyberie deň a čas z voľných termínov v kalendári (ponúkajú sa termíny z blokov, ktoré ambulancia otvorila). Objednávka vzniká ihneď so stavom „Nová" a pacient hneď dostane potvrdenie e-mailom a SMS. Personál ju môže následne potvrdiť (stav „Potvrdená", pacient dostane ďalšiu správu), presunúť alebo zrušiť. Stránka aj správy upozorňujú, že čas termínu je orientačný, lebo ambulancia musí niekedy prednostne ošetriť akútneho pacienta.

**17. Údaje v objednávke.**

| Údaj | Povinný | Poznámka |
|---|---|---|
| meno a priezvisko | áno | jedno pole, 3–200 znakov |
| dátum narodenia | áno | písaný DD.MM.RRRR; nie v budúcnosti, nie pred 1900 |
| rodné číslo | **nevyžaduje sa** | ak je na priloženej žiadanke/správe, spracúva sa len v rámci prílohy |
| poisťovňa | voľba (predvolená VšZP) | VšZP / Dôvera / Union / Iná |
| telefón | áno | aspoň 9 číslic; pri zapnutom overení aj SMS kód |
| e-mail | áno | na potvrdenie a správu objednávky |
| adresa | **nevyžaduje sa** | |
| dôvod vyšetrenia / poznámka | nie | voľný text do 2000 znakov |
| prílohy | nie (pri tomto vyšetrení) | max. 3 súbory po 5 MB, PDF/JPG/PNG |
| typ vyšetrenia, termín | áno | pri Zachráň nohu je vyšetrenie predvybrané |

Ukladá sa aj čas vytvorenia, stav a interná poznámka personálu. IP adresa sa pri objednávke **neukladá** (len dočasné počítadlo na obmedzenie počtu pokusov, mazané každú hodinu).

**18. Prílohy.** Dá sa nahrať žiadanka, fotografia rany alebo lekárska správa, všetko **dobrovoľne** („Žiadanka alebo lekárske správy — nepovinné"); pri iných vyšetreniach ambulancie, ktoré žiadanku vyžadujú, je príloha povinná. Súbory idú do neverejného úložiska do priečinka s číslom objednávky. Prezerá ich personál ambulancie v správe (správca a sestra všetky; lekár len pri vlastných pacientoch) cez dočasný odkaz platný 5 minút; sťahujú sa jednotlivo, hromadný export neexistuje. Prílohy sa automaticky mažú po termíne (pozri bod 37).

**19. Overenie.** Telefón sa overuje **SMS kódom pri odoslaní objednávky** (v ostrej prevádzke zapnuté): pacient si nechá poslať 6-miestny kód, platí 10 minút, max. 3 SMS na číslo za 15 minút, 5 pokusov na kód; bez overeného čísla objednávka neprejde. E-mail sa overovacím odkazom neoveruje (potvrdenie naň príde). Pri správe alebo zrušení objednávky sa SMS kód nevyžaduje (pozri bod 20). Žiadosť „Zavolajte mi späť" sa neoveruje vôbec (zámerne jednoduché pre seniorov; personál overí pri hovore).

**20. Otvorenie, zmena, zrušenie.** Pacient zadá **číslo objednávky (ANG-…) a telefónne číslo** uvedené v objednávke (musí sa zhodovať posledných 9 číslic), buď v sekcii „Už máte objednávku?", alebo cez tlačidlo „Zmeniť / zrušiť termín" v e-maile, ktoré číslo objednávky predvyplní (telefón treba stále zadať). Zobrazí sa len stav, termín, lekár a typ vyšetrenia (nie meno, dátum narodenia ani dôvod). Zmena termínu je možná najneskôr 24 hodín vopred (kontroluje server), zrušenie je online možné kedykoľvek do termínu. Počet pokusov je obmedzený (10 na telefónne číslo a 30 na IP adresu za 15 minút). Ďalšie overenie (SMS kód) sa pri týchto krokoch nepoužíva.

**21. Posudzovanie pred potvrdením.** Systém nič zdravotné neposudzuje. Personál vidí v správe celú objednávku (vrátane dôvodu a príloh) a môže ju potvrdiť, presunúť alebo zrušiť s dôvodom („Na žiadosť pacienta", „Prekážka na strane pracoviska", „Duplicitná objednávka", vlastný text); dôvod sa uloží k objednávke a pošle pacientovi. Či lekár pred termínom prílohy systematicky posudzuje a kde zaznamenáva medicínske rozhodnutie (zdravotná dokumentácia v NIS?): **neviem — preverí NÚSCH**. Podľa návrhu programu sa triedenie robí až pri vyšetrení.

## E. Objednávanie za inú osobu

**22. Môže odoslať príbuzný.** Áno, obe cesty s tým počítajú (text pri formulári: „Objednať vás môže aj syn, dcéra či sused — s vaším vedomím napíše vaše meno a telefón, na ktorom vás zastihneme."). Formulár žiada **údaje pacienta** (meno pacienta, telefón, na ktorom zastihneme pacienta); pri objednávke aj e-mail — môže byť e-mail pacienta alebo pomáhajúcej osoby, formulár to nerozlišuje. Údaje pomáhajúcej osoby sa nezbierajú. **[LEN BETA]**: políčko v objednávke obsahuje vetu „Ak objednávate inú osobu, potvrdzujete, že konáte s jej vedomím."; v Podmienkach je vyhlásenie, že konajúca osoba koná s vedomím pacienta.

**23. Rozlíšenie pacient / zástupca.** Formulár **nerozlišuje** (žiadne pole „kto vypĺňa"). Pri hovore personál komunikuje s osobou na uvedenom čísle; postup, ako si overí, že hovorí s pacientom alebo s kým (otázka na dátum narodenia, súhlas pacienta s tým, aby za neho konal príbuzný): **neviem — preverí NÚSCH**, odporúčame doplniť do interného postupu.

**24. Deti a osoby s opatrovníkom.** Technicky nič nebráni (dátum narodenia sa neobmedzuje), program však nie je pre deti určený (nehojace sa rany pri ateroskleróze a cukrovke sú problém dospelých). Postup overenia zastúpenia (predloženie dokladu pri vyšetrení) a či sa deti majú z programu vylúčiť: **neviem — preverí NÚSCH**.

**25. Čo dostane objednávajúca osoba.** Všetky správy idú na e-mail a telefón uvedené vo formulári. Potvrdzovací e-mail obsahuje typ vyšetrenia (názov „ZACHRÁŇ NOHU – Rýchle zhodnotenie rany…"), termín, lekára, číslo objednávky, pokyny a odkaz na správu termínu; SMS obsahuje názov ambulancie, termín a pokyn, čo priniesť. Opis ťažkostí (dôvod), prílohy ani výsledky vyšetrenia sa nikdy neposielajú. Ten, kto pozná číslo objednávky a telefón, môže termín zmeniť alebo zrušiť.

## F. Samotest a zdravotnícky obsah

**26. Otázky a výsledky (doslovne).** Nadpis „Môžem sa objednať?", podtitul „Odpovedzte na 4 otázky. Nič sa nikam neukladá." Odpovede Áno / Nie.
1. „Máte na nohe ranu, vred alebo odreninu, ktorá sa nehojí dlhšie ako 2 týždne?" *(silná)*
2. „Máte cukrovku, fajčíte, chodíte na dialýzu alebo ste už mali zákrok na cievach nôh?" *(rizikový faktor)*
3. „Bolí vás noha v pokoji, najmä v noci, a uľaví sa vám, keď ju spustíte z postele?" *(silná)*
4. „Zmenil prst alebo chodidlo farbu (modrá, fialová, čierna) alebo je noha nápadne chladná?" *(silná)*

Výsledok sa zobrazí až po zodpovedaní všetkých otázok („Výsledok sa zobrazí po zodpovedaní všetkých otázok."):
- Áno na otázku 1, 3 alebo 4 → **„Objednajte sa čo najskôr."** „Vaše odpovede ukazujú na ranu alebo bolesť, pri ktorej treba cievy vyšetriť bez odkladu. Termín máte do týždňa." + tlačidlo „Chcem sa objednať ›" (posun na objednávací formulár).
- Áno len na otázku 2 → **„Vyšetrenie sa oplatí."** „Máte rizikový faktor, pri ktorom sa cievy nôh oplatí skontrolovať. Objednajte sa, alebo to preberte so svojím lekárom."
- Všetko Nie → **„Zatiaľ nie je dôvod na obavy."** „Sledujte nohy. Ak sa objaví rana, ktorá sa nehojí, bolesť v pokoji alebo zmena farby, objednajte sa."
- Pod každým výsledkom: „Test nenahrádza vyšetrenie. Pri náhlej silnej bolesti a bledej či studenej nohe volajte 155."

Samostatná sekcia „Kedy okamžite volať 155 / 112" vymenúva: náhla silná bolesť nohy, noha zrazu bledá, mramorová alebo studená, necitlivosť alebo nehybnosť, sčernenie prsta, rana s horúčkou/zimnicou/šíriacim sa začervenaním.

**27. Vyhodnotenie.** Výlučne v prehliadači návštevníka (stav stránky v pamäti). Odpovede sa **neodosielajú, neukladajú** (ani do localStorage), **neprenášajú do formulára**, nezapisujú do analytiky (žiadna nie je) a personál ich nevidí. Po obnovení stránky sú preč.

**28. Autorstvo a schválenie obsahu.** Obsah pripravil MUDr. Lukáš Vincze (Angiologická ambulancia č. 1, NÚSCH) na základe odporúčaní ESC 2024, ACC/AHA 2024, IWGDF/ESVS/SVS 2023 a AHA 2024 (zdroje sú v pätičke stránky); technicky ho spracovala FiveV. Formálne schválenie vedením pracoviska a kto zodpovedá za aktualizácie: **neviem — preverí NÚSCH**. Samostatné posúdenie z hľadiska zdravotníckeho softvéru (MDR) **nebolo vykonané**; samotest nič nediagnostikuje ani nevypočítava, len podľa jednoduchého pravidla „aspoň jedno áno pri silnej otázke" zobrazí jeden z troch pevných textov s odporúčaním objednať sa, a výslovne uvádza, že nenahrádza vyšetrenie. Prosíme o posúdenie, či je potrebné niečo viac.

## G. Správy pacientovi a personálu

**29. Správy pacientovi (všetko [UŽ FUNGUJE]).**

| Udalosť | Kanál | Obsah (anonymizované) |
|---|---|---|
| odoslanie objednávky | e-mail | predmet „Objednávka — Angiologická ambulancia č. 1 — {DD.MM.RRRR} o {HH:MM}"; telo: názov vyšetrenia, termín, lekár, číslo objednávky, pokyny k vyšetreniu, spoločné pokyny ambulancie (vrátane vety o orientačnom čase), adresa, rámček „Potrebujete zmeniť alebo zrušiť termín?" s tlačidlom na `…/#/angio1/objednavka/{ID}`, „Vyšetrenie je bez poplatku." |
| odoslanie objednávky | SMS | `NUSCH: Rezervacia - angiologicka amb. c. 1, {DD.MM.RRRR HH:MM}. Prineste zoznam liekov. Podrobnosti v e-maili.` (pri vyšetrení so žiadankou „Prineste ziadanku a zoznam liekov.") |
| potvrdenie personálom | e-mail + SMS | „Termín potvrdený — …"; SMS `NUSCH: Vas termin v angiologickej amb. c. 1 {termín} je potvrdeny. Pridte 10 min vopred.` |
| zmena termínu (personálom alebo pacientom) | e-mail + SMS | „Zmena termínu — … — nový termín …"; SMS `NUSCH: Zmena terminu - angiologicka amb. c. 1. Novy termin: {termín}. Podrobnosti v e-maili.` |
| zrušenie (personálom alebo pacientom) | e-mail + SMS | „Objednávka zrušená — …" s dôvodom; SMS `NUSCH: Vasa objednavka do angiologickej amb. c. 1 na {termín} bola zrusena. Podrobnosti v e-maili.` |
| pripomienka deň vopred (17:00 SEČ) | e-mail + SMS | „Pripomienka: zajtra {HH:MM} — Angiologická ambulancia č. 1"; SMS `NUSCH: Pripomienka - zajtra {HH:MM} angiologicka amb. c. 1. Pridte 10 min vopred. Prineste zoznam liekov. Zmena/zrusenie online cez odkaz v e-maili.` |
| žiadosť o zavolanie | žiadna správa pacientovi | potvrdenie len na obrazovke (bod 12) |
| SMS overovací kód | SMS | `NUSCH: Vas overovaci kod: {6 číslic}. Plati 10 minut. Nikomu ho neposielajte.` |

SMS nikdy neobsahuje meno pacienta. Odosielateľ SMS je textový „NUSCH". E-mail odosiela adresa nastavená v správe (doména cievny.sk). Angio e-maily zatiaľ **nemajú** v pätičke odkazy na podmienky a informácie o údajoch (majú ich len USG e-maily) — doplníme.

**30. Správy personálu.**
- **E-mail pri novej objednávke a pri zrušení pacientom** (od 13. 10. 2026): predmet „Nová objednávka — Angiologická ambulancia č. 1 — {ID} — {termín}" / „Pacient zrušil objednávku — …"; obsah: **meno, dátum narodenia, poisťovňa, telefón, e-mail, vyšetrenie, termín, lekár, dôvod/poznámka (prvých 500 znakov), počet príloh, číslo objednávky**, tlačidlo do správy. Prílohy sa neposielajú. Dôvod vyšetrenia je zdravotný údaj — prosíme posúdiť, či ho z e-mailu vypustiť (technicky jednoduché).
- **Spätné volanie:** SMS `NUSCH spatne volanie: {meno}, tel. +{číslo}, volat kedykolvek. Sprava: objednanie.cievny.sk/sprava` (meno skrátené na 40 znakov bez diakritiky) a e-mail s menom, telefónom, číslom žiadosti a zdrojom. Alternatíva „neutrálne upozornenie bez mena" je technicky možná.
- Pripomienky, potvrdenia a zmeny personál e-mailom nedostáva; vidí ich v správe.

**31. Schránky a zariadenia.** E-maily idú na dve adresy nastavené v databáze: adresa pre kópie objednávok (služobná schránka lekára v doméne nusch.sk) a kontaktná adresa pracoviska v doméne cievny.sk (schránky Zoho). SMS idú na jeden služobný mobil nastavený v správe (len správca ho môže zmeniť). Či sú to výlučne služobné zariadenia a či existuje presmerovanie na súkromný e-mail: **neviem — preverí NÚSCH** (systém žiadne presmerovanie nerobí).

**32. Prístup k schránkam a mazanie.** **neviem — preverí NÚSCH.** Systém správy po odoslaní neuchováva (u poskytovateľa Resend ostávajú technické záznamy o doručení podľa jeho podmienok; obsah správ v jeho rozhraní je dostupný obmedzený čas — preveríme a doplníme). Odporúčame: spoločná služobná schránka ambulancie s automatickým mazaním po 90 dňoch a mobil so zámkom, SMS mazať po vybavení.

## H. Dodávatelia a umiestnenie údajov

**33. Používané služby.**

| Služba | Používa sa? | Na čo |
|---|---|---|
| Supabase | áno | databáza, úložisko príloh, prihlasovanie personálu, naplánované úlohy, trezor kľúčov |
| Resend | áno | odosielanie e-mailov pacientom a personálu |
| BulkGate | áno | odosielanie SMS (potvrdenia, pripomienky, overovacie kódy, upozornenie personálu) |
| Zoho | áno (nepriamo) | e-mailové schránky domény cievny.sk, kam chodí kópia pre personál |
| GitHub | áno | zdrojový kód a hosting statickej stránky (GitHub Pages); žiadne údaje pacientov |
| Fio banka | **nie** pre tento program | používa sa len pri platených USG |
| hosting | GitHub Pages (statické súbory) + Supabase (API) | |
| monitoring chýb, analytika, CAPTCHA, ochrana formulárov, mapy, videá, externé písma | **nie** | písma sú súčasťou stránky; ochrana formulárov je vlastná (limity počtu pokusov na IP a číslo) |
| Websupport | plánované | len presmerovanie domény zachrannohu.sk |

**34. Účty, správa, platby.** Podľa našich informácií sú účty Supabase, Resend, BulkGate a GitHub zriadené a spravované **FiveV** v mene NÚSCH; schránky Zoho a doména cievny.sk patria pracovisku. Kto účty platí a na koho sú zmluvne vedené: **neviem — preverí NÚSCH/FiveV** (odporúčame, aby prevádzkovateľ mal minimálne prístup vlastníka alebo písomné potvrdenie vlastníctva účtov).

**35. Zmluvné subjekty a regióny.**
- Supabase, Inc. (USA) — projekt v regióne **Frankfurt, eu-central-1 (AWS)**: databáza, prílohy, zálohy aj logy sú v EÚ. DPA Supabase je štandardné online (prijatím podmienok).
- Resend — Plus Five Five, Inc. (USA), certifikácia EU-U.S. Data Privacy Framework; e-maily (adresa, meno, termín, typ vyšetrenia, u personálu aj ďalšie údaje) prechádzajú do USA.
- BulkGate — prevádzkovateľ so sídlom v Českej republike (presné obchodné meno podľa zmluvy/faktúry: na doplnenie); SMS obsah a čísla.
- Zoho Corporation — dátové centrum pre účet cievny.sk (EÚ?): na overenie.
- GitHub, Inc. (USA) — len zdrojový kód a statické súbory, technické logy prístupu na web (IP).
- Zmluvy/DPA a zoznamy subdodávateľov: **neviem — preverí FiveV/NÚSCH**; vieme priložiť odkazy na verejné DPA dodávateľov.

**36. Podpora mimo EÚ.** Supabase aj GitHub sú americké spoločnosti; ich technická podpora môže mať v odôvodnených prípadoch prístup k infraštruktúre mimo EÚ (Supabase deklaruje prístup k dátam zákazníka len na žiadosť zákazníka). Resend spracúva v USA. Podklady: Supabase DPA + SCC, Resend DPF certifikát, GitHub DPA — **na preverenie a priloženie (FiveV)**.

## I. Uchovávanie a vymazávanie

**37. Skutočne nastavené lehoty ([UŽ FUNGUJE], automaticky).**

| Kategória | Lehota | Od kedy |
|---|---|---|
| žiadosť o zavolanie — vybavená (iný stav než Nová) | zmazaná po 90 dňoch | od poslednej zmeny stavu |
| žiadosť o zavolanie — nevybavená (Nová) | zmazaná po 90 dňoch | od odoslania |
| IP adresa pri žiadosti | vymazaná po 7 dňoch | od odoslania |
| objednávka — uskutočnená, zrušená aj zmeškaná | celá objednávka zmazaná 28 dní po termíne | od termínu |
| prílohy a dôvod vyšetrenia | zmazané ihneď po termíne (nedostavenie, zrušenie, nepotvrdená) alebo najneskôr 7 dní po termíne; pri zrušení ihneď | od termínu / zrušenia |
| technické počítadlá pokusov (IP, telefón) | 1 hodina | od pokusu |
| SMS overovacie záznamy (číslo, odtlačok kódu) | 1 deň | od odoslania kódu |
| auditný záznam operácií personálu (bez mien) | 90 dní | od operácie |
| záznamy o odoslaných požiadavkách na e-mail/SMS (technické odpovede) | 90 dní | |
| záznam „zdravotného stavu systému" (health_events, bez osobných údajov) | zatiaľ bez lehoty | doplníme 90 dní |
| e-maily a SMS u pacienta / v schránkach personálu | mimo systému | pozri 31–32 |
| zálohy databázy | denné zálohy Supabase, uchovanie 7 dní | |

**38. Automatické mazanie.** Už funguje: naplánované databázové úlohy bežia každú noc (objednávky ambulancie 01:15 UTC, žiadosti o zavolanie 03:41 UTC, osirelé prílohy 02:30 UTC, počítadlá každú hodinu). Úspešnosť kontroluje technický správca FiveV (záznam behov úloh, bezpečnostné audity); funkcie boli testované na skúšobnej databáze pri zavedení. Pravidelný protokol o kontrole mazania zatiaľ nie je — **[PLÁNUJEME]** (mesačná kontrola + záznam).

**39. Prenos do NIS / zdravotnej dokumentácie.** Objednávkový systém nie je napojený na nemocničný informačný systém. Pri vyšetrení si personál údaje potrebné do zdravotnej dokumentácie zapíše ručne (v správe je tlačidlo „Kopírovať údaje pacienta"). Čo presne sa prenáša (prílohy? dôvod?), kto to robí a ako sa overí pred automatickým výmazom (7 dní po termíne): **neviem — preverí NÚSCH**; odporúčame interný pokyn „prílohy potrebné do dokumentácie uložiť do NIS v deň vyšetrenia".

**40. Zálohy a obnova.** Supabase robí denné zálohy databázy s uchovaním 7 dní (plán bez obnovy k bodu v čase). Po obnove zo zálohy by sa mohli vrátiť údaje vymazané za posledných max. 7 dní; v takom prípade sa nočné mazacie úlohy spustia znova a údaje po lehote opäť odstránia (je to opísané aj v informáciách pre pacientov). Postup obnovy je v rukách technického správcu; písomný postup obnovy **[PLÁNUJEME]**.

**41. Dlhšie uchovanie pri sťažnosti alebo incidente.** Systém to zatiaľ nepodporuje (mazanie je automatické a bez výnimiek). Kto by rozhodoval a ako údaje oddeliť: **neviem — preverí NÚSCH**. Technicky je možné doplniť príznak „pozdržať výmaz" s dôvodom a dátumom; navrhujeme to zaviesť až podľa odporúčania posudku.

## J. Prístupy a bezpečnosť

**42. Kto čo vidí.**

| Kategória | sestra | lekár | správca (superadmin, NÚSCH) | FiveV (správca DB) | podpora dodávateľov |
|---|---|---|---|---|---|
| objednávky (všetky údaje) | áno | len vlastní pacienti | áno | technický prístup k databáze | len infraštruktúra (pozri 36) |
| prílohy | áno | len vlastní pacienti | áno | technický prístup | — |
| žiadosti o zavolanie | áno (mení) | len číta | áno | technický prístup | — |
| nastavenia, používatelia | áno (časť) | nie | áno | áno | — |
| auditný záznam | áno | nie | áno | áno | — |

Vedenie NÚSCH bez vlastného konta prístup nemá. Pacient vidí len svoju objednávku (číslo + telefón). **Export alebo hromadné stiahnutie** údajov ambulancie v aplikácii **neexistuje** (CSV export je len pri platených USG); jednotlivé údaje sa dajú skopírovať do schránky. Priamy export z databázy môže urobiť len správca databázy (FiveV).

**43. Dvojfaktorové overenie.** Rozhranie **vyžaduje** zápis autentifikátora (TOTP) pri prvom prihlásení pre každého člena personálu a potom kód pri každom prihlásení. Vynútenie na úrovni databázy (`mfa_enforce`) je zatiaľ **vypnuté** — zapne sa, keď si ho zapíšu všetci (dnes sú 2 kontá personálu, 1 ešte bez autentifikátora) **[PLÁNUJEME, do 14 dní]**. Každý má vlastné konto (pozvánka e-mailom), zdieľané kontá nie sú. Rolu správcu možno prideliť len priamo v databáze, nie z aplikácie.

**44. Ochrana príloh a prístupu pacienta.** Súbory sú v neverejnom úložisku; personál ich otvára cez podpísaný odkaz platný **5 minút**; nahrať možno len PDF/JPG/PNG do 5 MB, max. 3 na objednávku, len do priečinka existujúcej objednávky. Pacient sa k objednávke dostane len kombináciou čísla objednávky (náhodných 10 znakov, nedá sa uhádnuť) a telefónu; limity 10 pokusov na číslo a 30 na IP za 15 minút. Objednávky: max. 20 z jednej IP za 15 minút a 3 aktívne na jedno telefónne číslo; žiadosti o zavolanie 5 z IP a 2 na číslo za 15 minút. SMS kódy: 3 na číslo za 15 minút, 5 pokusov na kód, globálny strop 60 kódov za 15 minút.

**45. Osobné údaje v logoch a verejných nástrojoch.** Do adresy (URL) sa dostáva len číslo objednávky (ANG-…), nikdy meno ani telefón. Auditný záznam obsahuje len číslo objednávky, akciu a zmenu stavu/termínu/lekára. Chybové hlásenia pacientovi sú všeobecné; chyby sa nikam externe neodosielajú (žiadny monitoring). Zdrojový kód je verejný na GitHube a **neobsahuje** žiadne kľúče ani údaje pacientov (kontrolované pri auditoch; kľúče sú v trezore databázy). Technické logy poskytovateľov (Supabase, GitHub Pages) obsahujú IP adresy a adresy požiadaviek podľa ich podmienok. Jedna vec na opravu: zoznam žiadostí o zavolanie posiela do prehliadača personálu aj stĺpec s IP adresou (nezobrazuje sa) — odstránime.

**46. Bezpečnostné testy a incidenty.** Kód prešiel 9 vlnami interného bezpečnostného auditu (naposledy október 2026) s nápravou nálezov; používa sa Supabase Security Advisor; automatizované testy prebiehajú pri každej zmene. Externý penetračný test **nebol** vykonaný. Incident: technické hlásenie prijíma a prístupy vie okamžite zablokovať správca FiveV (odobratie role / konta, zmena kľúčov, vypnutie formulárov); kto je kontaktná osoba na strane NÚSCH a písomný postup hlásenia (vrátane 72-hodinovej lehoty voči ÚOOÚ): **neviem — preverí NÚSCH** / **[PLÁNUJEME]** písomný postup.

## K. Cookies, analytika a automatické spracúvanie

**47. Cookies a úložisko prehliadača.** Stránka **nepoužíva cookies**. V ostrej prevádzke pacientska časť do prehliadača **nič neukladá**: rozpracovaný formulár, odpovede samotestu, prílohy aj overovací kód sú len v pamäti stránky a po obnovení zmiznú. Jediný záznam v localStorage vzniká u **personálu po prihlásení**: prihlasovací token knižnice Supabase (`sb-…-auth-token`, obsahuje prístupový a obnovovací token a identitu používateľa; platí do odhlásenia, obnovovaný automaticky). Aplikácia má aj skúšobný režim bez databázy (len pre vývoj), ktorý ukladá ukážkové objednávky do localStorage — v ostrej prevádzke sa nepoužíva.

**48. Externé nástroje a obsah.** Žiadne: bez Google Analytics, Meta Pixel, máp, videí, CAPTCHA, externých písiem (písma Source Sans 3 a Source Serif 4 sú súčasťou stránky), bez sledovania kliknutí v e-mailoch (odkazy v e-mailoch vedú priamo na objednanie.cievny.sk) a bez nástrojov na záznam správania. Bezpečnostná politika obsahu (CSP) v stránke dovoľuje spojenie len s vlastnou doménou a databázovým projektom. Náhľad pri zdieľaní (OG obrázok) je na vlastnej doméne.

**49. Automatické rozhodnutia.** Systém robí len technické rozhodnutia: odmietne neplatné údaje (napr. meno bez písmen, číslo s menej ako 9 číslicami), dočasne obmedzí počet pokusov z jednej IP adresy alebo telefónneho čísla (15 minút), nedovolí viac než 3 aktívne objednávky na číslo a pri žiadosti o zavolanie neuloží duplicitu do 24 hodín. **Neurčuje naliehavosť, neposudzuje zdravotný stav ani nezamieta pacienta** — samotest len zobrazí jeden z troch textov a nikam sa neposiela; o termíne a postupe rozhoduje personál. Každý technický zásah vie personál preveriť (pacient môže poslať SMS / nechať číslo) a limity sú dočasné.

## L. Kontakty a existujúce podklady

**50. Kontakty na zverejnenie.** Kontakt pracoviska pre pacientov: SMS 0949 000 677 (dnes v texte), e-mail pracoviska — **doplní NÚSCH**. Kontakt na uplatnenie práv k údajom, zodpovedná osoba NÚSCH (DPO): **neviem — doplní NÚSCH** (v texte sú zatiaľ označené [DOPLNIŤ]). Technické problémy: navrhujeme adresu pracoviska s preposlaním technikovi (FiveV), aby pacient nekontaktoval dodávateľa priamo.

**51. Existujúce dokumenty.**
- všeobecné informácie NÚSCH o ochrane údajov — **neviem — preverí NÚSCH** (na webe NÚSCH pravdepodobne existujú, máme sa na ne odvolať)
- zmluva NÚSCH – FiveV a prílohy (čl. 28) — **neviem — preverí NÚSCH** (podľa našich informácií zatiaľ nie je)
- zmluvné podklady dodávateľov — štandardné online podmienky/DPA (Supabase, Resend, BulkGate, GitHub), zhromaždí FiveV
- záznam o spracovateľských činnostiach — nie je (návrh obsahu: tabuľka v `docs/pravne-posudenie-navrh.md`, časť 4.1)
- retenčná smernica — nie je ako dokument; lehoty sú v kóde a v informáciách pre pacientov
- posúdenie oprávneného záujmu (IP adresa, OTP) — nie je
- DPIA alebo vstupné posúdenie — nie je
- pravidlá prístupov, incidentov a vybavovania žiadostí — nie sú; technické pravidlá prístupov sú zdokumentované v kóde a v internom checklist-e (GO-LIVE.md)

**52. Konečný výstup.** Potrebujeme **oboje samostatne**: (1) verejný text na web — „Informácie o spracúvaní osobných údajov" a „Podmienky online objednávania" (dnes návrh na `…/#/osobne-udaje` a `…/#/podmienky`, zapracujeme opravy); (2) interný opis systému pre NÚSCH/DPO (základ: tento dotazník + technická príloha v `docs/pravne-posudenie-navrh.md`). Stav prevádzky: informačná stránka Zachráň nohu s objednaním je **v ostrej prevádzke od 12. 10. 2026**, formulár „Zavolajte mi späť" od 13. 10. 2026 (zatiaľ jednotky žiadostí). Dnes sú pri formulároch v ostrej prevádzke tieto informácie: v pätičke každej stránky odkazy „Podmienky online objednávania · Ochrana osobných údajov" (texty písané pre USG, označené NÁVRH) a pri formulári Zavolajte mi späť veta „Číslo použijeme len na dohodnutie termínu…". Verzia na bete (v107) má navyše povinné políčko oboznámenia v objednávke, vetu s odkazom pri žiadosti o zavolanie a texty rozšírené o tento program — do ostrej ich dáme po vašom posúdení.

---

## Nezrovnalosti zistené pri odpovedaní (opravíme v aplikácii)

1. Angio e-maily nemajú v pätičke odkazy na Podmienky a Informácie o údajoch (majú ich len USG e-maily) — doplniť.
2. Zoznam žiadostí o zavolanie posiela stĺpec IP do prehliadača personálu (nezobrazuje sa) — vyradiť zo selectu.
3. Tabuľka `health_events` (technický stav systému, bez osobných údajov) nemá lehotu — doplniť 90 dní.
4. Rozhranie hovorí „zrušenie najneskôr 24 hodín vopred", server pri zrušení lehotu nevynucuje (len pri zmene termínu) — zjednotiť text.
5. Informácie o údajoch majú „[OVERIŤ región projektu]" — región je potvrdený Frankfurt (eu-central-1), doplniť.
6. Zvážiť: dôvod vyšetrenia v e-maili personálu a meno pacienta v SMS personálu nahradiť neutrálnym upozornením (podľa posudku).
7. Pri schválení interného postupu doplniť do správy pole „číslo objednávky" pri žiadosti o zavolanie namiesto voľnej poznámky.
