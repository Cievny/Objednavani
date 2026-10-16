# Online objednávanie NÚSCH (objednanie.cievny.sk) — podklad na právne posúdenie

*Verzia k 16. 10. 2026 (aplikácia v107). Pripravené na posúdenie právnym poradcom / službou praktik.ai a následne DPO a právnym oddelením NÚSCH, a.s. Texty v časti 3 sú totožné s textami zverejnenými v aplikácii (`src/legal.jsx`, adresy `#/podmienky` a `#/osobne-udaje`); v aplikácii sú zatiaľ označené ako NÁVRH.*

## 1. O čom systém je

**objednanie.cievny.sk** je webová aplikácia Národného ústavu srdcových a cievnych chorôb, a.s. (prevádzkovateľ osobných údajov), ktorú technicky prevádzkuje FiveV s. r. o. (sprostredkovateľ). Pacient sa cez ňu objednáva bez registrácie a bez hesla. Má štyri toky:

| Tok | Adresa | Čo pacient robí | Platí sa? |
|---|---|---|---|
| USG vyšetrenia ciev (doplnkové ordinačné hodiny) | `/` | vyberie vyšetrenie a termín, vyplní údaje, zaplatí QR kódom / prevodom | áno (samoplatca alebo doplatok so žiadankou) |
| Angiologická ambulancia č. 1 | `/#/angio1` | vyberie vyšetrenie a termín, vyplní údaje, podľa typu priloží žiadanku; telefón môže byť overený SMS kódom | nie (verejné zdravotné poistenie) |
| Program **Zachráň nohu** (nehojaca sa rana na nohe) | `/zachrannohu`, pripravuje sa doména zachrannohu.sk | informačná stránka so samotestom (vyhodnotenie len v prehliadači, nič sa neukladá) + objednanie do angiologickej ambulancie na vyšetrenie **bez žiadanky** | nie |
| **Zavolajte mi späť** | súčasť `/#/angio1` a Zachráň nohu | zadá len meno a telefón; personál zavolá a termín dohodne telefonicky; môže odoslať aj príbuzný | nie |
| CT pracovisko | `/#/ct` | ako angiologická ambulancia, žiadanka vždy povinná | nie |

**Cieľová skupina programu Zachráň nohu sú seniori** (často s cukrovkou), preto je formulár „Zavolajte mi späť" zámerne najjednoduchší možný: dve polia, bez zaškrtávacieho políčka, s krátkou vetou a odkazom na informácie o osobných údajoch.

**Subdodávatelia sprostredkovateľa:** Supabase, Inc. (databáza a úložisko príloh, región EÚ), Resend / Plus Five Five, Inc. (e-maily, USA, certifikácia EU-U.S. Data Privacy Framework), BulkGate (SMS, Česká republika), Zoho Corporation (e-mailové schránky domény cievny.sk), GitHub, Inc. (hosting statického webu, bez údajov pacientov).

## 2. Čo potrebujeme posúdiť

Pri každej otázke uvádzame, ako sme to zatiaľ nastavili. Prosíme o potvrdenie, opravu alebo doplnenie.

