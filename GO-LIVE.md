# GO-LIVE checklist — objednanie.cievny.sk

Stav k 30.07.2026 (v46). Systém je funkčný v skúšobnej prevádzke
(platby, párovanie ~1 min, e-maily s logom, SMS, faktúry, kôš,
samoobslužné storno/presun, doplnkové hodiny). Pred ostrým spustením
treba dokončiť body nižšie.

## 1. Texty — chýbajúce údaje ([DOPLNIŤ] v src/legal.jsx)

- [ ] v107: právne texty rozšírené o angio/CT objednávky, program Zachráň nohu,
      žiadosť o spätné zavolanie, OTP a upozornenia personálu; angio a CT formulár
      majú povinné políčko „Oboznámil/a som sa…", karta Zavolajte mi späť vetu
      s odkazom. Podklad na právne posúdenie (otázky, plné znenie, technická
      príloha, kontrolný zoznam): `docs/pravne-posudenie-navrh.md` — čaká na
      posúdenie (praktik.ai → DPO + právne oddelenie NÚSCH). Po schválení
      preniesť opravy do src/legal.jsx aj do docs súboru.

- [ ] Oficiálny e-mail pre objednávky (VOP, hlavička dokumentu)
- [ ] Oficiálny reklamačný kontakt (VOP čl. VIII)
- [ ] IBAN v texte VOP čl. IV (v systéme už je, v texte je placeholder)
- [ ] Dátum účinnosti VOP aj GDPR dokumentu (deň spustenia)
- [ ] Zodpovedná osoba (DPO) NÚSCH + kontakt (GDPR dokument)
- [ ] Po vyplnení: odstrániť DraftBanner (návrhový pás) z legal.jsx
- [ ] Odstrániť banner „skúšobná prevádzka" z úvodnej stránky (booking.jsx)

## 2. Právne overenia (právne oddelenie NÚSCH)

- [ ] Výnimka zo 14-dňového odstúpenia pri zdravotných výkonoch
      (VOP čl. VI — presné ustanovenie zák. 108/2024 Z. z.)
- [ ] Aplikovateľnosť alternatívneho riešenia sporov (391/2015 Z. z.)
      — ak nie, odsek vypustiť (VOP čl. VIII)
- [ ] Lehota uchovávania zdravotnej dokumentácie v GDPR dokumente
- [x] Doplnkové ordinačné hodiny schválené BSK + cenník zverejnený
      aj v čakárni (potvrdené 30.07.2026)

## 3. Supabase — nastavenia a skripty

- [ ] **v138 — nový vzhľad úvodu (26. 11. 2026) — ODLOŽENÉ, len na beta:** lekár: „ešte by som to nedával von".
      Nový vzhľad sa zobrazí len v beta builde (`VITE_BETA=1`) alebo lokálne s `VITE_NEW_LOOK=1`; ostrá stránka
      má aj po nasadení pôvodný úvod v105. Zapnutie na ostrej: `NEW_LOOK = true` v `src/hero.jsx`. Bez skriptu. Úvod USG objednávania
      a dotazníka konzultácie: tmavomodrý blok s veľkým nadpisom („Zdravé cievy" / „Poraďte sa"), okrúhle tlačidlo
      so šípkou, fotka z ultrazvuku v oblúku; pod úvodom USG štyri farebné dlaždice služieb (ultrazvuk ciev,
      angiologická ambulancia, poradiť sa s lekárom, Zachráň nohu). Inšpirácia: návrh z Dribbble od lekára,
      prevedený do farieb NÚSCH (`src/hero.jsx`, farby `--color-tile-*` v `src/index.css`). Pôvodný úvod
      v105 ostal v kóde (`UsgHeroV105`) na prípadný návrat. Na ostrú len po odsúhlasení.
- [ ] **v137 — konzultácie: „Pozvať k nám" → žiadosť na pracovný e-mail lekára (25. 11. 2026):** spustiť
      `supabase/konzultacie-004.sql` (po konzultacie-002, na 003 nezávisí; idempotentné; editor ukáže `KONZULTACIE-004 OK`).
      Pri rozhodnutí „Pozvať k nám (ústav)" je predvolene zaškrtnuté „poslať celú žiadosť na môj pracovný e-mail"
      (iniciály, rok, kraj, kontakt, dotazník, popis, návrh zaradenia, odpoveď) — aby bolo podľa čoho pacienta objednať.
      Adresu treba výslovne nastaviť: správa → Konzultácie → „Upozornenia e-mailom" → „Pracovný e-mail lekára"
      (`settings.consult_forward_email`); bez nej sa nič neposiela a systém adresu neháda. POZOR: e-mail obsahuje
      zdravotné údaje a kópia v pošte už nepodlieha automatickému mazaniu; pacient je o tom informovaný v súhlase,
      na stránke o ochrane údajov a v pätičke odpovede. Pri iných rozhodnutiach sa nič neposiela.
