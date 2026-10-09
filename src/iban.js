// Platobné údaje — fail-closed (audit vlna 8).
//  • IBAN sa už nedá meniť z aplikácie; zdroj pravdy je tabuľka
//    payment_identity v databáze (mení sa len v SQL editore) a jej zrkadlo
//    settings.iban, ktoré aplikácia číta.
//  • Produkčný build má IBAN navyše „pripnutý" (VITE_PINNED_IBAN v deploy.yml).
//    QR kód a IBAN sa pacientovi zobrazia LEN ak je IBAN platný (mod-97),
//    nie je demo a zhoduje sa s pripnutým. Inak sa zobrazí text, že platobné
//    údaje prídu e-mailom (e-mail ich berie z databázy).
//  Zmena účtu = runbook v GO-LIVE.md (SQL editor + nový deploy).

// demo účet z vývoja (zložený, aby sa v builde nevyskytoval ako celok)
const DEMO_IBANS = new Set([["SK31", "1200", "0000", "1987", "4263", "7541"].join("")]);

export const normalizeIban = (s) => String(s || "").replace(/\s/g, "").toUpperCase();

export const PINNED_IBAN = normalizeIban(import.meta.env.VITE_PINNED_IBAN);

const HAS_BACKEND = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);

export function isValidIban(input) {
  const s = normalizeIban(input);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  if (s.startsWith("SK") && s.length !== 24) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let n = 0;
  for (const c of r) {
    const v = c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55;
    n = (n * (v > 9 ? 100 : 10) + v) % 97;
  }
  return n === 1;
}

export const isDemoIban = (s) => {
  const n = normalizeIban(s);
  return !n || DEMO_IBANS.has(n) || n.startsWith("SK__");
};

// Smú sa pacientovi ukázať platobné údaje (QR + IBAN)?
export function paymentReady(settings) {
  const iban = normalizeIban(settings?.iban);
  if (!isValidIban(iban) || isDemoIban(iban)) return false;
  if (HAS_BACKEND) return Boolean(PINNED_IBAN) && iban === PINNED_IBAN;
  return true; // demo bez servera: stačí platný IBAN v localStorage
}

// Prečo nie — na zobrazenie personálu v Nastaveniach
export function paymentStatus(settings) {
  const iban = normalizeIban(settings?.iban);
  if (!iban) return { ok: false, reason: "IBAN nie je nastavený (payment_identity je prázdna)." };
  if (!isValidIban(iban)) return { ok: false, reason: "IBAN neprešiel kontrolou (mod-97)." };
  if (isDemoIban(iban)) return { ok: false, reason: "Je nastavený DEMO IBAN." };
  if (HAS_BACKEND && !PINNED_IBAN) return { ok: false, reason: "Build nemá pripnutý IBAN (VITE_PINNED_IBAN v deploy.yml)." };
  if (HAS_BACKEND && iban !== PINNED_IBAN) return { ok: false, reason: `IBAN v databáze (${iban}) sa nezhoduje s pripnutým v builde (${PINNED_IBAN}).` };
  return { ok: true, reason: "" };
}

export const PAYMENT_PENDING_TEXT = "Platobné údaje (IBAN a QR kód) vám pošleme e-mailom spolu s potvrdením rezervácie.";