1. **Právny základ bez súhlasu.** Spracúvanie staviame na čl. 6 ods. 1 písm. b) GDPR (objednanie = opatrenia pred uzavretím zmluvy o poskytnutí zdravotnej starostlivosti), pri zdravotných údajoch na čl. 9 ods. 2 písm. h) GDPR v spojení so zákonom č. 576/2004 Z. z., pri účtovných dokladoch na čl. 6 ods. 1 písm. c). Súhlas podľa čl. 6 ods. 1 písm. a) / čl. 9 ods. 2 písm. a) **zámerne nepoužívame** (bol by odvolateľný a pri zdravotnej starostlivosti nevhodný). Zaškrtávacie políčko vo formulári má preto znenie „Oboznámil/a som sa s Podmienkami… a s Informáciami…", nie „súhlasím so spracovaním". Je to správne a postačujúce na splnenie informačnej povinnosti podľa čl. 13 GDPR?
2. **Žiadosť o spätné zavolanie bez políčka.** Pri formulári s menom a telefónom nie je zaškrtávacie políčko, len veta „Odoslaním potvrdzujete, že ste sa oboznámili s informáciami o spracúvaní osobných údajov" s odkazom. Stačí to, alebo je políčko potrebné aj tu?
3. **Objednanie / žiadosť o zavolanie treťou osobou** (syn, dcéra, sused, opatrovateľ). Riešime vyhlásením konajúcej osoby (Podmienky čl. III ods. 5 a čl. X ods. 3) a informovaním pacienta podľa čl. 14 GDPR pri prvom hovore. Je to dostatočné? Treba niečo meniť pri osobách bez spôsobilosti na právne úkony?
4. **SMS personálu** s menom a telefónnym číslom pacienta na služobný mobil (cez BulkGate) pri novej žiadosti o zavolanie. Je primerané posielať meno pacienta, alebo máme posielať len „nová žiadosť, pozrite správu"?
5. **E-maily personálu** o každej objednávke (meno, dátum narodenia, poisťovňa, telefón, e-mail, typ vyšetrenia, termín, dôvod) cez Resend (USA, DPF) do schránok Zoho. Stačí certifikácia DPF ako základ prenosu podľa čl. 45, alebo máme uzavrieť aj štandardné zmluvné doložky / prejsť na EÚ poskytovateľa?
6. **Prílohy od pacienta** (fotografia žiadanky, lekárska správa — osobitná kategória). Ukladajú sa v privátnom úložisku s prístupom len pre prihlásený personál s dvojfaktorovým overením, mažú sa do 7 dní po termíne. Treba niečo navyše (napr. výslovné upozornenie pri nahrávaní)?
7. **IP adresa** pri žiadosti o zavolanie sa uchováva 7 dní na ochranu pred zneužitím (čl. 6 ods. 1 písm. f)). Pri objednávkach sa IP používa len na dočasné počítadlo (1 hodina). Je potrebný písomný test proporcionality (balančný test) a máme ho priložiť k záznamu podľa čl. 30?
8. **Overenie telefónu SMS kódom** (záznam: číslo, odtlačok kódu, čas; 1 deň). Je v poriadku ako oprávnený záujem?
9. **Lehoty uchovávania v objednávkovom systéme:** prílohy a dôvod do 7 dní po termíne, objednávka do 7 dní po uzavretí / najneskôr 28 dní po termíne, zrušené 7 dní, žiadosti o zavolanie 90 dní, auditný log 90 dní, faktúry 10 rokov. Zdravotná dokumentácia sa vedie **mimo** tohto systému v nemocničnom informačnom systéme. Je toto oddelenie správne opísané a sú lehoty obhájiteľné?
10. **Vyňatie platených USG vyšetrení z režimu zmlúv na diaľku** (zákon č. 108/2024 Z. z., čl. 3 ods. 3 písm. b) smernice 2011/83/EÚ) a **aplikovateľnosť alternatívneho riešenia sporov** (zákon č. 391/2015 Z. z.) — Podmienky čl. VI a VIII, dnes označené [OVERIŤ].
11. **Posúdenie vplyvu (DPIA, čl. 35 GDPR).** Ide o online spracúvanie zdravotných údajov pacientov nemocnice (nie vo veľkom rozsahu v zmysle recitálu 91 — jedno pracovisko, desiatky objednávok týždenne). Je DPIA povinná podľa zoznamu ÚOOÚ SR? Ak áno, priložíme technickú prílohu (časť 4) ako podklad.
12. **Zmluva so sprostredkovateľom (čl. 28 GDPR)** medzi NÚSCH a FiveV s. r. o. vrátane reťazenia subdodávateľov (Supabase, Resend, BulkGate, Zoho, GitHub). Prosíme o kontrolu, či existujúca zmluva pokrýva všetky toky vrátane spätných volaní a SMS personálu; ak zmluva neexistuje, prosíme o návrh.
13. **Informačná stránka Zachráň nohu** — zdravotnícky obsah, orientačný samotest (4 otázky áno/nie, výsledok len odporúča objednať sa / volať 155), odkazy na odborné odporúčania (ESC 2024, ACC/AHA 2024, IWGDF/ESVS/SVS 2023). V pätičke je vyhlásenie, že obsah nenahrádza vyšetrenie. Je formulácia zodpovednosti dostatočná?
14. **Cookies / localStorage bez súhlasu** — používa sa len technicky nevyhnutné úložisko (formulár, prihlásenie personálu), žiadna analytika; odvolávame sa na § 109 ods. 8 zákona č. 452/2021 Z. z. Správne?
15. **Čo ešte chýba**, aby bol prevádzkovateľ pri kontrole ÚOOÚ alebo ÚDZS krytý (napr. záznam o spracovateľských činnostiach, poučenie personálu, interná smernica pre vybavovanie práv dotknutých osôb)?

## 3. Navrhované znenie dokumentov

Miesta označené **[DOPLNIŤ]** a **[OVERIŤ]** sa vyplnia pri schválení (zoznam v časti 5).

---

## 3.1 Podmienky online objednávania

### Článok I — Poskytovateľ

Poskytovateľom zdravotnej starostlivosti a zmluvnou stranou pacienta je:

- **Obchodné meno:** Národný ústav srdcových a cievnych chorôb, a. s.
- **Sídlo:** Pod Krásnou hôrkou 1, 833 48 Bratislava
- **IČO:** 35 971 126
- **Registrácia:** Obchodný register Mestského súdu Bratislava III, oddiel Sa, vložka č. 3774/B
- **Pracovisko:** Špecializované sonografické pracovisko NÚSCH, a. s.
- **Kontakt pre objednávky:** SMS na 0949 000 677 (uveďte číslo objednávky) · e-mail **[DOPLNIŤ oficiálny e-mail]**

Objednávkový systém technicky prevádzkuje spoločnosť FiveV s. r. o., Hrudky 4318/63, 900 25 Chorvátsky Grob, IČO 56 516 711, ako sprostredkovateľ poskytovateľa; technická prevádzka systému nezakladá zmluvný vzťah medzi pacientom a touto spoločnosťou. (ďalej len „poskytovateľ" a „pracovisko")

### Článok II — Predmet a povaha zmluvy

1. Tieto podmienky upravujú online objednávanie prostredníctvom webovej stránky objednanie.cievny.sk (vrátane vstupov objednanie.cievny.sk/zachrannohu a zachrannohu.sk): a) rezerváciu termínu a úhradu ceny ultrasonografických (USG) vyšetrení poskytovaných v doplnkových ordinačných hodinách (články III až VIII), b) objednávanie na vyšetrenia v angiologickej ambulancii a na CT pracovisku poskytované bez poplatku v rámci verejného zdravotného poistenia (článok IX) a c) žiadosť o spätné zavolanie (článok X).
2. USG vyšetrenia podľa písm. a) sa poskytujú ako výkony uhrádzané pacientom podľa platného cenníka (samoplatca), alebo s doplatkom pri predložení žiadanky od lekára, ak to cenník pri danom vyšetrení umožňuje.
3. Odoslanie online objednávky je návrhom na uzavretie zmluvy o poskytnutí zdravotnej starostlivosti, resp. služieb súvisiacich s jej poskytovaním. Zmluva vzniká potvrdením termínu zo strany pracoviska po pripísaní platby; o potvrdení je pacient informovaný e-mailom, prípadne SMS.
4. Zmluva sa uzatvára v slovenskom jazyku. Údaje objednávky môže pacient pred jej odoslaním skontrolovať a opraviť. Objednávka je u poskytovateľa evidovaná po dobu uvedenú v dokumente Informácie o spracúvaní osobných údajov.

