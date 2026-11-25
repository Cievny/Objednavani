import { useCallback, useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import { classify } from "./triaz.js";

// Konzultácie z Instagramu (konzultacie-001, -002): verejný triážny formulár a prehľad pre lekára.
// Po vybavení sa žiadosť IHNEĎ a natrvalo maže — ostáva len anonymný počet (consult_stats).
// Demo režim (bez databázy): localStorage.

export const CONSULT_KEY = "consultRequests_v1";
export const CONSULT_STATS_KEY = "consultStats_v1";
const DEMO_OPEN_KEY = "consultFormOff_v1";
const NEED_SQL = "Konzultácie ešte nie sú zapnuté v databáze (spustite supabase/konzultacie-001.sql).";
const NEED_SQL2 = "Okamžité mazanie po vybavení ešte nie je v databáze zapnuté — spustite supabase/konzultacie-002.sql. Dovtedy žiadosti, prosím, nevybavujte.";

const load = () => { try { return JSON.parse(localStorage.getItem(CONSULT_KEY) || "[]"); } catch { return []; } };
const save = (list) => localStorage.setItem(CONSULT_KEY, JSON.stringify(list));
const loadStats = () => { try { return JSON.parse(localStorage.getItem(CONSULT_STATS_KEY) || "[]"); } catch { return []; } };
// stav: new = čaká · sending = odpoveď sa odosiela (zdravotné údaje sú už zmazané) · failed = brána odpoveď neprijala
const row = (r) => ({
  id: r.id, createdAt: r.created_at, initials: r.initials, birthYear: r.birth_year, region: r.region || "", topic: r.topic,
  answers: r.answers || {}, flags: Array.isArray(r.flags) ? r.flags : [], note: r.note || "", contactType: r.contact_type, contact: r.contact,
  status: r.status, outcome: r.outcome || "", replyText: r.reply_text || "", sendError: r.send_error || "", sentAt: r.sent_at || "",
});
const statRow = (r) => ({ doneOn: r.done_on, topic: r.topic, outcome: r.outcome, channel: r.channel, replySent: Boolean(r.reply_sent), waitDays: Number(r.wait_days) || 0 });
const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// kontakt v jednotnom tvare (demo; v databáze to robí consult_submit)
const normContact = (type, value) => {
  const v = String(value || "").trim();
  if (type === "sms") {
    let d = v.replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("4210") && d.length === 13) d = "421" + d.slice(4);
    else if (d.startsWith("0")) d = "421" + d.slice(1);
    else if (d.length === 9 && d.startsWith("9")) d = "421" + d;
    if (d.length < 11 || d.length > 15) throw new Error("Zadajte platné číslo mobilu (napr. 0949 123 456).");
    return "+" + d;
  }
  if (type === "email") {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || v.length > 254) throw new Error("Zadajte platný e-mail.");
    return v.toLowerCase();
  }
  if (type === "instagram") {
    const n = v.replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, "").replace(/^@/, "").replace(/\/+$/, "").toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(n)) throw new Error("Zadajte svoje meno na Instagrame (napr. @meno).");
    return n;
  }
  throw new Error("Vyberte, kam vám máme odpovedať.");
};

export const consultApi = {
  // je príjem žiadostí zapnutý? null = databáza konzultácie ešte nemá
  async ready() {
    if (!supabase) return !localStorage.getItem(DEMO_OPEN_KEY);
    const { data, error } = await supabase.rpc("consult_ready");
    if (error) return error.code === "PGRST202" ? null : true; // pri výpadku spojenia formulár neskrývať — chybu ukáže odoslanie
    return data === true;
  },
  async submit(req) {
    if (!supabase) {
      if (localStorage.getItem(DEMO_OPEN_KEY)) throw new Error("Príjem žiadostí je momentálne pozastavený. Skúste to, prosím, neskôr.");
      const letters = String(req.initials || "").replace(/[^\p{L}]/gu, "");
      if (letters.length < 1 || letters.length > 4) throw new Error("Zadajte len iniciály (napr. J. K.), nie celé meno.");
      const id = "KON-" + Math.random().toString(16).slice(2, 10).toUpperCase().padEnd(8, "0");
      const list = load();
      list.push({ id, createdAt: new Date().toISOString(), initials: [...letters.toUpperCase()].map((c) => c + ".").join(" "), birthYear: Number(req.birthYear), region: req.region || "",
        topic: req.topic, answers: req.answers || {}, flags: req.flags || [], note: String(req.note || "").trim(), contactType: req.contactType, contact: normContact(req.contactType, req.contact),
        status: "new", outcome: "", replyText: "", sendError: "", sentAt: "" });
      save(list);
      return id;
    }
    const { data, error } = await supabase.rpc("consult_submit", {
      p_initials: req.initials, p_birth_year: Number(req.birthYear), p_topic: req.topic, p_answers: req.answers || {}, p_flags: req.flags || [],
      p_note: req.note || "", p_contact_type: req.contactType, p_contact: req.contact, p_region: req.region || "", p_consent: Boolean(req.consent),
    });
    if (error) {
      // zrozumiteľné sú len hlášky našej funkcie (P0001); ostatné chyby pacientovi neukazujeme v surovom tvare
      if (error.code === "P0001" && error.message) throw new Error(error.message);
      throw new Error(error.code === "PGRST202" ? "Formulár je dočasne nedostupný. Skúste to, prosím, neskôr." : "Žiadosť sa nepodarilo odoslať pre technickú chybu. Skúste to, prosím, o chvíľu znova.");
    }
    return data?.id || "";
  },
};

