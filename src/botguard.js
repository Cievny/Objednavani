// Ochrana formulárov pred botmi (v113).
//
// 1. Neviditeľné pole (honeypot) + čas vyplnenia: formulár zavolá
//    guardFor({ hp, startedAt }) tesne pred odoslaním; hodnoty idú v hlavičkách
//    x-nusch-hp a x-nusch-ms s každou požiadavkou na Supabase a overuje ich
//    databázová funkcia bot_guard() (režim log / on v settings.bot_guard).
// 2. Cloudflare Turnstile (len ak je nastavený VITE_TURNSTILE_SITE_KEY):
//    ensureHumanPass() získa token, Edge Function turnstile-pass ho overí
//    a vráti preukaz, ktorý ide v hlavičke x-nusch-pass.

// kľúč stránky očistený (premenná môže omylom obsahovať medzery, nové riadky alebo viac hodnôt)
const RAW_SITE_KEY = String(import.meta.env.VITE_TURNSTILE_SITE_KEY || "").trim().split(/\s+/)[0] || "";
export const TURNSTILE_SITE_KEY = /^0x[A-Za-z0-9_-]{10,}$/.test(RAW_SITE_KEY) ? RAW_SITE_KEY : "";
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

const state = { hp: "", startedAt: 0, pass: "", passAt: 0 };

// formulár tesne pred odoslaním (hp = obsah skrytého poľa, startedAt = Date.now() pri zobrazení)
export function guardFor({ hp = "", startedAt = 0 } = {}) {
  state.hp = String(hp || "").slice(0, 200);
  state.startedAt = startedAt || 0;
}

// hlavičky pre každú požiadavku na Supabase (supabaseClient.js → global.fetch)
export function guardHeaders() {
  const h = { "x-nusch-hp": state.hp };
  if (state.startedAt) h["x-nusch-ms"] = String(Math.max(0, Date.now() - state.startedAt));
  if (state.pass) h["x-nusch-pass"] = state.pass;
  return h;
}

// --- Cloudflare Turnstile ---------------------------------------------------
let scriptPromise = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { scriptPromise = null; reject(new Error("Overenie, že nie ste robot, sa nepodarilo načítať. Skontrolujte pripojenie.")); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

function getToken() {
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("Overenie trvá príliš dlho.")), 15000))]);
  return withTimeout(loadTurnstile().then((ts) => new Promise((resolve, reject) => {
    // kontajner dole uprostred — väčšinou ostane prázdny (neviditeľné overenie);
    // ak Cloudflare chce interakciu, ukáže sa v ňom zaškrtávacie políčko
    let box = document.getElementById("turnstile-box");
    if (!box) {
      box = document.createElement("div");
      box.id = "turnstile-box";
      box.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60";
      document.body.appendChild(box);
    }
    box.innerHTML = "";
    const done = (fn) => (v) => { setTimeout(() => { try { ts.remove(id); } catch { /* */ } box.innerHTML = ""; }, 0); fn(v); };
    const id = ts.render(box, {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: "interaction-only",
      language: "sk",
      callback: done(resolve),
      "error-callback": done(() => reject(new Error("Overenie, že nie ste robot, zlyhalo. Skúste to znova."))),
      "timeout-callback": done(() => reject(new Error("Overenie vypršalo. Skúste to znova."))),
    });
  })));
}

// Zaistí platný preukaz (15 min); bez nastaveného kľúča nič nerobí.
// NIKDY nevyhodí chybu: zlyhanie Turnstile (blokovaný skript, zlý kľúč, sieť) nesmie
// zablokovať pacienta. Ak databáza preukaz vyžaduje (turnstile_enforce = on),
// odmietne požiadavku sama a pacient dostane jej zrozumiteľnú hlášku.
export async function ensureHumanPass() {
  if (!TURNSTILE_SITE_KEY || !SUPABASE_URL) return;
  if (state.pass && Date.now() - state.passAt < 15 * 60 * 1000) return;
  try {
    const token = await getToken();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/turnstile-pass`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ token }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j?.pass) { state.pass = j.pass; state.passAt = Date.now(); }
    else console.warn("Turnstile: preukaz nevydaný", r.status, j?.error || "");
  } catch (e) {
    console.warn("Turnstile:", e?.message || e);
  }
}

// skryté pole pre formuláre (človek ho nevidí ani doň netabuje)
export const honeypotProps = {
  type: "text", name: "website", tabIndex: -1, autoComplete: "off", "aria-hidden": "true",
  style: { position: "absolute", left: "-10000px", width: "1px", height: "1px", opacity: 0 },
};