### Článok III — Objednávka a rezervácia termínu

1. Pacient si v systéme vyberie typ vyšetrenia a voľný termín a vyplní požadované údaje (meno a priezvisko, dátum narodenia, telefón, e-mail, dôvod vyšetrenia; pri vyšetrení so žiadankou aj údaje odporúčajúceho lekára a prílohy).
2. Odoslaním objednávky vzniká rezervácia termínu. Rezervácia sa stáva záväznou až po pripísaní platby a potvrdení pracoviskom.
3. Ak platba nie je pripísaná do 3 pracovných dní od odoslania objednávky, najneskôr však 24 hodín pred termínom, pracovisko je oprávnené rezerváciu zrušiť a termín uvoľniť.
4. Pracovisko si vyhradzuje právo objednávku odmietnuť alebo termín presunúť z prevádzkových alebo medicínskych dôvodov; v takom prípade pacientovi vráti prijatú platbu v plnej výške alebo mu ponúkne náhradný termín podľa jeho voľby.
5. Ak objednávku vykonáva iná osoba než pacient, odoslaním objednávky vyhlasuje, že je zákonným zástupcom pacienta alebo koná s jeho vedomím a súhlasom. Zmluvnou stranou zmluvy o poskytnutí zdravotnej starostlivosti je pacient.
6. Pacient je povinný uvádzať v objednávke pravdivé a úplné údaje. Ak nepravdivé alebo neúplné údaje znemožnia riadne poskytnutie vyšetrenia, pracovisko je oprávnené vyšetrenie nevykonať; úhrada sa v takom prípade posudzuje podľa článku V.
7. Na ochranu pred zneužitím systému a blokovaním kapacity možno na jedno telefónne číslo evidovať najviac 3 aktívne objednávky súčasne. Ak pacient potrebuje viac termínov, kontaktuje pracovisko SMS správou na čísle 0949 000 677.
8. Systém ponúka termíny postupne od začiatku otvorených ordinačných blokov tak, aby vyšetrenia nadväzovali; po obsadení ponúkaného času sa automaticky sprístupní nasledujúci.

### Článok IV — Cena a platba

1. Ceny vyšetrení sa riadia platným cenníkom poskytovateľa zverejneným na stránke objednávania. Rozhodujúca je cena platná v čase odoslania objednávky, uvedená v objednávke a v potvrdzujúcom e-maile.
2. Termíny ponúkané v tomto systéme sú poskytované v doplnkových ordinačných hodinách poskytovateľa podľa zákona č. 576/2004 Z. z. a zákona č. 577/2004 Z. z., schválených príslušným samosprávnym krajom. Cenník je schválený a zverejnený na stránke objednávania aj v priestoroch pracoviska.
3. Pri vyšetrení so žiadankou od lekára hradí pacient doplatok za poskytnutie vyšetrenia v doplnkových ordinačných hodinách podľa cenníka. Nejde o spoplatnenie zdravotnej starostlivosti plne hradenej z verejného zdravotného poistenia — vyšetrenie v riadnych ordinačných hodinách zostáva pacientovi so žiadankou naďalej dostupné bezplatne cestou štandardného objednania u poskytovateľa. Originál žiadanky (výmenného lístka) je pacient povinný predložiť pri vyšetrení; bez jej predloženia je pracovisko oprávnené účtovať plnú cenu samoplatcu alebo vyšetrenie nevykonať.
4. Platba sa realizuje bezhotovostne prevodom alebo QR kódom (PAY by square) na účet IBAN **[DOPLNIŤ účet NÚSCH]** s variabilným symbolom prideleným pri objednávke. Platba sa považuje za uhradenú okamihom pripísania na účet.
5. Po pripísaní platby poskytovateľ automaticky vystaví faktúru (doklad o zaplatení) a doručí ju pacientovi e-mailom na adresu uvedenú v objednávke. Pri vrátení platby sa k faktúre vystaví a rovnakým spôsobom doručí dobropis. Doklady neobsahujú žiadne údaje o zdravotnom stave.

### Článok V — Zmena a zrušenie termínu, storno podmienky

1. Pacient môže objednávku zrušiť online najneskôr 48 hodín pred termínom, a to cez odkaz „Spravovať alebo zrušiť objednávku" v ktoromkoľvek e-maile o objednávke alebo v sekcii „Už máte objednávku?" na stránke objednávania (zadaním čísla objednávky a telefónneho čísla). Menej ako 48 hodín pred termínom je zrušenie možné už len SMS správou na čísle 0949 000 677 s uvedením čísla objednávky.
2. Pri zrušení najneskôr 48 hodín pred termínom sa uhradená platba vracia v plnej výške na účet, z ktorého bola prijatá, do 7 pracovných dní od zrušenia.
3. Pri zrušení menej ako 48 hodín pred termínom alebo pri nedostavení sa na vyšetrenie uhradená platba prepadá v prospech poskytovateľa ako storno poplatok zodpovedajúci rezervovanej kapacite pracoviska.
4. Ak pacient preukáže, že zrušenie alebo nedostavenie sa spôsobili vážne dôvody hodné osobitného zreteľa (najmä náhle ochorenie alebo hospitalizácia), pracovisko mu namiesto uplatnenia storno poplatku ponúkne náhradný termín.
5. Ak termín zruší alebo presunie pracovisko, pacient má vždy právo na vrátenie platby v plnej výške alebo na náhradný termín podľa vlastnej voľby. O presune termínu je pacient informovaný e-mailom a SMS; ak mu nový termín nevyhovuje, môže objednávku zrušiť podľa ods. 1 s vrátením platby v plnej výške.
6. Pracovisko môže z prevádzkových dôvodov (najmä práceneschopnosť lekára) zmeniť vyšetrujúceho lekára; termín, čas, rozsah ani cena vyšetrenia sa tým nemenia a pacient je o zmene vopred informovaný e-mailom a SMS. Ak pacient so zmenou nesúhlasí, môže objednávku zrušiť podľa ods. 1 a 2.
7. Zrušená objednávka sa v systéme uchováva 7 dní od zrušenia; počas tejto lehoty ju pracovisko môže na žiadosť pacienta obnoviť (ak je pôvodný termín ešte voľný), potom sa údaje vymažú.

