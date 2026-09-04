import { useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import { loadJson, toISODate, USG_ORDERS_KEY } from "./booking.jsx";
import { CT_ORDERS_KEY, ANGIO_ORDERS_KEY } from "./podappkyData.js";

// ============================================================
// Čakáreň — QR check-in pacienta („Som tu"), routa #/som-tu.
// Pacient naskenuje QR kód na stojane pred ambulanciou, zadá
// telefónne číslo a potvrdí príchod. Personál uvidí pri
// objednávke zelené „V ČAKÁRNI od HH:MM".
//
// Bezpečnosť (audit vlna 6): server na základe telefónu vracia LEN
// čas termínu a stav príchodu — žiadne číslo objednávky, typ
// vyšetrenia ani lekára (zdravotný údaj). Potvrdenie príchodu ide
// tiež len podľa telefónu (označí všetky dnešné objednávky).
// ============================================================

const phone9 = (s) => (s || "").replace(/\D/g, "").slice(-9);

const fmtTime = (iso) => {
  try { return new Date(iso).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
};

// --- demo režim (localStorage) — zrkadlí RPC checkin_lookup/checkin_confirm ---

const demoLookup = (phone) => {
  const p9 = phone9(phone);
  const today = toISODate(new Date());
  const active = (o) => o.status === "new" || o.status === "confirmed";
  const usg = loadJson(USG_ORDERS_KEY, [])
    .filter((o) => o.date === today && active(o) && phone9(o.patient?.phone) === p9)
    .map((o) => ({ time: o.time, arrivedAt: o.arrivedAt || "" }));
  const ct = loadJson(CT_ORDERS_KEY, [])
    .filter((o) => o.date === today && active(o) && phone9(o.phone) === p9)
    .map((o) => ({ time: o.time, arrivedAt: o.arrivedAt || "" }));
  const angio = loadJson(ANGIO_ORDERS_KEY, [])
    .filter((o) => o.date === today && active(o) && phone9(o.phone) === p9)
    .map((o) => ({ time: o.time, arrivedAt: o.arrivedAt || "" }));
  return [...usg, ...ct, ...angio].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
};

const demoConfirm = (phone) => {
  const p9 = phone9(phone);
  const today = toISODate(new Date());
  let hit = false;
  const stamp = (list, phoneOf) => list.map((o) => {
    if (o.date === today && (o.status === "new" || o.status === "confirmed") && phone9(phoneOf(o)) === p9) {
      hit = true;
      return { ...o, arrivedAt: o.arrivedAt || new Date().toISOString() };
    }
    return o;
  });
  const usg = stamp(loadJson(USG_ORDERS_KEY, []), (o) => o.patient?.phone);
  const ct = stamp(loadJson(CT_ORDERS_KEY, []), (o) => o.phone);
  const angio = stamp(loadJson(ANGIO_ORDERS_KEY, []), (o) => o.phone);
  if (hit) {
    localStorage.setItem(USG_ORDERS_KEY, JSON.stringify(usg));
    localStorage.setItem(CT_ORDERS_KEY, JSON.stringify(ct));
    localStorage.setItem(ANGIO_ORDERS_KEY, JSON.stringify(angio));
  }
  return hit;
};

// --- Supabase režim ---

const rpcLookup = async (phone) => {
  const { data, error } = await supabase.rpc("checkin_lookup", { p_phone: phone });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((r) => ({
    time: (r.slot_time || "").slice(0, 5), arrivedAt: r.arrived_at || "",
  }));
};

const rpcConfirm = async (phone) => {
  const { data, error } = await supabase.rpc("checkin_confirm", { p_phone: phone });
  if (error) throw error;
  return Boolean(data);
};

// verejný tok nezobrazuje surové DB chyby — len rate-limit a všeobecnú hlášku
const friendly = (e) => {
  const m = (e && e.message) || "";
  if (/priveľa|rate|too many/i.test(m)) return "Priveľa pokusov. Skúste to, prosím, o chvíľu.";
  if (/telefón|telefon/i.test(m)) return m;
  return "Momentálne sa nepodarilo spojiť so systémom. Skúste to, prosím, znova o chvíľu.";
};

const CheckinView = () => {
  const [phone, setPhone] = useState("");
  const [list, setList] = useState(null); // null = ešte nehľadal
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmedAt, setConfirmedAt] = useState(null);

  const search = async () => {
    setError("");
    setConfirmedAt(null);
    if (phone9(phone).length < 9) { setError("Zadajte celé telefónne číslo (napr. 0900 123 456)."); return; }
    setBusy(true);
    try {
      const found = isSupabaseConfigured ? await rpcLookup(phone) : demoLookup(phone);
      setList(found);
    } catch (e) {
      setError(friendly(e));
      setList(null);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError("");
    setBusy(true);
    try {
      const ok = isSupabaseConfigured ? await rpcConfirm(phone) : demoConfirm(phone);
      if (!ok) throw new Error("Príchod sa nepodarilo zaznamenať. Obráťte sa, prosím, na personál.");
      const now = new Date().toISOString();
      setList((prev) => (prev || []).map((o) => ({ ...o, arrivedAt: o.arrivedAt || now })));
      setConfirmedAt(now);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  const anyPending = Array.isArray(list) && list.some((o) => !o.arrivedAt);

  return (
    <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-8 space-y-5">
      {/* Banner v štýle hero z objednávacej stránky — modré vlny, text zľava */}
      <div className="relative overflow-hidden rounded-[12px] min-h-[170px] md:min-h-[210px] flex flex-col justify-center">
        <img
          src="hero-cakaren.jpg" alt="" aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover object-right"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#1E3580] via-[#2B46A2]/85 to-transparent" />
        <div className="relative p-5 md:p-7">
          <div className="flex items-center gap-4">
            <div className="shrink-0 bg-white rounded-[12px] p-2 shadow-sm">
              <img src="logo-nusch.png" alt="Logo NÚSCH" className="w-10 h-10 md:w-12 md:h-12 block" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] md:text-xs font-bold tracking-widest text-white/70 uppercase mb-1">
                Národný ústav srdcových a cievnych chorôb, a.s.
              </p>
              <h1 className="text-2xl md:text-3xl font-extrabold text-white leading-tight drop-shadow-sm">Som v čakárni</h1>
            </div>
          </div>
          <p className="text-sm text-white/90 mt-3 max-w-md">
            Dajte nám vedieť, že ste prišli — zadajte telefónne číslo, ktoré ste uviedli pri objednaní, a potvrďte príchod.
          </p>
        </div>
      </div>

      {confirmedAt && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-[10px] p-4 text-center space-y-1">
          <p className="text-3xl" aria-hidden="true">✅</p>
          <p className="font-bold text-emerald-800">Ďakujeme, personál vie, že ste tu.</p>
          <p className="text-sm text-emerald-700">Posaďte sa, prosím — budeme vás volať podľa poradia.</p>
          <p className="text-sm text-emerald-800 pt-1">Kým na vás príde rad, môžete si prečítať:</p>
          <a
            href="https://cievny.tasklogy.sk/pacienti"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex flex-col items-center gap-1.5 bg-white border border-emerald-300 rounded-[10px] px-6 py-3 hover:bg-emerald-50 transition-colors shadow-sm"
          >
            <img src="logo-cievny.png" alt="cievny.sk" className="h-9" />
            <span className="text-xs font-semibold text-[#2B46A2]">informácie pre pacientov →</span>
          </a>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-[10px] p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="space-y-2">
        <label className="block text-sm font-semibold text-[#444444]">Telefónne číslo</label>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          placeholder="+421 900 000 000"
          className="w-full border border-[#E0E4EF] rounded-[10px] px-4 py-3 text-lg focus:outline-none focus:border-[#2B46A2]"
        />
        <button
          onClick={search}
          disabled={busy}
          className="w-full bg-[#2B46A2] hover:bg-[#223A8C] disabled:opacity-50 text-white font-bold py-3 rounded-[10px] transition-colors"
        >
          {busy && list === null ? "Hľadám…" : "Vyhľadať moju objednávku"}
        </button>
      </div>

      {list !== null && list.length === 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-[10px] p-4 text-sm text-amber-800">
          Na dnes sme pre toto číslo nenašli žiadnu objednávku. Skontrolujte, či ste zadali telefón
          z objednávky. Ak si myslíte, že ide o chybu, obráťte sa, prosím, na personál ambulancie.
        </div>
      )}

      {list !== null && list.length > 0 && !confirmedAt && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-[#444444]">
            {list.length === 1 ? "Našli sme vašu dnešnú objednávku:" : "Našli sme vaše dnešné objednávky:"}
          </p>
          <div className="space-y-2">
            {list.map((o, i) => (
              <div key={i} className="bg-[#F8F9FC] border border-[#E0E4EF] rounded-[10px] px-4 py-3 flex items-center justify-between gap-2">
                <span className="text-sm text-slate-600">Dnes o <strong className="text-[#2B46A2]">{o.time}</strong></span>
                {o.arrivedAt && <span className="text-sm font-bold text-emerald-700">✓ prihlásený o {fmtTime(o.arrivedAt)}</span>}
              </div>
            ))}
          </div>
          {anyPending && (
            <button
              onClick={confirm}
              disabled={busy}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold py-3 rounded-[10px] transition-colors"
            >
              ✓ Som tu — potvrdiť príchod
            </button>
          )}
        </div>
      )}

      <p className="text-xs text-slate-400 text-center">
        Číslo použijeme len na vyhľadanie vašej dnešnej objednávky. Ak sa vám check-in nedarí,
        pokojne sa posaďte — personál vás zavolá podľa poradia.
      </p>
    </div>
  );
};

export default CheckinView;
