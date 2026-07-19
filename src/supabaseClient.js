import { createClient } from "@supabase/supabase-js";

// Doplňte do .env (pozri .env.example):
//   VITE_SUPABASE_URL=https://<projekt>.supabase.co
//   VITE_SUPABASE_ANON_KEY=<anon key zo Settings -> API>
// Bez týchto hodnôt beží appka v demo režime na localStorage.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
export const isSupabaseConfigured = Boolean(supabase);
