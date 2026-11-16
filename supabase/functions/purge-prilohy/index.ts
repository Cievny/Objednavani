// Edge Function purge-prilohy (prilohy-mazanie-001)
//
// Vybaví rad súborov na zmazanie (tabuľka attachment_purge_queue): prílohy
// zrušených objednávok, objednávok po lehote uchovávania a súbory bez
// objednávky. Súbory maže cez Storage API — Supabase už nedovoľuje mazať ich
// priamym SQL a len Storage API ich odstráni naozaj (aj z disku).
//
// Volá ju databáza (pg_net): hneď po zaradení súboru do radu a každú noc.
// Funkcia nemá žiadny vstup — maže len to, čo do radu zaradila databáza,
// preto ju môže zavolať ktokoľvek bez rizika (verify_jwt = false; projekt
// používa publishable kľúč, nie JWT). Servisný kľúč má len funkcia
// (SUPABASE_SERVICE_ROLE_KEY dodáva Supabase automaticky).

const BUCKET = "prilohy";
const BATCH = 200;      // súborov na jedno volanie Storage API
const MAX_ROUNDS = 10;  // najviac 2000 súborov na jedno spustenie

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ ok: false, error: "not configured" }, 503);
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const rpc = (fn: string, args: unknown) =>
    fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });

  let deleted = 0, remaining = 0, rounds = 0, error = "";
  try {
    for (; rounds < MAX_ROUNDS; rounds++) {
      const take = await rpc("attachment_purge_take", { p_limit: BATCH });
      if (!take.ok) { error = `take ${take.status}: ${(await take.text()).slice(0, 200)}`; break; }
      const rows: { bucket: string; path: string }[] = await take.json();
      const paths = rows.filter((r) => r.bucket === BUCKET && r.path).map((r) => r.path);
      if (paths.length === 0) break;

      let stepError = "";
      const del = await fetch(`${url}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers, body: JSON.stringify({ prefixes: paths }) });
      if (!del.ok) stepError = `storage ${del.status}: ${(await del.text()).slice(0, 200)}`;
      else await del.body?.cancel();

      const settle = await rpc("attachment_purge_settle", { p_error: stepError });
      if (!settle.ok) { error = `settle ${settle.status}: ${(await settle.text()).slice(0, 200)}`; break; }
      const s = await settle.json();
      deleted += Number(s?.deleted) || 0;
      remaining = Number(s?.remaining) || 0;
      if (stepError) { error = stepError; break; }
      if (remaining === 0) break;
    }
  } catch (e) {
    error = `exception: ${String((e as Error)?.message || e).slice(0, 200)}`;
  }
  return json({ ok: error === "", deleted, remaining, error }, error ? 500 : 200);
});
