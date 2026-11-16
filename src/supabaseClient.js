import { createClient } from "@supabase/supabase-js";
import { guardHeaders } from "./botguard.js";

// Doplňte do .env (pozri .env.example):
//   VITE_SUPABASE_URL=https://<projekt>.supabase.co
//   VITE_SUPABASE_ANON_KEY=<anon key zo Settings -> API>
// Bez týchto hodnôt beží appka v demo režime na localStorage.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Ochrana pred botmi (v113): ku každej požiadavke sa pridajú hlavičky
// x-nusch-hp / x-nusch-ms / x-nusch-pass, ktoré overuje databázová funkcia bot_guard().
const guardedFetch = (input, init = {}) => {
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  Object.entries(guardHeaders()).forEach(([k, v]) => { if (v !== undefined) headers.set(k, v); });
  return fetch(input, { ...init, headers });
};

export const supabase = url && anonKey ? createClient(url, anonKey, { global: { fetch: guardedFetch } }) : null;
export const isSupabaseConfigured = Boolean(supabase);

// Pacientske akcie (overenie, zmena, zrušenie objednávky): zrozumiteľnú správu
// majú len chyby, ktoré vyhodili naše databázové funkcie (SQLSTATE P0001).
// Všetko ostatné (chyba databázy, výpadok spojenia) pacientovi neukazujeme
// v surovom technickom tvare — dostane návod, čo robiť.
export const PATIENT_TECH_ERROR = "Nepodarilo sa to pre technickú chybu na našej strane. Skúste to prosím o chvíľu znova, alebo nám napíšte SMS s číslom objednávky na 0949 000 677.";
export const patientDbError = (error) => {
  if (!error) return null;
  if (error.code === "P0001" && error.message) return new Error(error.message);
  if (error.code === "23505" || error.code === "23P01") { const e = new Error("Vybraný termín bol medzičasom obsadený. Vyberte iný."); e.code = "SLOT_TAKEN"; return e; }
  try { console.error("Technická chyba pri pacientskej akcii:", error.code || "", error.message || error); } catch { /* */ }
  return new Error(PATIENT_TECH_ERROR);
};

// Číslo objednávky tak, ako ho čaká databáza: bez medzier, veľkými písmenami
// (pacient ho často prepíše malými písmenami alebo s medzerou).
export const normOrderId = (id) => String(id || "").replace(/\s+/g, "").toUpperCase();

// Otvorené termíny načítavame len od tohto dňa (14 dní dozadu kvôli prehľadu
// personálu) — staré bunky by inak časom prekročili limit počtu riadkov API
// (predvolene 1000) a časť termínov by sa potichu nenačítala.
export const slotsFromIso = () => {
  const d = new Date(Date.now() - 14 * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Načítanie VŠETKÝCH riadkov po stránkach. API vracia na jednu požiadavku
// najviac „Max rows" riadkov (predvolene 1000) a zvyšok potichu zahodí — pri
// 5-minútových bunkách termínov by tak po pár otvorených týždňoch zmizla časť
// dní pacientom aj personálu. `build` musí vrátiť NOVÝ dotaz so stabilným
// zoradením a `{ count: "exact" }` (pri select); pri RPC sa končí prázdnou stranou.
export async function selectAllRows(build, pageSize = 1000) {
  const out = [];
  let total = null;
  for (let guard = 0; guard < 100; guard++) {
    const { data, error, count } = await build().range(out.length, out.length + pageSize - 1);
    if (error) return { data: null, error };
    if (typeof count === "number") total = count;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (total !== null ? out.length >= total : data.length < pageSize) break;
  }
  return { data: out, error: null };
}
