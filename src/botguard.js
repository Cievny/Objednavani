// Ochrana formulárov pred botmi (v113).
//
// 1. Neviditeľné pole (honeypot) + čas vyplnenia: formulár zavolá
//    guardFor({ hp, startedAt }) tesne pred odoslaním; hodnoty idú v hlavičkách
//    x-nusch-hp a x-nusch-ms s každou požiadavkou na Supabase a overuje ich
//    databázová funkcia bot_guard() (režim log / on v settings.bot_guard).
// 2. Cloudflare Turnstile (len ak je nastavený VITE_TURNSTILE_SITE_KEY):
//    ensureHumanPass() získa token, Edge Function turnstile-pass ho overí
//    a vráti preukaz, ktorý ide v hlavičke x-nusch-pass.

export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";
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
  return loadTurnstile().then((ts) => new Promise((resolve, reject) => {
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
  }));
}

// zaistí platný preukaz (15 min); bez nastaveného kľúča nič nerobí
export async function ensureHumanPass() {
  if (!TURNSTILE_SITE_KEY || !SUPABASE_URL) return;
  if (state.pass && Date.now() - state.passAt < 15 * 60 * 1000) return;
  const token = await getToken();
  const r = await fetch(`${SUPABASE_URL}/functions/v1/turnstile-pass`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ token }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.pass) throw new Error(j?.error || "Overenie, že nie ste robot, sa nepodarilo.");
  state.pass = j.pass; state.passAt = Date.now();
}

// skryté pole pre formuláre (človek ho nevidí ani doň netabuje)
export const honeypotProps = {
  type: "text", name: "website", tabIndex: -1, autoComplete: "off", "aria-hidden": "true",
  style: { position: "absolute", left: "-10000px", width: "1px", height: "1px", opacity: 0 },
};
