import { useState, useMemo, useEffect } from "react";
import { useMsg } from "./toast.jsx";
import {
  MonthCalendar, toISODate, earliestTimeFor, computeOfferedSlots, firstPatientIso, PATIENT_LEAD_NOTE,
  normalizeDoctors, doctorDoesExam, addMinutes, BASE_SLOT_MIN, genSlots,
  insuranceOptions, normalizePhone, ArrivedBadge, BirthDateInput,
} from "./booking.jsx";
import { useAngioData } from "./podappkyData.js";
import ZachranNohuLanding, { CallbackCard } from "./zachrannohu.jsx";
import { ConsentAck } from "./legal.jsx";

// ============================================================
// Angiologická ambulancia č. 1 — objednávanie bez poplatku
// (routa #/angio1). Zrkadlo CT vetvy, ale s verejnou pacientskou
// vrstvou (AngioPatientApp — bez prihlásenia) a správou za
// prihlásením (AngioAdminApp). Dátová vrstva: useAngioData.
// ============================================================

export const CLINIC_NAME = "Angiologická ambulancia č. 1";

// Vstupy s jedným predvybraným vyšetrením (#/angio1/<kľúč>): pacient nevidí
// zoznam ostatných typov, ide rovno na výber termínu. Termíny, lekári
// a správa sú spoločné s ambulanciou. Vyšetrenie sa hľadá podľa id, náhradne
// podľa názvu (keby sa id v cenníku zmenilo); ak nie je aktívne, zobrazí sa
// bežný zoznam.
export const ANGIO_LANDINGS = {
  zachrannohu: {
    examTypeId: "ang_vnwtrvq2",
    labelMatch: /zachr[áa][ňn] nohu/i,
    cta: "Objednať sa — termín do týždňa",
  },
};
export const findLandingExam = (landing, pricelist) => {
  if (!landing) return null;
  const list = pricelist || [];
  return list.find((p) => p.id === landing.examTypeId) || list.find((p) => landing.labelMatch.test(p.label || "")) || null;
};

