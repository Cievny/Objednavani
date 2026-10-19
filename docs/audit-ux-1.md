# Audit funkčnosti a dizajnu — vlna UX 1 (október 2026)

Tri nezávislé kontroly kódu (pacientske toky, správa pre personál, konzistencia dizajnu) nad verziou v109. Každý nález má závažnosť (**HIGH** = nesprávne správanie alebo riziko pre dáta, **MED** = mätúce / nekonzistentné, **LOW** = kozmetika) a stav:

- ✅ **v110** — opravené vo funkčnej vlne (beta)
- 🎨 **v111** — rieši dizajnová normalizácia (beta)
- 🗓 **v112** — rieši zjednotenie CT správy s angio kalendárom (beta)
- ⏳ **odložené** — s dôvodom
- ℹ **rozhodnutie** — vedomá voľba, nie chyba

Databázové zmeny k v110 sú v `supabase/angio-015.sql` (spustiť v produkcii spolu s nasadením).

---

## A. Pacientske toky

### USG objednávanie (`src/booking.jsx`, `src/data.js`)
| # | Sev. | Nález | Stav |
|---|---|---|---|
| A1 | HIGH | Polovične napísaný dátum narodenia prešiel validáciou (kontrolovalo sa len, že pole nie je prázdne), objednávka išla bez dátumu | ✅ v110 — kontrola `birthDate` pred odoslaním |
| A2 | HIGH | Po „Nová objednávka" ostalo overenie SMS kódom z predošlej objednávky; server ho už použil → ďalšia objednávka zlyhala; po 30 min to isté | ✅ v110 — reset OTP a príloh, pri chybe overenia návrat na „Poslať kód" |
| A3 | HIGH | „+421 0949 …" sa normalizovalo na „+4210949…" (do objednávky, SMS aj vyhľadania) | ✅ v110 — spoločná `normalizePhone` (USG, angio, CT) |
| A4 | MED | Kalendár a prvý voľný deň ignorovali zvolené vyšetrenie; pri dlhom vyšetrení bez voľných dní prázdny kalendár bez hlášky | ✅ v110 — závislosť od vyšetrenia, kalendár skočí na prvý voľný deň |
| A5 | MED | Po chybe „termín medzičasom obsadený" ostal pacient na kroku 3; každý pokus vytvoril nové číslo objednávky a osirelé prílohy | ✅ v110 — návrat na krok 2 s čerstvou ponukou, číslo objednávky raz za sedenie |
| A6 | MED | Presun termínu cez holý dátumový vstup bez informácie o voľných dňoch a bez potvrdenia | ✅ v110 — mesačný kalendár s voľnými dňami + potvrdenie |
| A7 | MED | Vyhľadanie mohlo spadnúť pri neznámom stave; po zrušení pacientom stav „Zamietnutá (Zrušené pacientom)" | ✅ v110 — bezpečný prístup k stavu, text „Zrušená" |
| A8 | MED | Deep-link z e-mailu nič nescrolloval ani nezameral | ✅ v110 — posun na sekciu + fokus na telefón |
| A9 | MED | Bez posunu pohľadu medzi krokmi (na mobile krok 4 uprostred stránky), chybový box bez `role="alert"` | ✅ v110 |
| A10 | MED | Prílohy nad 3 sa ticho zahodili, duplicity povolené | ⏳ odložené (LOW dopad; hláška v111) |
| A11 | MED | Text „platba do 24 hodín" vs VOP „3 pracovné dni, najneskôr 24 h pred termínom" | ✅ v110 |
| A12 | MED | Labely bez `htmlFor`, bez `autoComplete`, čipy bez `aria-pressed` | ✅ v110 čiastočne (`autoComplete`, `type=tel`), zvyšok 🎨 v111 (`Field`) |
| A13 | MED | Nízky kontrast `text-slate-400` | 🎨 v111 |
| A14 | LOW | ICS: `revokeObjectURL` hneď po kliku, časy bez TZID | ✅ v110 |
| A15 | LOW | „Dnes" v lokálnom čase prehliadača vs server Europe/Bratislava | ⏳ odložené (okrajové; server je rozhodujúci) |
| A16 | LOW | Malé dotykové ciele (šípky 36 px, ✕ bez paddingu) | 🎨 v111 |
| A17 | LOW | Chyba načítania termínov sa tvárila ako „nie sú otvorené termíny" | ✅ v110 — hláška + „Skúsiť znova" |
| A18 | LOW | Odkazy v pätičke otvorili právne texty v tom istom okne → stratený rozpísaný formulár | ✅ v110 — nové okno |
| A19 | LOW | USG stránka bez `<h1>` | ✅ v110 |

