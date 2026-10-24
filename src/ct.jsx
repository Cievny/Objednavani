import { useState, useMemo } from "react";
import { useMsg } from "./toast.jsx";
import {
  MonthCalendar, toISODate, earliestTimeFor, genSlots, computeOfferedSlots, firstPatientIso, PATIENT_LEAD_NOTE,
  normalizeDoctors, doctorDoesExam, addMinutes, BASE_SLOT_MIN,
  insuranceOptions, validateBirthNumber, normalizePhone, ArrivedBadge, BirthDateInput,
} from "./booking.jsx";
import { useCtData } from "./podappkyData.js";
import { ConsentAck } from "./legal.jsx";
import { fmtLong, AngioAdmin } from "./angio.jsx";

const newCtId = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b = new Uint8Array(10); (window.crypto || window.msCrypto).getRandomValues(b);
  let s = ""; for (let i = 0; i < b.length; i++) s += abc[b[i] % 32];
  return "CT-" + s;
};
import { inputSmCls as inp } from "./ui.jsx";
const ctStatuses = { new: "Nová", confirmed: "Potvrdená", done: "Vykonané", noshow: "Nedostavil sa", rejected: "Zrušená" };

// všetky platné začiatky pre daný deň (súvislé voľné bunky jedného lekára,
// dosť za sebou na trvanie) — pre presun personálom
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

