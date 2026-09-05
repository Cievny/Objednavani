import { useState, useMemo } from "react";
import {
  MonthCalendar, toISODate, earliestTimeFor, genSlots, computeOfferedSlots,
  normalizeDoctors, doctorDoesExam, addMinutes, BASE_SLOT_MIN,
  insuranceOptions, validateBirthNumber, normalizePhone, ArrivedBadge,
} from "./booking.jsx";
import { useCtData } from "./podappkyData.js";

const newCtId = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b = new Uint8Array(10); (window.crypto || window.msCrypto).getRandomValues(b);
  let s = ""; for (let i = 0; i < b.length; i++) s += abc[b[i] % 32];
  return "CT-" + s;
};
const inp = "w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 text-sm focus:ring-2 focus:ring-[#2B46A2] outline-none";
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
  const [msg, setMsg] = useState("");
  const [errs, setErrs] = useState({});
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
  const isAvailable = (iso) => iso >= todayIso && freeSlotsFor(iso).length > 0;

  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); clearErr(k); };

  const submit = async () => {
    // validácia VŠETKÝCH polí naraz — chybné polia sa zvýraznia súčasne
    const e = {};
    if (form.name.trim().length < 3) e.name = "Zadajte meno a priezvisko.";
    if (!form.birthDate) e.birthDate = "Zadajte dátum narodenia.";
    if (form.phone.replace(/\D/g, "").length < 9) e.phone = "Neplatné telefónne číslo (aspoň 9 číslic).";
    if (!form.email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) e.email = "Zadajte platný e-mail.";
    if (files.length === 0) e.files = "Priložte žiadanku (výmenný lístok) — môžete ju odfotiť.";
    setErrs(e);
    if (Object.keys(e).length > 0) { setMsg("Skontrolujte a doplňte zvýraznené polia."); return; }
    setBusy(true); setMsg("");
    try {
      const id = newCtId();
      await data.createOrder({ id, examTypeId, patientName: form.name.trim(), birthDate: form.birthDate || null,
        insurance: form.insurance, phone: normalizePhone(form.phone), email: form.email.trim(), reason: form.reason.trim(), date, time }, files);
      setDone({ id, date, time, label: examType?.label });
      setFiles([]);
    } catch (err) { setMsg(err?.message || String(err)); } finally { setBusy(false); }
  };
  const ic = (k) => inp + (errs[k] ? " border-red-400 ring-1 ring-red-300" : "");
  const Err = ({ k }) => errs[k] ? <p className="text-xs text-red-600 mt-1">{errs[k]}</p> : null;

  if (done) {
    return (
      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-6 text-center">
        <h2 className="text-xl font-bold text-[#16A34A] mb-2">Objednávka na CT je prijatá</h2>
        <p className="text-slate-700">{done.label}</p>
        <p className="text-slate-700">Termín: <b>{done.date} o {done.time}</b></p>
        <p className="text-slate-700 mb-1">Číslo objednávky: <b className="font-mono">{done.id}</b></p>
        <p className="text-sm text-slate-500 mt-3">CT je bez poplatku. Potvrdenie sme poslali e-mailom (ak bol zadaný).</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6 space-y-5">
      <h2 className="text-xl font-bold text-[#2B46A2]">Objednanie na CT vyšetrenie <span className="text-sm font-normal text-slate-500">(bez poplatku)</span></h2>

      {step === 1 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-slate-700">Vyberte typ vyšetrenia</p>
          {data.pricelist.length === 0 && <p className="text-sm text-slate-400">Zatiaľ nie sú nastavené žiadne typy CT vyšetrení.</p>}
          {data.pricelist.map((p) => (
            <button key={p.id} onClick={() => { setExamTypeId(p.id); setStep(2); setDate(""); setTime(""); }}
              className={`w-full text-left border-2 rounded-[10px] p-3 transition-colors ${examTypeId === p.id ? "border-[#2B46A2] bg-[#F0F4FF]" : "border-slate-200 hover:border-[#8fb8dd]"}`}>
              <span className="font-bold text-slate-800">{p.label}</span>
              <span className="block text-xs text-slate-500 mt-1">Trvanie ~{p.durationSlots * 5} min</span>
            </button>
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
          {/* Nahrávanie žiadanky — pri CT povinné */}
          <div className={errs.files ? "border border-red-300 bg-red-50 rounded-[10px] p-3" : "border border-amber-300 bg-amber-50 rounded-[10px] p-3"}>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Žiadanka (výmenný lístok) — odfoťte alebo nahrajte * <span className="font-normal text-slate-400">(PDF, JPG, PNG — max 3 súbory po 5 MB)</span></label>
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

// ---------- Overenie / zrušenie CT objednávky pacientom ----------
function CtOrderLookup({ data }) {
  const [id, setId] = useState("");
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
    if (!window.confirm("Naozaj zrušiť CT objednávku?")) return;
    setBusy(true); setMsg("");
    try { await data.cancelOrder(found.id, phone.trim()); setFound({ ...found, status: "rejected" }); }
    catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6 space-y-3">
      <h3 className="text-lg font-bold text-[#2B46A2]">Už máte CT objednávku?</h3>
      <p className="text-sm text-slate-500">Zadajte číslo objednávky (CT-…) a telefón, ktorý ste uviedli.</p>
      <div className="grid md:grid-cols-2 gap-3">
        <input className={inp} placeholder="Číslo objednávky (CT-…)" value={id} onChange={(e) => setId(e.target.value)} />
        <input className={inp} placeholder="Telefón zadaný pri objednávke" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <button onClick={search} disabled={busy} className="bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white font-bold py-2.5 px-5 rounded-[10px]">
        {busy ? "Hľadám…" : "Vyhľadať"}
      </button>
      {msg && <p className="text-sm text-red-600 font-semibold">{msg}</p>}
      {found && (
        <div className="border border-slate-200 rounded-[10px] p-4 space-y-1">
          <p className="text-sm"><b>{found.id}</b> — <span className="font-semibold">{ctStatuses[found.status] || found.status}</span></p>
          <p className="text-sm text-slate-600">Termín: <b>{found.date} o {found.time}</b>{found.doctor ? ` · ${found.doctor}` : ""}</p>
          {(found.status === "new" || found.status === "confirmed") && (
            <button onClick={cancel} disabled={busy} className="mt-2 bg-white border border-red-300 text-red-600 text-sm font-semibold px-4 py-2 rounded-[10px] hover:bg-red-50">
              Zrušiť objednávku
            </button>
          )}
          {found.status === "rejected" && <p className="text-sm text-[#856404]">Objednávka je zrušená.</p>}
        </div>
      )}
    </div>
  );
}

// ---------- Karta CT objednávky (správa) ----------
function CtOrderCard({ order, data, canManage }) {
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
          <span className="text-xs bg-white border border-slate-200 rounded px-2 py-0.5">{ctStatuses[order.status]}</span>
          <ArrivedBadge order={order} />
        </div>
        <span className="text-xs text-slate-500">{order.id}</span>
      </div>
      <p className="text-sm"><b>{order.patientName}</b>{order.exam?.label ? ` · ${order.exam.label}` : ""}</p>
      <p className="text-xs text-slate-500">{order.phone}{order.doctor ? ` · Lekár: ${order.doctor}` : ""}{order.reason ? ` · ${order.reason}` : ""}</p>
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

// ---------- Správa CT ----------
function CtAdmin({ data, role }) {
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
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white rounded-[12px] p-4 text-center shadow-sm"><div className="text-2xl font-extrabold text-[#2B46A2]">{todayProgram.length}</div><div className="text-xs text-slate-500">dnešný program</div></div>
            <div className="bg-white rounded-[12px] p-4 text-center shadow-sm"><div className="text-2xl font-extrabold text-amber-600">{pending.length}</div><div className="text-xs text-slate-500">nové (na potvrdenie)</div></div>
            <div className="bg-white rounded-[12px] p-4 text-center shadow-sm"><div className="text-2xl font-extrabold text-[#2B46A2]">{next7}</div><div className="text-xs text-slate-500">objednaní — 7 dní</div></div>
          </div>
          <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5">
            <h3 className="text-lg font-bold text-[#2B46A2] mb-3">Dnešný program</h3>
            {todayProgram.length === 0 ? <p className="text-sm text-slate-400">Dnes nie sú objednaní žiadni pacienti.</p>
              : <div className="space-y-2">{todayProgram.map((o) => <CtOrderCard key={o.id} order={o} data={data} canManage={canManage} />)}</div>}
          </div>
        </div>
      )}

      {tab === "calendar" && (
        <div className="space-y-4">
          {canManage && (
            <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5">
              <h3 className="text-lg font-bold text-[#2B46A2] mb-3">Otvoriť CT termíny</h3>
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
              <p className="text-xs text-slate-400 mt-2">Termíny sa otvárajú v 5-min mriežke; dĺžku vyšetrenia určuje typ CT výkonu. Tip: kliknite na deň v kalendári a otvorte ho jedným tlačidlom.</p>
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
                {dayOrders.map((o) => <CtOrderCard key={o.id} order={o} data={data} canManage={canManage} />)}
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
            : <div className="space-y-2">{filtered.map((o) => <CtOrderCard key={o.id} order={o} data={data} canManage={canManage} />)}</div>}
        </div>
      )}

      {tab === "settings" && canManage && <CtSettings data={data} isSuper={isSuper} />}
    </div>
  );
}

// ---------- Nastavenia CT (výkony + lekári) ----------
function CtSettings({ data, isSuper }) {
  const [exams, setExams] = useState(() => data.pricelist.map((p) => ({ ...p })));
  const [docs, setDocs] = useState(() => normalizeDoctors(data.doctors));
  const [msg, setMsg] = useState("");
  const slug = () => "ct_" + Math.random().toString(36).slice(2, 10);
  // presun typu v zozname (poradie = sort_order = poradie pre pacienta)
  const move = (i, d) => setExams((p) => { const j = i + d; if (j < 0 || j >= p.length) return p; const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const saveExams = () => { setMsg(""); data.savePricelist(exams.filter((e) => e.label.trim())).then(() => setMsg("✓ Typy CT vyšetrení uložené.")).catch((e) => setMsg(e.message)); };
  const saveDocs = () => { setMsg(""); data.saveDoctors(docs.filter((d) => d.name.trim())).then(() => setMsg("✓ CT lekári uložení.")).catch((e) => setMsg(e.message)); };

  return (
    <div className="space-y-5">
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-[#16A34A]" : "text-red-600"}`}>{msg}</p>}

      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 space-y-3">
        <h3 className="text-lg font-bold text-[#2B46A2]">Typy CT vyšetrení</h3>
        <p className="text-xs text-slate-400">Poradie v zozname je poradie, v akom typy uvidí pacient — šípkami ▲▼ ho zmeníte a uložte.</p>
        {exams.map((e, i) => (
          <div key={e.id} className="border border-slate-200 rounded-[10px] p-3 space-y-2">
            <div className="flex gap-2">
              <input className={inp} placeholder="Názov vyšetrenia" value={e.label} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, label: ev.target.value } : x))} />
              <label className="text-sm shrink-0">Trvanie<br />
                <select className={inp} value={e.durationSlots} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, durationSlots: Number(ev.target.value) } : x))}>
                  {[2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n * 5} min</option>)}
                </select>
              </label>
              <div className="flex flex-col shrink-0 self-start pt-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Posunúť vyššie" aria-label="Posunúť vyššie" className="text-slate-500 hover:text-[#2B46A2] text-xs leading-none px-1 py-0.5 disabled:opacity-30">▲</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === exams.length - 1} title="Posunúť nižšie" aria-label="Posunúť nižšie" className="text-slate-500 hover:text-[#2B46A2] text-xs leading-none px-1 py-0.5 disabled:opacity-30">▼</button>
              </div>
              <button onClick={() => setExams((p) => p.filter((_, j) => j !== i))} className="text-red-600 text-sm shrink-0 self-start pt-2">✕</button>
            </div>
            <textarea className={inp} rows={2} placeholder="Pokyny / príprava" value={e.instructions} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, instructions: ev.target.value } : x))} />
          </div>
        ))}
        <button onClick={() => setExams((p) => [...p, { id: slug(), label: "", instructions: "", durationSlots: 3 }])} className="bg-[#F0F2F5] text-[#444] text-sm font-semibold px-4 py-2 rounded-[10px]">+ Pridať vyšetrenie</button>
        <div><button onClick={saveExams} className="bg-[#2B46A2] text-white text-sm font-semibold px-4 py-2 rounded-[10px]">Uložiť typy vyšetrení</button></div>
      </div>

      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 space-y-3">
        <h3 className="text-lg font-bold text-[#2B46A2]">CT lekári</h3>
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

