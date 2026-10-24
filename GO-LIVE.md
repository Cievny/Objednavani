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

- [ ] v117 (ručné pridanie pacienta personálom): spustiť `supabase/rucne-001.sql`
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