### Článok VI — Odstúpenie od zmluvy (platené USG vyšetrenia)

1. Zdravotná starostlivosť poskytovaná pacientom zdravotníckymi pracovníkmi je vyňatá z pôsobnosti právnej úpravy zmlúv uzavretých na diaľku podľa zákona č. 108/2024 Z. z. o ochrane spotrebiteľa **[OVERIŤ presné ustanovenie s právnym oddelením — čl. 3 ods. 3 písm. b) smernice 2011/83/EÚ]**. Na objednané vyšetrenie sa preto nevzťahuje zákonné právo odstúpiť od zmluvy do 14 dní bez uvedenia dôvodu.
2. Možnosti zrušenia objednávky a podmienky vrátenia platby upravuje článok V týchto podmienok.

### Článok VII — Práva a povinnosti pacienta

1. Pacient sa dostaví 15 minút pred termínom a riadi sa pokynmi pracoviska a prípravou na vyšetrenie uvedenou v potvrdzujúcom e-maile.
2. Pri vyšetrení pacient predloží doklad totožnosti, preukaz poistenca a pri vyšetrení so žiadankou originál žiadanky.
3. Meškanie pacienta dlhšie ako 15 minút sa môže považovať za nedostavenie sa na termín s následkami podľa článku V ods. 3 a 4.

### Článok VIII — Reklamácie, sťažnosti a dohľad

1. Reklamácie súvisiace s objednávaním a platbou vybavuje pracovisko na adrese **[DOPLNIŤ oficiálny reklamačný kontakt]**; lehota na vybavenie je 30 dní od doručenia.
2. Podnety týkajúce sa poskytnutej zdravotnej starostlivosti možno podať poskytovateľovi postupom podľa § 17 zákona č. 576/2004 Z. z. Dohľad nad poskytovaním zdravotnej starostlivosti vykonáva Úrad pre dohľad nad zdravotnou starostlivosťou, Žellova 2, 829 24 Bratislava (udzs-sk.sk).
3. Dozor nad spotrebiteľskými aspektmi online objednávania a platieb vykonáva Slovenská obchodná inšpekcia, Inšpektorát SOI pre Bratislavský kraj, Bajkalská 21/A, 820 07 Bratislava (soi.sk).
4. Možnosť obrátiť sa na subjekt alternatívneho riešenia sporov podľa zákona č. 391/2015 Z. z. **[OVERIŤ aplikovateľnosť na zdravotné výkony s právnym oddelením; v prípade neaplikovateľnosti odsek vypustiť]**.

### Článok IX — Objednávanie na vyšetrenia bez poplatku (angiologická ambulancia, CT pracovisko)

1. Prostredníctvom stránky sa možno objednať aj na vyšetrenia v Angiologickej ambulancii č. 1 a na CT pracovisku poskytovateľa. Tieto vyšetrenia sú zdravotnou starostlivosťou hradenou z verejného zdravotného poistenia; pacient za objednanie ani za vyšetrenie neplatí žiadny poplatok a články IV až VI sa na ne nevzťahujú.
2. Pri niektorých vyšetreniach je podmienkou žiadanka (výmenný lístok) od lekára; pacient ju pri objednávke priloží (fotografia alebo PDF) a originál predloží pri vyšetrení. Pri vyšetreniach označených „bez žiadanky" (napríklad rýchle zhodnotenie nehojacej sa rany na dolnej končatine v programe Zachráň nohu) žiadanka potrebná nie je; o ďalšom postupe rozhodne lekár pri vyšetrení.
3. Odoslaním objednávky vzniká rezervácia termínu; potvrdenie je pacientovi doručené e-mailom. Pacient vyplní meno a priezvisko, dátum narodenia, zdravotnú poisťovňu, telefónne číslo, e-mail a podľa potreby dôvod vyšetrenia a prílohy. Telefónne číslo môže byť overené jednorazovým SMS kódom.
4. Čas termínu je orientačný. Pracovisko je ústavným zariadením najvyššieho typu a musí v niektorých prípadoch prednostne ošetriť akútneho pacienta; o väčšom posune alebo zmene termínu je pacient informovaný e-mailom alebo SMS a môže si zvoliť náhradný termín.
5. Pacient môže objednávku zmeniť alebo zrušiť online cez odkaz v e-maile alebo v sekcii „Už máte objednávku?" najneskôr 24 hodín pred termínom; neskôr SMS správou na čísle uvedenom v potvrdení. Zrušenie ani nedostavenie sa nie je spojené so žiadnym poplatkom; opakované nedostavenie sa bez ospravedlnenia môže byť dôvodom na odmietnutie ďalšej online objednávky.
6. Na ochranu kapacity možno na jedno telefónne číslo evidovať obmedzený počet aktívnych objednávok; ďalší termín dohodne pracovisko individuálne.
7. Objednanie cez stránku nenahrádza neodkladnú zdravotnú starostlivosť. Pri náhlych alebo rýchlo sa zhoršujúcich ťažkostiach (náhla silná bolesť končatiny, bledá alebo studená noha, strata citlivosti alebo hybnosti) je potrebné volať tiesňovú linku 155 alebo 112.

### Článok X — Žiadosť o spätné zavolanie