// ---------- Pacientske objednávanie na CT ----------
function CtBookingView({ data }) {
  const [step, setStep] = useState(1);
  const [examTypeId, setExamTypeId] = useState("");
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

  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); clearErr(k); };

  const submit = async () => {
    // validácia VŠETKÝCH polí naraz — chybné polia sa zvýraznia súčasne
    const e = {};
    if (form.name.trim().length < 3) e.name = "Zadajte meno a priezvisko.";
    if (!form.birthDate) e.birthDate = "Zadajte dátum narodenia.";
    if (form.phone.replace(/\D/g, "").length < 9) e.phone = "Neplatné telefónne číslo (aspoň 9 číslic).";
    if (!form.email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) e.email = "Zadajte platný e-mail.";
    if (files.length === 0) e.files = "Priložte žiadanku (výmenný lístok) — môžete ju odfotiť.";
    if (!ack) e.ack = "Potvrďte, prosím, že ste sa oboznámili s podmienkami a informáciami o spracúvaní osobných údajov.";
    setErrs(e);
    if (Object.keys(e).length > 0) { setMsg("Skontrolujte a doplňte zvýraznené polia."); return; }
    setBusy(true); setMsg("");
    try {
      const id = newCtId();
      await data.createOrder({ id, examTypeId, patientName: form.name.trim(), birthDate: form.birthDate || null,
        insurance: form.insurance, phone: normalizePhone(form.phone), email: form.email.trim(), reason: form.reason.trim(), date, time }, files);
      setDone({ id, date, time, label: examType?.label });
      setFiles([]);
    } catch (err) {
      const m = err?.message || String(err);
      setMsg(m);
      if (err?.code === "SLOT_TAKEN" || /obsaden/i.test(m)) { setStep(2); setTime(""); }
    } finally { setBusy(false); }
  };
  const ic = (k) => inp + (errs[k] ? " border-danger/40 ring-1 ring-danger/40" : "");
  const Err = ({ k }) => errs[k] ? <p className="text-xs text-danger mt-1">{errs[k]}</p> : null;

  if (done) {
    return (
      <div className="bg-white rounded-xl border border-line p-6 text-center">
        <h2 className="text-xl font-semibold text-success mb-2">Objednávka na CT je prijatá</h2>
        <p className="text-ink">{done.label}</p>
        <p className="text-ink">Termín: <b>{fmtLong(done.date)} o {done.time}</b></p>
        <p className="text-ink mb-1">Číslo objednávky: <b className="font-mono">{done.id}</b></p>
        <p className="text-sm text-muted mt-3">CT vyšetrenie je bez poplatku. Potvrdenie sme poslali e-mailom. Príďte, prosím, 10 minút pred termínom so žiadankou.</p>
        <p className="text-xs text-muted mt-2">Zrušenie termínu vybavíte v sekcii „Už máte CT objednávku?“ (číslo objednávky + telefón).</p>
        <div className="flex flex-wrap justify-center gap-2 mt-5">
          <button type="button" onClick={() => { setDone(null); setStep(1); setExamTypeId(""); setDate(""); setTime(""); setForm({ name: "", birthDate: "", insurance: "25", phone: "", email: "", reason: "" }); setAck(false); setErrs({}); }}
            className="bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-4 py-2 rounded-lg">Nová objednávka</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-line p-5 md:p-6 space-y-5">
      <h2 className="text-xl font-semibold text-brand">Objednanie na CT vyšetrenie <span className="text-sm font-normal text-muted">(bez poplatku)</span></h2>

      {step === 1 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-ink">Vyberte typ vyšetrenia</p>
          {data.pricelist.length === 0 && <p className="text-sm text-muted">Zatiaľ nie sú nastavené žiadne typy CT vyšetrení.</p>}
          {data.pricelist.map((p) => (
            <button key={p.id} onClick={() => { setExamTypeId(p.id); setStep(2); setDate(""); setTime(""); }}
              className={`w-full text-left border-2 rounded-lg p-3 transition-colors ${examTypeId === p.id ? "border-brand bg-brand-soft" : "border-line hover:border-brand/50"}`}>
              <span className="font-semibold text-ink">{p.label}</span>
              <span className="block text-xs text-muted mt-1">Trvanie ~{p.durationSlots * 5} min</span>
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <button onClick={() => setStep(1)} className="text-sm text-brand hover:underline">← Zmeniť vyšetrenie</button>
          <p className="text-sm text-muted">Vybrané: <b>{examType?.label}</b></p>
          <div className="grid md:grid-cols-2 gap-5">
            <div>
              <MonthCalendar monthDate={monthDate}
                onMonthChange={(delta) => setMonthDate((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
                isAvailable={isAvailable} selected={date} onSelect={(iso) => { setDate(iso); setTime(""); }} />
              <p data-testid="lead-note" className="text-xs text-muted mt-2">{PATIENT_LEAD_NOTE}</p>
            </div>
            <div>
              <p className="text-sm font-semibold text-ink mb-2">{date ? `Voľné časy — ${fmtLong(date)}` : "Vyberte deň"}</p>
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
          {time && <button onClick={() => setStep(3)} className="bg-brand hover:bg-brand-dark text-white font-semibold py-3 px-5 rounded-lg">Pokračovať</button>}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <button onClick={() => setStep(2)} className="text-sm text-brand hover:underline">← Späť na termín</button>
          <p className="text-sm text-muted"><b>{examType?.label}</b> · {date} o {time}</p>
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
          {/* Nahrávanie žiadanky — pri CT povinné */}
          <div className={errs.files ? "border border-danger/40 bg-danger-soft rounded-lg p-3" : "border border-warn/30 bg-warn-soft rounded-lg p-3"}>
            <label className="block text-xs font-semibold text-muted mb-1">Žiadanka (výmenný lístok) — odfoťte alebo nahrajte * <span className="font-normal text-muted">(PDF, JPG, PNG — max 3 súbory po 5 MB)</span></label>
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
          <ConsentAck checked={ack} onChange={(v) => { setAck(v); clearErr("ack"); }} error={errs.ack} testId="ct-ack" />
          {msg && <p className="text-sm text-danger font-semibold">{msg}</p>}
          <button onClick={submit} disabled={busy} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-3 px-5 rounded-lg">
            {busy ? "Odosielam…" : "Objednať sa (bez poplatku)"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Overenie / zrušenie CT objednávky pacientom ----------
function CtOrderLookup({ data }) {
  const [id, setId] = useState("");
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
    if (!window.confirm("Naozaj zrušiť CT objednávku?")) return;
    setBusy(true); setMsg("");
    try {
      const ok = await data.cancelOrder(found.id, phone.trim());
      if (ok === false) throw new Error("Objednávku sa nepodarilo zrušiť — skontrolujte číslo a telefón.");
      setFound({ ...found, status: "rejected" });
    }
    catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-line p-5 md:p-6 space-y-3">
      <h3 className="text-lg font-semibold text-brand">Už máte CT objednávku?</h3>
      <p className="text-sm text-muted">Zadajte číslo objednávky (CT-…) a telefón, ktorý ste uviedli.</p>
      <div className="grid md:grid-cols-2 gap-3">
        <input className={inp} placeholder="Číslo objednávky (CT-…)" aria-label="Číslo objednávky" value={id} onChange={(e) => { setId(e.target.value); setFound(null); setMsg(""); }} />
        <input className={inp} type="tel" inputMode="tel" autoComplete="tel" placeholder="Telefón zadaný pri objednávke" aria-label="Telefón zadaný pri objednávke" value={phone} onChange={(e) => { setPhone(e.target.value); setFound(null); setMsg(""); }} />
      </div>
      <button onClick={search} disabled={busy} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-2.5 px-5 rounded-lg">
        {busy ? "Hľadám…" : "Vyhľadať"}
      </button>
      {msg && <p className="text-sm text-danger font-semibold" role="alert">{msg}</p>}
      {found && (
        <div className="border border-line rounded-lg p-4 space-y-1">
          <p className="text-sm"><b>{found.id}</b> — <span className="font-semibold">{ctStatuses[found.status] || found.status}</span></p>
          <p className="text-sm text-muted">Termín: <b>{fmtLong(found.date)} o {found.time}</b>{found.doctor ? ` · ${found.doctor}` : ""}</p>
          {(found.status === "new" || found.status === "confirmed") && (
            <button onClick={cancel} disabled={busy} className="mt-2 bg-white border border-danger/40 text-danger text-sm font-semibold px-4 py-2 rounded-lg hover:bg-danger-soft">
              Zrušiť objednávku
            </button>
          )}
          {found.status === "rejected" && <p className="text-sm text-warn">Objednávka je zrušená.</p>}
        </div>
      )}
    </div>
  );
}

// ---------- Karta CT objednávky (správa) ----------
// Karta a správa CT: od v112 sa používa zdieľaná správa z angio.jsx (AngioAdmin, clinic="ct").

function CtSettings({ data, isSuper }) {
  const [exams, setExams] = useState(() => data.pricelist.map((p) => ({ ...p })));
  const [docs, setDocs] = useState(() => normalizeDoctors(data.doctors));
  const [msg, setMsg] = useMsg();
  const slug = () => "ct_" + Math.random().toString(36).slice(2, 10);
  // presun typu v zozname (poradie = sort_order = poradie pre pacienta)
  const move = (i, d) => setExams((p) => { const j = i + d; if (j < 0 || j >= p.length) return p; const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const saveExams = () => { setMsg(""); data.savePricelist(exams.filter((e) => e.label.trim())).then(() => setMsg("✓ Typy CT vyšetrení uložené.")).catch((e) => setMsg(e.message)); };
  const saveDocs = () => { setMsg(""); data.saveDoctors(docs.filter((d) => d.name.trim())).then(() => setMsg("✓ CT lekári uložení.")).catch((e) => setMsg(e.message)); };

  return (
    <div className="space-y-5">
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-success" : "text-danger"}`}>{msg}</p>}

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">Typy CT vyšetrení</h3>
        <p className="text-xs text-muted">Poradie v zozname je poradie, v akom typy uvidí pacient — šípkami ▲▼ ho zmeníte a uložte.</p>
        {exams.map((e, i) => (
          <div key={e.id} className="border border-line rounded-lg p-3 space-y-2">
            <div className="flex gap-2">
              <input className={inp} placeholder="Názov vyšetrenia" value={e.label} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, label: ev.target.value } : x))} />
              <label className="text-sm shrink-0">Trvanie<br />
                <select className={inp} value={e.durationSlots} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, durationSlots: Number(ev.target.value) } : x))}>
                  {[2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n * 5} min</option>)}
                </select>
              </label>
              <div className="flex flex-col shrink-0 self-start pt-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Posunúť vyššie" aria-label="Posunúť vyššie" className="text-muted hover:text-brand text-xs leading-none px-1 py-0.5 disabled:opacity-50">▲</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === exams.length - 1} title="Posunúť nižšie" aria-label="Posunúť nižšie" className="text-muted hover:text-brand text-xs leading-none px-1 py-0.5 disabled:opacity-50">▼</button>
              </div>
              <button onClick={() => setExams((p) => p.filter((_, j) => j !== i))} className="text-danger text-sm shrink-0 self-start pt-2">✕</button>
            </div>
            <textarea className={inp} rows={2} placeholder="Pokyny / príprava" value={e.instructions} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, instructions: ev.target.value } : x))} />
          </div>
        ))}
        <button onClick={() => setExams((p) => [...p, { id: slug(), label: "", instructions: "", durationSlots: 3 }])} className="bg-soft text-ink text-sm font-semibold px-4 py-2 rounded-lg">+ Pridať vyšetrenie</button>
        <div><button onClick={saveExams} className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť typy vyšetrení</button></div>
      </div>

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">CT lekári</h3>
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
        {isSuper && <div><button onClick={saveDocs} className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť lekárov</button></div>}
      </div>
    </div>
  );
}