- [ ] **v136 — konzultácie: e-mail pri každej novej žiadosti (25. 11. 2026):** spustiť `supabase/konzultacie-003.sql`
      (po konzultacie-002; idempotentné; editor ukáže riadok `KONZULTACIE-003 OK`). Doteraz prišiel e-mail hneď
      len pri akútnych príznakoch. Po novom každá nová žiadosť → e-mail „Konzultácie: nová žiadosť" (bez zdravotných
      údajov, s počtom čakajúcich); najviac jeden za 15 minút — žiadosti, ktoré prídu medzitým, oznámi spoločný
      e-mail po uplynutí odstupu (`consult_tick`, úloha `konzultacie-odoslanie` každých 5 minút). Akútna žiadosť
      má naďalej vlastný e-mail ihneď; ranný súhrn ostáva. Adresy: správa → Konzultácie → „Upozornenia e-mailom".
- [x] **v135 — konzultácie: tri nové témy (25. 11. 2026):** bez skriptu. Dotazník pozná aj zúženie obličkových
      (renálnych) tepien, cievne malformácie (AVM) a panvovú kongesciu; pravidlá zaradenia sú v `src/triaz.js`
      (návrh na odsúhlasenie lekárom). Databáza nové témy prijíma bez zmeny. Na ostrej od 25. 11. 2026.
