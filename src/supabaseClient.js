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
