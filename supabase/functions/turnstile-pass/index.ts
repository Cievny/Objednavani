// Edge Function turnstile-pass (v113, ochrana pred botmi)
//
// Prehliadač pošle token z Cloudflare Turnstile → funkcia ho overí u Cloudflare
// (tajný kľúč TURNSTILE_SECRET je len tu, v Supabase → Edge Functions → Secrets)
// a vydá jednorazový preukaz (riadok v human_passes, platí 20 min, max. 6 použití).
// Prehliadač ho potom posiela v hlavičke x-nusch-pass pri žiadosti o SMS kód
// a pri „Zavolajte mi späť"; overuje ho databázová funkcia bot_guard().
//
// Nasadenie: verify_jwt = false (projekt používa publishable kľúč, nie JWT).

const ALLOWED_ORIGINS = ["https://objednanie.cievny.sk", "http://localhost:5173", "http://localhost:4173"];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false }), { status: 405, headers });

  const secret = Deno.env.get("TURNSTILE_SECRET");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !url || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: "Overenie nie je nastavené." }), { status: 503, headers });
  }

  let token = "";
  try { token = String((await req.json())?.token || ""); } catch { token = ""; }
  if (!token || token.length > 4096) {
    return new Response(JSON.stringify({ ok: false, error: "Chýba overenie." }), { status: 400, headers });
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  if (ip) form.append("remoteip", ip);
  let verified = false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = await r.json();
    verified = j?.success === true;
  } catch { verified = false; }
  if (!verified) {
    return new Response(JSON.stringify({ ok: false, error: "Overenie, že nie ste robot, sa nepodarilo." }), { status: 403, headers });
  }

  const ins = await fetch(`${url}/rest/v1/human_passes`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: "{}",
  });
  if (!ins.ok) {
    return new Response(JSON.stringify({ ok: false, error: "Preukaz sa nepodarilo vydať." }), { status: 500, headers });
  }
  const rows = await ins.json();
  return new Response(JSON.stringify({ ok: true, pass: rows?.[0]?.id || "" }), { headers });
});