- [x] **v134 — konzultácie: okamžité mazanie po vybavení (25. 11. 2026):** spustiť `supabase/konzultacie-002.sql` — skript spustený a stránka nasadená na ostrú 25. 11. 2026
      (po konzultacie-001; idempotentné; editor ukáže riadok `KONZULTACIE-002 OK`). Požiadavka GDPR:
      po vybavení nesmú v systéme ostať citlivé údaje.
      1. vybavenie bez odoslania zo systému (Instagram, „vybaviť bez odoslania") → riadok sa zmaže hneď;
      2. odpoveď SMS / e-mailom → zdravotné údaje, iniciály, rok a kraj sa zmažú hneď; kontakt a text odpovede
         ostanú len do potvrdenia brány (`consult_finalize`, úloha `konzultacie-odoslanie` každých 5 minút
         a pri každom otvorení prehľadu), potom sa zmaže celý riadok;
      3. brána správu odmietne alebo 15 minút nepotvrdí → žiadosť sa vráti lekárovi ako „Neodoslané" (len kontakt
         a text odpovede), personálu príde e-mail; lekár ju pošle znova alebo zavrie; najdlhšie 7 dní;
      4. ostáva anonymný počet v `consult_stats` (deň, téma, rozhodnutie, spôsob odpovede, dni čakania) —
         záložka „Vybavené — počty"; žiadosť sa už nedá vrátiť medzi nevybavené, interná poznámka zanikla;
      5. každé vybavenie sa v správe potvrdzuje („natrvalo zmaže"); stránka v134 vybavovanie zablokuje,
         kým skript nie je spustený.
- [x] **v133 — konzultácie z Instagramu (25. 11. 2026):** spustiť `supabase/konzultacie-001.sql` — spustené na ostrej 25. 11. 2026
      (po audit-vlna10-001; idempotentné; editor ukáže riadok `KONZULTACIE-001 OK | zapnutý`).
      Verejný dotazník `objednanie.cievny.sk/konzultacia/` (odkaz do Instagramu) NEDÁVA termín: človek uvedie
      iniciály, rok narodenia, voliteľne kraj, ťažkosti (téma + pár otázok + voľný text) a kontakt na odpoveď
      (SMS / e-mail / Instagram). Meno, rodné číslo ani IP adresa sa neukladajú.
      1. pri akútnych príznakoch dostane pacient pokyn hneď na obrazovke (155 / lekár ešte dnes) a personálu
         príde e-mail bez zdravotných údajov; inak raz denne o 06:05 UTC súhrn čakajúcich (`konzultacie-suhrn`);
      2. Správa → „Konzultácie z Instagramu" (`#/konzultacie`): žiadosti zoradené podľa NÁVRHU zaradenia
         (akútne / ústav / na posúdenie / rajónny angiológ / obvodný lekár) s dôvodmi; pravidlá sú v
         `src/triaz.js` (návrh na odsúhlasenie lekárom — zaradenie sa počíta pri zobrazení, nie v databáze);
      3. odpovedá len lekár a superadmin (`consult_resolve`): SMS bez diakritiky (najviac 450 znakov) alebo
         e-mail odíde zo systému; pri Instagrame si lekár odpoveď skopíruje a pošle sám; sestra len číta;
      4. poriadok: nevybavené žiadosti sa mažú po 90 dňoch (`konzultacie-cleanup`, 01:40 UTC); vybavené
         sa od konzultacie-002 mažú hneď (pôvodne po 30 dňoch);
      5. ochrana: limity na IP a kontakt, denný strop 300 žiadostí, skryté pole + čas vyplnenia (`bot_guard`);
         príjem sa dá pozastaviť tlačidlom v správe (`consult_set_open`) — dotazník to pacientovi oznámi;
      6. adresa upozornení: správa → Konzultácie → „Upozornenia e-mailom" (`settings.consult_notify_email`);
         prázdne = adresy pracoviska (`copy_email` + `notify_email`).
      Stránka v133 dotazník ponúkne až po spustení skriptu (pýta sa databázy `consult_ready`).
- [x] **v132 — CT zásobník (23. 11. 2026):** spustiť `supabase/ct-zasobnik-001.sql` — skript spustený a stránka v132
      nasadená na ostrú 23. 11. 2026 (overené: tabuľka, funkcie, práva, nočná úloha).
      (po ct-lekari-004, audit-vlna10-001 a zabezpecenie-001; idempotentné; vypíše `CT-ZASOBNIK-001 OK`).
      Termíny na ďalší mesiac sú známe až koncom mesiaca — lekár preto môže žiadosť o CT poslať
      aj BEZ termínu (stránka pre lekárov → „Bez termínu — do zásobníka", nepovinné „požadované obdobie").
      1. žiadosť čaká v tabuľke `ct_waitlist`; personál dostane e-mail, pacient nič;
      2. Správa CT → hore panel „Zásobník": sestra / superadmin pridelí termín (`ct_waitlist_assign`) —
         vznikne POTVRDENÁ objednávka a pacient dostane rovnakú SMS a e-mail ako pri potvrdení
         bežnej žiadosti; alebo žiadosť odstráni (`ct_waitlist_remove`, pacientovi sa nič neposiela);
      3. lekár podľa r.č. (záložka Presun termínu) vidí, že pacient v zásobníku čaká;
      4. poriadok: žiadosť čakajúca > 60 dní sa každý pondelok pripomenie e-mailom, po 90 dňoch
         sa zmaže aj s prílohami (`ct-zasobnik-cleanup`, 01:25 UTC); prílohy zásobníka nočné
         mazanie „súborov bez objednávky" nechá;
      5. vypnutie zásobníka (stránka ho prestane ponúkať): v SQL editore
         `insert into settings (key, value) values ('ct_waitlist', 'off') on conflict (key) do update set value = 'off';`
      Stránka v132 zásobník ponúkne až po spustení skriptu (pýta sa databázy `ct_waitlist_ready`).
- [x] **v131 — zabezpečenie (18. 11. 2026):** spustiť `supabase/zabezpecenie-001.sql` — skript spustený na ostrej 19. 11. 2026, stránka na ostrej od 23. 11. 2026 (spolu s v132)
      (po audit-vlna10-001; idempotentné; vypíše `ZABEZPECENIE-001 OK`, v editore „Success").
      1. povinná žiadanka sa už nedá obísť vlastným programom — príloha bez nahratého súboru
         sa odmietne (stránka také prílohy neposiela), obmedzená veľkosť zoznamu príloh;
      2. CT pre lekárov: overenie „nie som robot" (Turnstile) pri spoločnom hesle. Po skripte
         je VYPNUTÉ; zapína superadmin v Správe CT → Nastavenia → Prístup pre lekárov
         (vypnúť vie aj sestra). Pred zapnutím nechať jedného lekára prihlásiť sa
         z nemocničného počítača — v Správe CT je vidieť, či overenie v jeho prehliadači prešlo.
         Formuláre pacientov sa nemenia (`turnstile_enforce` ostáva `off`).
      Stránka v131: prihlásenie lekára posiela preukaz a pri odmietnutí si vypýta nový.
- [x] **Oprava strážcu brán (18. 11. 2026):** spustiť `supabase/audit-vlna10-003.sql` — spustené na ostrej 23. 11. 2026
      (po audit-vlna10-001). Hodinová kontrola `http-watch` počítala aj chyby banky — 18. 11.
      o 17:07 poslala planý poplach „e-mailová alebo SMS brána vracia chyby" pre päťminútový
      výpadok Fio. Po oprave sa banka do kontroly e-mailov/SMS nepočíta a má vlastné
      upozornenie, keď 6 hodín neprišla úspešná odpoveď (typicky vypršaný token Fio).
- [x] **Rozhodnutia po audite (17. 11. 2026):** spustiť `supabase/audit-vlna10-002.sql` — spustené na ostrej 23. 11. 2026
      (po audit-vlna10-001; idempotentné; vypíše `AUDIT-VLNA10-002 OK`).
      1. CT: pacient si termín online nezruší — `ct_cancel_order` už nie je dostupná cez API
         (stránka ju nepoužívala; pacient sa musí ozvať pracovisku);
      2. angio a CT: zrušené objednávky sa mažú 7 dní po zrušení (ako USG), nie termín + 28 dní;
      3. banka: párovanie platieb pozerá 10 dní dozadu (doteraz 3).
- [x] **v130 — opravy z veľkého auditu (16. 11. 2026):** spustiť `supabase/audit-vlna10-001.sql`
      — spustené na ostrej 17. 11. 2026 (overené 18. 11.: úlohy `slots-cleanup` a `http-watch` bežia,
      staré termíny zmazané, žiadna zlyhaná úloha). Stránka v130 je na ostrej od 18. 11. 2026.
      (po prilohy-mazanie-001; idempotentné; na konci vypíše `AUDIT-VLNA10-001 OK`).
      Overené na vernej kópii ostrej schémy (79 kontrol celých postupov pacienta aj personálu).
      1. staré otvorené termíny sa mažú po 14 dňoch (`slots-cleanup`, 01:35 UTC) — USG mala 748
         riadkov, API vracia najviac 1000 → hrozilo tiché miznutie dní; stránky od v130
         načítavajú termíny, objednávky aj faktúry po stránkach;
      2. „Skontrolovať platby" už nečaká na banku (padalo na 8 s limit a blokovalo párovanie);
      3. `ct_create_order` už nie je dostupná verejne (obchádzala heslo pre lekárov);
      4. „Vystaviť chýbajúce faktúry" — superadmin má oprávnenie;
      5. pripomienky len deň vopred (nie v deň termínu s textom „zajtra"); po presune termínu
         sa pripomienka pošle znova;
      6. CT: zamietnutá žiadosť lekára o presun potvrdeného termínu → pacient dostane zrušenie;
      7. chyba pri skladaní e-mailu (USG, CT) už nezablokuje zmenu objednávky; zapíše sa
         do stavu systému;
      8. strážca hlási aj zachytené chyby a chýbajúce kľúče (Resend, BulkGate, Fio);
         `http-watch` každú hodinu kontroluje, či e-mailová / SMS brána nevracia chyby;
      9. USG: zrušená ZAPLATENÁ objednávka → e-mail „vrátiť platbu" na `notify_email` / `copy_email`;
      10. angio pripomienka: menej ako 24 h do termínu → namiesto „zmeňte online" pýta SMS;
      11. SMS na čísla „+421 0949 …", neutrálna hlavička e-mailov, angio zrušenie vyžaduje telefón,
          CT pri zrušení maže aj klinické údaje a odtlačok r.č., nočné mazanie starých SMS kódov,
          „platbu sme prijali" len pri naozaj zaplatenej objednávke.
      Stránka v130: zrozumiteľné chyby namiesto surových, číslo objednávky bez ohľadu na veľkosť
      písmen, dátum narodenia aj ako 5.5.1958, opakované odoslanie objednávky s prílohou, karta
      „nepodarilo sa načítať" namiesto „žiadne termíny", chyby v správe viditeľné (toast),
      uloženie cenníka čaká na výsledok.
- [x] **v129 — NALIEHAVÉ (zistené 16. 11. 2026): rušenie objednávok a mazanie príloh.**
      Spustené a nasadené 16. 11. 2026 (overené: zrušenie funguje, funkcia zmazala 7 súborov, rad prázdny).
      Supabase zakázal mazať súbory priamym SQL zo `storage.objects`; naše funkcie to
      robili, takže v angiologickej ambulancii a na CT sa nedala zrušiť ŽIADNA
      objednávka (pacient ani personál) a nočné mazanie údajov po lehote
      (`angio-cleanup`, `ct-cleanup`) padalo od septembra 2026. Pri USG sa chyba
      ignorovala — súbory príloh ostávali v úložisku.
      1. spustiť `supabase/prilohy-mazanie-001.sql` (hneď; rušenie začne fungovať,
         súbory sa zaradia do radu `attachment_purge_queue`);
      2. nasadiť Edge Function `supabase/functions/purge-prilohy` (verify_jwt = false) —
         rad vybaví cez Storage API (hneď po zrušení a každú noc o 02:45 UTC);
      3. skript pridáva `system_watchdog()` (denne 05:30 UTC): pri zlyhanej nočnej
         úlohe alebo prílohách čakajúcich na zmazanie > 24 h pošle e-mail na
         `notify_email` / `copy_email` a zapíše do stavu systému.
      Pozn.: súbory „zmazané" priamym SQL pred zavedením ochrany mohli fyzicky ostať
      v úložisku Supabase (bez záznamu) — overiť / dať odstrániť cez podporu Supabase.
- [x] v128 (SMS „meškáme pre akútneho pacienta"): spustiť `supabase/meskanie-001.sql`
      (po rucne-001 a ct-lekari-001; môže sa spustiť hneď). V Prehľade USG,
      angiologickej ambulancie aj CT pribudne tlačidlo „📣 SMS: meškáme" — pošle
      pevný text všetkým dnešným nevybaveným pacientom (stav nová / potvrdená,
      zapnuté správy, mobil; lekár len svojim), voliteľne s odhadom meškania.
      Ďalšia SMS najskôr o 10 minút, najviac 5 za deň na ambulanciu; odoslania
      sa zapisujú do `delay_sms_log`. Každá SMS sa účtuje ako bežná SMS.
- [x] v125 (CT pre lekárov — žiadosť o presun termínu viazaná na rodné číslo):
      spustiť `supabase/ct-lekari-004.sql` (po ct-lekari-002) — môže sa spustiť
      hneď, súčasná ostrá verzia s ním funguje ďalej. Lekár pri žiadosti zadá
      r.č. (zo žiadanky sa vyplní samo); databáza ukladá len odtlačok r.č.
      s tajným kľúčom, nie samotné číslo. V záložke „Presun termínu" lekár po
      zadaní r.č. vidí len termíny tohto pacienta a vyberie nový; termín sa
      rezervuje, objednávka je opäť „nová" a CT pracovisko ju potvrdí (e-mail
      „Žiadosť lekára o presun termínu"). Ak by sa neskôr znova spustil
      ct-lekari-001/002, treba potom znova spustiť aj 004.
      v126: ten istý skript pridá pokyn „prineste čerstvý výsledok kreatinínu"
      aj do e-mailov pacientovi (potvrdenie, presun, pripomienka deň vopred) —
      lekár môže CT s kontrastom objednať aj bez aktuálneho kreatinínu.
- [x] v124 (CT pre lekárov — len objednanie, bez prehľadu objednaných): spustiť
      `supabase/ct-lekari-003.sql` AŽ po nasadení v124 na ostrú — zmaže funkciu
      `ct_doctor_list`, aby sa zoznam pacientov nedal získať ani priamo cez API
      so spoločným heslom. (Pred nasadením by v starej verzii prestala fungovať
      záložka „Objednaní pacienti".)
- [x] v122 (CT pre lekárov — „pacient prinesie čerstvý kreatinín"): spustiť
      `supabase/ct-lekari-002.sql` (po ct-lekari-001) — server prijme žiadosť
      s kontrastom bez kreatinínu, ak lekár označí, že ho pacient prinesie;
      pacient dostane pripomenutie v SMS pri potvrdení a deň vopred.
- [x] v119 (CT pre lekárov NÚSCH): spustiť `supabase/ct-lekari-001.sql` (po rucne-001)
      — stránka `objednanie.cievny.sk/#/ct-lekar` so spoločným heslom; lekár pošle
      žiadosť do voľného CT termínu (klinická otázka, kontrast, žiadanka), CT
      pracovisko ju potvrdí v správe CT; pacient dostane SMS / e-mail až po
      potvrdení. Potom: Správa → CT → Nastavenia → „Prístup pre lekárov NÚSCH"
      nastaviť heslo (len superadmin). Heslo meniť pri odchode lekára.
- [x] v117 (ručné pridanie pacienta personálom): spustiť `supabase/rucne-001.sql`
      — stĺpce `created_by` / `notify_patient`, RPC `usg_/angio_/ct_staff_create_order`
      (lekár, sestra, superadmin; bez SMS overenia a povinnej žiadanky, aj na dnes
      a mimo otvorených termínov), notifikácie pacientovi sa dajú vypnúť, e-mail
      personálu „Nová objednávka" sa pri ručne zadanej neposiela. Skript je
      spätne kompatibilný so staršou verziou frontendu (dá sa spustiť pred nasadením).
- [x] v113 (ochrana pred botmi): spustiť `supabase/boti-001.sql` — kontrola
      botov (režim `log` = len zapisuje do health_events), denný strop 300
      overovacích SMS + e-mail personálu pri 80 % a pri strope, 15-min stropy
      30, upozornenie pri 40 spätných volaniach za 24 h, mazanie health_events.
      Po ~1 týždni skontrolovať `select * from health_events where source like
      'bot-guard%'` a ak skutoční pacienti nepadajú, prepnúť
      `update settings set value='on' where key='bot_guard';`
- [ ] Cloudflare Turnstile (voliteľné): 1) dash.cloudflare.com → Turnstile →
      Add site, doména objednanie.cievny.sk, režim Managed; 2) Site key do
      GitHub → Settings → Secrets and variables → Actions → Variables ako
      `TURNSTILE_SITE_KEY`; 3) Secret key do Supabase → Edge Functions →
      Secrets ako `TURNSTILE_SECRET`; 4) nasadiť Edge Function
      `supabase/functions/turnstile-pass` (verify_jwt = false); 5) nové
      nasadenie stránky; 6) po overení `update settings set value='on' where
      key='turnstile_enforce';` 7) v Informáciách o osobných údajoch odstrániť
      [OVERIŤ] pri Cloudflare.