1. Pacient, ktorý sa nevie alebo nechce objednať online, môže zanechať meno a telefónne číslo so žiadosťou o spätné zavolanie. Pracovisko zavolá spravidla najneskôr nasledujúci pracovný deň a termín dohodne telefonicky.
2. Žiadosť o spätné zavolanie nie je objednávkou ani rezerváciou termínu; termín vzniká až dohodou počas hovoru.
3. Žiadosť môže za pacienta odoslať aj blízka osoba (napríklad rodinný príslušník alebo opatrovateľ). Odoslaním vyhlasuje, že koná s vedomím pacienta a že uvedené telefónne číslo je číslo, na ktorom možno pacienta zastihnúť. Totožnosť pacienta a údaje potrebné na objednanie pracovisko overí priamo s pacientom pri hovore.
4. Pracovisko môže odmietnuť spätné zavolanie, ak žiadosť zjavne nesúvisí s poskytovaním zdravotnej starostlivosti alebo ak ide o zneužitie služby.

### Článok XI — Záverečné ustanovenia

1. Spracúvanie osobných údajov upravuje samostatný dokument Informácie o spracúvaní osobných údajov, dostupný na stránke objednávania.
2. Poskytovateľ negarantuje nepretržitú dostupnosť objednávkového systému; plánovaná údržba a krátkodobé výpadky nemajú vplyv na už vytvorené objednávky. Ak systém nie je dostupný, objednávku, jej zmenu alebo zrušenie možno vybaviť SMS správou na čísle 0949 000 677.
3. Tieto podmienky nadobúdajú účinnosť dňom **[DOPLNIŤ]**. Poskytovateľ ich môže meniť; pre objednávku platí znenie účinné v čase jej odoslania, ktoré je pacientovi dostupné na stránke objednávania.
4. Právne vzťahy neupravené týmito podmienkami sa spravujú právnym poriadkom Slovenskej republiky, najmä zákonom č. 576/2004 Z. z. a Občianskym zákonníkom.

---

## 3.2 Informácie o spracúvaní osobných údajov

### Prevádzkovateľ a sprostredkovateľ

- **Prevádzkovateľ:** Národný ústav srdcových a cievnych chorôb, a. s., Pod Krásnou hôrkou 1, 833 48 Bratislava, IČO 35 971 126
- **Zodpovedná osoba (DPO):** **[DOPLNIŤ meno a kontakt DPO NÚSCH]**
- **Kontakt pre dotknuté osoby:** **[DOPLNIŤ oficiálny kontaktný kanál]**
- **Sprostredkovateľ:** FiveV s. r. o., Hrudky 4318/63, 900 25 Chorvátsky Grob, IČO 56 516 711, zapísaná v Obchodnom registri Mestského súdu Bratislava III, oddiel Sro, vložka č. 181520/B — technická prevádzka objednávkového systému výlučne na základe pokynov prevádzkovateľa a zmluvy podľa čl. 28 GDPR.

### Aké údaje spracúvame, na aký účel a ako dlho

Nasledujúce body platia pre všetky online objednávky (USG vyšetrenia, angiologická ambulancia, CT pracovisko), ak nie je uvedené inak. Právnym základom spracúvania nie je súhlas: údaje spracúvame, lebo je to nevyhnutné na objednanie a poskytnutie zdravotnej starostlivosti; zaškrtnutím políčka vo formulári pacient potvrdzuje, že sa s týmito informáciami oboznámil.

