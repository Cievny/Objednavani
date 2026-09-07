import { useState, useMemo, useEffect } from "react";
import {
  MonthCalendar, toISODate, earliestTimeFor, computeOfferedSlots,
  normalizeDoctors, doctorDoesExam, addMinutes, BASE_SLOT_MIN,
  insuranceOptions, normalizePhone, ArrivedBadge,
} from "./booking.jsx";
import { useAngioData } from "./podappkyData.js";

// ============================================================
// Angiologická ambulancia č. 1 — objednávanie bez poplatku
// (routa #/angio1). Zrkadlo CT vetvy, ale s verejnou pacientskou
// vrstvou (AngioPatientApp — bez prihlásenia) a správou za
// prihlásením (AngioAdminApp). Dátová vrstva: useAngioData.
// ============================================================

export const CLINIC_NAME = "Angiologická ambulancia č. 1";

const newAngioId = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b = new Uint8Array(10); (window.crypto || window.msCrypto).getRandomValues(b);
  let s = ""; for (let i = 0; i < b.length; i++) s += abc[b[i] % 32];
  return "ANG-" + s;
};
const inp = "w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 text-sm focus:ring-2 focus:ring-[#2B46A2] outline-none";
const statuses = { new: "Nová", confirmed: "Potvrdená", done: "Vykonané", noshow: "Nedostavil sa", rejected: "Zrušená" };

// všetky platné začiatky pre daný deň (súvislé voľné bunky jedného lekára) — pre presun personálom
function freeStartsFor(openSlots, takenSet, iso, durationMin, doctors, examTypeId) {
  const open = (openSlots[iso] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
  const byTime = new Map(open.map((s) => [s.time, s]));
  const need = Math.max(1, Math.round(durationMin / BASE_SLOT_MIN));
  return open.filter((slot) => {
    if (examTypeId && !doctorDoesExam(doctors, slot.doctor, examTypeId)) return false;
    for (let i = 0; i < need; i++) {
      const c = byTime.get(addMinutes(slot.time, i * BASE_SLOT_MIN));
      if (!c || c.doctor !== slot.doctor || takenSet.has(c.time)) return false;
    }
    return true;
  });
}

// Jednoduché formátovanie textu (rovnaké pravidlá ako e-mail, angio-006):
// riadok končiaci „:" = nadpis, „- " = odrážka, prázdny riadok = odsek
function FormattedText({ text }) {
  const lines = String(text || "").split(/\r?\n/);
  const out = []; let list = [];
  const flush = () => { if (list.length) { out.push(<ul key={`ul${out.length}`} className="list-disc pl-5 space-y-0.5">{list.map((l, i) => <li key={i}>{l}</li>)}</ul>); list = []; } };
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t) { flush(); out.push(<div key={`sp${i}`} className="h-2" />); return; }
    if (/^[-*•]\s+/.test(t)) { list.push(t.replace(/^[-*•]\s+/, "")); return; }
    flush();
    if (/^#\s+/.test(t) || (/:$/.test(t) && t.length <= 60)) out.push(<p key={i} className="font-semibold mt-1">{t.replace(/^#\s+/, "")}</p>);
    else out.push(<p key={i}>{t}</p>);
  });
  flush();
  return <div className="space-y-0.5">{out}</div>;
}