export default function CtApp({ isStaff, role = "superadmin", doctorName = "" }) {
  const [view, setView] = useState("admin");
  const data = useCtData(isStaff);
  const btn = "px-4 py-2 rounded-lg text-sm font-semibold transition-colors";
  return (
    <div className="space-y-4">
      <div className="bg-warn-soft border border-warn/30 text-warn rounded-lg px-4 py-3 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
        <span>Testovacia sekcia — CT objednávanie (bez poplatku). Nie je verejná.</span>
        <a href="#/sprava" className="text-brand hover:underline">← Späť do správy</a>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setView("admin")} className={`${btn} ${view === "admin" ? "bg-brand text-white" : "bg-soft text-ink"}`}>Správa</button>
        <button onClick={() => setView("book")} className={`${btn} ${view === "book" ? "bg-brand text-white" : "bg-soft text-ink"}`}>Objednať sa (náhľad)</button>
        <button onClick={() => setView("lookup")} className={`${btn} ${view === "lookup" ? "bg-brand text-white" : "bg-soft text-ink"}`}>Overiť objednávku</button>
      </div>
      {view === "admin" ? <AngioAdmin data={data} role={role} clinic="ct" SettingsView={CtSettings} doctorName={doctorName} />
        : view === "lookup" ? <CtOrderLookup data={data} />
        : <><CtBookingView data={data} /><CtOrderLookup data={data} /></>}
    </div>
  );
}
