# Objednávanie na USG — NÚSCH, a.s.

Samostatná webová aplikácia na online objednávanie pacientov na platené USG
vyšetrenia v rámci doplnkových ordinačných hodín.

## Dve stránky

| URL | Kto | Čo |
|-----|-----|----|
| `/#/` | pacient | sprievodca objednaním v 4 krokoch (vyšetrenie → termín → údaje → QR platba) |
| `/#/sprava` | pracovisko | otváranie termínov v kalendári, spracovanie žiadostí, cenník, nastavenia platby |

Stránka pracoviska je chránená provizórnym prístupovým kódom (`nusch2026`,
konštanta `ADMIN_ACCESS_CODE` v `src/App.jsx`). Nie je to reálne zabezpečenie —
nahradí ho prihlásenie cez Supabase Auth.

## Funkcie

Pacient (`/#/`):
- 4-krokový sprievodca objednaním (vyšetrenie → termín → údaje → platba)
- povinná voľba žiadanky: s ňou doplatok (30 €), bez nej plná cena
- mesačný kalendár len s termínmi, ktoré pracovisko otvorilo
- **bez rodného čísla** — pýta sa len dátum narodenia (RČ sa doplní pri
  vyšetrení alebo zo žiadanky); e-mail a telefón povinné
- QR platba PAY by square (`bysquare` + `qrcode`)
- overenie stavu / zrušenie objednávky podľa čísla objednávky + telefónu

Pracovisko (`/#/sprava`):
- **Prehľad** — dnešný program pre lekára, štatistiky, čakajúce žiadosti
- **Kalendár** — pás 14 dní s obsadenosťou, hromadné otvorenie pracovných
  dní v rozsahu, otváranie/zatváranie jednotlivých slotov
  (20-minútové sloty, 07:30–14:10)
- **Objednávky** — všetky objednávky s filtrami (stav, deň, hľadanie podľa
  mena/telefónu/čísla), presunutie na iný termín, zrušenie, export CSV
- **Nastavenia** — cenník NÚSCH (dve ceny na položku; prázdny doplatok =
  len samoplatca) a platobné údaje (IBAN, príjemca)

## Vývoj

```sh
npm install
npm run dev       # vývojový server
npm run build     # produkčný build do dist/
npm run preview   # náhľad buildu
```

Stack: React 19 + Vite 7 + Tailwind CSS 4 (bundlovaný, bez CDN).

## Stav dát — DÔLEŽITÉ

Aplikácia je zatiaľ **prototyp bez servera**: objednávky, otvorené termíny,
cenník aj nastavenia sa ukladajú do `localStorage` prehliadača. Pacient
a pracovisko teda zatiaľ nevidia spoločné dáta — na ostrú prevádzku treba
backend (pozri nižšie).

Predvolený IBAN v nastaveniach je **verejne známy vzorový (DEMO) IBAN**,
nie účet NÚSCH. Aplikácia na to upozorňuje v správe aj pri QR kóde.

## Supabase (ostrá prevádzka)

Integrácia je hotová — appka beží v dvoch režimoch:

- **bez `.env`** → demo na localStorage (vrátane prístupového kódu),
- **s `.env`** → Supabase: spoločná databáza, prihlásenie personálu cez
  Supabase Auth (e-mail + heslo), realtime obnovovanie stránky pracoviska.

Bezpečnostný model: pacient (anonymný) nikdy nečíta tabuľku `orders` —
obsadenosť termínov, vytvorenie, overenie aj zrušenie objednávky idú cez
SECURITY DEFINER funkcie (`get_booked_slots`, `create_order`,
`lookup_order`, `cancel_order`), ktoré vracajú len nevyhnutné údaje.
Dvojitú rezerváciu blokuje unikátny index na (deň, čas).

### Postup nasadenia

1. [supabase.com](https://supabase.com) → **New project**, región
   **Frankfurt (eu-central-1)** — zdravotné údaje ostanú v EÚ.
2. **SQL Editor** → vložiť a spustiť celý [`supabase/schema.sql`](supabase/schema.sql).
3. **Authentication → Sign In / Up** → vypnúť verejnú registráciu
   (Allow new users to sign up = OFF); personál pozývať cez
   **Authentication → Users → Invite user** (nusch.sk e-maily).
4. Skopírovať `.env.example` na `.env` a doplniť **Project URL** a
   **anon key** (Settings → API).
5. V správe appky nastaviť skutočný IBAN pracoviska (alebo upraviť
   riadok v tabuľke `settings`).
6. Build nasadiť napr. na Vercel/Netlify (env premenné zadať aj tam).

## Beta prevádzka

Web má dve verzie na jednej doméne:

| URL | vetva | účel |
|-----|-------|------|
| `objednanie.cievny.sk` (+ `/sprava/`) | `main` | produkcia |
| `objednanie.cievny.sk/beta/` (+ `/beta/sprava/`) | `beta` | testovanie zmien |

Pravidlá:
- nové úpravy sa pushujú do vetvy `beta` — nasadia sa pod `/beta/`
  (v hlavičke majú štítok „BETA — testovacia verzia", stránka je noindex),
- `main` sa mení už len fast-forwardom z otestovanej `beta`,
- beta zdieľa produkčnú Supabase databázu — SQL zmeny musia byť vždy
  spätne kompatibilné (aditívne), aby nerozbili bežiacu produkciu.
