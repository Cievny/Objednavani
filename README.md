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