### Angiologická ambulancia a Zachráň nohu (`src/angio.jsx`, `src/zachrannohu.jsx`, `src/podappkyData.js`)
| # | Sev. | Nález | Stav |
|---|---|---|---|
| B1 | HIGH | „Objednávka je zrušená" sa mohla zobraziť, aj keď server nič nezrušil (ignorovaný výsledok), a výsledok vyhľadania ostal po zmene vstupov | ✅ v110 |
| B2 | HIGH | Texty sľubovali „zrušenie najneskôr 24 h vopred", server to pri zrušení nevynucoval; presun < 24 h vrátil surovú chybu | ✅ v110 — 24 h aj na serveri (angio-015), tlačidlá < 24 h skryté s vysvetlením |
| B3 | HIGH | Pacient angio/CT nikdy nedostal čerstvé termíny (bez obnovy), po „obsadený" ostal ten istý slot v ponuke | ✅ v110 — obnova každých 30 s + pri návrate do okna, návrat na krok 2 |
| B4 | MED | Bez stavu načítania: nakrátko predvolený cenník a prázdny kalendár | ✅ v110 |
| B5 | MED | Presun pacientom vrátil potvrdenú objednávku na „Nová" bez vysvetlenia a ponúkal všetky časy (nie 3 najbližšie) | ✅ v110 |
| B6 | MED | Pacientovi sa zobrazovali ISO dátumy („2026-10-22") | ✅ v110 — „Štvrtok 22. 10. 2026" |
| B7 | MED | Kalendár štartoval na aktuálnom mesiaci, bez hlášky „nie sú otvorené termíny" | ✅ v110 |
| B8 | MED | Formulár bez `htmlFor`/`aria-describedby`, ✕ bez názvu, bez fokusu na prvú chybu | 🎨 v111 (`Field`), fokus ⏳ |
| B9 | LOW | „← Späť na hlavnú stránku" viedlo na USG | ✅ v110 |
| B10 | MED | Landing tvrdil „bez žiadanky" bez ohľadu na nastavenie cenníka | ✅ v110 — texty podľa `requiresReferral` |
| B11 | LOW | Formulár „Zavolajte mi späť" bez klientskej validácie; čip „Zavoláme vám" aj bez funkcie; výsledok samotestu bez `aria-live` | ✅ v110 |
| B12 | LOW | Rovná úvodzovka v „Už máte objednávku?" | 🎨 v111 |

### CT a check-in (`src/ct.jsx`, `src/checkin.jsx`)
| # | Sev. | Nález | Stav |
|---|---|---|---|
| C1 | MED | CT obrazovka po objednaní bola slepá ulička („(ak bol zadaný)" pri povinnom e-maile, bez Nová objednávka) | ✅ v110 |
| C2 | MED | CT zrušenie ignorovalo výsledok RPC; zmena vstupov nečistila výsledok | ✅ v110 |
| C3 | MED | Check-in: zmena telefónu po vyhľadaní nechala starý zoznam | ✅ v110 |

### Nekonzistencie medzi tokmi (USG / angio / CT)
Indikátor krokov len v USG; rôzne nadpisy po odoslaní; stavy „Zamietnutá/Vykonaná/Neprišiel" vs „Zrušená/Vykonané/Nedostavil sa"; „Pracujem…" vs „Hľadám…"; 48 h vs 24 h (ℹ rozhodnutie: USG platené 48 h, bez poplatku 24 h); telefón 0949 000 677 natvrdo na 5 miestach. Stav: terminológia a stavy 🎨 v111 (`STATUS_TONES` + jednotné texty), krokovanie angio/CT ⏳ odložené.

---

## B. Správa pre personál

### Kalendár angio (v109) a dáta
| # | Sev. | Nález | Stav |
|---|---|---|---|
| D1 | HIGH | Bez realtime/obnovy: nové objednávky a QR check-in sa neukázali bez F5, dve karty sa rozchádzali | ✅ v110 — realtime kanál (objednávky, termíny, spätné volania) s debounce, poistka každú minútu, pri návrate do okna, tlačidlo „↻ Obnoviť" |
| D2 | HIGH | „Vrátiť medzi aktívne" poslalo pacientovi SMS + e-mail „termín potvrdený" | ✅ v110 — triggery reagujú len na nová → potvrdená (angio-015, aj CT) |
| D3 | HIGH | „Zrušiť" na jeden klik: hneď SMS/e-mail a výmaz prílohy, Obnoviť prílohu nevráti | ✅ v110 — potvrdenie s upozornením, poznámka pri Obnoviť |
| D4 | HIGH | Obnovenie tokenu (~hodinovo) odmontovalo správu — stratené filtre a rozpísané formuláre | ✅ v110 — rola a MFA sa načítavajú len pri zmene používateľa |
| D5 | MED | Objednávka s medzerou v otvorených bunkách sa vykreslila dvakrát (duplicitný kľúč) | ✅ v110 — jeden blok cez medzeru |
| D6 | MED | Panel Otvoriť dovolil minulé dni; týždenná navigácia a „Dnes" nemenili rozsah; mesiac nesledoval týždeň | ✅ v110 — `selectDay`, kontrola minulých dní v UI aj v dátovej vrstve |
| D7 | MED | Bez stropu dní pri otváraní (preklep roku = tisíce riadkov); náhľad bez zarovnania na 5 min | ✅ v110 — strop 92 dní, potvrdenie nad 10 dní, prázdny rozsah = chyba |
| D8 | MED | Zatváranie z neaktuálneho stavu mohlo zavrieť bunky práve obsadené pacientom | ✅ v110 — server maže len voľné bunky (`angio_close_free_slots`) |
| D9 | MED | Príznak „v čakárni" z minulých dní držal prioritu a odznak navždy | ✅ v110 — len dnes |
| D10 | MED | Chyby len inline hore (toast len pre úspech); bez stavu „ukladám" pri akciách | ✅ v110 — červený toast pre chyby, tlačidlá disabled počas ukladania |
| D11 | MED | Nastavenia mohli uložiť predvolený cenník / prázdnych lekárov pred načítaním | ✅ v110 — uložiť až po načítaní, formulár sleduje dáta kým nie je rozpísaný |
| D12 | LOW | Filter „Dnes" z dlaždice ostal potichu; Potvrdiť dvakrát pri rozbalení; hľadanie telefónu s medzerami; čas „Objednané" v UTC; presun ponúkal uplynuté časy; „len nevybavené" skrývalo „Volané" | ✅ v110 |
| D13 | LOW | Kvadratické výpočty pri každom renderi | ✅ v110 čiastočne (`useMemo` obsadenosti), zvyšok ⏳ |
| D14 | LOW | Minulé dni v mesačnom kalendári nerozlíšené | 🎨 v111 |

### Roly, relácia, bezpečnosť správy
| # | Sev. | Nález | Stav |
|---|---|---|---|
| E1 | MED | Chyba načítania roly sa tvárila ako „účet nemá rolu"; expirovaná relácia bez slovenskej hlášky | ✅ v110 — „Nepodarilo sa overiť rolu" + Skúsiť znova; „Relácia vypršala" |
| E2 | MED | Lekár videl cudzie obsadené bunky ako voľné (RLS vidí len svojich pacientov) | ✅ v110 — lekár nemá záložku Kalendár |
| E3 | MED | Bez „Odhlásiť sa" v správe angio/CT | ✅ v110 — lišta prihláseného používateľa pre každú správu |
| E4 | LOW | USG dáta sa načítavali aj na angio/CT/právnych stránkach; titulok okna nemenný | ✅ v110 |
| E5 | LOW | MFA zápis sa pri obnovení stránky reštartuje | ⏳ odložené (doplniť poznámku v111) |

### CT správa (`src/ct.jsx`)
| # | Sev. | Nález | Stav |
|---|---|---|---|
| F1 | MED | Chýba všetko z v109 (týždeň, bloky, zatváranie, kompaktné riadky, klikateľné dlaždice, Neprišiel, história, kopírovanie údajov) | 🗓 v112 |
| F2 | MED | Otvorenie víkendu hlásilo „✓ otvorené" bez riadkov | ✅ v110 — spoločná dátová vrstva vráti chybu |
| F3 | LOW | Vykonané/neprišiel v jantárovej farbe | ✅ v110 |

### USG správa (`src/booking.jsx`, `src/data.js`)
| # | Sev. | Nález | Stav |
|---|---|---|---|
| G1 | MED | Realtime bez debounce — otvorenie týždňa spustilo stovky načítaní | ✅ v110 |
| G2 | MED | Zatvorenie bloku = jeden dotaz na bunku | ✅ v110 — hromadné `closeSlots` |
| G3 | LOW | Vykonaní miznú z dnešného programu (angio ich radí nakoniec); týždeň od dneška vs od pondelka | ⏳ odložené (zjednotiť v samostatnej vlne) |

---

## C. Dizajn (`src/*.jsx`, `src/index.css`, `index.html`, manifest)
| # | Sev. | Nález (počty pred v111) | Stav |
|---|---|---|---|
| H1 | MED–HIGH | `text-slate-400` 111× (kontrast ~2,6:1, publikum 45+), `text-slate-*` spolu 323× | 🎨 v111 → `text-muted` / `text-ink` |
| H2 | MED | `font-bold` 148× na nadpisoch, tlačidlách a taboch | 🎨 v111 → `font-semibold` |
| H3 | MED | Červená/jantárová/zelená mimo tokenov (~150×), zvyšky tmavej témy (`bg-green-800 text-green-200`, PaidBadge, „✓ Uložené" s kontrastom 2:1, zelené Potvrdiť v USG) | 🎨 v111 |
| H4 | MED | `border-slate-200/300` 51×, tiene na tlačidlách/kartách 13×, `rounded` vs `rounded-lg`, 26 kombinácií primárneho tlačidla, 5 sekundárnych, 5 „danger" (niektoré bez hover), 4 hodnoty disabled | 🎨 v111 → `Btn` |
| H5 | MED | 6 kópií triedy inputu, 6 vzorov labelu, angio/CT formuláre nie sú `<form>` | 🎨 v111 → `Field`, `inputCls` |
| H6 | MED–HIGH | Stavové farby nekonzistentné (USG zoznam confirmed = zelená, done = modrá; kalendár confirmed = brand; angio done = zelená) | 🎨 v111 → `STATUS_TONES` |
| H7 | MED | Drobné písmo `text-[10px]`/`text-[11px]` 40× | 🎨 v111 → min. `text-xs` |
| H8 | MED | Serif + bold na h2 v správe, bránach a MFA; `capitalize` na slovenských dátumoch; neaktívny tab rovnakou farbou | 🎨 v111 |
| H9 | MED | `manifest.webmanifest` so starou farbou témy; koreňový `index.html` bez description/OG; bez `color-scheme` | 🎨 v111 |
| H10 | LOW | Emoji ikony (📎 🪑 📞) a mix šípok ‹› / ←→ | ⏳ odložené (SVG ikony v neskoršej vlne) |

---

## Čo treba spustiť v produkcii
1. `supabase/termin-zajtra-001.sql` (v108) — už aplikované.
2. `supabase/angio-015.sql` (v110) — pri nasadení v110 na ostrú.

## Čo si overiť na bete
- Správa angio: Kalendár (týždeň, bloky, zatváranie), červený toast pri chybe, „↻ Obnoviť", lišta s odhlásením, Zrušiť s potvrdením.
- Pacient: presun termínu cez kalendár (USG aj angio), hláška pri < 24 h (angio), „Nová objednávka" po SMS overení.