- [x] v110 (audit UX 1): spustiť `supabase/angio-015.sql` (aplikované 20.10.2026) — zrušenie pacientom
      len ≥ 24 h vopred, notifikácia „potvrdené" len z nová → potvrdená (Vrátiť
      medzi aktívne už nepíše pacientovi), angio/ct_close_free_slots (hromadné
      zatváranie len voľných buniek), arrived_at sa pri presune na iný deň nuluje,
      tabuľky ambulancií v realtime publikácii. Správa: `docs/audit-ux-1.md`.
- [ ] v108: spustiť `supabase/termin-zajtra-001.sql` — pacient sa online objedná
      (aj presunie termín) najskôr na nasledujúci deň; 5 pacientskych RPC,
      personál v správe bez zmeny. Frontend to isté (kalendár od zajtra).

- [ ] Spustiť `supabase/doplnkove-hodiny-001.sql` (ak ešte nebol)
- [ ] V správe nastaviť čas doplatkových termínov (Nastavenia →
      Nastavenia platby → „Termíny so žiadankou najskôr od")
- [ ] Vyplniť Fakturačné údaje (Nastavenia) a stlačiť „Dovystaviť
      chýbajúce faktúry" (záložka Faktúry)
- [ ] Nastaviť settings: `mail_from` (adresa @cievny.sk overená
      v Resend) a `notify_email` (interný oznam o novej objednávke)
- [ ] Skontrolovať ostrý IBAN v Nastaveniach platby (nie DEMO)
- [x] Vypnúť verejnú registráciu: Auth → Sign In / Up → Allow new
      users to sign up = OFF (personál sa pozýva pozvánkou)
- [x] Spustiť `supabase/audit-vlna3-001.sql` (bezpečnosť + kalendár, vlna 1)
- [ ] Spustiť `supabase/audit-vlna4-001.sql` (vlna 2 — stredné/nízke)
- [ ] Spustiť `reminders.sql` (voliteľné — odolnejšie pripomienky; s kľúčmi)

## 4. Bezpečnosť — kľúče

- [ ] REVOKNÚŤ starý Resend kľúč `re_4uoat2NB_…` (bol v repozitári;
      resend.com → API Keys → Revoke). Aktuálny kľúč ostáva len
      v DB funkciách.
- [x] sb_secret revoknutý, nikdy nepoužitý
- [x] Žiadne kľúče v public repozitári (kontroluje sa pri každom pushi)

## 5. SMS (BulkGate)

- [ ] Overiť schválenie odosielateľa „NUSCH" (gText) a kredit
- [ ] Testovacia SMS na 0917911202 (objednávka + potvrdenie platby)
- [ ] E-mail personálu pri novej objednávke (`supabase/angio-014.sql`): angio a CT
      posielajú správu na `copy_email` + `notify_email` (nová objednávka, zrušenie
      pacientom); USG posiela na `notify_email` (notify_order_emails). `copy_email`
      je chránený kľúč — mení sa len v SQL editore:
      `update settings set value = 'adresa@nusch.sk' where key = 'copy_email';`
- [ ] Spätné volania (v99, `supabase/angio-013.sql`): spustiť skript v SQL editore,
      potom Správa → Angio → Nastavenia → „Spätné volania — mobil pre SMS" zadať
      mobil pracoviska. Pacient na stránke nechá meno + číslo („Zavolajte mi späť"),
      príde SMS na mobil + e-mail na kópiu objednávok; žiadosti sú v záložke
      Spätné volania (sľub: hovor najneskôr nasledujúci pracovný deň).

## 6. Prevádzkové návyky

- [ ] Mesačne: záložka Faktúry → Export CSV (kniha faktúr, 10 rokov)
      + prípadne `select * from invoices;` → Download CSV
- [ ] Denné zálohy DB robí Supabase; kompletná záloha kódu:
      vetva `zaloha-v43-2026-07-30` + ZIP u superadmina
- [ ] DMARC reporty od Googlu chodia denne — netreba na ne reagovať;
      po pár týždňoch bez problémov sprísniť DNS na `p=quarantine`

## 7. Voliteľné vylepšenia (po spustení)

- [ ] PWA ikona/aplikácia aj pre pacientsku stránku (teraz má správa)
- [ ] Automatická mesačná pripomienka exportu faktúr
- [ ] Štatistika: prehľad tržieb podľa mesiacov v záložke Faktúry
- [ ] Dvaja lekári v tom istom čase (paralelné ambulancie/sondy) —
      vyžaduje zmenu dátového modelu open_slots; dnes platí „1 pacient
      v čase". Na vyžiadanie.

## 8. Audit — stav (bezpečnostný + funkčný, 30.–31.07.2026)

- [x] Vlna 1 (kritické + vysoké): prílohy len pre personál, rate-limit
      create_order (IP), invoice_counters RLS, náhodné ID objednávok +
      rate-limit podľa telefónu, validácia ID, zákaz termínu v minulosti,
      closeDay/openWindow oprava, doplnkové hodiny packing, objednávky
      mimo hodín viditeľné. → v47, `audit-vlna3-001.sql`
- [x] Vlna 2 (stredné + nízke): e-maily lekárov skryté (public_doctors),
      rola lekar bez DELETE + guard (platba/cena) + audit mazania,
      upratovanie osirelých príloh, backfill duration_min, CSV injection,
      noopener, referral_from HH:MM, odolné pripomienky. → v48,
      `audit-vlna4-001.sql`
- Záťažové testy: 20 súbežných na 1 termín → prejde 1; limit 3/telefón;
      300 objednávok/10 spojení bez chýb; ~6600 čítaní/s pri 100 klientoch.

## 10. Audit vlna 9 — kontrola zmien v95–v100 (Zachráň nohu, spätné volania)

Dva nezávislé prechody kódu + Security Advisors. Bez HIGH nálezu. Opravy:

- `supabase/angio-013.sql` (spustiť v SQL editore): žiadosť o spätné volanie
  sa vždy uloží (globálny strop len potlačí SMS/e-mail), odpoveď pri duplicite
  je rovnaká ako pri novej žiadosti (nič neprezradí o cudzom čísle), meno len
  z písmen (žiadne odkazy v SMS od „NUSCH"), IPv6 limit po /64, update len
  superadmin/sestra, žiadne TRUNCATE práva, IP sa maže po 7 dňoch, žiadosti
  po 90 dňoch. Bez overenia OTP zámerne (jednoduchosť pre seniorov) — pri
  hovore si overte, že volaný o žiadosť naozaj stojí.
- `supabase/audit-vlna9-001.sql` (po angio-013): search_path pre 6 funkcií,
  trigger funkcie bez EXECUTE pre anon/authenticated, stará `create_order`
  bez príloh zrušená, `mfa_ok()` v `reschedule_order`, `create_adhoc_payment`,
  `resend_adhoc_email`, `issue_missing_invoices`, `list_staff`.
- Frontend v100: hlášky formulára len známe slovenské (inak všeobecná veta),
  kotvy fungujú aj v novej karte, fokus po posune, väčšie dotykové plochy,
  `aria-pressed`/`role=alert`, obrázky sa pri chybe skryjú, krátka adresa
  `/zachrannohu/` má CSP a cieľ len na vlastnom origine.

Úlohy mimo kódu:
- [ ] Supabase → Authentication → Attack protection: zapnúť „Leaked password protection"
- [ ] Druhý člen personálu si zapíše autentifikátor (predpoklad pre `mfa_enforce = on`)
- [ ] Správa → Angio → Nastavenia: mobil pre SMS spätných volaní
- [ ] pg_net/btree_gist v schéme public: advisor WARN, ponechané (presun by menil volania `net.*`)

## 9. Audit vlna 8 — zabezpečenie pred ostrým spustením platieb (v93, `audit-vlna8-001.sql`)

Princíp: hranica dôvery je `session_user`. Aplikácia ide cez rolu
`authenticator`, SQL editor a cron cez `postgres`. Ochranné triggery pustia
zmenu IBAN-u, chránených nastavení a roly superadmin LEN z SQL editora —
žiadny účet personálu (ani superadmin) ani ukradnutý token ich z API nezmení.

### Čo skript robí
- Kľúče (Resend, BulkGate, Fio) presunuté do **Supabase Vault**; funkcie čítajú
  `app_secret('…')`. Rotácia = Dashboard → Vault → upraviť hodnotu (funkcie sa
  neprepisujú). Mená: `resend_api_key`, `bulkgate_app_id`,
  `bulkgate_app_token`, `fio_token`.
- **IBAN**: tabuľka `payment_identity` (1 riadok, mení sa len v SQL editore),
  zrkadlo `settings.iban`, kontrola mod-97 + zákaz demo účtu, e-maily/faktúry
  čítajú `payment_iban()`; bez platného IBAN-u e-mail povie „platobné údaje
  pošleme dodatočne" a zapíše `health_events`. Frontend má IBAN pripnutý
  (`VITE_PINNED_IBAN` v deploy.yml) — QR sa ukáže len pri zhode.
- `settings`: `iban, beneficiary, notify_email, copy_email, mail_from,
  mfa_enforce` chránené triggerom; audit každej zmeny nastavení, rolí, cenníka,
  CT a angio objednávok (`audit_log`).
- Objednávky: VS unikátny; cena/VS/typ/created_at nemenné z API; `paid` mení
  len Fio párovanie alebo `mark_order_paid(id, paid, dôvod)` (sestra/superadmin,
  dôvod ≥ 10 znakov, audit `paid-manual`, kópia na `copy_email`).
- **MFA (TOTP)** pre celý personál: aplikácia vyžaduje zápis autentifikátora
  pri prvom prihlásení a kód pri každom ďalšom; databáza (`mfa_ok()`) pri
  `settings.mfa_enforce = 'on'` bez AAL2 nevydá žiadne údaje.
- Prílohy: lekár vidí len prílohy svojich pacientov, mazať smie len
  sestra/superadmin; `create_order` overí, že prílohy patria k objednávke.
- Rate-limity cez `client_ip()` (cf-connecting-ip), IP limity na
  lookup/zrušenie/presun, OTP z kryptografického generátora.
- `set_staff_role` nevie prideliť ani zmeniť superadmina; `health_events`.

### Checklist spustenia
- [ ] Dashboard → Database → Extensions → **supabase_vault** = ON
- [ ] Authentication → Multi-factor → **TOTP = Enabled**; password min. 12
- [ ] SQL editor: spustiť `supabase/audit-vlna8-001.sql`; prečítať NOTICE
      (Vault 4 kľúče, payment_identity = ostrý IBAN, 0 chýb)
- [ ] Dashboard → Vault: skontrolovať 4 kľúče (ak niektorý chýba, doplniť
      presne pod uvedeným menom)
- [ ] Nasadiť v93 (beta → overiť → main). Bez v93 staršia aplikácia zobrazí
      pri ukladaní IBAN-u chybu „chránené" (neškodné).
- [ ] Každý člen personálu sa prihlási a zapíše autentifikátor (Google /
      Microsoft Authenticator). Stav vidno v Správa → Používatelia (MFA ✓).
- [ ] Po ~14 dňoch, keď majú všetci MFA ✓:
      `update settings set value = 'on' where key = 'mfa_enforce';`
- [ ] Resend: revoknúť starý kľúč `re_4uoat2NB_…`; DNS DMARC `p=quarantine`
- [ ] Fio: token iba na čítanie („Pouze sledování")
- [ ] Supabase org: 2FA pre všetkých členov, Members prečistiť
- [ ] GitHub: 2FA povinné; branch protection `main` (PR + Code Owners review,
      bez force-push) a `beta` (push len vlastník, bez force-push)
- [ ] Po nasadení: Dashboard → Advisors → Security bez ERROR nálezov

### Runbook: zmena IBAN
1. SQL editor (ako postgres):
   `update payment_identity set iban = 'SK…', beneficiary = 'NÚSCH, a.s.';`
   (neplatný alebo demo IBAN sa odmietne; zmena sa zapíše do `audit_log`
   a zrkadlí do `settings.iban`, e-maily ho posielajú okamžite)
2. `deploy.yml`: `VITE_PINNED_IBAN` v oboch build joboch → commit do `beta`
   → overiť na /beta/ (QR sa zobrazí) → fast-forward `main`.
3. Medzi krokmi 1 a 2 pacient vidí „platobné údaje pošleme e-mailom" — e-mail
   už obsahuje nový IBAN.

### Runbook: rotácia kľúča
Dashboard → Vault → secret (`resend_api_key` / `bulkgate_app_token` /
`fio_token`) → nová hodnota. Žiadny SQL ani deploy. Starý kľúč revoknúť
u poskytovateľa.

### Runbook: správa superadminov (len SQL editor)
```sql
insert into staff_roles (user_id, role)
select id, 'superadmin' from auth.users where email = 'meno@nusch.sk'
on conflict (user_id) do update set role = 'superadmin', doctor_name = '';
-- odobrať: update staff_roles set role = 'sestra' where user_id = (select id from auth.users where email = '…');
```

### Runbook: stratený autentifikátor
Dashboard → Authentication → Users → používateľ → Factors → odstrániť.
Pri najbližšom prihlásení si zapíše nový.

### Prístup, ktorý triggery obchádza
SQL editor, Supabase konektor/PAT a servisný kľúč bežia ako `postgres`.
Držte ich v správcovi hesiel, prístup len vlastník.