const newAngioId = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b = new Uint8Array(10); (window.crypto || window.msCrypto).getRandomValues(b);
  let s = ""; for (let i = 0; i < b.length; i++) s += abc[b[i] % 32];
  return "ANG-" + s;
};
import { inputSmCls as inp } from "./ui.jsx";
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
function AngioBookingView({ data, landing = null }) {
  const [step, setStep] = useState(1);
  const [examTypeId, setExamTypeId] = useState("");
  // vstup s jedným vyšetrením: predvybrať a preskočiť krok 1 (aj po „Nová objednávka")
  const landingExam = findLandingExam(landing, data.pricelist);
  useEffect(() => {
    if (landingExam && step === 1 && !examTypeId) { setExamTypeId(landingExam.id); setStep(2); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landingExam?.id, step, examTypeId]);
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [form, setForm] = useState({ name: "", birthDate: "", insurance: "25", phone: "", email: "", reason: "" });
  const [files, setFiles] = useState([]);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useMsg();
  const [errs, setErrs] = useState({});
  const [ack, setAck] = useState(false); // oboznámenie s podmienkami a informáciami o osobných údajoch
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
  const minIso = firstPatientIso();
  const isAvailable = (iso) => iso >= minIso && freeSlotsFor(iso).length > 0;
  // prvý voľný deň pre zvolené vyšetrenie — kalendár sa naň otvorí; bez neho hláška
  const firstFreeIso = useMemo(() => {
    let d = minIso;
    for (let i = 0; i < 180; i++) { if (isAvailable(d)) return d; d = addDays(d, 1); }
    return "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.openSlots, data.occupied, examTypeId, durationMin]);
  useEffect(() => {
    if (step === 2 && firstFreeIso) { const d = isoDate(firstFreeIso); setMonthDate(new Date(d.getFullYear(), d.getMonth(), 1)); }
  }, [step, firstFreeIso]);

  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); clearErr(k); };

  const submit = async () => {
    const e = {};
    if (form.name.trim().length < 3) e.name = "Zadajte meno a priezvisko.";
    if (!form.birthDate) e.birthDate = "Zadajte dátum narodenia.";
    if (form.phone.replace(/\D/g, "").length < 9) e.phone = "Neplatné telefónne číslo (aspoň 9 číslic).";
    if (!form.email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) e.email = "Zadajte platný e-mail.";
    if (needsReferral && files.length === 0) e.files = "Priložte žiadanku (výmenný lístok) — môžete ju odfotiť.";
    if (data.smsVerify && !e.phone && !phoneVerified) e.phone = "Overte telefónne číslo SMS kódom.";
    if (!ack) e.ack = "Potvrďte, prosím, že ste sa oboznámili s podmienkami a informáciami o spracúvaní osobných údajov.";
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
    } catch (err) {
      const m = err?.message || String(err);
      setMsg(m);
      if (err?.code === "SLOT_TAKEN" || /obsaden/i.test(m)) { setStep(2); setTime(""); } // termín medzičasom obsadený → späť na výber času s čerstvou ponukou
      else if (/overen/i.test(m)) setOtp({ stage: "idle", phone: "", code: "", token: "", msg: "", busy: false, demoCode: "" });
    } finally { setBusy(false); }
  };
  const ic = (k) => inp + (errs[k] ? " border-danger/40 ring-1 ring-danger/40" : "");
  const Err = ({ k }) => errs[k] ? <p className="text-xs text-danger mt-1">{errs[k]}</p> : null;

  if (done) {
    return (
      <div className="bg-white rounded-xl border border-line p-6 text-center">
        <h2 className="text-xl font-semibold text-success mb-2">Objednávka je prijatá</h2>
        <p className="text-ink">{done.label}</p>
        <p className="text-ink">Termín: <b>{fmtLong(done.date)} o {done.time}</b></p>
        <p className="text-ink mb-1">Číslo objednávky: <b className="font-mono">{done.id}</b></p>
        <p className="text-sm text-muted mt-3">Vyšetrenie je bez poplatku. Potvrdenie sme poslali e-mailom. Príďte, prosím, 10 minút pred termínom{done.needsReferral ? " so žiadankou" : ""}.</p>
        <p className="text-sm text-warn bg-warn-soft border border-warn/30 rounded-lg px-3 py-2 mt-3 text-left"><b>Čas termínu je orientačný.</b> Ako pracovisko najvyššieho typu musíme niekedy prednostne ošetriť akútneho pacienta. Ďakujeme za pochopenie.</p>
        <p className="text-xs text-muted mt-2">Zmenu alebo zrušenie termínu vybavíte online cez odkaz v e-maili alebo v sekcii „Už máte objednávku?" (najneskôr 24 hodín vopred). Telefón/SMS len v naozaj nutných prípadoch – ozveme sa vám späť.</p>
        <div className="flex flex-wrap justify-center gap-2 mt-5">
          <button type="button" onClick={() => { setDone(null); setStep(1); setExamTypeId(""); setDate(""); setTime(""); setForm({ name: "", birthDate: "", insurance: "25", phone: "", email: "", reason: "" }); setOtp({ stage: "idle", phone: "", code: "", token: "", msg: "", busy: false, demoCode: "" }); setAck(false); setErrs({}); }}
            className="bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-4 py-2 rounded-lg">Nová objednávka</button>
          <a href="#/angio1" className="bg-soft hover:bg-line text-ink text-sm font-semibold px-4 py-2 rounded-lg">← Späť na stránku ambulancie</a>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-line p-5 md:p-6 space-y-5">
      <h2 className="text-xl font-semibold text-brand">Objednanie na vyšetrenie <span className="text-sm font-normal text-muted">(bez poplatku)</span></h2>
      {step < 3 && data.requestCallback && (
        <p className="text-sm text-muted -mt-2">Nedarí sa vám objednať online?{" "}
          <a href="#zavolame" data-testid="booking-callback-link" className="font-semibold text-brand underline underline-offset-2 hover:text-brand-dark"
            onClick={(e) => { const el = document.getElementById("zavolame"); if (el) { e.preventDefault(); el.scrollIntoView({ behavior: "smooth", block: "start" }); } }}>
            Nechajte nám číslo, zavoláme vám ›</a></p>
      )}
      {step === 1 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-ink">Vyberte typ vyšetrenia / návštevy</p>
          {data.pricelist.length === 0 && <p className="text-sm text-muted">Zatiaľ nie sú nastavené žiadne typy vyšetrení.</p>}
          {data.pricelist.map((p) => (
            <div key={p.id} className={`border-2 rounded-lg transition-colors ${examTypeId === p.id ? "border-brand bg-brand-soft" : "border-line hover:border-brand/50"}`}>
              <button onClick={() => { setExamTypeId(p.id); setStep(2); setDate(""); setTime(""); }} className="w-full text-left p-3">
                <span className="font-semibold text-ink">{p.label}</span>
                <span className="block text-xs text-muted mt-1">Trvanie ~{p.durationSlots * 5} min{p.description ? ` · ${p.description}` : ""}{p.requiresReferral === false ? " · bez žiadanky" : ""}</span>
              </button>
              {p.about && (
                <div className="px-3 pb-2">
                  <button type="button" onClick={() => setAboutOpen((o) => (o === p.id ? "" : p.id))} className="text-xs font-semibold text-brand hover:underline">
                    {aboutOpen === p.id ? "▴ Skryť podrobnosti" : "▾ Viac o vyšetrení"}
                  </button>
                  {aboutOpen === p.id && <div data-testid="exam-about" className="mt-2 text-sm text-ink"><FormattedText text={p.about} /></div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {landingExam
            ? (
              <div data-testid="landing-exam" className="border-2 border-brand bg-brand-soft rounded-lg p-3">
                <p className="font-semibold text-ink">{examType?.label}</p>
                <p className="text-xs text-muted mt-1">Trvanie ~{(examType?.durationSlots || 3) * 5} min{examType?.description ? ` · ${examType.description}` : ""}{examType?.requiresReferral === false ? " · bez žiadanky" : ""}</p>
                {examType?.about && (
                  <>
                    <button type="button" onClick={() => setAboutOpen((o) => (o ? "" : examType.id))} className="text-xs font-semibold text-brand hover:underline mt-1">
                      {aboutOpen ? "▴ Skryť podrobnosti" : "▾ Viac o vyšetrení"}
                    </button>
                    {aboutOpen && <div data-testid="exam-about" className="mt-2 text-sm text-ink"><FormattedText text={examType.about} /></div>}
                  </>
                )}
              </div>
            )
            : <button onClick={() => setStep(1)} className="text-sm text-brand hover:underline">← Zmeniť vyšetrenie</button>}
          {!landingExam && <p className="text-sm text-muted">Vybrané: <b>{examType?.label}</b></p>}
          <div className="grid md:grid-cols-2 gap-5">
            <div>
              <MonthCalendar monthDate={monthDate}
                onMonthChange={(delta) => setMonthDate((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
                isAvailable={isAvailable} selected={date} onSelect={(iso) => { setDate(iso); setTime(""); }} />
              <p data-testid="lead-note" className="text-xs text-muted mt-2">{PATIENT_LEAD_NOTE}</p>
            </div>
            <div>
              <p className="text-sm font-semibold text-ink mb-2">{date ? `Voľné časy — ${fmtLong(date)}` : "Vyberte deň"}</p>
              {!date && !firstFreeIso && <p className="text-sm text-warn bg-warn-soft border border-warn/30 rounded-lg px-3 py-2" data-testid="no-slots">Momentálne nie sú otvorené žiadne termíny. Skúste to neskôr alebo nám nechajte číslo nižšie — zavoláme vám.</p>}
              <div className="flex flex-wrap gap-2">
                {date && freeSlotsFor(date).map((s) => (
                  <button key={s.time} onClick={() => setTime(s.time)}
                    className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${time === s.time ? "bg-brand text-white border-brand" : "bg-white text-brand border-line hover:border-brand"}`}>
                    {s.time}{s.doctor ? <span className="block text-xs font-normal opacity-70">{s.doctor}</span> : null}
                  </button>
                ))}
                {date && freeSlotsFor(date).length === 0 && <p className="text-sm text-muted">V tento deň nie sú voľné termíny.</p>}
              </div>
            </div>
          </div>
          <p data-testid="orientacny-termin" className="text-sm text-warn bg-warn-soft border border-warn/30 rounded-lg px-3 py-2">
            <b>Čas termínu je orientačný.</b> Ako pracovisko najvyššieho typu musíme niekedy prednostne ošetriť akútneho pacienta. Ďakujeme za pochopenie.
          </p>
          {time && <button onClick={() => setStep(3)} className="bg-brand hover:bg-brand-dark text-white font-semibold py-3 px-5 rounded-lg">Pokračovať</button>}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <button onClick={() => setStep(2)} className="text-sm text-brand hover:underline">← Späť na termín</button>
          <p className="text-sm text-muted"><b>{examType?.label}</b> · {fmtLong(date)} o {time}</p>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">Meno a priezvisko *</label>
              <input className={ic("name")} placeholder="Ján Novák" value={form.name} onChange={set("name")} />
              <Err k="name" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">Dátum narodenia *</label>
              <BirthDateInput className={ic("birthDate")} value={form.birthDate} onChange={(v) => { setForm((f) => ({ ...f, birthDate: v })); clearErr("birthDate"); }} />
              <Err k="birthDate" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">Zdravotná poisťovňa</label>
              <select className={inp} value={form.insurance} onChange={set("insurance")}>
                {insuranceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">Telefón *</label>
              <input className={ic("phone")} placeholder="+421 900 000 000" value={form.phone} onChange={set("phone")} />
              <Err k="phone" />
              {data.smsVerify && (
                <div data-testid="otp-box" className="mt-2 text-sm">
                  {phoneVerified ? (
                    <p className="text-success font-semibold">✓ Číslo overené</p>
                  ) : otp.stage === "sent" && phoneDigits(otp.phone) === phoneDigits(form.phone) ? (
                    <div className="space-y-2">
                      <p className="text-muted">Kód sme poslali SMS na <b>{otp.phone}</b>. Platí 10 minút.{otp.demoCode ? ` (demo: kód ${otp.demoCode})` : ""}</p>
                      <div className="flex gap-2">
                        <input className={inp} inputMode="numeric" maxLength={6} placeholder="6-miestny kód" value={otp.code}
                          onChange={(ev) => setOtp((o) => ({ ...o, code: ev.target.value.replace(/\D/g, "").slice(0, 6), msg: "" }))} />
                        <button type="button" onClick={verifyOtp} disabled={otp.busy || otp.code.length !== 6}
                          className="bg-brand disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg shrink-0">Overiť kód</button>
                      </div>
                      <button type="button" onClick={sendOtp} disabled={otp.busy} className="text-xs text-brand hover:underline">Poslať kód znova</button>
                    </div>
                  ) : (
                    <button type="button" onClick={sendOtp} disabled={otp.busy}
                      className="bg-brand-soft hover:bg-line disabled:opacity-50 text-brand text-sm font-semibold px-4 py-2 rounded-lg">
                      {otp.busy ? "Posielam…" : "Poslať overovací SMS kód"}
                    </button>
                  )}
                  {otp.msg && <p className="text-xs text-danger mt-1">{otp.msg}</p>}
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">E-mail (na potvrdenie) *</label>
              <input className={ic("email")} type="email" placeholder="jan.novak@…" value={form.email} onChange={set("email")} />
              <Err k="email" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">Dôvod / poznámka</label>
              <input className={inp} placeholder="nepovinné" value={form.reason} onChange={set("reason")} />
            </div>
          </div>
          {/* Nahrávanie žiadanky — povinné podľa typu vyšetrenia */}
          <div className={errs.files ? "border border-danger/40 bg-danger-soft rounded-lg p-3" : needsReferral ? "border border-warn/30 bg-warn-soft rounded-lg p-3" : "border border-line bg-page rounded-lg p-3"}>
            <label className="block text-xs font-semibold text-muted mb-1">
              {needsReferral ? "Žiadanka (výmenný lístok) — odfoťte alebo nahrajte *" : "Žiadanka alebo lekárske správy — nepovinné"}{" "}
              <span className="font-normal text-muted">(PDF, JPG, PNG — max 3 súbory po 5 MB)</span>
            </label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png" multiple onChange={handleFilePick}
              className="block w-full text-sm text-muted file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-brand-soft file:text-brand file:font-semibold hover:file:bg-line" />
            <Err k="files" />
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between text-sm bg-page border border-line rounded-lg px-3 py-1.5">
                    <span className="truncate">{f.name}</span>
                    <button onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="text-danger text-xs font-semibold shrink-0 ml-2">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <ConsentAck checked={ack} onChange={(v) => { setAck(v); clearErr("ack"); }} error={errs.ack} testId="angio-ack" />
          {msg && <p className="text-sm text-danger font-semibold">{msg}</p>}
          <button onClick={submit} disabled={busy} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-3 px-5 rounded-lg">
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
  const [msg, setMsg] = useMsg();
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
    try {
      const ok = await data.cancelOrder(found.id, phone.trim());
      if (ok === false) throw new Error("Objednávku sa nepodarilo zrušiť — skontrolujte číslo a telefón alebo nám napíšte SMS na 0949 000 677.");
      setFound({ ...found, status: "rejected", statusNote: "Zrušené pacientom" });
    }
    catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); }
  };
  // zmena a zrušenie online najneskôr 24 h pred termínom (rovnaké pravidlo stráži databáza, angio-015)
  const hoursUntil = found ? (new Date(`${found.date}T${found.time || "00:00"}:00`) - Date.now()) / 3600000 : 0;
  const activeFound = found && (found.status === "new" || found.status === "confirmed");
  const canChange = activeFound && hoursUntil >= 24;

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
    // rovnaká ponuka ako pri objednávaní: najbližšie 3 časy natesno
    return computeOfferedSlots({ openSlots: data.openSlots, takenSet: taken, doctors: data.doctors, examTypeId: found.exam?.typeId, durationMin: dur, iso, minTime: earliestTimeFor(iso, "") })
      .filter((s) => !(iso === found.date && s.time === found.time));
  };
  const rAvailable = (iso) => iso >= firstPatientIso() && rStarts(iso).length > 0;
  const pick = async (iso, t) => {
    if (!window.confirm(`Zmeniť termín na ${fmtLong(iso)} o ${t}?`)) return;
    setBusy(true); setMsg(""); setOk("");
    try {
      await data.patientReschedule(found.id, phone.trim(), iso, t);
      setFound({ ...found, date: iso, time: t, status: "new" });
      setResched(false); setRDate("");
      setOk(`Termín je zmenený na ${fmtLong(iso)} o ${t}. Pracovisko ho ešte raz potvrdí; potvrdenie pošleme e-mailom a SMS.`);
    } catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); }
  };

  return (
    <div id="angio-lookup" className="bg-white rounded-xl border border-line p-5 md:p-6 space-y-3">
      <h3 className="text-lg font-semibold text-brand">Už máte objednávku?</h3>
      <p className="text-sm text-muted">Zadajte číslo objednávky (ANG-…) a telefón, ktorý ste uviedli. Termín tu môžete zmeniť alebo zrušiť (najneskôr 24 hodín vopred).</p>
      <div className="grid md:grid-cols-2 gap-3">
        <input className={inp} placeholder="Číslo objednávky (ANG-…)" aria-label="Číslo objednávky" value={id} onChange={(e) => { setId(e.target.value); setFound(null); setMsg(""); }} />
        <input className={inp} type="tel" inputMode="tel" autoComplete="tel" placeholder="Telefón zadaný pri objednávke" aria-label="Telefón zadaný pri objednávke" value={phone} onChange={(e) => { setPhone(e.target.value); setFound(null); setMsg(""); }} />
      </div>
      <button onClick={search} disabled={busy} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-2.5 px-5 rounded-lg">
        {busy ? "Hľadám…" : "Vyhľadať"}
      </button>
      {msg && <p className="text-sm text-danger font-semibold" role="alert">{msg}</p>}
      {found && (
        <div className="border border-line rounded-lg p-4 space-y-1">
          <p className="text-sm"><b>{found.id}</b> — <span className="font-semibold">{statuses[found.status] || found.status}</span></p>
          {found.exam?.label && <p className="text-sm text-muted">{found.exam.label}</p>}
          <p className="text-sm text-muted">Termín: <b>{fmtLong(found.date)} o {found.time}</b>{found.doctor ? ` · ${found.doctor}` : ""}</p>
          {ok && <p className="text-sm text-success font-semibold" role="status">{ok}</p>}
          {activeFound && !canChange && (
            <p className="text-xs bg-warn-soft border border-warn/30 rounded-lg p-2 text-warn font-semibold" data-testid="too-late">
              Do termínu zostáva menej ako 24 hodín — online zmena ani zrušenie už nie je možné. Ak sa nemôžete dostaviť, pošlite nám SMS s číslom objednávky na 0949 000 677.
            </p>
          )}
          {canChange && (
            <div className="flex flex-wrap gap-2 mt-2">
              <button onClick={() => { setResched(!resched); setOk(""); setMsg(""); }} disabled={busy} className="bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-4 py-2 rounded-lg">
                {resched ? "Zavrieť zmenu termínu" : "Zmeniť termín"}
              </button>
              <button onClick={cancel} disabled={busy} className="bg-white border border-danger/40 text-danger text-sm font-semibold px-4 py-2 rounded-lg hover:bg-danger-soft">
                Zrušiť objednávku
              </button>
            </div>
          )}
          {resched && canChange && (
            <div data-testid="patient-resched" className="mt-3 bg-page border border-line rounded-lg p-3 space-y-3">
              <p className="text-sm text-muted">Ak vám termín nevyhovuje, vyberte si iný z otvorených. Zmena je možná najneskôr 24 hodín pred termínom. Telefón/SMS 0949 000 677 len v naozaj nutných prípadoch – ozveme sa vám späť.</p>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <MonthCalendar monthDate={rMonth}
                    onMonthChange={(delta) => setRMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
                    isAvailable={rAvailable} selected={rDate} onSelect={(iso) => setRDate(iso)} />
                  <p data-testid="lead-note" className="text-xs text-muted mt-2">{PATIENT_LEAD_NOTE}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink mb-2">{rDate ? `Voľné časy — ${fmtLong(rDate)}` : "Vyberte deň"}</p>
                  <div className="flex flex-wrap gap-2">
                    {rDate && rStarts(rDate).map((s) => (
                      <button key={s.time} onClick={() => pick(rDate, s.time)} disabled={busy}
                        className="px-3 py-2 rounded-lg text-sm font-semibold border bg-white text-brand border-line hover:border-brand">
                        {s.time}{s.doctor ? <span className="block text-xs font-normal opacity-70">{s.doctor}</span> : null}
                      </button>
                    ))}
                    {rDate && rStarts(rDate).length === 0 && <p className="text-sm text-muted">V tento deň nie sú voľné termíny.</p>}
                  </div>
                </div>
              </div>
            </div>
          )}
          {found.status === "rejected" && <p className="text-sm text-warn">Objednávka je zrušená.</p>}
        </div>
      )}
    </div>
  );
}

// ---------- Karta objednávky (správa) ----------
// Všetky údaje pacienta pre personál (na zaevidovanie do nemocničného systému) + kopírovanie
const fmtD = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join(".") : "—");
const fmtDT = (iso) => { if (!iso) return "—"; try { return new Date(iso).toLocaleString("sk-SK", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return String(iso).slice(0, 16); } };
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
    <div data-testid="patient-details" className="bg-white/70 border border-line rounded-lg p-3">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div><dt className="text-xs uppercase tracking-wide text-muted">Dátum narodenia</dt><dd className="font-semibold">{fmtD(order.birthDate)}</dd></div>
        <div><dt className="text-xs uppercase tracking-wide text-muted">Poisťovňa</dt><dd className="font-semibold">{ins}</dd></div>
        <div><dt className="text-xs uppercase tracking-wide text-muted">Telefón</dt><dd className="font-semibold">{order.phone ? <a href={`tel:${order.phone.replace(/\s/g, "")}`} className="text-brand hover:underline">{order.phone}</a> : "—"}</dd></div>
        <div><dt className="text-xs uppercase tracking-wide text-muted">E-mail</dt><dd className="font-semibold break-all">{order.email ? <a href={`mailto:${order.email}`} className="text-brand hover:underline">{order.email}</a> : "—"}</dd></div>
        {order.doctor && <div><dt className="text-xs uppercase tracking-wide text-muted">Lekár</dt><dd>{order.doctor}</dd></div>}
        <div><dt className="text-xs uppercase tracking-wide text-muted">Objednané</dt><dd>{fmtDT(order.createdAt)}</dd></div>
        {order.reason && <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-muted">Dôvod / poznámka</dt><dd className="whitespace-pre-wrap">{order.reason}</dd></div>}
      </dl>
      <button type="button" onClick={copy} className="mt-2 text-xs bg-soft hover:bg-line text-ink font-semibold px-3 py-1.5 rounded-lg">📋 Kopírovať údaje pacienta</button>
    </div>
  );
}

function AngioOrderCard({ order, data, canManage, embedded = false }) {
  const [resched, setResched] = useState(false);
  const [rdate, setRdate] = useState(order.date);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelText, setCancelText] = useState("");
  const [msg, setMsg] = useMsg();
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
    const minT = earliestTimeFor(iso, ""); // uplynuté časy dnes server odmietne — neponúkať ich
    return freeStartsFor(data.openSlots, taken, iso, order.durationMin || 15, data.doctors, order.exam?.typeId).filter((s) => !minT || s.time >= minT);
  };

  const [busy, setBusy] = useState(false);
  const run = async (fn) => { setMsg(""); setBusy(true); try { await fn(); } catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); } };
  const doCancel = (reason) => {
    if (!window.confirm(`Zrušiť objednávku ${order.id} (${order.patientName})?\nPacient dostane SMS a e-mail o zrušení; priložená žiadanka sa vymaže.`)) return;
    run(() => data.setStatus(order.id, "rejected", reason));
  };

  const tone = order.status === "rejected" ? "border-l-danger bg-danger-soft"
    : order.status === "confirmed" ? "border-l-brand bg-brand-soft"
    : order.status === "done" ? "border-l-success bg-success-soft"
    : order.status === "noshow" ? "border-l-line bg-soft"
    : "border-l-warn bg-warn-soft";

  return (
    <div className={`border border-line rounded-lg p-4 border-l-4 ${tone} space-y-2`}>
      {!embedded && (<>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold text-sm">{order.date} {order.time}</span>
          <span className="text-xs bg-white border border-line rounded-lg px-2 py-0.5">{statuses[order.status]}</span>
          <ArrivedBadge order={order} />
        </div>
        <span className="text-xs text-muted">{order.id}</span>
      </div>
      <p className="text-sm"><b>{order.patientName}</b>{order.exam?.label ? ` · ${order.exam.label}` : ""}{order.durationMin ? ` (${order.durationMin} min)` : ""}</p>
      </>)}
      {/* karta sa zobrazuje len v správe (personál vrátane lekára) — všetky údaje pacienta */}
      <PatientDetails order={order} onCopied={(ok) => setMsg(ok ? "" : "Kopírovanie do schránky sa nepodarilo.")} />
      {Array.isArray(order.attachments) && order.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {order.attachments.map((a, i) => (
            <button key={i} onClick={() => run(() => data.openAttachment(a))}
              className="text-xs bg-brand-soft text-brand border border-line rounded-lg px-2 py-1 hover:bg-line">
              📎 {a.name || `príloha ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      {order.statusNote && <p className="text-xs text-warn">{order.statusNote}</p>}
      {msg && <p className="text-xs text-danger font-semibold">{msg}</p>}

      {canManage && active && (
        <div className="flex flex-wrap gap-2 pt-1" aria-busy={busy}>
          {order.status === "new" && <button disabled={busy} onClick={() => run(() => data.setStatus(order.id, "confirmed"))} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg">{busy ? "Ukladám…" : "Potvrdiť"}</button>}
          <button disabled={busy} onClick={() => run(() => data.setStatus(order.id, "done"))} className="bg-soft hover:bg-line disabled:opacity-50 text-ink text-xs font-semibold px-3 py-1.5 rounded-lg">Vykonané</button>
          <button disabled={busy} onClick={() => run(() => data.setStatus(order.id, "noshow"))} className="bg-soft hover:bg-line disabled:opacity-50 text-ink text-xs font-semibold px-3 py-1.5 rounded-lg">Neprišiel</button>
          <button disabled={busy} onClick={() => setResched(!resched)} className="bg-soft hover:bg-line disabled:opacity-50 text-ink text-xs font-semibold px-3 py-1.5 rounded-lg">{resched ? "Zavrieť presun" : "Presunúť"}</button>
          <button disabled={busy} onClick={() => setCancelOpen(!cancelOpen)} className="bg-white border border-danger/40 text-danger hover:bg-danger-soft disabled:opacity-50 text-xs font-semibold px-3 py-1.5 rounded-lg">Zrušiť</button>
        </div>
      )}
      {canManage && order.status === "rejected" && (
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={busy} onClick={() => run(() => data.setStatus(order.id, "new"))} className="bg-soft hover:bg-line disabled:opacity-50 text-ink text-xs font-semibold px-3 py-1.5 rounded-lg">Obnoviť</button>
          <span className="text-xs text-muted">Pri zrušení sa prílohy vymazali — po obnovení ich treba od pacienta vyžiadať znova.</span>
        </div>
      )}
      {canManage && isSettled(order) && (
        <button onClick={() => run(() => data.setStatus(order.id, "confirmed"))} className="bg-soft text-ink text-xs font-semibold px-3 py-1.5 rounded-lg" title="Vrátiť medzi aktívne objednávky">Vrátiť medzi aktívne</button>
      )}

      {resched && active && (
        <div className="bg-white border border-line rounded-lg p-3 space-y-2">
          <input type="date" className={inp} min={toISODate(new Date())} value={rdate} onChange={(e) => setRdate(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            {starts(rdate).map((s) => (
              <button key={s.time} onClick={() => run(async () => { await data.reschedule(order.id, rdate, s.time); setResched(false); })}
                className="bg-white border border-line hover:border-brand text-brand text-xs font-semibold px-3 py-1.5 rounded-lg">{s.time}</button>
            ))}
            {starts(rdate).length === 0 && <p className="text-xs text-muted">Žiadne voľné časy v tento deň.</p>}
          </div>
        </div>
      )}
      {cancelOpen && active && (
        <div className="bg-white border border-danger/40 rounded-lg p-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            {["Na žiadosť pacienta", "Prekážka na strane pracoviska", "Duplicitná objednávka"].map((r) => (
              <button key={r} disabled={busy} onClick={() => doCancel(r)} className="bg-white border border-danger/40 text-danger hover:bg-danger-soft disabled:opacity-50 text-xs font-semibold px-3 py-1.5 rounded-lg">{r}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <input className={inp} placeholder="Vlastný dôvod…" value={cancelText} onChange={(e) => setCancelText(e.target.value)} />
            <button disabled={busy} onClick={() => doCancel(cancelText.trim() || "Zrušené pracoviskom")} className="bg-danger hover:bg-danger/90 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shrink-0">Zrušiť</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Pomôcky kalendára správy (v109) ----------
const DOW_LONG = ["Nedeľa", "Pondelok", "Utorok", "Streda", "Štvrtok", "Piatok", "Sobota"];
const DOW_SHORT = ["Ne", "Po", "Ut", "St", "Št", "Pi", "So"];
const isoDate = (iso) => new Date(`${iso}T12:00:00`);
export const fmtLong = (iso) => { if (!iso) return ""; const d = isoDate(iso); return `${DOW_LONG[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`; };
const addDays = (iso, n) => { const d = isoDate(iso); d.setDate(d.getDate() + n); return toISODate(d); };
const mondayOf = (iso) => addDays(iso, -((isoDate(iso).getDay() + 6) % 7));
const fmtDur = (min) => min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`;
const isSettled = (o) => o.status === "done" || o.status === "noshow";
// poradie v zoznamoch: najprv pacienti v čakárni, potom nasledujúci podľa času, vybavení (vykonané / neprišiel) nakoniec
const orderRank = (o) => isSettled(o) ? 2 : (o.arrivedAt && o.date === toISODate(new Date()) ? 0 : 1);
const byPriority = (a, b) => a.date.localeCompare(b.date) || orderRank(a) - orderRank(b) || a.time.localeCompare(b.time);
const cellsOf = (o) => {
  const [h, m0] = (o.time || "00:00").split(":").map(Number);
  const m = m0 - (m0 % 5); // čas mimo 5-min mriežky zarovnať nadol
  const n = Math.max(1, Math.ceil((o.durationMin || 15) / 5));
  return Array.from({ length: n }, (_, i) => { const t = h * 60 + m + i * 5; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; });
};
// Deň ako bloky: súvislé bunky jednej objednávky alebo súvislé voľno jedného lekára.
// Objednávky mimo otvorených buniek sa pridajú s príznakom outOfHours.
function daySegments(openCells, orders) {
  const byTime = new Map();
  orders.forEach((o) => cellsOf(o).forEach((t) => { if (!byTime.has(t)) byTime.set(t, o); }));
  const segs = []; const seen = new Set();
  openCells.forEach((c) => {
    const o = byTime.get(c.time) || null;
    const last = segs[segs.length - 1];
    // tá istá objednávka pokračuje aj cez medzeru v otvorených bunkách (jeden blok, nie dva);
    // voľno sa spája len ak nadväzuje a patrí tomu istému lekárovi
    const cont = last && ((o && last.order && last.order.id === o.id) || (!o && !last.order && last.end === c.time && last.doctor === (c.doctor || "")));
    if (cont) { last.end = addMinutes(c.time, 5); last.cells.push(c.time); }
    else segs.push({ start: c.time, end: addMinutes(c.time, 5), cells: [c.time], order: o, doctor: o ? (o.doctor || "") : (c.doctor || ""), outOfHours: false });
    if (o) seen.add(o.id);
  });
  orders.filter((o) => !seen.has(o.id)).forEach((o) => segs.push({ start: o.time, end: addMinutes(o.time, o.durationMin || 15), cells: [], order: o, doctor: o.doctor || "", outOfHours: true }));
  segs.sort((a, b) => a.start.localeCompare(b.start));
  const free = segs.filter((x) => !x.order).reduce((n, x) => n + x.cells.length, 0);
  return { segs, free };
}

// ---------- Kompaktný riadok objednávky (zoznamy v správe) ----------
// Jeden riadok: čas · pacient · vyšetrenie · stav; rozbalí sa na plnú kartu.
const statusChip = (s) => s === "confirmed" ? "bg-brand-soft text-brand" : s === "new" ? "bg-warn-soft text-warn" : s === "done" ? "bg-success-soft text-success" : s === "rejected" ? "bg-danger-soft text-danger" : s === "noshow" ? "bg-line text-ink" : "bg-soft text-muted";
function AngioOrderRow({ order, data, canManage, showDate = false, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [msg, setMsg] = useMsg();
  const confirm = async (e) => { e.stopPropagation(); setMsg(""); try { await data.setStatus(order.id, "confirmed"); } catch (err) { setMsg(err?.message || String(err)); } };
  const endTime = order.durationMin ? addMinutes(order.time, order.durationMin) : "";
  return (
    <div data-testid="order-row" data-status={order.status} className={`border border-line rounded-lg bg-white ${open ? "" : ""} ${isSettled(order) && !open ? "opacity-70" : ""}`}>
      <div role="button" tabIndex={0} onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-page rounded-lg">
        <div className="shrink-0 w-[4.6rem] text-sm font-mono font-semibold text-ink leading-tight">
          {showDate && <span className="block text-xs font-sans font-normal text-muted">{fmtD(order.date)}</span>}
          {order.time}{endTime && <span className="block text-xs font-normal text-muted">–{endTime}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-sm text-ink truncate">{order.patientName}</span>
            <ArrivedBadge order={order} />
          </div>
          <div className="text-xs text-muted truncate">{order.exam?.label || "—"}{order.doctor ? ` · ${order.doctor}` : ""}</div>
        </div>
        <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${statusChip(order.status)}`}>{statuses[order.status] || order.status}</span>
        {canManage && order.status === "new" && !open && (
          <button type="button" onClick={confirm} className="shrink-0 bg-brand hover:bg-brand-dark text-white text-xs font-semibold px-3 py-1.5 rounded-lg">Potvrdiť</button>
        )}
        <span className="shrink-0 text-muted text-xs" aria-label={open ? "Zbaliť" : "Rozbaliť"}>{open ? "▴" : "▾"}</span>
      </div>
      {msg && <p className="px-3 pb-2 text-xs text-danger font-semibold">{msg}</p>}
      {open && <div className="px-2 pb-2"><AngioOrderCard order={order} data={data} canManage={canManage} embedded /></div>}
    </div>
  );
}

// ---------- Správa ambulancie ----------
// Správa ambulancie — zdieľaná aj CT pracoviskom (clinic="ct": bez spätných volaní, vlastné Nastavenia)
export function AngioAdmin({ data, role, clinic = "angio", SettingsView = AngioSettings }) {
  const canManage = role === "superadmin" || role === "sestra";
  const isSuper = role === "superadmin";
  const [tab, setTab] = useState("overview");
  const todayIso = toISODate(new Date());

  const [wFrom, setWFrom] = useState(todayIso), [wTo, setWTo] = useState(todayIso);
  const [wtFrom, setWtFrom] = useState("07:30"), [wtTo, setWtTo] = useState("14:30"), [wDoctor, setWDoctor] = useState("");
  const [selDay, setSelDay] = useState(todayIso);
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [fStatus, setFStatus] = useState("all"), [fText, setFText] = useState("");
  const [msg, setMsg] = useMsg();

  const [busyAll, setBusyAll] = useState(false);
  const run = async (fn, ok) => { setMsg(""); setBusyAll(true); try { await fn(); if (ok) setMsg(ok); } catch (e) { setMsg(e?.message || String(e)); } finally { setBusyAll(false); } };

  const active = data.orders.filter((o) => o.status !== "rejected");
  const pending = data.orders.filter((o) => o.status === "new" && o.date >= todayIso); // minulé „nové" už nie sú na potvrdenie
  const todayProgram = active.filter((o) => o.date === todayIso).sort(byPriority);
  const arrivedToday = todayProgram.filter((o) => o.arrivedAt && (o.status === "new" || o.status === "confirmed")).length;
  const in7Iso = (() => { const e = new Date(); e.setDate(e.getDate() + 6); return toISODate(e); })(); // dnes + 6 = 7 dní
  const next7 = active.filter((o) => o.date >= todayIso && o.date <= in7Iso).length;
  // filter rozsahu pre zoznam Objednávky (dlaždice v Prehľade naň odkazujú)
  const [fRange, setFRange] = useState("all"); // all | today | week | arrived
  const showList = (status, range) => { setFStatus(status); setFRange(range); setFText(""); setTab("orders"); };

  const takenMap = useMemo(() => { const m = new Map(); data.occupied.forEach(({ date: d, time: t }) => { if (!m.has(d)) m.set(d, new Set()); m.get(d).add(t); }); return m; }, [data.occupied]);
  const takenSet = (iso) => takenMap.get(iso) || new Set();
  const selectDay = (iso) => { setSelDay(iso); setWFrom(iso); setWTo(iso); const d = isoDate(iso); setMonthDate(new Date(d.getFullYear(), d.getMonth(), 1)); };
  const dayOpen = (data.openSlots[selDay] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
  const dayFree = dayOpen.filter((s) => !takenSet(selDay).has(s.time));
  const [freeOpen, setFreeOpen] = useState(false); // zoznam voľných 5-min buniek zbalený
  const [wSkipWeekends, setWSkipWeekends] = useState(true);
  const [cFrom, setCFrom] = useState("07:30"), [cTo, setCTo] = useState("14:30"); // zatvorenie rozsahu
  const dayOrders = active.filter((o) => o.date === selDay).sort(byPriority);
  const isAvailableAdmin = (iso) => (data.openSlots[iso] || []).length > 0;
  // deň ako bloky (objednávky + voľno), pacienti v čakárni hore, vybavení dole
  const day = daySegments(dayOpen, dayOrders);
  const isWaiting = (o) => !isSettled(o) && o.arrivedAt && selDay === todayIso; // čakáreň len dnes
  const waiting = dayOrders.filter(isWaiting);
  const settled = dayOrders.filter(isSettled);
  const timeline = day.segs.filter((x) => !x.order || (!isSettled(x.order) && !isWaiting(x.order)));
  const dayRange = dayOpen.length ? `${dayOpen[0].time}–${addMinutes(dayOpen[dayOpen.length - 1].time, 5)}` : "";
  useEffect(() => { // rozsah zatvorenia = skutočné otváracie hodiny dňa
    if (dayOpen.length) { setCFrom(dayOpen[0].time); setCTo(addMinutes(dayOpen[dayOpen.length - 1].time, 5)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selDay, dayOpen.length]);
  // náhľad otvorenia (rovnaké zarovnanie na 5 min ako openWindow)
  const align5 = (t) => { const [h, m] = String(t || "").split(":").map(Number); if (Number.isNaN(h) || Number.isNaN(m)) return t; const tot = Math.round((h * 60 + m) / 5) * 5; return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`; };
  const openPreview = (() => {
    const times = genSlots(align5(wtFrom), align5(wtTo), 5).length;
    let days = 0, past = false, weekendOnly = false;
    if (wFrom && wTo && wFrom <= wTo) {
      let d = wFrom; let guard = 0; let anyDay = 0;
      while (d <= wTo && guard++ < 370) { const dow = isoDate(d).getDay(); anyDay++; if (d >= todayIso && (!wSkipWeekends || (dow !== 0 && dow !== 6) || wFrom === wTo)) days++; d = addDays(d, 1); }
      past = wTo < todayIso; weekendOnly = !past && days === 0 && anyDay > 0;
    }
    return { days, times, cells: days * times, past, weekendOnly };
  })();
  const weekStart = mondayOf(selDay);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const dayStats = (iso) => {
    const open = (data.openSlots[iso] || []);
    const ords = active.filter((o) => o.date === iso);
    const taken = takenSet(iso);
    return { open: open.length, free: open.filter((c) => !taken.has(c.time)).length, patients: ords.length, waiting: ords.filter((o) => !isSettled(o) && o.arrivedAt).length };
  };
  const closeCells = (times, label) => { if (!times.length) return; if (!window.confirm(`Zavrieť ${label}?\nObjednaní pacienti ostávajú, zatvoria sa len voľné časy.`)) return; run(() => data.closeSlots(selDay, times), "✓ Termíny zavreté."); };
  const freeInRange = dayFree.filter((c) => c.time >= cFrom && c.time < cTo).map((c) => c.time);

  const filtered = data.orders
    .filter((o) => fStatus === "all" ? o.status !== "rejected" : o.status === fStatus)
    .filter((o) => fRange === "today" ? o.date === todayIso
      : fRange === "week" ? (o.date >= todayIso && o.date <= in7Iso)
      : fRange === "arrived" ? (o.date === todayIso && o.arrivedAt && (o.status === "new" || o.status === "confirmed"))
      : true)
    .filter((o) => { const q = fText.trim().toLowerCase(); if (!q) return true; const qd = q.replace(/\s/g, ""); return o.patientName.toLowerCase().includes(q) || o.id.toLowerCase().includes(q) || (o.phone || "").replace(/\s/g, "").includes(qd); })
    .sort(byPriority);

  const cbNew = data.newCallbackCount || 0;
  // lekár vidí cez RLS len vlastných pacientov — kalendár obsadenosti by mu klamal, preto ho nemá
  const tabs = [["overview", "Prehľad"], ...(canManage ? [["calendar", "Kalendár"]] : []), ["orders", "Objednávky"], ...(clinic === "angio" ? [["callbacks", cbNew > 0 ? `Spätné volania (${cbNew})` : "Spätné volania"]] : []), ...(canManage ? [["settings", "Nastavenia"]] : [])];
  const filterActive = fRange !== "all" || fStatus !== "all";
  const btn = "shrink-0 px-4 py-2 rounded-lg text-sm font-semibold transition-colors";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" onClick={() => { setTab(id); if (id === "orders" && tab !== "orders") { setFRange("all"); setFStatus("all"); } }} className={`${btn} ${tab === id ? "bg-brand text-white" : "bg-soft text-ink"}`}>{label}</button>
        ))}
        <button type="button" onClick={() => data.reload?.()} title="Načítať aktuálne dáta" className={`${btn} ml-auto bg-white border border-line text-muted hover:text-ink`} data-testid="reload">↻ Obnoviť</button>
      </div>
      {data.loadError && <p className="text-sm font-semibold text-danger" role="alert">Dáta sa nepodarilo načítať ({data.loadError}). Zobrazený stav nemusí byť aktuálny.</p>}
      {msg && !msg.startsWith("✓") && <p className="text-sm font-semibold text-danger" role="alert">{msg}</p>}

      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { n: todayProgram.length, label: "dnešný program", color: "text-brand", go: () => showList("all", "today"), id: "today" },
              { n: arrivedToday, label: "v čakárni", color: "text-success", go: () => showList("all", "arrived"), id: "arrived" },
              { n: pending.length, label: "nové (na potvrdenie)", color: "text-warn", go: () => showList("new", "all"), id: "new" },
              { n: next7, label: "objednaní — 7 dní", color: "text-brand", go: () => showList("all", "week"), id: "week" },
            ].map((t) => (
              <button key={t.id} type="button" data-testid={`stat-${t.id}`} onClick={t.go} title="Zobraziť zoznam"
                className="bg-white rounded-lg p-4 text-center hover:bg-soft hover:bg-page active:bg-brand-soft transition">
                <div className={`text-2xl font-semibold ${t.color}`}>{t.n}</div>
                <div className="text-xs text-muted">{t.label}</div>
                <div className="text-xs text-brand mt-1">zobraziť ›</div>
              </button>
            ))}
          </div>
          {cbNew > 0 && (
            <button type="button" data-testid="stat-callbacks" onClick={() => setTab("callbacks")}
              className="w-full text-left bg-warn-soft border border-warn/30 text-warn rounded-lg px-4 py-3 text-sm font-semibold hover:bg-warn-soft">
              📞 {cbNew === 1 ? "1 pacient prosí" : `${cbNew} pacienti prosia`} o zavolanie späť — zobraziť ›
            </button>
          )}
          <div className="bg-white rounded-xl border border-line p-5">
            <h3 className="text-lg font-semibold text-brand mb-3">Dnešný program</h3>
            {todayProgram.length === 0 ? <p className="text-sm text-muted">Dnes nie sú objednaní žiadni pacienti.</p>
              : <div className="space-y-1.5">{todayProgram.map((o) => <AngioOrderRow key={o.id} order={o} data={data} canManage={canManage} />)}</div>}
          </div>
        </div>
      )}

      {tab === "calendar" && (
        <div className="space-y-4">
          {/* týždeň: 7 dní s obsadenosťou, výber dňa */}
          <div className="bg-white rounded-xl border border-line p-3 md:p-4">
            <div className="flex items-center justify-between mb-2">
              <button type="button" onClick={() => selectDay(addDays(selDay, -7))} className="text-sm font-semibold text-brand px-2 py-1 rounded-lg hover:bg-brand-soft">‹ Predchádzajúci týždeň</button>
              <button type="button" onClick={() => selectDay(todayIso)} className="text-sm font-semibold text-brand px-3 py-1 rounded-lg border border-line hover:bg-brand-soft">Dnes</button>
              <button type="button" onClick={() => selectDay(addDays(selDay, 7))} className="text-sm font-semibold text-brand px-2 py-1 rounded-lg hover:bg-brand-soft">Nasledujúci týždeň ›</button>
            </div>
            <div className="grid grid-cols-7 gap-1 md:gap-2">
              {weekDays.map((iso) => {
                const st = dayStats(iso); const d = isoDate(iso); const sel = iso === selDay; const past = iso < todayIso;
                return (
                  <button key={iso} type="button" data-iso={iso} data-testid="week-day" onClick={() => selectDay(iso)}
                    className={`rounded-lg border p-1.5 md:p-2 text-left transition-colors ${sel ? "border-brand bg-brand-soft" : "border-line hover:bg-page"} ${past ? "opacity-60" : ""}`}>
                    <div className={`text-xs md:text-xs font-semibold ${iso === todayIso ? "text-brand" : "text-muted"}`}>{DOW_SHORT[d.getDay()]} {d.getDate()}.{d.getMonth() + 1}.{iso === todayIso ? " · dnes" : ""}</div>
                    {st.open === 0
                      ? <div className="text-xs text-muted mt-1">{st.patients ? `${st.patients} pac.` : "zatvorené"}</div>
                      : (<>
                        <div className="text-sm md:text-base font-semibold text-ink mt-0.5">{st.patients} <span className="text-xs font-normal text-muted">pac.</span></div>
                        <div className="h-1.5 rounded-lg bg-line mt-1 overflow-hidden"><div className="h-full bg-brand" style={{ width: `${Math.round(100 * (st.open - st.free) / st.open)}%` }} /></div>
                        <div className="text-xs text-muted mt-0.5">{st.free > 0 ? `voľné ${fmtDur(st.free * 5)}` : "plný"}{st.waiting ? ` · 🪑 ${st.waiting}` : ""}</div>
                      </>)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid md:grid-cols-[3fr_2fr] gap-4 items-start">
            {/* deň: čakáreň → nasledujúci + voľné bloky → vybavení */}
            <div className="bg-white rounded-xl border border-line p-4 md:p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <h3 className="text-lg font-semibold text-brand">{fmtLong(selDay)}</h3>
                <p className="text-xs text-muted">{dayOrders.length} {dayOrders.length === 1 ? "pacient" : dayOrders.length < 5 ? "pacienti" : "pacientov"}{dayRange ? ` · otvorené ${dayRange}` : ""} · {dayFree.length} voľných buniek{dayFree.length ? ` (${fmtDur(dayFree.length * 5)})` : ""}</p>
              </div>
              {dayOrders.length === 0 && dayOpen.length === 0 && (
                <div className="text-sm text-muted space-y-2">
                  <p>V tento deň nie sú otvorené termíny.</p>
                  {canManage && selDay >= todayIso && (
                    <button onClick={() => run(() => data.openWindow({ dateFrom: selDay, dateTo: selDay, timeFrom: wtFrom, timeTo: wtTo, doctor: wDoctor, skipWeekends: false }), "✓ Termíny otvorené.")}
                      className="bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-4 py-2 rounded-lg">
                      Otvoriť {wtFrom}–{wtTo}{wDoctor ? ` · ${wDoctor}` : ""}
                    </button>
                  )}
                </div>
              )}
              {waiting.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-success mb-1">V čakárni ({waiting.length})</p>
                  <div className="space-y-1.5">{waiting.map((o) => <AngioOrderRow key={o.id} order={o} data={data} canManage={canManage} />)}</div>
                </div>
              )}
              {timeline.length > 0 && (
                <div>
                  {waiting.length > 0 && <p className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">Program dňa</p>}
                  <div className="space-y-1.5">
                    {timeline.map((x) => x.order ? (
                      <div key={x.order.id}>
                        {x.outOfHours && <p className="text-xs text-warn pl-1">mimo otvorených hodín</p>}
                        <AngioOrderRow order={x.order} data={data} canManage={canManage} />
                      </div>
                    ) : (
                      <div key={`f-${x.start}`} data-testid="free-block" className="flex items-center gap-3 px-3 py-1.5 rounded-lg border border-dashed border-success/50 bg-success-soft/40 text-sm">
                        <span className="shrink-0 w-[6.6rem] font-mono text-success font-semibold whitespace-nowrap">{x.start}–{x.end}</span>
                        <span className="flex-1 text-muted truncate">voľné {fmtDur(x.cells.length * 5)}{x.doctor ? ` · ${x.doctor}` : " · ktorýkoľvek lekár"}</span>
                        {canManage && <button type="button" disabled={busyAll} title="Zavrieť blok" onClick={() => closeCells(x.cells, `voľný blok ${x.start}–${x.end} (${fmtDur(x.cells.length * 5)})`)} className="shrink-0 text-xs font-semibold text-muted hover:text-danger disabled:opacity-50 px-2 py-1 rounded-lg hover:bg-danger-soft">Zavrieť</button>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {settled.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">Vybavené ({settled.length})</p>
                  <div className="space-y-1.5">{settled.map((o) => <AngioOrderRow key={o.id} order={o} data={data} canManage={canManage} />)}</div>
                </div>
              )}
              {canManage && dayFree.length > 0 && (
                <div className="mt-3">
                  <button type="button" onClick={() => setFreeOpen((o) => !o)} className="text-xs text-muted hover:text-brand">
                    {freeOpen ? "▴ Skryť voľné bunky" : `▾ Voľné 5-min bunky (${dayFree.length}) — zavrieť jednotlivo`}
                  </button>
                  {freeOpen && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {dayFree.map((c) => (
                        <button key={c.time} onClick={() => run(() => data.closeSlot(selDay, c.time))} title="Zavrieť termín"
                          className="text-xs bg-success-soft border border-success/40 text-success rounded-lg px-2 py-1 hover:bg-danger-soft hover:border-danger/40 hover:text-danger">
                          {c.time} ✕
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* pravý stĺpec: mesiac, otvoriť, zatvoriť */}
            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-line p-3">
                <MonthCalendar monthDate={monthDate}
                  onMonthChange={(delta) => setMonthDate((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
                  isAvailable={isAvailableAdmin} isSelectable={() => true}
                  selected={selDay} onSelect={(iso) => selectDay(iso)} />
                <p className="text-xs text-muted mt-1 text-center">Modré dni majú otvorené termíny.</p>
              </div>
              {canManage && (
                <div className="bg-white rounded-xl border border-line p-4 space-y-3" data-testid="open-panel">
                  <h3 className="text-base font-semibold text-brand">Otvoriť termíny</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {[["Dopoludnie", "07:30", "12:00"], ["Celý deň", "07:30", "15:30"], ["Popoludnie", "12:00", "15:30"]].map(([l, f, t]) => (
                      <button key={l} type="button" onClick={() => { setWtFrom(f); setWtTo(t); }}
                        className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${wtFrom === f && wtTo === t ? "bg-brand text-white border-brand" : "border-line text-muted hover:bg-page"}`}>{l} {f}–{t}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs text-muted">Od dňa<input type="date" className={inp} value={wFrom} onChange={(e) => { setWFrom(e.target.value); if (e.target.value > wTo) setWTo(e.target.value); }} /></label>
                    <label className="text-xs text-muted">Do dňa<input type="date" className={inp} value={wTo} onChange={(e) => setWTo(e.target.value)} /></label>
                    <label className="text-xs text-muted">Od<input type="time" step={300} className={inp} value={wtFrom} onChange={(e) => setWtFrom(e.target.value)} /></label>
                    <label className="text-xs text-muted">Do<input type="time" step={300} className={inp} value={wtTo} onChange={(e) => setWtTo(e.target.value)} /></label>
                  </div>
                  <label className="block text-xs text-muted">Lekár
                    <select className={inp} value={wDoctor} onChange={(e) => setWDoctor(e.target.value)}>
                      <option value="">— ktorýkoľvek —</option>
                      {data.doctors.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                    </select>
                  </label>
                  {wFrom !== wTo && (
                    <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={wSkipWeekends} onChange={(e) => setWSkipWeekends(e.target.checked)} className="accent-brand" /> preskočiť soboty a nedele</label>
                  )}
                  <button type="button" disabled={busyAll || openPreview.cells === 0}
                    onClick={() => { if (openPreview.days > 10 && !window.confirm(`Otvoriť termíny na ${openPreview.days} dní?`)) return; run(() => data.openWindow({ dateFrom: wFrom, dateTo: wTo, timeFrom: wtFrom, timeTo: wtTo, doctor: wDoctor, skipWeekends: wFrom !== wTo && wSkipWeekends }), "✓ Termíny otvorené."); }}
                    className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold px-4 py-2 rounded-lg" data-testid="open-run">
                    {busyAll ? "Ukladám…" : openPreview.past ? "Minulé dni nemožno otvoriť" : openPreview.weekendOnly ? "V rozsahu nie sú pracovné dni" : openPreview.cells === 0 ? "Zadajte platný rozsah" : `Otvoriť ${openPreview.days === 1 ? "deň" : `${openPreview.days} ${openPreview.days < 5 ? "dni" : "dní"}`} · ${fmtDur(openPreview.times * 5)}${openPreview.days > 1 ? " denne" : ""}`}
                  </button>
                  <p className="text-xs text-muted">Už otvorené časy sa nemenia (ani lekár); ak treba zmeniť lekára, čas najprv zavrite. Dĺžku vyšetrenia určuje typ v Nastaveniach.</p>
                </div>
              )}
              {canManage && dayFree.length > 0 && (
                <div className="bg-white rounded-xl border border-line p-4 space-y-3" data-testid="close-panel">
                  <h3 className="text-base font-semibold text-ink">Zavrieť voľné termíny · {fmtD(selDay)}</h3>
                  <button type="button" disabled={busyAll} onClick={() => closeCells(dayFree.map((c) => c.time), `všetky voľné termíny ${fmtD(selDay)} (${fmtDur(dayFree.length * 5)})`)}
                    className="w-full bg-white border border-danger/40 text-danger hover:bg-danger-soft disabled:opacity-50 font-semibold px-4 py-2 rounded-lg text-sm" data-testid="close-all-free">
                    Zavrieť všetky voľné ({fmtDur(dayFree.length * 5)})
                  </button>
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                    <label className="text-xs text-muted">Od<input type="time" step={300} className={inp} value={cFrom} onChange={(e) => setCFrom(e.target.value)} /></label>
                    <label className="text-xs text-muted">Do<input type="time" step={300} className={inp} value={cTo} onChange={(e) => setCTo(e.target.value)} /></label>
                    <button type="button" disabled={busyAll || freeInRange.length === 0} onClick={() => closeCells(freeInRange, `voľné termíny ${cFrom}–${cTo} (${fmtDur(freeInRange.length * 5)})`)}
                      className="bg-soft hover:bg-line disabled:opacity-50 text-ink text-sm font-semibold px-3 py-2 rounded-lg" data-testid="close-range">Zavrieť</button>
                  </div>
                  <p className="text-xs text-muted">Zatvárajú sa len voľné časy; obsadené termíny pacientov ostávajú.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "orders" && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-line p-4 flex flex-wrap gap-2 items-center">
            <select className={inp + " w-auto"} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="all">Aktívne</option>
              <option value="new">Nové</option><option value="confirmed">Potvrdené</option>
              <option value="done">Vykonané</option><option value="noshow">Neprišiel</option><option value="rejected">Kôš (zrušené)</option>
            </select>
            <select className={inp + " w-auto"} value={fRange} onChange={(e) => setFRange(e.target.value)} data-testid="range-filter">
              <option value="all">Všetky dni</option>
              <option value="today">Dnes</option>
              <option value="week">Najbližších 7 dní</option>
              <option value="arrived">V čakárni (dnes)</option>
            </select>
            <input className={inp + " flex-1 min-w-[10rem]"} placeholder="Hľadať meno / číslo / telefón" value={fText} onChange={(e) => setFText(e.target.value)} />
            <span className="text-xs text-muted">{filtered.length} objednávok</span>
            {filterActive && <button type="button" onClick={() => { setFRange("all"); setFStatus("all"); }} className="text-xs font-semibold text-brand hover:underline" data-testid="filter-reset">zrušiť filter ✕</button>}
          </div>
          {filtered.length === 0 ? <p className="text-sm text-muted">Žiadne objednávky.</p>
            : <div className="space-y-1.5">{filtered.map((o) => <AngioOrderRow key={o.id} order={o} data={data} canManage={canManage} showDate />)}</div>}
        </div>
      )}

      {tab === "callbacks" && clinic === "angio" && <AngioCallbacks data={data} canManage={canManage} />}
      {tab === "settings" && canManage && <SettingsView data={data} isSuper={isSuper} />}
    </div>
  );
}

// ---------- Spätné volania („Zavolajte mi späť", angio-013) ----------
// +421 949 123 456 z normalizovaného čísla (len číslice) — zobrazuje sa overené číslo, nie surový vstup pacienta
const fmtIntlPhone = (n) => (n && /^\d{11,15}$/.test(n) ? `+${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}` : "");
const CB_STATUSES = { new: "Nová", called: "Volané", booked: "Objednaný", unreachable: "Nedovolali sme sa", closed: "Uzavreté" };
const cbChip = (s) => s === "new" ? "bg-warn-soft text-warn" : s === "booked" ? "bg-success-soft text-success" : s === "unreachable" ? "bg-danger-soft text-danger" : "bg-soft text-muted";
function AngioCallbackRow({ cb, data, canManage }) {
  const [status, setStatus] = useState(cb.status);
  const [note, setNote] = useState(cb.statusNote || "");
  const [msg, setMsg] = useMsg();
  useEffect(() => { setStatus(cb.status); setNote(cb.statusNote || ""); }, [cb.status, cb.statusNote]);
  const dirty = status !== cb.status || note !== (cb.statusNote || "");
  const save = async () => { setMsg(""); try { await data.setCallbackStatus(cb.id, status, note); setMsg("✓ Uložené."); } catch (e) { setMsg(e?.message || String(e)); } };
  const when = cb.createdAt ? new Date(cb.createdAt) : null;
  const whenTxt = when ? `${fmtD(toISODate(when))} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}` : "";
  const prefTxt = cb.pref === "dopoludnia" ? "dopoludnia" : cb.pref === "popoludni" ? "popoludní" : "";
  return (
    <div data-testid="callback-row" className="border border-line rounded-lg bg-white p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{cb.patientName}</span>
        <a href={`tel:${cb.phoneNorm ? "+" + cb.phoneNorm : cb.phone}`} className="font-mono font-semibold text-brand hover:underline" data-testid="callback-phone">{fmtIntlPhone(cb.phoneNorm) || cb.phone}</a>
        {prefTxt && <span className="text-xs text-muted">volať {prefTxt}</span>}
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cbChip(cb.status)}`}>{CB_STATUSES[cb.status] || cb.status}</span>
        <span className="ml-auto text-xs text-muted">{whenTxt}{cb.source === "zachrannohu" ? " · Zachráň nohu" : ""} · {cb.id}</span>
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2 items-center">
          <select className="p-2 bg-white border border-line rounded-lg text-sm" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="callback-status">
            {Object.entries(CB_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className="flex-1 min-w-[12rem] p-2 bg-white border border-line rounded-lg text-sm" placeholder="Poznámka (napr. objednaný na 20.10. 9:00, číslo objednávky)" value={note} onChange={(e) => setNote(e.target.value)} data-testid="callback-note" />
          <button type="button" onClick={save} disabled={!dirty} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť</button>
          {msg && <span className={`text-xs font-semibold ${msg.startsWith("✓") ? "text-success" : "text-danger"}`}>{msg}</span>}
        </div>
      )}
      {!canManage && cb.statusNote && <p className="text-xs text-muted">{cb.statusNote}</p>}
    </div>
  );
}
function AngioCallbacks({ data, canManage }) {
  const [onlyOpen, setOnlyOpen] = useState(true);
  const list = (data.callbacks || []).filter((c) => (onlyOpen ? c.status === "new" || c.status === "called" || c.status === "unreachable" : true));
  return (
    <div className="bg-white rounded-xl border border-line p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-brand">Spätné volania</h3>
        <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} data-testid="callbacks-only-open" /> len nevybavené
        </label>
      </div>
      <p className="text-xs text-muted">Pacienti, ktorí nezvládli online objednanie a nechali nám číslo (stránka Zachráň nohu / angio). Sľúbili sme im hovor najneskôr nasledujúci pracovný deň. Po hovore zmeňte stav a objednajte ich cez stránku objednávania.</p>
      {list.length === 0 ? <p className="text-sm text-muted" data-testid="callbacks-empty">{onlyOpen ? "Žiadne nevybavené žiadosti." : "Zatiaľ žiadne žiadosti."}</p>
        : <div className="space-y-2">{list.map((cb) => <AngioCallbackRow key={cb.id} cb={cb} data={data} canManage={canManage} />)}</div>}
    </div>
  );
}

// ---------- Nastavenia (typy vyšetrení + lekári) ----------
function AngioSettings({ data, isSuper }) {
  const [exams, setExamsRaw] = useState(() => data.pricelist.map((p) => ({ ...p })));
  const [docs, setDocsRaw] = useState(() => normalizeDoctors(data.doctors));
  // Supabase: dáta prídu asynchrónne — kým personál nič nezmenil, formulár sleduje načítané hodnoty;
  // uložiť sa dá až po načítaní (inak by sa prepísal skutočný cenník predvoleným)
  const [dirty, setDirty] = useState({ exams: false, docs: false });
  const setExams = (v) => { setDirty((d) => ({ ...d, exams: true })); setExamsRaw(v); };
  const setDocs = (v) => { setDirty((d) => ({ ...d, docs: true })); setDocsRaw(v); };
  const examsKey = JSON.stringify(data.pricelist), docsKey = JSON.stringify(data.doctors);
  useEffect(() => { if (!dirty.exams) setExamsRaw(data.pricelist.map((p) => ({ ...p }))); }, [examsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!dirty.docs) setDocsRaw(normalizeDoctors(data.doctors)); }, [docsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [msg, setMsg] = useMsg();
  const slug = () => "ang_" + Math.random().toString(36).slice(2, 10);
  // presun typu v zozname (poradie = sort_order = poradie pre pacienta)
  const move = (i, d) => setExams((p) => { const j = i + d; if (j < 0 || j >= p.length) return p; const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const saveExams = () => { setMsg(""); data.savePricelist(exams.filter((e) => e.label.trim())).then(() => { setMsg("✓ Typy vyšetrení uložené."); setDirty((d) => ({ ...d, exams: false })); }).catch((e) => setMsg(e.message)); };
  const saveDocs = () => { setMsg(""); data.saveDoctors(docs.filter((d) => d.name.trim())).then(() => { setMsg("✓ Lekári uložení."); setDirty((d) => ({ ...d, docs: false })); }).catch((e) => setMsg(e.message)); };
  const [notes, setNotes] = useState(() => data.notes || "");
  useEffect(() => { setNotes(data.notes || ""); }, [data.notes]); // Supabase: hodnota príde asynchrónne
  const [smsVerify, setSmsVerify] = useState(() => !!data.smsVerify);
  useEffect(() => { setSmsVerify(!!data.smsVerify); }, [data.smsVerify]);
  const saveSmsVerifyClick = () => { setMsg(""); data.saveSmsVerify(smsVerify).then(() => setMsg(smsVerify ? "✓ Overovanie telefónu zapnuté." : "✓ Overovanie telefónu vypnuté.")).catch((e) => setMsg(e.message)); };
  const saveNotesClick = () => { setMsg(""); data.saveNotes(notes).then(() => setMsg("✓ Spoločné pokyny uložené.")).catch((e) => setMsg(e.message)); };
  const [cbSmsTo, setCbSmsTo] = useState(() => data.callbackSmsTo || "");
  useEffect(() => { setCbSmsTo(data.callbackSmsTo || ""); }, [data.callbackSmsTo]);
  const saveCbSmsToClick = () => { setMsg(""); data.saveCallbackSmsTo(cbSmsTo).then(() => setMsg("✓ Mobil pre SMS uložený.")).catch((e) => setMsg(e.message)); };

  return (
    <div className="space-y-5">
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-success" : "text-danger"}`}>{msg}</p>}

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">Typy vyšetrení / návštev</h3>
        <p className="text-xs text-muted">Poradie v zozname je poradie, v akom typy uvidí pacient — šípkami ▲▼ ho zmeníte a uložte.</p>
        {exams.map((e, i) => (
          <div key={e.id} className="border border-line rounded-lg p-3 space-y-2">
            <div className="flex gap-2">
              <input className={inp} placeholder="Názov vyšetrenia" value={e.label} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, label: ev.target.value } : x))} />
              <label className="text-sm shrink-0">Trvanie<br />
                <select className={inp} value={e.durationSlots} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, durationSlots: Number(ev.target.value) } : x))}>
                  {[2, 3, 4, 5, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n * 5} min</option>)}
                </select>
              </label>
              <div className="flex flex-col shrink-0 self-start pt-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Posunúť vyššie" aria-label="Posunúť vyššie" className="text-muted hover:text-brand text-xs leading-none px-1 py-0.5 disabled:opacity-50">▲</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === exams.length - 1} title="Posunúť nižšie" aria-label="Posunúť nižšie" className="text-muted hover:text-brand text-xs leading-none px-1 py-0.5 disabled:opacity-50">▼</button>
              </div>
              <button onClick={() => setExams((p) => p.filter((_, j) => j !== i))} className="text-danger text-sm shrink-0 self-start pt-2">✕</button>
            </div>
            <input className={inp} placeholder="Krátky popis (jeden riadok) — pacient ho vidí pri výbere vyšetrenia" value={e.description || ""} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, description: ev.target.value } : x))} />
            <textarea className={inp} rows={e.about && e.about.length > 200 ? 8 : 3} placeholder="Popis vyšetrenia — čo to je, pre koho, trvanie, priebeh. Pacient ho vidí na stránke po rozkliknutí ‚Viac o vyšetrení‘ (do e-mailu nejde)" value={e.about || ""} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, about: ev.target.value } : x))} />
            <textarea className={inp} rows={e.instructions && e.instructions.length > 200 ? 8 : 3} placeholder="Pokyny do e-mailu — len praktické veci: Čo priniesť, Príprava… Pacient ich dostane v potvrdzovacom e-maili a v pripomienke" value={e.instructions} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, instructions: ev.target.value } : x))} />
            <p className="text-xs text-muted">Formátovanie (popis aj pokyny): riadok končiaci dvojbodkou = tučný nadpis (napr. „Čo priniesť:"), riadky začínajúce „- " = odrážky, prázdny riadok = nový odsek.</p>
            <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
              <input type="checkbox" checked={e.requiresReferral !== false} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, requiresReferral: ev.target.checked } : x))} />
              Vyžaduje žiadanku (výmenný lístok) — pacient ju musí priložiť pri objednaní
            </label>
          </div>
        ))}
        <button onClick={() => setExams((p) => [...p, { id: slug(), label: "", description: "", about: "", instructions: "", requiresReferral: true, durationSlots: 3 }])} className="bg-soft text-ink text-sm font-semibold px-4 py-2 rounded-lg">+ Pridať vyšetrenie</button>
        <div><button type="button" onClick={saveExams} disabled={data.loading} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť typy vyšetrení</button></div>
      </div>

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">Spoločné pokyny pre pacientov</h3>
        <p className="text-xs text-muted">Jeden pokyn na riadok. Pacient ich dostane v potvrdzovacom e-maili, pri zmene termínu a v pripomienke deň vopred — na stránke sa nezobrazujú. Platia pre všetky typy vyšetrení.</p>
        {!isSuper && <p className="text-xs text-warn">Spoločné pokyny môže meniť len superadmin.</p>}
        <textarea className={inp} rows={8} placeholder="Napr. Príďte 10 minút pred termínom…" value={notes} onChange={(ev) => setNotes(ev.target.value)} disabled={!isSuper} />
        {isSuper && <div><button onClick={saveNotesClick} className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť spoločné pokyny</button></div>}
      </div>

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">Overovanie telefónu SMS kódom</h3>
        <p className="text-xs text-muted">Pacient si pred odoslaním objednávky nechá poslať 6-miestny kód SMS a zadá ho — objednávka bez overeného čísla neprejde. Kód platí 10 minút, max. 3 SMS na číslo za 15 minút. Personál overenie nepotrebuje. (Vyžaduje spustený angio-005.sql a kľúče SMS brány.)</p>
        <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
          <input type="checkbox" data-testid="sms-verify-toggle" checked={smsVerify} onChange={(ev) => setSmsVerify(ev.target.checked)} disabled={!isSuper} />
          Vyžadovať overenie telefónneho čísla SMS kódom pri objednaní
        </label>
        {!isSuper && <p className="text-xs text-warn">Overovanie môže zapnúť/vypnúť len superadmin.</p>}
        {isSuper && <div><button onClick={saveSmsVerifyClick} className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť overovanie</button></div>}
      </div>

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">Spätné volania — mobil pre SMS</h3>
        <p className="text-xs text-muted">Keď pacient na stránke nechá číslo („Zavolajte mi späť"), príde SMS na tento mobil a e-mail na kópiu objednávok. Prázdne = SMS sa neposiela, e-mail áno. (Vyžaduje spustený angio-013.sql.)</p>
        <input className={inp} type="tel" placeholder="napr. 0949 000 677" value={cbSmsTo} onChange={(ev) => setCbSmsTo(ev.target.value)} disabled={!isSuper} data-testid="callback-sms-to" />
        {!isSuper && <p className="text-xs text-warn">Mobil môže zmeniť len superadmin.</p>}
        {isSuper && <div><button onClick={saveCbSmsToClick} className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť mobil</button></div>}
      </div>

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">Lekári ambulancie</h3>
        {!isSuper && <p className="text-xs text-warn">Zoznam lekárov môže meniť len superadmin.</p>}
        {docs.map((d, i) => (
          <div key={i} className="border border-line rounded-lg p-3 space-y-2">
            <div className="flex gap-2">
              <input className={inp} placeholder="MUDr. Meno Priezvisko" value={d.name} onChange={(e) => setDocs((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} disabled={!isSuper} />
              <button onClick={() => setDocs((p) => p.filter((_, j) => j !== i))} className="text-danger text-sm shrink-0 self-start pt-2" disabled={!isSuper}>✕</button>
            </div>
            <input className={inp} placeholder="Ambulancia / miesto" value={d.location} onChange={(e) => setDocs((p) => p.map((x, j) => j === i ? { ...x, location: e.target.value } : x))} disabled={!isSuper} />
            <div className="flex flex-wrap gap-2">
              {data.pricelist.map((ex) => {
                const on = (d.examTypeIds || []).includes(ex.id);
                return (
                  <button key={ex.id} disabled={!isSuper}
                    onClick={() => setDocs((p) => p.map((x, j) => j === i ? { ...x, examTypeIds: on ? x.examTypeIds.filter((t) => t !== ex.id) : [...(x.examTypeIds || []), ex.id] } : x))}
                    className={`text-xs px-2 py-1 rounded-lg border ${on ? "bg-brand text-white border-brand" : "bg-white text-muted border-line"}`}>{ex.label}</button>
                );
              })}
            </div>
            <p className="text-xs text-muted">Ak nevyberiete žiadne, lekár robí všetky.</p>
          </div>
        ))}
        {isSuper && <button onClick={() => setDocs((p) => [...p, { name: "", email: "", location: "", examTypeIds: [] }])} className="bg-soft text-ink text-sm font-semibold px-4 py-2 rounded-lg">+ Pridať lekára</button>}
        {isSuper && <div><button type="button" onClick={saveDocs} disabled={data.loading} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť lekárov</button></div>}
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
  // vstup s jedným vyšetrením: #/angio1/zachrannohu
  const landingKey = (hash.match(/^#\/angio1\/([a-z0-9-]+)\/?$/) || [])[1];
  const landing = landingKey && landingKey !== "objednavka" && landingKey !== "sprava" ? ANGIO_LANDINGS[landingKey] || null : null;
  const landingExam = findLandingExam(landing, data.pricelist);
  if (landing && landingExam) {
    return (
      <ZachranNohuLanding landing={landing} exam={landingExam} requestCallback={data.requestCallback}>
        {data.loading ? <div className="bg-white rounded-xl border border-line p-6 text-center text-muted">Načítavam voľné termíny…</div> : <AngioBookingView data={data} landing={landing} />}
        <AngioOrderLookup data={data} initialId={orderLinkId} />
      </ZachranNohuLanding>
    );
  }
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-xl bg-brand-dark text-white p-6 md:p-8 border border-line">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
          <p className="text-xs md:text-xs font-semibold tracking-wide text-white/70 uppercase">Národný ústav srdcových a cievnych chorôb, a.s.</p>
          <a href="#/" className="text-xs font-semibold text-white/90 hover:text-white hover:underline whitespace-nowrap">← Objednávanie na USG</a>
        </div>
        <h1 className="text-2xl md:text-3xl font-semibold leading-tight">{CLINIC_NAME}</h1>
        <p className="text-sm text-white/90 mt-2 max-w-xl">
          Online objednanie na angiologické vyšetrenie. Vyšetrenie je <b>bez poplatku</b> — hradí ho zdravotná poisťovňa,
          preto je pri väčšine vyšetrení potrebná žiadanka (výmenný lístok) od vášho lekára. Termín si vyberiete sami, potvrdenie príde e-mailom.
        </p>
      </div>
      {data.loading ? <div className="bg-white rounded-xl border border-line p-6 text-center text-muted">Načítavam voľné termíny…</div> : <AngioBookingView data={data} landing={null} />}
      <section id="zavolame" className="scroll-mt-16"><CallbackCard onRequest={data.requestCallback} source="angio1" /></section>
      <AngioOrderLookup data={data} initialId={orderLinkId} />
    </div>
  );
}

// Správa ambulancie (za prihlásením personálu)
export function AngioAdminApp({ role = "superadmin", backHref = "#/sprava" }) {
  const data = useAngioData(true);
  return (
    <div className="space-y-4">
      <div className="bg-brand-soft border border-line text-brand rounded-lg px-4 py-3 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
        <span>{CLINIC_NAME} — správa objednávok{data.pendingCount > 0 ? ` · nové na potvrdenie: ${data.pendingCount}` : ""}</span>
        <a href={backHref} className="hover:underline">← Späť do správy USG</a>
      </div>
      <AngioAdmin data={data} role={role} />
    </div>
  );
}