export default function CtApp({ isStaff, role = "superadmin" }) {
  const [view, setView] = useState("admin");
  const data = useCtData(isStaff);
  const btn = "px-4 py-2 rounded-[10px] text-sm font-bold transition-colors";
  return (
    <div className="space-y-4">
      <div className="bg-[#FFF6E0] border border-[#E0C878] text-[#856404] rounded-[10px] px-4 py-3 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
        <span>Testovacia sekcia — CT objednávanie (bez poplatku). Nie je verejná.</span>
        <a href="#/sprava" className="text-[#2B46A2] hover:underline">← Späť do správy</a>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setView("admin")} className={`${btn} ${view === "admin" ? "bg-[#2B46A2] text-white" : "bg-[#F0F2F5] text-[#444]"}`}>Správa</button>
        <button onClick={() => setView("book")} className={`${btn} ${view === "book" ? "bg-[#2B46A2] text-white" : "bg-[#F0F2F5] text-[#444]"}`}>Objednať sa (náhľad)</button>
        <button onClick={() => setView("lookup")} className={`${btn} ${view === "lookup" ? "bg-[#2B46A2] text-white" : "bg-[#F0F2F5] text-[#444]"}`}>Overiť objednávku</button>
      </div>
      {view === "admin" ? <CtAdmin data={data} role={role} />
        : view === "lookup" ? <CtOrderLookup data={data} />
        : <><CtBookingView data={data} /><CtOrderLookup data={data} /></>}
    </div>
  );
}