- **Identifikačné a kontaktné údaje** — meno, priezvisko, dátum narodenia, zdravotná poisťovňa, telefónne číslo, e-mailová adresa. Účel: rezervácia termínu, identifikácia pacienta, notifikácie o objednávke. Právny základ: čl. 6 ods. 1 písm. b) GDPR — plnenie zmluvy, resp. opatrenia pred jej uzavretím. Doba uchovávania: po vykonaní vyšetrenia sa údaje z objednávkového systému odstraňujú do 7 dní od jeho uzavretia pracoviskom; najneskôr sa odstraňujú do 28 dní od termínu vyšetrenia.
- **Údaje o zdravotnom stave** — typ a dôvod vyšetrenia, údaje zo žiadanky, priložené lekárske správy. Účel: príprava a poskytnutie zdravotnej starostlivosti. Právny základ: čl. 9 ods. 2 písm. h) GDPR v spojení s čl. 6 ods. 1 písm. b) GDPR a so zákonom č. 576/2004 Z. z.; spracúvanie prebieha pod zodpovednosťou osôb viazaných povinnosťou mlčanlivosti. Doba uchovávania: prílohy, dôvod vyšetrenia a údaje zo žiadanky sa z objednávkového systému odstraňujú najneskôr do 7 dní po termíne vyšetrenia; informácia o type vyšetrenia sa odstraňuje spolu s objednávkou (do 7, najneskôr do 28 dní od termínu). Údaje prevzaté do zdravotnej dokumentácie sa uchovávajú mimo tohto systému v lehote podľa zákona č. 576/2004 Z. z. **[OVERIŤ presné znenie a plynutie lehoty]**
- **Zrušené objednávky** — úplné údaje objednávky sa po zrušení uchovávajú 7 dní od zrušenia (možnosť obnovenia objednávky na žiadosť pacienta a vybavenie vrátenia platby), potom sa vymazávajú. Účel: správa rezervácií a vrátenie platieb. Právny základ: čl. 6 ods. 1 písm. b) a f) GDPR. Nevyužité objednávky (nedostavenie sa, neuhradenie) sa vymazávajú najneskôr 28 dní od pôvodného termínu.
- **Údaje o úhrade** — suma, variabilný symbol, stav platby. Pri automatickom párovaní úhrad načítavame z výpisu bankového účtu prevádzkovateľa údaje o došlých platbách: sumu, menu, variabilný symbol, číslo protiúčtu a správu pre prijímateľa. Účel: párovanie úhrady s objednávkou a vybavenie prípadného vrátenia platby. Právny základ: čl. 6 ods. 1 písm. b) GDPR. Doba uchovávania: záznamy o platbách 90 dní; ostatné údaje sa vymazávajú spolu s objednávkou. Faktúry a dobropisy (účtovné doklady) obsahujú meno a priezvisko pacienta, neutrálny popis úkonu bez akýchkoľvek zdravotných údajov, sumu a platobné údaje; uchovávajú sa oddelene od objednávok po dobu 10 rokov podľa zákona č. 431/2002 Z. z. o účtovníctve (čl. 6 ods. 1 písm. c) GDPR — zákonná povinnosť) a prístup k nim má len poverený správca systému. Banka prevádzkovateľa (Fio banka, a.s., pobočka zahraničnej banky) spracúva platobné údaje ako samostatný prevádzkovateľ podľa vlastných podmienok.
- **Technické a prevádzkové údaje** — záznamy o operáciách personálu s objednávkami (auditný log) a technické počítadlá proti zneužitiu systému (počet aktívnych objednávok na telefónne číslo, počet pokusov o overenie objednávky alebo odoslanie formulára z jednej IP adresy). Účel: zabezpečenie a integrita systému, ochrana pred zneužitím a hromadným obsadzovaním termínov, preukázanie prístupov k údajom. Právny základ: čl. 6 ods. 1 písm. f) GDPR — oprávnený záujem na bezpečnosti systému; čl. 32 GDPR. Doba uchovávania: auditný log 90 dní; technické počítadlá (odvodené z IP adresy a telefónneho čísla) najviac 1 hodinu. IP adresy a technické záznamy o prístupe na web spracúvajú okrem toho prevádzkovatelia hostingovej infraštruktúry (GitHub, Supabase) vo svojich systémových logoch.
- **Overenie telefónneho čísla SMS kódom** — ak si pracovisko vyžiada overenie, na zadané číslo pošleme jednorazový kód; v systéme sa uchová číslo, odtlačok kódu a čas overenia. Účel: ochrana pred falošnými objednávkami na cudzie číslo. Právny základ: čl. 6 ods. 1 písm. f) GDPR. Doba uchovávania: najviac 1 deň.
- **Údaje odporúčajúceho lekára** — meno a pracovisko uvedené v žiadanke. Tieto údaje nezískavame priamo od dotknutej osoby, ale z dokumentácie predloženej pacientom; informácie sa poskytujú podľa čl. 14 GDPR. Účel: overenie indikácie vyšetrenia a komunikácia o výsledku. Právny základ: čl. 6 ods. 1 písm. f) GDPR — oprávnený záujem na overení indikácie. Doba uchovávania: zhodná s dobou uchovávania príslušnej objednávky.

### Objednávky na angiologickú ambulanciu a CT pracovisko

Pri týchto objednávkach (vrátane programu Zachráň nohu) spracúvame rovnaké kategórie údajov ako vyššie, s týmito rozdielmi: za vyšetrenie sa neplatí, preto nevznikajú žiadne platobné údaje ani faktúry; súčasťou objednávky môže byť fotografia alebo PDF žiadanky či lekárskej správy (údaje o zdravotnom stave podľa čl. 9 ods. 2 písm. h) GDPR), ktorú pacient nahrá sám. Prílohy a dôvod vyšetrenia sa zo systému odstraňujú ihneď po termíne (ak sa pacient nedostavil alebo bola objednávka zrušená), najneskôr do 7 dní po termíne; celá objednávka sa vymaže najneskôr 28 dní po termíne. Údaje potrebné na zdravotnú dokumentáciu si pracovisko prevezme pri vyšetrení do svojho zdravotníckeho informačného systému, kde sa uchovávajú v lehotách podľa zákona č. 576/2004 Z. z.

### Žiadosť o spätné zavolanie

Ak nám necháte meno a telefónne číslo so žiadosťou o zavolanie, uchováme ich spolu s údajom, z ktorej stránky žiadosť prišla, a so záznamom o vybavení (kto a kedy volal, stručná poznámka, prípadne číslo vytvorenej objednávky). Účel: dohodnutie termínu vyšetrenia telefonicky. Právny základ: čl. 6 ods. 1 písm. b) GDPR — opatrenia pred uzavretím zmluvy na žiadosť dotknutej osoby, pri zdravotných údajoch uvedených v hovore čl. 9 ods. 2 písm. h) GDPR. Na ochranu pred zneužitím formulára uchovávame 7 dní aj IP adresu, z ktorej bola žiadosť odoslaná (čl. 6 ods. 1 písm. f) GDPR). O novej žiadosti je personál informovaný SMS správou na služobný mobilný telefón a e-mailom na služobnú adresu (meno a telefónne číslo). Žiadosť sa vymaže najneskôr 90 dní od vybavenia; nevybavené žiadosti najneskôr 90 dní od odoslania.

Ak žiadosť odošle za pacienta iná osoba (napríklad rodinný príslušník), získavame údaje pacienta od tejto osoby; informácie podľa čl. 14 GDPR pacientovi poskytneme pri prvom telefonáte a sú dostupné aj na tejto stránke.

### Upozornenia pre personál

O každej novej objednávke a o zrušení objednávky pacientom je personál pracoviska informovaný e-mailom na služobné adresy; správa obsahuje meno, dátum narodenia, poisťovňu, kontaktné údaje, typ vyšetrenia, termín a prípadný dôvod vyšetrenia. Tieto správy sa doručujú prostredníctvom sprostredkovateľov uvedených nižšie (Resend, Zoho) a podliehajú rovnakým pravidlám mlčanlivosti ako samotná objednávka.

### Informačná stránka Zachráň nohu

Orientačný samotest na stránke Zachráň nohu sa vyhodnocuje výlučne vo vašom prehliadači; odpovede sa nikam neodosielajú ani neukladajú. Stránka nepoužíva žiadne analytické ani marketingové nástroje. Obsah stránky má informačný charakter a nenahrádza vyšetrenie lekárom.

