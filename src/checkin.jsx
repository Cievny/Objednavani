import { useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import { loadJson, toISODate, USG_ORDERS_KEY } from "./booking.jsx";
import { CT_ORDERS_KEY } from "./podappkyData.js";

// ============================================================
// Čakáreň — QR check-in pacienta („Som tu"), routa #/som-tu.
// Pacient naskenuje QR kód na stojane pred ambulanciou, zadá
// telefónne číslo a potvrdí príchod. Personál uvidí pri
// objednávke zelené „V ČAKÁRNI od HH:MM".
// Párovanie podľa telefónu (posledných 9 číslic) — rovnaký
// mechanizmus ako overenie objednávky, server má rate-limit.
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
    .map((o) => ({ kind: "usg", id: o.id, examLabel: o.exam?.label || "USG vyšetrenie", time: o.time, doctor: o.doctor || "", arrivedAt: o.arrivedAt || "" }));
  const ct = loadJson(CT_ORDERS_KEY, [])
    .filter((o) => o.date === today && active(o) && phone9(o.phone) === p9)
    .map((o) => ({ kind: "ct", id: o.id, examLabel: o.exam?.label || "CT vyšetrenie", time: o.time, doctor: o.doctor || "", arrivedAt: o.arrivedAt || "" }));
  return [...usg, ...ct].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
};

const demoConfirm = (id, phone) => {
  const p9 = phone9(phone);
  const today = toISODate(new Date());
  const key = id.startsWith("CT-") ? CT_ORDERS_KEY : USG_ORDERS_KEY;
  let hit = false;
  const list = loadJson(key, []).map((o) => {
    const oPhone = key === CT_ORDERS_KEY ? o.phone : o.patient?.phone;
    if (o.id === id && o.date === today && (o.status === "new" || o.status === "confirmed") && phone9(oPhone) === p9) {
      hit = true;
      return { ...o, arrivedAt: o.arrivedAt || new Date().toISOString() };
    }
    return o;
  });
  if (hit) localStorage.setItem(key, JSON.stringify(list));
  return hit;
};

// --- Supabase režim ---

const rpcLookup = async (phone) => {
  const { data, error } = await supabase.rpc("checkin_lookup", { p_phone: phone });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []).map((r) => ({
    kind: r.kind, id: r.id, examLabel: r.exam_label || "", time: (r.slot_time || "").slice(0, 5),
    doctor: r.doctor || "", arrivedAt: r.arrived_at || "",
  }));
};

const rpcConfirm = async (id, phone) => {
  const { data, error } = await supabase.rpc("checkin_confirm", { p_id: id, p_phone: phone });
  if (error) throw new Error(error.message);
  return Boolean(data);
};

const CheckinView = () => {
  const [phone, setPhone] = useState("");
  const [list, setList] = useState(null); // null = ešte nehľadal
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [justConfirmed, setJustConfirmed] = useState(null);

  const search = async () => {
    setError("");
    setJustConfirmed(null);
    if (phone9(phone).length < 9) { setError("Zadajte celé telefónne číslo (napr. 0900 123 456)."); return; }
    setBusy(true);
    try {
      const found = isSupabaseConfigured ? await rpcLookup(phone) : demoLookup(phone);
      setList(found);
    } catch (e) {
      setError(e.message || String(e));
      setList(null);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (item) => {
    setError("");
    setBusy(true);
    try {
      const ok = isSupabaseConfigured ? await rpcConfirm(item.id, phone) : demoConfirm(item.id, phone);
      if (!ok) throw new Error("Príchod sa nepodarilo zaznamenať. Obráťte sa, prosím, na personál.");
      const now = new Date().toISOString();
      setList((prev) => prev.map((o) => (o.id === item.id ? { ...o, arrivedAt: o.arrivedAt || now } : o)));
      setJustConfirmed(item);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

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

      {justConfirmed && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-[10px] p-4 text-center space-y-1">
          <p className="text-3xl" aria-hidden="true">✅</p>
          <p className="font-bold text-emerald-800">Ďakujeme, personál vie, že ste tu.</p>
          <p className="text-sm text-emerald-700">
            {justConfirmed.examLabel} o {justConfirmed.time} — posaďte sa, prosím, budeme vás volať.
          </p>
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

      {list !== null && list.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-[#444444]">Vaše dnešné objednávky:</p>
          {list.map((o) => (
            <div key={o.id} className="bg-[#F8F9FC] border border-[#E0E4EF] rounded-[10px] p-4 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="font-bold text-[#2B46A2]">{o.examLabel}</p>
                <span className="bg-[#F0F4FF] text-[#2B46A2] text-xs font-bold px-2 py-1 rounded">{o.kind === "ct" ? "CT" : "USG"}</span>
              </div>
              <p className="text-sm text-slate-600">
                Dnes o <strong>{o.time}</strong>{o.doctor && <> · {o.doctor}</>}
              </p>
              {o.arrivedAt ? (
                <p className="text-sm font-bold text-emerald-700">✓ Príchod zaznamenaný o {fmtTime(o.arrivedAt)}</p>
              ) : (
                <button
                  onClick={() => confirm(o)}
                  disabled={busy}
                  className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold py-3 rounded-[10px] transition-colors"
                >
                  ✓ Som tu — potvrdiť príchod
                </button>
              )}
            </div>
          ))}
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