// ---------- Pacientske objednávanie (verejné) ----------
function AngioBookingView({ data }) {
  const [step, setStep] = useState(1);
  const [examTypeId, setExamTypeId] = useState("");
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [form, setForm] = useState({ name: "", birthDate: "", insurance: "25", phone: "", email: "", reason: "" });
  const [files, setFiles] = useState([]);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [errs, setErrs] = useState({});
  const clearErr = (k) => setErrs((x) => { if (!x[k]) return x; const n = { ...x }; delete n[k]; return n; });
  // overenie telefónu SMS kódom (ak je zapnuté v Nastaveniach)
  const [otp, setOtp] = useState({ stage: "idle", phone: "", code: "", token: "", msg: "", busy: false, demoCode: "" });
  const [aboutOpen, setAboutOpen] = useState(""); // rozbalený popis typu vyšetrenia („Viac o vyšetrení")
  const phoneDigits = (p) => (p || "").replace(/\D/g, "");
  const phoneVerified = otp.stage === "verified" && phoneDigits(otp.phone) === phoneDigits(form.phone);
  const sendOtp = async () => {
    if (phoneDigits(form.phone).length < 9) { setErrs((x) => ({ ...x, phone: "Neplatné telefónne číslo (aspoň 9 číslic)." })); return; }
    setOtp((o) => ({ ...o, busy: true, msg: "" }));
    try {
      const r = await data.sendOtp(normalizePhone(form.phone));
      setOtp({ stage: "sent", phone: form.phone, code: "", token: "", msg: "", busy: false, demoCode: r?.demoCode || "" });
      clearErr("phone");
    } catch (e) { setOtp((o) => ({ ...o, busy: false, msg: e?.message || String(e) })); }
  };
  const verifyOtp = async () => {
    setOtp((o) => ({ ...o, busy: true, msg: "" }));
    try {
      const r = await data.verifyOtp(normalizePhone(otp.phone), otp.code);
      if (r?.ok) { setOtp((o) => ({ ...o, stage: "verified", token: r.token, msg: "", busy: false })); clearErr("phone"); }
      else setOtp((o) => ({ ...o, msg: r?.error || "Nesprávny kód.", busy: false }));
    } catch (e) { setOtp((o) => ({ ...o, busy: false, msg: e?.message || String(e) })); }
  };

  const handleFilePick = (e) => {
    setMsg("");
    const picked = Array.from(e.target.files || []);
    const ok = [];
    for (const f of picked) {
      if (!/\.(pdf|jpe?g|png)$/i.test(f.name)) { setMsg(`Súbor ${f.name}: povolené sú len PDF, JPG a PNG.`); continue; }
      if (f.size > 5 * 1024 * 1024) { setMsg(`Súbor ${f.name} je väčší ako 5 MB.`); continue; }
      ok.push(f);
    }
    setFiles((prev) => [...prev, ...ok].slice(0, 3));
    clearErr("files");
    e.target.value = "";
  };

  const examType = data.pricelist.find((p) => p.id === examTypeId) || null;
  const durationMin = (examType?.durationSlots || 3) * 5;
  // žiadanka povinná podľa typu (neznámy typ = povinná; rovnaká logika ako trigger angio_require_attachment)
  const needsReferral = examType ? examType.requiresReferral !== false : true;

  const takenByDate = useMemo(() => {
    const m = new Map();
    data.occupied.forEach(({ date: d, time: t }) => { if (!m.has(d)) m.set(d, new Set()); m.get(d).add(t); });
    return m;
  }, [data.occupied]);

  const freeSlotsFor = (iso) => computeOfferedSlots({
    openSlots: data.openSlots, takenSet: takenByDate.get(iso) || new Set(),
    doctors: data.doctors, examTypeId, durationMin, iso, minTime: earliestTimeFor(iso, ""),
  });
  const todayIso = toISODate(new Date());
  const isAvailable = (iso) => iso >= todayIso && freeSlotsFor(iso).length > 0;

  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); clearErr(k); };

  const submit = async () => {
    const e = {};
    if (form.name.trim().length < 3) e.name = "Zadajte meno a priezvisko.";
    if (!form.birthDate) e.birthDate = "Zadajte dátum narodenia.";
    if (form.phone.replace(/\D/g, "").length < 9) e.phone = "Neplatné telefónne číslo (aspoň 9 číslic).";
    if (!form.email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) e.email = "Zadajte platný e-mail.";
    if (needsReferral && files.length === 0) e.files = "Priložte žiadanku (výmenný lístok) — môžete ju odfotiť.";
    if (data.smsVerify && !e.phone && !phoneVerified) e.phone = "Overte telefónne číslo SMS kódom.";
    setErrs(e);
    if (Object.keys(e).length > 0) { setMsg("Skontrolujte a doplňte zvýraznené polia."); return; }
    setBusy(true); setMsg("");
    try {
      const id = newAngioId();
      await data.createOrder({ id, examTypeId, patientName: form.name.trim(), birthDate: form.birthDate || null,
        insurance: form.insurance, phone: normalizePhone(form.phone), email: form.email.trim(), reason: form.reason.trim(), date, time,
        verifyToken: phoneVerified ? otp.token : "" }, files);
      setDone({ id, date, time, label: examType?.label, needsReferral });
      setFiles([]);
    } catch (err) { setMsg(err?.message || String(err)); } finally { setBusy(false); }
  };
  const ic = (k) => inp + (errs[k] ? " border-red-400 ring-1 ring-red-300" : "");
  const Err = ({ k }) => errs[k] ? <p className="text-xs text-red-600 mt-1">{errs[k]}</p> : null;

  if (done) {
    return (
      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-6 text-center">
        <h2 className="text-xl font-bold text-[#16A34A] mb-2">Objednávka je prijatá</h2>
        <p className="text-slate-700">{done.label}</p>
        <p className="text-slate-700">Termín: <b>{done.date} o {done.time}</b></p>
        <p className="text-slate-700 mb-1">Číslo objednávky: <b className="font-mono">{done.id}</b></p>
        <p className="text-sm text-slate-500 mt-3">Vyšetrenie je bez poplatku. Potvrdenie sme poslali e-mailom. Príďte, prosím, 10 minút pred termínom{done.needsReferral ? " so žiadankou" : ""}.</p>
        <p className="text-xs text-slate-500 mt-2">Zmenu alebo zrušenie termínu vybavíte online cez odkaz v e-maili alebo v sekcii „Už máte objednávku?" (najneskôr 24 hodín vopred). Telefón/SMS len v naozaj nutných prípadoch – ozveme sa vám späť.</p>
        <div className="flex flex-wrap justify-center gap-2 mt-5">
          <button type="button" onClick={() => { setDone(null); setStep(1); setExamTypeId(""); setDate(""); setTime(""); setForm({ name: "", birthDate: "", insurance: "25", phone: "", email: "", reason: "" }); setOtp({ stage: "idle", phone: "", code: "", token: "", msg: "", busy: false, demoCode: "" }); }}
            className="bg-[#2B46A2] hover:bg-[#1E3580] text-white text-sm font-semibold px-4 py-2 rounded-[10px]">Nová objednávka</button>
          <a href="#/" className="bg-[#F0F2F5] hover:bg-[#E0E4EF] text-[#444] text-sm font-semibold px-4 py-2 rounded-[10px]">← Späť na hlavnú stránku</a>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6 space-y-5">
      <h2 className="text-xl font-bold text-[#2B46A2]">Objednanie na vyšetrenie <span className="text-sm font-normal text-slate-500">(bez poplatku)</span></h2>
      {step === 1 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-slate-700">Vyberte typ vyšetrenia / návštevy</p>
          {data.pricelist.length === 0 && <p className="text-sm text-slate-400">Zatiaľ nie sú nastavené žiadne typy vyšetrení.</p>}
          {data.pricelist.map((p) => (
            <div key={p.id} className={`border-2 rounded-[10px] transition-colors ${examTypeId === p.id ? "border-[#2B46A2] bg-[#F0F4FF]" : "border-slate-200 hover:border-[#8fb8dd]"}`}>
              <button onClick={() => { setExamTypeId(p.id); setStep(2); setDate(""); setTime(""); }} className="w-full text-left p-3">
                <span className="font-bold text-slate-800">{p.label}</span>
                <span className="block text-xs text-slate-500 mt-1">Trvanie ~{p.durationSlots * 5} min{p.description ? ` · ${p.description}` : ""}{p.requiresReferral === false ? " · bez žiadanky" : ""}</span>
              </button>
              {p.about && (
                <div className="px-3 pb-2">
                  <button type="button" onClick={() => setAboutOpen((o) => (o === p.id ? "" : p.id))} className="text-xs font-semibold text-[#2B46A2] hover:underline">
                    {aboutOpen === p.id ? "▴ Skryť podrobnosti" : "▾ Viac o vyšetrení"}
                  </button>
                  {aboutOpen === p.id && <div data-testid="exam-about" className="mt-2 text-sm text-slate-700"><FormattedText text={p.about} /></div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <button onClick={() => setStep(1)} className="text-sm text-[#2B46A2] hover:underline">← Zmeniť vyšetrenie</button>
          <p className="text-sm text-slate-600">Vybrané: <b>{examType?.label}</b></p>
          <div className="grid md:grid-cols-2 gap-5">
            <MonthCalendar monthDate={monthDate}
              onMonthChange={(delta) => setMonthDate((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
              isAvailable={isAvailable} selected={date} onSelect={(iso) => { setDate(iso); setTime(""); }} />
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-2">{date ? `Voľné časy — ${date}` : "Vyberte deň"}</p>
              <div className="flex flex-wrap gap-2">
                {date && freeSlotsFor(date).map((s) => (
                  <button key={s.time} onClick={() => setTime(s.time)}
                    className={`px-3 py-2 rounded-[10px] text-sm font-semibold border transition-colors ${time === s.time ? "bg-[#2B46A2] text-white border-[#2B46A2]" : "bg-white text-[#2B46A2] border-slate-300 hover:border-[#2B46A2]"}`}>
                    {s.time}{s.doctor ? <span className="block text-[10px] font-normal opacity-70">{s.doctor}</span> : null}
                  </button>
                ))}
                {date && freeSlotsFor(date).length === 0 && <p className="text-sm text-slate-400">V tento deň nie sú voľné termíny.</p>}
              </div>
            </div>
          </div>
          {time && <button onClick={() => setStep(3)} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white font-bold py-3 px-5 rounded-[10px]">Pokračovať</button>}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <button onClick={() => setStep(2)} className="text-sm text-[#2B46A2] hover:underline">← Späť na termín</button>
          <p className="text-sm text-slate-600"><b>{examType?.label}</b> · {date} o {time}</p>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Meno a priezvisko *</label>
              <input className={ic("name")} placeholder="Ján Novák" value={form.name} onChange={set("name")} />
              <Err k="name" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Dátum narodenia *</label>
              <input className={ic("birthDate")} type="date" value={form.birthDate} onChange={set("birthDate")} />
              <Err k="birthDate" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Zdravotná poisťovňa</label>
              <select className={inp} value={form.insurance} onChange={set("insurance")}>
                {insuranceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Telefón *</label>
              <input className={ic("phone")} placeholder="+421 900 000 000" value={form.phone} onChange={set("phone")} />
              <Err k="phone" />
              {data.smsVerify && (
                <div data-testid="otp-box" className="mt-2 text-sm">
                  {phoneVerified ? (
                    <p className="text-[#16A34A] font-semibold">✓ Číslo overené</p>
                  ) : otp.stage === "sent" && phoneDigits(otp.phone) === phoneDigits(form.phone) ? (
                    <div className="space-y-2">
                      <p className="text-slate-600">Kód sme poslali SMS na <b>{otp.phone}</b>. Platí 10 minút.{otp.demoCode ? ` (demo: kód ${otp.demoCode})` : ""}</p>
                      <div className="flex gap-2">
                        <input className={inp} inputMode="numeric" maxLength={6} placeholder="6-miestny kód" value={otp.code}
                          onChange={(ev) => setOtp((o) => ({ ...o, code: ev.target.value.replace(/\D/g, "").slice(0, 6), msg: "" }))} />
                        <button type="button" onClick={verifyOtp} disabled={otp.busy || otp.code.length !== 6}
                          className="bg-[#2B46A2] disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-[10px] shrink-0">Overiť kód</button>
                      </div>
                      <button type="button" onClick={sendOtp} disabled={otp.busy} className="text-xs text-[#2B46A2] hover:underline">Poslať kód znova</button>
                    </div>
                  ) : (
                    <button type="button" onClick={sendOtp} disabled={otp.busy}
                      className="bg-[#F0F4FF] hover:bg-[#E0E4EF] disabled:opacity-50 text-[#2B46A2] text-sm font-semibold px-4 py-2 rounded-[10px]">
                      {otp.busy ? "Posielam…" : "Poslať overovací SMS kód"}
                    </button>
                  )}
                  {otp.msg && <p className="text-xs text-red-600 mt-1">{otp.msg}</p>}
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">E-mail (na potvrdenie) *</label>
              <input className={ic("email")} type="email" placeholder="jan.novak@…" value={form.email} onChange={set("email")} />
              <Err k="email" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Dôvod / poznámka</label>
              <input className={inp} placeholder="nepovinné" value={form.reason} onChange={set("reason")} />
            </div>
          </div>
          {/* Nahrávanie žiadanky — povinné podľa typu vyšetrenia */}
          <div className={errs.files ? "border border-red-300 bg-red-50 rounded-[10px] p-3" : needsReferral ? "border border-amber-300 bg-amber-50 rounded-[10px] p-3" : "border border-slate-200 bg-[#F8F9FC] rounded-[10px] p-3"}>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              {needsReferral ? "Žiadanka (výmenný lístok) — odfoťte alebo nahrajte *" : "Žiadanka alebo lekárske správy — nepovinné"}{" "}
              <span className="font-normal text-slate-400">(PDF, JPG, PNG — max 3 súbory po 5 MB)</span>
            </label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png" multiple onChange={handleFilePick}
              className="block w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-[10px] file:border-0 file:bg-[#F0F4FF] file:text-[#2B46A2] file:font-semibold hover:file:bg-[#E0E4EF]" />
            <Err k="files" />
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between text-sm bg-[#F8F9FC] border border-slate-200 rounded-[8px] px-3 py-1.5">
                    <span className="truncate">{f.name}</span>
                    <button onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="text-red-600 text-xs font-semibold shrink-0 ml-2">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {msg && <p className="text-sm text-red-600 font-semibold">{msg}</p>}
          <button onClick={submit} disabled={busy} className="bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white font-bold py-3 px-5 rounded-[10px]">
            {busy ? "Odosielam…" : "Objednať sa (bez poplatku)"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Overenie / zrušenie objednávky pacientom ----------
function AngioOrderLookup({ data, initialId = "" }) {
  const [id, setId] = useState(initialId || "");
  // deep-link z e-mailu (#/angio1/objednavka/ANG-…): predvyplniť číslo a prísť na sekciu
  useEffect(() => {
    if (!initialId) return;
    setId(initialId);
    const el = document.getElementById("angio-lookup");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [initialId]);
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true); setMsg(""); setFound(null);
    try {
      const o = await data.lookupOrder(id.trim(), phone.trim());
      if (!o) setMsg("Objednávku sme nenašli. Skontrolujte číslo a telefón.");
      else setFound(o);
    } catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!window.confirm("Naozaj zrušiť objednávku?")) return;
    setBusy(true); setMsg("");
    try { await data.cancelOrder(found.id, phone.trim()); setFound({ ...found, status: "rejected" }); }
    catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); }
  };

  // zmena termínu pacientom — výber z otvorených termínov (rovnaké pravidlá ako pri objednaní)
  const [resched, setResched] = useState(false);
  const [rMonth, setRMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [rDate, setRDate] = useState("");
  const [ok, setOk] = useState("");
  const takenByDate = useMemo(() => {
    const m = new Map();
    data.occupied.forEach(({ date: d, time: t }) => { if (!m.has(d)) m.set(d, new Set()); m.get(d).add(t); });
    return m;
  }, [data.occupied]);
  const todayIso = toISODate(new Date());
  const rStarts = (iso) => {
    if (!found) return [];
    const dur = found.durationMin || 15;
    const [h, mi] = (found.time || "00:00").split(":").map(Number);
    const own = new Set(Array.from({ length: Math.max(1, Math.round(dur / 5)) }, (_, i) => addMinutes(`${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`, i * 5)));
    const taken = new Set([...(takenByDate.get(iso) || new Set())].filter((t) => !(iso === found.date && own.has(t))));
    return freeStartsFor(data.openSlots, taken, iso, dur, data.doctors, found.exam?.typeId)
      .filter((s) => !(iso === found.date && s.time === found.time))
      .filter((s) => iso > todayIso || s.time >= earliestTimeFor(iso, ""));
  };
  const rAvailable = (iso) => iso >= todayIso && rStarts(iso).length > 0;
  const pick = async (iso, t) => {
    if (!window.confirm(`Zmeniť termín na ${iso} o ${t}?`)) return;
    setBusy(true); setMsg(""); setOk("");
    try {
      await data.patientReschedule(found.id, phone.trim(), iso, t);
      setFound({ ...found, date: iso, time: t, status: "new" });
      setResched(false); setRDate("");
      setOk(`Termín je zmenený na ${iso} o ${t}. Potvrdenie pošleme e-mailom${data.smsVerify ? " a SMS" : ""}.`);
    } catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); }
  };

  return (
    <div id="angio-lookup" className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6 space-y-3">
      <h3 className="text-lg font-bold text-[#2B46A2]">Už máte objednávku?</h3>
      <p className="text-sm text-slate-500">Zadajte číslo objednávky (ANG-…) a telefón, ktorý ste uviedli. Termín tu môžete zmeniť alebo zrušiť (najneskôr 24 hodín vopred).</p>
      <div className="grid md:grid-cols-2 gap-3">
        <input className={inp} placeholder="Číslo objednávky (ANG-…)" value={id} onChange={(e) => setId(e.target.value)} />
        <input className={inp} placeholder="Telefón zadaný pri objednávke" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <button onClick={search} disabled={busy} className="bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white font-bold py-2.5 px-5 rounded-[10px]">
        {busy ? "Hľadám…" : "Vyhľadať"}
      </button>
      {msg && <p className="text-sm text-red-600 font-semibold">{msg}</p>}
      {found && (
        <div className="border border-slate-200 rounded-[10px] p-4 space-y-1">
          <p className="text-sm"><b>{found.id}</b> — <span className="font-semibold">{statuses[found.status] || found.status}</span></p>
          {found.exam?.label && <p className="text-sm text-slate-600">{found.exam.label}</p>}
          <p className="text-sm text-slate-600">Termín: <b>{found.date} o {found.time}</b>{found.doctor ? ` · ${found.doctor}` : ""}</p>
          {ok && <p className="text-sm text-[#16A34A] font-semibold">{ok}</p>}
          {(found.status === "new" || found.status === "confirmed") && (
            <div className="flex flex-wrap gap-2 mt-2">
              <button onClick={() => { setResched(!resched); setOk(""); setMsg(""); }} disabled={busy} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white text-sm font-semibold px-4 py-2 rounded-[10px]">
                {resched ? "Zavrieť zmenu termínu" : "Zmeniť termín"}
              </button>
              <button onClick={cancel} disabled={busy} className="bg-white border border-red-300 text-red-600 text-sm font-semibold px-4 py-2 rounded-[10px] hover:bg-red-50">
                Zrušiť objednávku
              </button>
            </div>
          )}
          {resched && (found.status === "new" || found.status === "confirmed") && (
            <div data-testid="patient-resched" className="mt-3 bg-[#F8F9FC] border border-slate-200 rounded-[10px] p-3 space-y-3">
              <p className="text-sm text-slate-600">Ak vám termín nevyhovuje, vyberte si iný z otvorených. Zmena je možná najneskôr 24 hodín pred termínom. Telefón/SMS 0949 000 677 len v naozaj nutných prípadoch – ozveme sa vám späť.</p>
              <div className="grid md:grid-cols-2 gap-4">
                <MonthCalendar monthDate={rMonth}
                  onMonthChange={(delta) => setRMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
                  isAvailable={rAvailable} selected={rDate} onSelect={(iso) => setRDate(iso)} />
                <div>
                  <p className="text-sm font-semibold text-slate-700 mb-2">{rDate ? `Voľné časy — ${rDate}` : "Vyberte deň"}</p>
                  <div className="flex flex-wrap gap-2">
                    {rDate && rStarts(rDate).map((s) => (
                      <button key={s.time} onClick={() => pick(rDate, s.time)} disabled={busy}
                        className="px-3 py-2 rounded-[10px] text-sm font-semibold border bg-white text-[#2B46A2] border-slate-300 hover:border-[#2B46A2]">
                        {s.time}{s.doctor ? <span className="block text-[10px] font-normal opacity-70">{s.doctor}</span> : null}
                      </button>
                    ))}
                    {rDate && rStarts(rDate).length === 0 && <p className="text-sm text-slate-400">V tento deň nie sú voľné termíny.</p>}
                  </div>
                </div>
              </div>
            </div>
          )}
          {found.status === "rejected" && <p className="text-sm text-[#856404]">Objednávka je zrušená.</p>}
        </div>
      )}
    </div>
  );
}

// ---------- Karta objednávky (správa) ----------
// Všetky údaje pacienta pre personál (na zaevidovanie do nemocničného systému) + kopírovanie
const fmtD = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join(".") : "—");
const fmtDT = (iso) => (iso ? `${fmtD(iso)} ${String(iso).slice(11, 16)}` : "—");
function PatientDetails({ order, onCopied }) {
  const ins = insuranceOptions.find((o) => o.id === order.insurance)?.label || order.insurance || "—";
  const rows = [
    ["Meno a priezvisko", order.patientName],
    ["Dátum narodenia", fmtD(order.birthDate)],
    ["Poisťovňa", ins],
    ["Telefón", order.phone || "—"],
    ["E-mail", order.email || "—"],
    ["Vyšetrenie", order.exam?.label || "—"],
    ["Termín", `${fmtD(order.date)} ${order.time}${order.durationMin ? ` (${order.durationMin} min)` : ""}`],
    ["Lekár", order.doctor || "—"],
    ["Dôvod / poznámka", order.reason || "—"],
    ["Číslo objednávky", order.id],
    ["Objednané", fmtDT(order.createdAt)],
  ];
  const copy = async () => {
    const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
    try { await navigator.clipboard.writeText(text); onCopied?.(true); } catch { onCopied?.(false); }
  };
  return (
    <div data-testid="patient-details" className="bg-white/70 border border-slate-200 rounded-[10px] p-3">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Dátum narodenia</dt><dd className="font-semibold">{fmtD(order.birthDate)}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Poisťovňa</dt><dd className="font-semibold">{ins}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Telefón</dt><dd className="font-semibold">{order.phone ? <a href={`tel:${order.phone.replace(/\s/g, "")}`} className="text-[#2B46A2] hover:underline">{order.phone}</a> : "—"}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">E-mail</dt><dd className="font-semibold break-all">{order.email ? <a href={`mailto:${order.email}`} className="text-[#2B46A2] hover:underline">{order.email}</a> : "—"}</dd></div>
        {order.doctor && <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Lekár</dt><dd>{order.doctor}</dd></div>}
        <div><dt className="text-[11px] uppercase tracking-wide text-slate-400">Objednané</dt><dd>{fmtDT(order.createdAt)}</dd></div>
        {order.reason && <div className="sm:col-span-2"><dt className="text-[11px] uppercase tracking-wide text-slate-400">Dôvod / poznámka</dt><dd className="whitespace-pre-wrap">{order.reason}</dd></div>}
      </dl>
      <button type="button" onClick={copy} className="mt-2 text-xs bg-[#F0F2F5] hover:bg-[#E0E4EF] text-[#444] font-semibold px-3 py-1.5 rounded">📋 Kopírovať údaje pacienta</button>
    </div>
  );
}

function AngioOrderCard({ order, data, canManage }) {
  const [resched, setResched] = useState(false);
  const [rdate, setRdate] = useState(order.date);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelText, setCancelText] = useState("");
  const [msg, setMsg] = useState("");
  const active = order.status === "new" || order.status === "confirmed";

  const takenByDate = useMemo(() => {
    const m = new Map();
    data.occupied.forEach(({ date: d, time: t }) => { if (!m.has(d)) m.set(d, new Set()); m.get(d).add(t); });
    return m;
  }, [data.occupied]);
  const ownCells = useMemo(() => {
    const [h, m] = order.time.split(":").map(Number); const n = Math.max(1, Math.round((order.durationMin || 15) / 5));
    return new Set(Array.from({ length: n }, (_, i) => { const t = h * 60 + m + i * 5; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; }));
  }, [order]);

  const starts = (iso) => {
    const taken = new Set([...(takenByDate.get(iso) || new Set())].filter((t) => !(iso === order.date && ownCells.has(t))));
    return freeStartsFor(data.openSlots, taken, iso, order.durationMin || 15, data.doctors, order.exam?.typeId);
  };

  const run = async (fn) => { setMsg(""); try { await fn(); } catch (e) { setMsg(e?.message || String(e)); } };

  const tone = order.status === "rejected" ? "border-l-red-400 bg-red-50"
    : order.status === "confirmed" ? "border-l-[#2B46A2] bg-[#F0F4FF]"
    : "border-l-amber-400 bg-amber-50";

  return (
    <div className={`border border-[#E0E4EF] rounded-[10px] p-4 border-l-4 ${tone} space-y-2`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-bold text-sm">{order.date} {order.time}</span>
          <span className="text-xs bg-white border border-slate-200 rounded px-2 py-0.5">{statuses[order.status]}</span>
          <ArrivedBadge order={order} />
        </div>
        <span className="text-xs text-slate-500">{order.id}</span>
      </div>
      <p className="text-sm"><b>{order.patientName}</b>{order.exam?.label ? ` · ${order.exam.label}` : ""}{order.durationMin ? ` (${order.durationMin} min)` : ""}</p>
      {/* karta sa zobrazuje len v správe (personál vrátane lekára) — všetky údaje pacienta */}
      <PatientDetails order={order} onCopied={(ok) => setMsg(ok ? "" : "Kopírovanie do schránky sa nepodarilo.")} />
      {Array.isArray(order.attachments) && order.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {order.attachments.map((a, i) => (
            <button key={i} onClick={() => run(() => data.openAttachment(a))}
              className="text-xs bg-[#F0F4FF] text-[#2B46A2] border border-[#c9d6f5] rounded px-2 py-1 hover:bg-[#E0E4EF]">
              📎 {a.name || `príloha ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      {order.statusNote && <p className="text-xs text-[#856404]">{order.statusNote}</p>}
      {msg && <p className="text-xs text-red-600 font-semibold">{msg}</p>}

      {canManage && active && (
        <div className="flex flex-wrap gap-2 pt-1">
          {order.status === "new" && <button onClick={() => run(() => data.setStatus(order.id, "confirmed"))} className="bg-[#2B46A2] text-white text-xs font-semibold px-3 py-1.5 rounded">Potvrdiť</button>}
          <button onClick={() => run(() => data.setStatus(order.id, "done"))} className="bg-[#F0F2F5] text-[#444] text-xs font-semibold px-3 py-1.5 rounded">Vykonané</button>
          <button onClick={() => setResched(!resched)} className="bg-[#F0F2F5] text-[#444] text-xs font-semibold px-3 py-1.5 rounded">{resched ? "Zavrieť presun" : "Presunúť"}</button>
          <button onClick={() => setCancelOpen(!cancelOpen)} className="bg-white border border-red-300 text-red-600 text-xs font-semibold px-3 py-1.5 rounded">Zrušiť</button>
        </div>
      )}
      {canManage && order.status === "rejected" && (
        <button onClick={() => run(() => data.setStatus(order.id, "new"))} className="bg-[#F0F2F5] text-[#444] text-xs font-semibold px-3 py-1.5 rounded">Obnoviť</button>
      )}

      {resched && active && (
        <div className="bg-white border border-slate-200 rounded-[10px] p-3 space-y-2">
          <input type="date" className={inp} value={rdate} onChange={(e) => setRdate(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            {starts(rdate).map((s) => (
              <button key={s.time} onClick={() => run(async () => { await data.reschedule(order.id, rdate, s.time); setResched(false); })}
                className="bg-white border border-slate-300 hover:border-[#2B46A2] text-[#2B46A2] text-xs font-semibold px-3 py-1.5 rounded">{s.time}</button>
            ))}
            {starts(rdate).length === 0 && <p className="text-xs text-slate-400">Žiadne voľné časy v tento deň.</p>}
          </div>
        </div>
      )}
      {cancelOpen && active && (
        <div className="bg-white border border-red-200 rounded-[10px] p-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            {["Na žiadosť pacienta", "Prekážka na strane pracoviska", "Duplicitná objednávka"].map((r) => (
              <button key={r} onClick={() => run(() => data.setStatus(order.id, "rejected", r))} className="bg-white border border-red-300 text-red-600 text-xs font-semibold px-3 py-1.5 rounded">{r}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <input className={inp} placeholder="Vlastný dôvod…" value={cancelText} onChange={(e) => setCancelText(e.target.value)} />
            <button onClick={() => run(() => data.setStatus(order.id, "rejected", cancelText.trim() || "Zrušené pracoviskom"))} className="bg-red-600 text-white text-xs font-semibold px-3 py-1.5 rounded shrink-0">Zrušiť</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Správa ambulancie ----------
function AngioAdmin({ data, role }) {
  const canManage = role === "superadmin" || role === "sestra";
  const isSuper = role === "superadmin";
  const [tab, setTab] = useState("overview");
  const todayIso = toISODate(new Date());

  const [wFrom, setWFrom] = useState(todayIso), [wTo, setWTo] = useState(todayIso);
  const [wtFrom, setWtFrom] = useState("07:30"), [wtTo, setWtTo] = useState("14:30"), [wDoctor, setWDoctor] = useState("");
  const [selDay, setSelDay] = useState(todayIso);
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [fStatus, setFStatus] = useState("all"), [fText, setFText] = useState("");
  const [msg, setMsg] = useState("");

  const run = async (fn, ok) => { setMsg(""); try { await fn(); if (ok) setMsg(ok); } catch (e) { setMsg(e?.message || String(e)); } };

  const active = data.orders.filter((o) => o.status !== "rejected");
  const pending = data.orders.filter((o) => o.status === "new");
  const todayProgram = active.filter((o) => o.date === todayIso).sort((a, b) => a.time.localeCompare(b.time));
  const arrivedToday = todayProgram.filter((o) => o.arrivedAt && (o.status === "new" || o.status === "confirmed")).length;
  const next7 = (() => { const e = new Date(); e.setDate(e.getDate() + 7); const ei = toISODate(e); return active.filter((o) => o.date >= todayIso && o.date <= ei).length; })();

  const takenSet = (iso) => new Set(data.occupied.filter((o) => o.date === iso).map((o) => o.time));
  const dayOpen = (data.openSlots[selDay] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
  const dayOrders = active.filter((o) => o.date === selDay).sort((a, b) => a.time.localeCompare(b.time));
  const isAvailableAdmin = (iso) => (data.openSlots[iso] || []).length > 0;

  const filtered = data.orders
    .filter((o) => fStatus === "all" ? o.status !== "rejected" : o.status === fStatus)
    .filter((o) => { const q = fText.trim().toLowerCase(); if (!q) return true; return o.patientName.toLowerCase().includes(q) || o.id.toLowerCase().includes(q) || o.phone.includes(q); })
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const tabs = [["overview", "Prehľad"], ["calendar", "Kalendár"], ["orders", "Objednávky"], ...(canManage ? [["settings", "Nastavenia"]] : [])];
  const btn = "shrink-0 px-4 py-2 rounded-[10px] text-sm font-bold transition-colors";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`${btn} ${tab === id ? "bg-[#2B46A2] text-white" : "bg-[#F0F2F5] text-[#444]"}`}>{label}</button>
        ))}
      </div>
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-[#16A34A]" : "text-red-600"}`}>{msg}</p>}

      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white rounded-[12px] p-4 text-center shadow-sm"><div className="text-2xl font-extrabold text-[#2B46A2]">{todayProgram.length}</div><div className="text-xs text-slate-500">dnešný program</div></div>
            <div className="bg-white rounded-[12px] p-4 text-center shadow-sm"><div className="text-2xl font-extrabold text-emerald-600">{arrivedToday}</div><div className="text-xs text-slate-500">v čakárni</div></div>
            <div className="bg-white rounded-[12px] p-4 text-center shadow-sm"><div className="text-2xl font-extrabold text-amber-600">{pending.length}</div><div className="text-xs text-slate-500">nové (na potvrdenie)</div></div>
            <div className="bg-white rounded-[12px] p-4 text-center shadow-sm"><div className="text-2xl font-extrabold text-[#2B46A2]">{next7}</div><div className="text-xs text-slate-500">objednaní — 7 dní</div></div>
          </div>
          <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5">
            <h3 className="text-lg font-bold text-[#2B46A2] mb-3">Dnešný program</h3>
            {todayProgram.length === 0 ? <p className="text-sm text-slate-400">Dnes nie sú objednaní žiadni pacienti.</p>
              : <div className="space-y-2">{todayProgram.map((o) => <AngioOrderCard key={o.id} order={o} data={data} canManage={canManage} />)}</div>}
          </div>
        </div>
      )}

      {tab === "calendar" && (
        <div className="space-y-4">
          {canManage && (
            <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5">
              <h3 className="text-lg font-bold text-[#2B46A2] mb-3">Otvoriť termíny</h3>
              <div className="flex flex-wrap gap-2 items-end">
                <label className="text-sm">Od dňa<br /><input type="date" className={inp} value={wFrom} onChange={(e) => setWFrom(e.target.value)} /></label>
                <label className="text-sm">Do dňa<br /><input type="date" className={inp} value={wTo} onChange={(e) => setWTo(e.target.value)} /></label>
                <label className="text-sm">Od<br /><input type="time" className={inp} value={wtFrom} onChange={(e) => setWtFrom(e.target.value)} /></label>
                <label className="text-sm">Do<br /><input type="time" className={inp} value={wtTo} onChange={(e) => setWtTo(e.target.value)} /></label>
                <label className="text-sm">Lekár<br />
                  <select className={inp} value={wDoctor} onChange={(e) => setWDoctor(e.target.value)}>
                    <option value="">— (ktokoľvek) —</option>
                    {data.doctors.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                  </select>
                </label>
                <button onClick={() => run(() => data.openWindow({ dateFrom: wFrom, dateTo: wTo, timeFrom: wtFrom, timeTo: wtTo, doctor: wDoctor }), "✓ Termíny otvorené.")} className="bg-[#2B46A2] text-white font-semibold px-4 py-2 rounded-[10px]">Otvoriť termíny</button>
              </div>
              <p className="text-xs text-slate-400 mt-2">Termíny sa otvárajú v 5-min mriežke; dĺžku určuje typ vyšetrenia v Nastaveniach. Tip: kliknite na deň v kalendári a otvorte ho jedným tlačidlom.</p>
            </div>
          )}
          <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 grid md:grid-cols-2 gap-5">
            <MonthCalendar monthDate={monthDate}
              onMonthChange={(delta) => setMonthDate((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
              isAvailable={isAvailableAdmin} isSelectable={(iso) => iso >= todayIso}
              selected={selDay} onSelect={(iso) => { setSelDay(iso); setWFrom(iso); setWTo(iso); }} />
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-2">Deň {selDay}</p>
              {dayOrders.length === 0 && dayOpen.length === 0 && <p className="text-sm text-slate-400">V tento deň nie sú otvorené termíny.</p>}
              {canManage && dayOpen.length === 0 && (
                <button
                  onClick={() => run(() => data.openWindow({ dateFrom: selDay, dateTo: selDay, timeFrom: wtFrom, timeTo: wtTo, doctor: wDoctor, skipWeekends: false }), "✓ Termíny otvorené.")}
                  className="mt-2 bg-[#2B46A2] hover:bg-[#1E3580] text-white text-sm font-semibold px-4 py-2 rounded-[10px]">
                  Otvoriť termíny v tento deň ({wtFrom}–{wtTo}{wDoctor ? ` · ${wDoctor}` : ""})
                </button>
              )}
              <div className="space-y-2">
                {dayOrders.map((o) => <AngioOrderCard key={o.id} order={o} data={data} canManage={canManage} />)}
              </div>
              {canManage && dayOpen.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-slate-500 mb-1">Voľné 5-min bunky ({dayOpen.filter((s) => !takenSet(selDay).has(s.time)).length}):</p>
                  <div className="flex flex-wrap gap-1">
                    {dayOpen.filter((s) => !takenSet(selDay).has(s.time)).map((s) => (
                      <button key={s.time} onClick={() => run(() => data.closeSlot(selDay, s.time))} title="Zavrieť termín"
                        className="text-xs bg-[#F0FDF4] border border-[#16A34A]/40 text-[#16A34A] rounded px-2 py-1 hover:bg-red-50 hover:border-red-300 hover:text-red-600">
                        {s.time} ✕
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "orders" && (
        <div className="space-y-4">
          <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-4 flex flex-wrap gap-2 items-center">
            <select className={inp + " w-auto"} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="all">Aktívne</option>
              <option value="new">Nové</option><option value="confirmed">Potvrdené</option>
              <option value="done">Vykonané</option><option value="rejected">Kôš (zrušené)</option>
            </select>
            <input className={inp + " flex-1 min-w-[10rem]"} placeholder="Hľadať meno / číslo / telefón" value={fText} onChange={(e) => setFText(e.target.value)} />
            <span className="text-xs text-slate-500">{filtered.length} objednávok</span>
          </div>
          {filtered.length === 0 ? <p className="text-sm text-slate-400">Žiadne objednávky.</p>
            : <div className="space-y-2">{filtered.map((o) => <AngioOrderCard key={o.id} order={o} data={data} canManage={canManage} />)}</div>}
        </div>
      )}

      {tab === "settings" && canManage && <AngioSettings data={data} isSuper={isSuper} />}
    </div>
  );
}

// ---------- Nastavenia (typy vyšetrení + lekári) ----------
function AngioSettings({ data, isSuper }) {
  const [exams, setExams] = useState(() => data.pricelist.map((p) => ({ ...p })));
  const [docs, setDocs] = useState(() => normalizeDoctors(data.doctors));
  const [msg, setMsg] = useState("");
  const slug = () => "ang_" + Math.random().toString(36).slice(2, 10);
  // presun typu v zozname (poradie = sort_order = poradie pre pacienta)
  const move = (i, d) => setExams((p) => { const j = i + d; if (j < 0 || j >= p.length) return p; const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const saveExams = () => { setMsg(""); data.savePricelist(exams.filter((e) => e.label.trim())).then(() => setMsg("✓ Typy vyšetrení uložené.")).catch((e) => setMsg(e.message)); };
  const saveDocs = () => { setMsg(""); data.saveDoctors(docs.filter((d) => d.name.trim())).then(() => setMsg("✓ Lekári uložení.")).catch((e) => setMsg(e.message)); };
  const [notes, setNotes] = useState(() => data.notes || "");
  useEffect(() => { setNotes(data.notes || ""); }, [data.notes]); // Supabase: hodnota príde asynchrónne
  const [smsVerify, setSmsVerify] = useState(() => !!data.smsVerify);
  useEffect(() => { setSmsVerify(!!data.smsVerify); }, [data.smsVerify]);
  const saveSmsVerifyClick = () => { setMsg(""); data.saveSmsVerify(smsVerify).then(() => setMsg(smsVerify ? "✓ Overovanie telefónu zapnuté." : "✓ Overovanie telefónu vypnuté.")).catch((e) => setMsg(e.message)); };
  const saveNotesClick = () => { setMsg(""); data.saveNotes(notes).then(() => setMsg("✓ Spoločné pokyny uložené.")).catch((e) => setMsg(e.message)); };

  return (
    <div className="space-y-5">
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-[#16A34A]" : "text-red-600"}`}>{msg}</p>}

      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 space-y-3">
        <h3 className="text-lg font-bold text-[#2B46A2]">Typy vyšetrení / návštev</h3>
        <p className="text-xs text-slate-400">Poradie v zozname je poradie, v akom typy uvidí pacient — šípkami ▲▼ ho zmeníte a uložte.</p>
        {exams.map((e, i) => (
          <div key={e.id} className="border border-slate-200 rounded-[10px] p-3 space-y-2">
            <div className="flex gap-2">
              <input className={inp} placeholder="Názov vyšetrenia" value={e.label} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, label: ev.target.value } : x))} />
              <label className="text-sm shrink-0">Trvanie<br />
                <select className={inp} value={e.durationSlots} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, durationSlots: Number(ev.target.value) } : x))}>
                  {[2, 3, 4, 5, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n * 5} min</option>)}
                </select>
              </label>
              <div className="flex flex-col shrink-0 self-start pt-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Posunúť vyššie" aria-label="Posunúť vyššie" className="text-slate-500 hover:text-[#2B46A2] text-xs leading-none px-1 py-0.5 disabled:opacity-30">▲</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === exams.length - 1} title="Posunúť nižšie" aria-label="Posunúť nižšie" className="text-slate-500 hover:text-[#2B46A2] text-xs leading-none px-1 py-0.5 disabled:opacity-30">▼</button>
              </div>
              <button onClick={() => setExams((p) => p.filter((_, j) => j !== i))} className="text-red-600 text-sm shrink-0 self-start pt-2">✕</button>
            </div>
            <input className={inp} placeholder="Krátky popis (jeden riadok) — pacient ho vidí pri výbere vyšetrenia" value={e.description || ""} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, description: ev.target.value } : x))} />
            <textarea className={inp} rows={e.about && e.about.length > 200 ? 8 : 3} placeholder="Popis vyšetrenia — čo to je, pre koho, trvanie, priebeh. Pacient ho vidí na stránke po rozkliknutí ‚Viac o vyšetrení‘ (do e-mailu nejde)" value={e.about || ""} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, about: ev.target.value } : x))} />
            <textarea className={inp} rows={e.instructions && e.instructions.length > 200 ? 8 : 3} placeholder="Pokyny do e-mailu — len praktické veci: Čo priniesť, Príprava… Pacient ich dostane v potvrdzovacom e-maili a v pripomienke" value={e.instructions} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, instructions: ev.target.value } : x))} />
            <p className="text-[11px] text-slate-400">Formátovanie (popis aj pokyny): riadok končiaci dvojbodkou = tučný nadpis (napr. „Čo priniesť:"), riadky začínajúce „- " = odrážky, prázdny riadok = nový odsek.</p>
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input type="checkbox" checked={e.requiresReferral !== false} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, requiresReferral: ev.target.checked } : x))} />
              Vyžaduje žiadanku (výmenný lístok) — pacient ju musí priložiť pri objednaní
            </label>
          </div>
        ))}
        <button onClick={() => setExams((p) => [...p, { id: slug(), label: "", description: "", about: "", instructions: "", requiresReferral: true, durationSlots: 3 }])} className="bg-[#F0F2F5] text-[#444] text-sm font-semibold px-4 py-2 rounded-[10px]">+ Pridať vyšetrenie</button>
        <div><button onClick={saveExams} className="bg-[#2B46A2] text-white text-sm font-semibold px-4 py-2 rounded-[10px]">Uložiť typy vyšetrení</button></div>
      </div>

      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 space-y-3">
        <h3 className="text-lg font-bold text-[#2B46A2]">Spoločné pokyny pre pacientov</h3>
        <p className="text-xs text-slate-400">Jeden pokyn na riadok. Pacient ich dostane v potvrdzovacom e-maili, pri zmene termínu a v pripomienke deň vopred — na stránke sa nezobrazujú. Platia pre všetky typy vyšetrení.</p>
        {!isSuper && <p className="text-xs text-[#856404]">Spoločné pokyny môže meniť len superadmin.</p>}
        <textarea className={inp} rows={8} placeholder="Napr. Príďte 10 minút pred termínom…" value={notes} onChange={(ev) => setNotes(ev.target.value)} disabled={!isSuper} />
        {isSuper && <div><button onClick={saveNotesClick} className="bg-[#2B46A2] text-white text-sm font-semibold px-4 py-2 rounded-[10px]">Uložiť spoločné pokyny</button></div>}
      </div>

      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 space-y-3">
        <h3 className="text-lg font-bold text-[#2B46A2]">Overovanie telefónu SMS kódom</h3>
        <p className="text-xs text-slate-400">Pacient si pred odoslaním objednávky nechá poslať 6-miestny kód SMS a zadá ho — objednávka bez overeného čísla neprejde. Kód platí 10 minút, max. 3 SMS na číslo za 15 minút. Personál overenie nepotrebuje. (Vyžaduje spustený angio-005.sql a kľúče SMS brány.)</p>
        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input type="checkbox" data-testid="sms-verify-toggle" checked={smsVerify} onChange={(ev) => setSmsVerify(ev.target.checked)} disabled={!isSuper} />
          Vyžadovať overenie telefónneho čísla SMS kódom pri objednaní
        </label>
        {!isSuper && <p className="text-xs text-[#856404]">Overovanie môže zapnúť/vypnúť len superadmin.</p>}
        {isSuper && <div><button onClick={saveSmsVerifyClick} className="bg-[#2B46A2] text-white text-sm font-semibold px-4 py-2 rounded-[10px]">Uložiť overovanie</button></div>}
      </div>

      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 space-y-3">
        <h3 className="text-lg font-bold text-[#2B46A2]">Lekári ambulancie</h3>
        {!isSuper && <p className="text-xs text-[#856404]">Zoznam lekárov môže meniť len superadmin.</p>}
        {docs.map((d, i) => (
          <div key={i} className="border border-slate-200 rounded-[10px] p-3 space-y-2">
            <div className="flex gap-2">
              <input className={inp} placeholder="MUDr. Meno Priezvisko" value={d.name} onChange={(e) => setDocs((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} disabled={!isSuper} />
              <button onClick={() => setDocs((p) => p.filter((_, j) => j !== i))} className="text-red-600 text-sm shrink-0 self-start pt-2" disabled={!isSuper}>✕</button>
            </div>
            <input className={inp} placeholder="Ambulancia / miesto" value={d.location} onChange={(e) => setDocs((p) => p.map((x, j) => j === i ? { ...x, location: e.target.value } : x))} disabled={!isSuper} />
            <div className="flex flex-wrap gap-2">
              {data.pricelist.map((ex) => {
                const on = (d.examTypeIds || []).includes(ex.id);
                return (
                  <button key={ex.id} disabled={!isSuper}
                    onClick={() => setDocs((p) => p.map((x, j) => j === i ? { ...x, examTypeIds: on ? x.examTypeIds.filter((t) => t !== ex.id) : [...(x.examTypeIds || []), ex.id] } : x))}
                    className={`text-xs px-2 py-1 rounded border ${on ? "bg-[#2B46A2] text-white border-[#2B46A2]" : "bg-white text-slate-600 border-slate-300"}`}>{ex.label}</button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-400">Ak nevyberiete žiadne, lekár robí všetky.</p>
          </div>
        ))}
        {isSuper && <button onClick={() => setDocs((p) => [...p, { name: "", email: "", location: "", examTypeIds: [] }])} className="bg-[#F0F2F5] text-[#444] text-sm font-semibold px-4 py-2 rounded-[10px]">+ Pridať lekára</button>}
        {isSuper && <div><button onClick={saveDocs} className="bg-[#2B46A2] text-white text-sm font-semibold px-4 py-2 rounded-[10px]">Uložiť lekárov</button></div>}
      </div>
    </div>
  );
}

// ---------- Vstupné body ----------

// Verejná pacientska stránka (bez prihlásenia): hero + objednávanie + overenie
export function AngioPatientApp() {
  const data = useAngioData(false);
  // deep-link z e-mailu: #/angio1/objednavka/ANG-… → predvyplní „Už máte objednávku?"
  const hash = window.location.hash || "";
  const orderLinkId = hash.startsWith("#/angio1/objednavka/") ? decodeURIComponent(hash.slice("#/angio1/objednavka/".length)).trim() : "";
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-[15px] bg-gradient-to-r from-[#1E3580] to-[#2B46A2] text-white p-6 md:p-8 shadow-[0_2px_12px_rgba(0,0,0,0.08)]">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
          <p className="text-[11px] md:text-xs font-bold tracking-widest text-white/70 uppercase">Národný ústav srdcových a cievnych chorôb, a.s.</p>
          <a href="#/" className="text-xs font-semibold text-white/90 hover:text-white hover:underline whitespace-nowrap">← Späť na hlavnú stránku</a>
        </div>
        <h1 className="text-2xl md:text-3xl font-extrabold leading-tight">{CLINIC_NAME}</h1>
        <p className="text-sm text-white/90 mt-2 max-w-xl">
          Online objednanie na angiologické vyšetrenie. Vyšetrenie je <b>bez poplatku</b> — hradí ho zdravotná poisťovňa,
          preto je pri väčšine vyšetrení potrebná žiadanka (výmenný lístok) od vášho lekára. Termín si vyberiete sami, potvrdenie príde e-mailom.
        </p>
      </div>
      <AngioBookingView data={data} />
      <AngioOrderLookup data={data} initialId={orderLinkId} />
    </div>
  );
}

// Správa ambulancie (za prihlásením personálu)
export function AngioAdminApp({ role = "superadmin", backHref = "#/sprava" }) {
  const data = useAngioData(true);
  return (
    <div className="space-y-4">
      <div className="bg-[#F0F4FF] border border-[#c9d6f5] text-[#2B46A2] rounded-[10px] px-4 py-3 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
        <span>{CLINIC_NAME} — správa objednávok{data.pendingCount > 0 ? ` · nové na potvrdenie: ${data.pendingCount}` : ""}</span>
        <a href={backHref} className="hover:underline">← Späť do správy USG</a>
      </div>
      <AngioAdmin data={data} role={role} />
    </div>
  );
}