### Rodné číslo

Rodné číslo v objednávkovom formulári nevyžadujeme. Ak je uvedené v priloženej žiadanke alebo v lekárskej správe, spracúvame ho výlučne v rozsahu nevyhnutnom na poskytnutie zdravotnej starostlivosti. Overenie totožnosti prebieha až pri vyšetrení.

### Výmaz údajov, zálohy a štatistika

Po uplynutí uvedených lehôt sa údaje z prevádzkovej databázy odstraňujú. Zo záložných kópií, ktoré slúžia výlučne na obnovu systému pri poruche, sa údaje odstránia najneskôr do 7 dní; do záložných kópií sa počas tejto doby nezasahuje. Ak dôjde k obnove systému zo zálohy, výmaz údajov po uplynutí lehôt sa vykoná opakovane.

Na účely riadenia kapacít pracoviska uchovávame anonymné súhrnné údaje (počty objednávok podľa dátumu, typu vyšetrenia a stavu). Tieto údaje neumožňujú identifikáciu konkrétnej osoby a nevzťahuje sa na ne režim ochrany osobných údajov.

### Komu údaje sprístupňujeme

Údaje sú prístupné poverenému personálu prevádzkovateľa prostredníctvom individuálnych používateľských kont a v rozsahu nevyhnutnom na plnenie pracovných úloh; všetky tieto osoby sú viazané povinnosťou mlčanlivosti.

Systém technicky zabezpečuje sprostredkovateľ FiveV s. r. o., ktorý na jeho prevádzku využíva týchto ďalších sprostredkovateľov (subdodávateľov):

- Supabase, Inc. — databáza a úložisko systému; dáta sú uložené v dátovom centre v Európskej únii **[OVERIŤ región projektu]**
- Resend (Plus Five Five, Inc., USA) — odosielanie e-mailových notifikácií (e-mailová adresa a obsah notifikácie)
- BulkGate (prevádzkovateľ platformy so sídlom v Českej republike **[OVERIŤ presné obchodné meno podľa zmluvy/faktúry]**) — odosielanie SMS notifikácií pacientom a personálu (telefónne číslo a text SMS vrátane overovacích kódov)
- Zoho Corporation — e-mailové schránky domény cievny.sk **[OVERIŤ EÚ dátové centrum]**
- GitHub, Inc. — hosting statickej webovej stránky; údaje o pacientoch sa na ňom neuchovávajú, spracúvajú sa technické záznamy vrátane IP adresy

Údaje neposkytujeme žiadnym tretím stranám na marketingové účely.

### Prenos do tretej krajiny

Pri odosielaní e-mailových notifikácií (pacientom aj personálu) dochádza k prenosu e-mailovej adresy a obsahu notifikácie — vrátane mena, termínu a údaja o type vyšetrenia (údaj týkajúci sa zdravia) — do Spojených štátov amerických. Poskytovateľ Resend (Plus Five Five, Inc.) je certifikovaný v rámci EU-U.S. Data Privacy Framework; prenos sa uskutočňuje na základe rozhodnutia Európskej komisie o primeranosti podľa čl. 45 GDPR. Kópiu informácií o uplatnených zárukách poskytneme na požiadanie na kontaktnej adrese uvedenej vyššie. Ostatné spracúvanie prebieha v Európskej únii.

### Cookies a podobné technológie

Webová stránka používa výlučne technicky nevyhnutné súbory cookie a podobné technológie (vrátane úložiska localStorage prehliadača) potrebné na fungovanie objednávkového formulára a na zabezpečenie prihlásenia personálu. Na ich používanie sa podľa § 109 zákona č. 452/2021 Z. z. o elektronických komunikáciách nevyžaduje súhlas. Analytické ani marketingové nástroje nepoužívame.

### Vaše práva

Máte právo na prístup k údajom, ich opravu, výmaz, obmedzenie spracúvania, prenosnosť údajov a právo namietať proti spracúvaniu založenému na oprávnenom záujme. Žiadosti vybavujeme do jedného mesiaca od doručenia.

Vzhľadom na krátke lehoty uchovávania nemusíme byť po výmaze schopní žiadateľa v systéme identifikovať; v takom prípade nemôžeme žiadosti vyhovieť, ak nám dotknutá osoba neposkytne dodatočné identifikačné údaje (čl. 11 ods. 2 GDPR).

Právo na výmaz je obmedzené pri údajoch, ktoré sme povinní uchovávať podľa osobitných predpisov, najmä pri zdravotnej dokumentácii a účtovných dokladoch.

Poskytnutie údajov je požiadavkou potrebnou na objednanie a poskytnutie zdravotnej starostlivosti; bez nich nie je možné objednávku ani žiadosť o zavolanie vybaviť. Nedochádza k automatizovanému individuálnemu rozhodovaniu ani k profilovaniu. Údaje detí a osôb pozbavených spôsobilosti zadáva zákonný zástupca.

Máte právo podať sťažnosť Úradu na ochranu osobných údajov Slovenskej republiky, Hraničná 12, 820 07 Bratislava (dataprotection.gov.sk).

Účinné od: **[DOPLNIŤ dátum zverejnenia]**

---

## 4. Technická príloha

### 4.1 Prehľad údajov podľa toku

