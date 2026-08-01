# GO-LIVE checklist — objednanie.cievny.sk

Stav k 30.07.2026 (v46). Systém je funkčný v skúšobnej prevádzke
(platby, párovanie ~1 min, e-maily s logom, SMS, faktúry, kôš,
samoobslužné storno/presun, doplnkové hodiny). Pred ostrým spustením
treba dokončiť body nižšie.

## 1. Texty — chýbajúce údaje ([DOPLNIŤ] v src/legal.jsx)

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
