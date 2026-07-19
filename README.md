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

- **Kalendár riadený pracoviskom** — pacient vidí len termíny, ktoré pracovisko
  otvorilo (20-minútové sloty, 07:30–14:10).
- **Žiadanka** — pacient povinne volí, či má žiadanku od lekára:
  so žiadankou platí doplatok (30 €), bez nej plnú samoplatcovskú cenu.
- **Cenník NÚSCH** (platnosť od 01.03.2026) — editovateľný v správe,
  dve ceny na položku (samoplatca / doplatok), prázdny doplatok = položka
  len pre samoplatcov.
- **QR platba PAY by square** — slovenský štandard, funguje vo všetkých
  bankových aplikáciách (knižnica `bysquare` + `qrcode`).

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

## Ďalší krok: Supabase

Návrh schémy je pripravený v [`supabase/schema.sql`](supabase/schema.sql)
(tabuľky `orders`, `open_slots`, `pricelist`, `settings` + RLS politiky
a unikátny index proti dvojitej rezervácii toho istého termínu).

Postup nasadenia:

1. Vytvoriť projekt na [supabase.com](https://supabase.com) a spustiť
   `supabase/schema.sql` v SQL editore.
2. `npm install @supabase/supabase-js` a doplniť URL + anon key do `.env`.
3. V `src/booking.jsx` vymeniť telo hooku `useBookingData()` — jediné miesto,
   kde sa siaha na dáta — za volania Supabase.
4. Prihlásenie pracoviska cez Supabase Auth namiesto prístupového kódu.
5. Hosting buildu napr. na Vercel/Netlify.