| Tok | Údaje | Účel | Právny základ | Lehota v systéme | Kto vidí | Subdodávateľ |
|---|---|---|---|---|---|---|
| USG objednávka | meno, dátum narodenia, poisťovňa, telefón, e-mail, dôvod vyšetrenia, typ vyšetrenia, (so žiadankou) lekár a pracovisko, prílohy; suma, variabilný symbol, stav platby | rezervácia, úhrada, notifikácie | 6(1)(b), 9(2)(h); doklady 6(1)(c) | prílohy a dôvod ≤ 7 dní po termíne; objednávka 7 dní po uzavretí / ≤ 28 dní po termíne; zrušené 7 dní; platby 90 dní; faktúry 10 rokov | personál pracoviska (individuálne kontá, MFA) | Supabase, Resend, BulkGate, Fio banka (párovanie platieb) |
| Angio / CT objednávka (aj Zachráň nohu) | meno, dátum narodenia, poisťovňa, telefón, e-mail, dôvod (nepovinný), typ vyšetrenia, prílohy (žiadanka/správa) | rezervácia, príprava vyšetrenia | 6(1)(b), 9(2)(h) | prílohy a dôvod ihneď po termíne pri nedostavení/zrušení, inak ≤ 7 dní; objednávka ≤ 28 dní po termíne | personál (sestra, lekár s obmedzením na vlastné prílohy, správca) | Supabase, Resend, BulkGate |
| Zavolajte mi späť | meno, telefón (zadané aj normalizované), zdroj stránky, stav vybavenia, poznámka, číslo objednávky; **IP adresa** | telefonické dohodnutie termínu | 6(1)(b); IP 6(1)(f) | IP 7 dní; záznam 90 dní od vybavenia / odoslania | personál (sestra, správca); lekár číta | Supabase, BulkGate (SMS personálu), Resend (e-mail personálu) |
| Overenie telefónu SMS | telefón, odtlačok kódu, čas, token | ochrana pred falošnou objednávkou | 6(1)(f) | 1 deň | nikto priamo (systém) | BulkGate |
| Počítadlá proti zneužitiu | kľúč odvodený z IP (IPv6 /64) alebo telefónu, počet | limity (napr. 5 žiadostí / 15 min z IP) | 6(1)(f), čl. 32 | 1 hodina | nikto priamo | Supabase |
| Auditný log | kto z personálu kedy čo zmenil (bez zdravotných údajov nad rámec typu vyšetrenia) | preukázateľnosť prístupov | 6(1)(f), čl. 32 | 90 dní | správca | Supabase |
| Upozornenia personálu | e-mail s údajmi objednávky; SMS s menom a telefónom pri spätnom volaní | prevádzka ambulancie | ako pôvodný účel | v schránkach personálu podľa internej politiky NÚSCH | personál | Resend → Zoho; BulkGate |
| Anonymná štatistika | počty podľa dátumu, typu a stavu | kapacitné plánovanie | nejde o osobné údaje | neobmedzene | personál | Supabase |
| Samotest Zachráň nohu | — (vyhodnotenie v prehliadači) | informovanie | — | neukladá sa | — | — |

### 4.2 Bezpečnostné opatrenia (čl. 32)

- Dáta v databáze Supabase v regióne EÚ, šifrované v pokoji aj pri prenose (TLS); prílohy v privátnom úložisku bez verejných odkazov.
- Prístup pacienta bez konta: objednávku vidí len ten, kto pozná jej číslo **a** telefónne číslo (OTP pri citlivých krokoch), s limitom pokusov.
- Personál: individuálne kontá, dvojfaktorové overenie (TOTP) pripravené na povinné zapnutie, role (správca / sestra / lekár) vynútené na úrovni databázy (Row Level Security); lekár vidí prílohy len vlastných pacientov.
- Kľúče k službám (e-mail, SMS, banka) v šifrovanom trezore databázy, nie v kóde; bankový účet pre platby nemožno zmeniť z aplikácie (len zásahom správcu databázy + nové nasadenie).
- Automatické mazanie podľa lehôt každú noc (databázové úlohy), vrátane záloh do 7 dní; mazané objednávky sa prevedú na anonymné počty.
- Limity proti zneužitiu na IP a telefón, ochrana pred hromadným obsadzovaním termínov (max. 3 aktívne objednávky na číslo).
- Auditný záznam operácií personálu; pravidelné bezpečnostné audity kódu (9 vĺn), nálezy opravené; verejný kód bez tajomstiev.
- E-maily a SMS obsahujú len nevyhnutné údaje; faktúry neobsahujú zdravotné údaje.

### 4.3 Zobrazenie informácií pacientovi

- Odkazy „Podmienky online objednávania" a „Ochrana osobných údajov" v pätičke každej stránky vrátane Zachráň nohu.
- USG, angio a CT formulár: povinné políčko „Oboznámil/a som sa…" s odkazmi, plus veta o objednávaní inej osoby.
- Zavolajte mi späť: veta pod tlačidlom s odkazom na informácie o osobných údajoch.
- Potvrdzovacie e-maily: pätička s odkazmi na oba dokumenty.

## 5. Kontrolný zoznam pre NÚSCH (mimo kódu)

- [ ] Kontakt na zodpovednú osobu (DPO) a kontaktný kanál pre dotknuté osoby — doplniť do dokumentu.
- [ ] Oficiálny e-mail pre objednávky a reklamačný kontakt; IBAN v texte Podmienok čl. IV.
- [ ] Zmluva o spracúvaní osobných údajov (čl. 28) NÚSCH ↔ FiveV s. r. o. so zoznamom subdodávateľov.
- [ ] Záznam o spracovateľských činnostiach (čl. 30) — doplniť toky z tabuľky 4.1.
- [ ] Rozhodnutie o DPIA (čl. 35) podľa výsledku posúdenia; prípadne balančný test pre IP adresu a OTP.
- [ ] Overiť položky [OVERIŤ]: región Supabase projektu, obchodné meno BulkGate, dátové centrum Zoho, ustanovenie zákona 108/2024, ARS, lehota zdravotnej dokumentácie.
- [ ] Poučenie personálu (mlčanlivosť, práca so služobným mobilom, na ktorý chodia SMS s menami pacientov).
- [ ] Dátum účinnosti oboch dokumentov → odstrániť banner NÁVRH v aplikácii.
