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

const state = { hp: "", startedAt: 0, pass: "", passAt: 0, ts: TURNSTILE_SITE_KEY ? "idle" : "" };

// formulár tesne pred odoslaním (hp = obsah skrytého poľa, startedAt = Date.now() pri zobrazení)
export function guardFor({ hp = "", startedAt = 0 } = {}) {
  state.hp = String(hp || "").slice(0, 200);
  state.startedAt = startedAt || 0;
}

// hlavičky pre každú požiadavku na Supabase (supabaseClient.js → global.fetch)
// x-nusch-ts = stav overenia Turnstile (ok / pending / err:<kód> / …) — databáza ho
// v režime log zapisuje, aby sa dalo zistiť, prečo overenie u pacientov nedobehlo
export function guardHeaders() {
  const h = { "x-nusch-hp": state.hp };
  if (state.startedAt) h["x-nusch-ms"] = String(Math.max(0, Date.now() - state.startedAt));
  if (state.pass) h["x-nusch-pass"] = state.pass;
  if (state.ts) h["x-nusch-ts"] = state.ts.slice(0, 60);
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
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("script")));
      s.onerror = () => { scriptPromise = null; reject(new Error("script")); };
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
    let id = null;
    const cleanup = () => setTimeout(() => { try { if (id != null) ts.remove(id); } catch { /* */ } box.innerHTML = ""; }, 0);
    try {
      id = ts.render(box, {
        sitekey: TURNSTILE_SITE_KEY,
        appearance: "interaction-only",
        retry: "never",
        callback: (t) => { cleanup(); resolve(t); },
        "error-callback": (code) => { cleanup(); reject(new Error("err:" + (code || "?"))); return true; },
        "timeout-callback": () => { cleanup(); reject(new Error("timeout-widget")); },
        "unsupported-callback": () => { cleanup(); reject(new Error("unsupported")); },
        "before-interactive-callback": () => { state.ts = "interactive"; },
      });
    } catch (e) {
      cleanup(); reject(new Error("render:" + String(e?.message || e).slice(0, 40)));
    }
  }));
}

// získanie preukazu na pozadí (raz; súbežné volania zdieľajú tú istú požiadavku)
let passPromise = null;
let failedAt = 0;
const passValid = () => state.pass && Date.now() - state.passAt < 15 * 60 * 1000;
function startPass() {
  if (!TURNSTILE_SITE_KEY || !SUPABASE_URL || passValid()) return Promise.resolve();
  if (passPromise) return passPromise;
  // po zlyhaní neskúšať znova hneď (onFocus formulára sa volá pri každom poli)
  if (failedAt && Date.now() - failedAt < 20000) return Promise.resolve();
  state.ts = "pending";
  const hardTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000));
  passPromise = Promise.race([(async () => {
    const token = await getToken();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/turnstile-pass`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ token }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.pass) throw new Error("pass:" + r.status);
    state.pass = j.pass; state.passAt = Date.now(); state.ts = "ok";
  })(), hardTimeout]).catch((e) => {
    failedAt = Date.now();
    state.ts = String(e?.message || "chyba").slice(0, 60);
    console.warn("Turnstile:", state.ts);
  }).finally(() => { passPromise = null; });
  return passPromise;
}

// Spustiť overenie vopred — keď pacient začne vypĺňať formulár (nie až pri odoslaní).
export function prewarmHumanPass() { startPass(); }

// Pred odoslaním počkať na preukaz najviac `wait` ms. NIKDY nevyhodí chybu a nezdrží
// pacienta: ak preukaz nie je hotový, požiadavka ide bez neho. Povinnosť preukazu
// vynucuje len databáza (turnstile_enforce = on) so zrozumiteľnou hláškou.
export async function ensureHumanPass(wait = 1500) {
  if (!TURNSTILE_SITE_KEY || !SUPABASE_URL || passValid()) return;
  await Promise.race([startPass(), new Promise((r) => setTimeout(r, wait))]);
}

// skryté pole pre formuláre (človek ho nevidí ani doň netabuje)
export const honeypotProps = {
  type: "text", name: "website", tabIndex: -1, autoComplete: "off", "aria-hidden": "true",
  style: { position: "absolute", left: "-10000px", width: "1px", height: "1px", opacity: 0 },
};