// text SMS tak, ako ho pošle databáza (funkcia sms_plain): bez diakritiky, len základné znaky
const SMS_FROM = "áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽěřůĚŘŮöüÖÜ„“”‚‘’–—";
const SMS_TO = `aacdeillnoorstuyzAACDEILLNOORSTUYZeruERUouOU"""'''--`;
export const smsPlain = (text) => [...String(text || "").replace(/…/g, "...").replace(/\n/g, " ")]
  .map((ch) => { const i = SMS_FROM.indexOf(ch); return i >= 0 ? SMS_TO[i] : ch; }).join("")
  .replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
export const SMS_MAX = 450; // bez úvodného „NUSCH: "

// ---------- prehľad pre lekára ----------
export function useConsultRequests(isStaff) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState("");
  const [stats, setStats] = useState([]);
  const [needsUpgrade, setNeedsUpgrade] = useState(false); // databáza ešte nemá okamžité mazanie (konzultacie-002)

  const reload = useCallback(async () => {
    if (!supabase) {
      setList(load()); setStats(loadStats().map(statRow)); setOpen(!localStorage.getItem(DEMO_OPEN_KEY)); setLoading(false); setError("");
      return;
    }
    if (!isStaff) return;
    // najprv potvrdiť odoslané odpovede (brána prijala → riadok sa zmaže; odmietla → vráti sa ako neodoslaná)
    try { await supabase.rpc("consult_finalize"); } catch { /* staršia databáza alebo výpadok — zoznam sa načíta aj tak */ }
    const [rq, st, cs] = await Promise.all([
      supabase.from("consult_requests").select("*").order("created_at", { ascending: true }).limit(1000),
      supabase.from("settings").select("key,value").in("key", ["consult_form", "consult_notify_email"]),
      supabase.from("consult_stats").select("done_on,topic,outcome,channel,reply_sent,wait_days").order("done_on", { ascending: false }).limit(5000),
    ]);
    setLoading(false);
    const missing = (e, name) => e && (e.code === "42P01" || e.code === "PGRST205" || (new RegExp(name).test(e.message || "") && /not exist|schema cache/i.test(e.message || "")));
    if (rq.error) {
      setError(missing(rq.error, "consult_requests") ? NEED_SQL : rq.error.message || "Žiadosti sa nepodarilo načítať."); setList([]); setStats([]);
      return;
    }
    // žiadosti vybavené ešte starším postupom (pred konzultacie-002) sa v prehľade neukazujú
    setList((rq.data || []).map(row).filter((r) => ["new", "sending", "failed"].includes(r.status)));
    setError(cs.error ? (missing(cs.error, "consult_stats") ? NEED_SQL2 : cs.error.message || "Počty sa nepodarilo načítať.") : "");
    setNeedsUpgrade(Boolean(missing(cs.error, "consult_stats")));
    setStats(cs.error ? [] : (cs.data || []).map(statRow));
    const s = Object.fromEntries((st.data || []).map((x) => [x.key, x.value]));
    setOpen(s.consult_form !== "off"); setNotifyEmail(s.consult_notify_email || "");
  }, [isStaff]);
  useEffect(() => { reload(); }, [reload]);

  // rozhodnutie + odpoveď; send = odoslať SMS / e-mail zo systému (pri Instagrame sa nič neposiela).
  // Žiadosť sa tým natrvalo maže — nedá sa vrátiť.
  const resolve = async (id, { outcome, reply, send }) => {
    if (!supabase) {
      const all = load(); const r = all.find((x) => x.id === id);
      if (!r) throw new Error("Žiadosť sa nenašla (už bola vybavená a zmazaná).");
      const sent = send && r.contactType !== "instagram";
      save(all.filter((x) => x.id !== id));
      localStorage.setItem(CONSULT_STATS_KEY, JSON.stringify([{ done_on: isoToday(), topic: r.topic, outcome, channel: r.contactType, reply_sent: Boolean(sent),
        wait_days: Math.max(0, Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000)) }, ...loadStats()]));
      await reload();
      return { sent: sent ? r.contactType : null };
    }
    const { data, error: e } = await supabase.rpc("consult_resolve", { p_id: id, p_outcome: outcome, p_reply: reply || "", p_send: Boolean(send) });
    if (e) throw new Error(e.message);
    await reload();
    return { sent: data?.sent || null };
  };
  const setFormOpen = async (on) => {
    if (!supabase) { if (on) localStorage.removeItem(DEMO_OPEN_KEY); else localStorage.setItem(DEMO_OPEN_KEY, "1"); }
    else { const { error: e } = await supabase.rpc("consult_set_open", { p_on: Boolean(on) }); if (e) throw new Error(e.message); }
    await reload();
  };
  const saveNotifyEmail = async (email) => {
    const v = String(email || "").trim();
    if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error("E-mail nie je platný.");
    if (supabase) { const { error: e } = await supabase.from("settings").upsert([{ key: "consult_notify_email", value: v }], { onConflict: "key" }); if (e) throw new Error(e.message); }
    setNotifyEmail(v);
  };

  // návrh zaradenia sa počíta z odpovedí pri každom zobrazení (pravidlá: src/triaz.js)
  const withTriage = list.map((r) => ({ ...r, triage: classify(r) }));
  return { isSupabase: isSupabaseConfigured, list: withTriage, stats, needsUpgrade, loading, error, open, notifyEmail, reload, resolve, setFormOpen, saveNotifyEmail };
}
