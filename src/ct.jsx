import { useState, useMemo } from "react";
import { MonthCalendar, toISODate, earliestTimeFor, genSlots } from "./booking.jsx";
import { useCtData } from "./podappkyData.js";

const newCtId = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b = new Uint8Array(10); (window.crypto || window.msCrypto).getRandomValues(b);
  let s = ""; for (let i = 0; i < b.length; i++) s += abc[b[i] % 32];
  return "CT-" + s;
};

// ---------- Pacientske objednávanie na CT (bez poplatku) ----------
function CtBookingView({ data }) {
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [form, setForm] = useState({ name: "", birthDate: "", insurance: "", phone: "", email: "", reason: "" });
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const takenByDate = useMemo(() => {
    const m = new Map();
    data.occupied.forEach(({ date: d, time: t }) => { if (!m.has(d)) m.set(d, new Set()); m.get(d).add(t); });
    return m;
  }, [data.occupied]);

  const freeTimes = (iso) => {
    const taken = takenByDate.get(iso) || new Set();
    const min = earliestTimeFor(iso, "");
    return (data.openSlots[iso] || []).filter((s) => !taken.has(s.time) && (!min || s.time >= min));
  };
  const todayIso = toISODate(new Date());
  const isAvailable = (iso) => iso >= todayIso && freeTimes(iso).length > 0;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const input = "w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 text-sm focus:ring-2 focus:ring-[#2B46A2] outline-none";

  const submit = async () => {
    setBusy(true); setMsg("");
    try {
      if (!date || !time) throw new Error("Vyberte termín.");
      if (form.name.trim().length < 3) throw new Error("Zadajte meno pacienta.");
      if (form.phone.replace(/\D/g, "").length < 9) throw new Error("Zadajte platné telefónne číslo.");
      const id = newCtId();
      await data.createOrder({ id, patientName: form.name.trim(), birthDate: form.birthDate || null,
        insurance: form.insurance.trim(), phone: form.phone.trim(), email: form.email.trim(), reason: form.reason.trim(),
        date, time });
      setDone({ id, date, time });
    } catch (err) { setMsg(err?.message || String(err)); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-6 text-center">
        <h2 className="text-xl font-bold text-[#16A34A] mb-2">Objednávka na CT je prijatá</h2>
        <p className="text-slate-700">Termín: <b>{done.date} o {done.time}</b></p>
        <p className="text-slate-700 mb-1">Číslo objednávky: <b className="font-mono">{done.id}</b></p>
        <p className="text-sm text-slate-500 mt-3">CT vyšetrenie je bez poplatku. Potvrdenie sme poslali na e-mail (ak bol zadaný).</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6 space-y-5">
      <div>
        <h2 className="text-xl font-bold text-[#2B46A2] mb-1">Objednanie na CT vyšetrenie</h2>
        <p className="text-slate-600 text-sm">Vyberte voľný termín. CT vyšetrenie je <b>bez poplatku</b>.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <MonthCalendar monthDate={monthDate}
          onMonthChange={(delta) => setMonthDate((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
          isAvailable={isAvailable} selected={date}
          onSelect={(iso) => { setDate(iso); setTime(""); }} />
        <div>
          <p className="text-sm font-semibold text-slate-700 mb-2">{date ? `Voľné časy — ${date}` : "Najprv vyberte deň"}</p>
          <div className="flex flex-wrap gap-2">
            {date && freeTimes(date).map((s) => (
              <button key={s.time} onClick={() => setTime(s.time)}
                className={`px-3 py-2 rounded-[10px] text-sm font-semibold border transition-colors ${time === s.time ? "bg-[#2B46A2] text-white border-[#2B46A2]" : "bg-white text-[#2B46A2] border-slate-300 hover:border-[#2B46A2]"}`}>
                {s.time}
              </button>
            ))}
            {date && freeTimes(date).length === 0 && <p className="text-sm text-slate-400">V tento deň nie sú voľné termíny.</p>}
          </div>
        </div>
      </div>

      {time && (
        <div className="grid md:grid-cols-2 gap-3 border-t border-slate-200 pt-4">
          <input className={input} placeholder="Meno a priezvisko" value={form.name} onChange={set("name")} />
          <input className={input} type="date" value={form.birthDate} onChange={set("birthDate")} />
          <input className={input} placeholder="Poisťovňa" value={form.insurance} onChange={set("insurance")} />
          <input className={input} placeholder="+421 900 000 000" value={form.phone} onChange={set("phone")} />
          <input className={input} type="email" placeholder="e-mail (na potvrdenie)" value={form.email} onChange={set("email")} />
          <input className={input} placeholder="Dôvod / poznámka (nepovinné)" value={form.reason} onChange={set("reason")} />
          <div className="md:col-span-2">
            {msg && <p className="text-sm text-red-600 font-semibold mb-2">{msg}</p>}
            <button onClick={submit} disabled={busy} className="bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white font-bold py-3 px-5 rounded-[10px] transition-colors">
              {busy ? "Odosielam…" : "Objednať sa (bez poplatku)"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Skrytá správa CT termínov ----------
function CtAdmin({ data }) {
  const today = toISODate(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [tFrom, setTFrom] = useState("07:30");
  const [tTo, setTTo] = useState("14:30");
  const [step, setStep] = useState("20");
  const [doctor, setDoctor] = useState("");
  const [msg, setMsg] = useState("");

  const openWin = async () => {
    setMsg("");
    try {
      const times = genSlots(tFrom, tTo, Number(step));
      if (times.length === 0) throw new Error("Neplatný časový rozsah alebo krok.");
      await data.openWindow({ dateFrom: from, dateTo: to, times, doctor: doctor.trim() });
      setMsg(`✓ Otvorených ${times.length} termínov/deň.`);
    } catch (err) { setMsg(err?.message || String(err)); }
  };

  const active = data.orders.filter((o) => o.status !== "rejected").sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const input = "p-2 bg-white border border-slate-300 rounded-[10px] text-slate-800 text-sm";

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6">
        <h3 className="text-lg font-bold text-[#2B46A2] mb-3">Otvoriť CT termíny</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-sm">Od dňa<br /><input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-sm">Do dňa<br /><input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="text-sm">Od<br /><input type="time" className={input} value={tFrom} onChange={(e) => setTFrom(e.target.value)} /></label>
          <label className="text-sm">Do<br /><input type="time" className={input} value={tTo} onChange={(e) => setTTo(e.target.value)} /></label>
          <label className="text-sm">Interval (min)<br /><input type="number" min="5" step="5" className={`${input} w-24`} value={step} onChange={(e) => setStep(e.target.value)} /></label>
          <label className="text-sm">Lekár<br /><input className={input} placeholder="nepovinné" value={doctor} onChange={(e) => setDoctor(e.target.value)} /></label>
          <button onClick={openWin} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white font-semibold px-4 py-2 rounded-[10px] transition-colors">Otvoriť termíny</button>
        </div>
        {msg && <p className={`text-sm font-semibold mt-2 ${msg.startsWith("✓") ? "text-[#16A34A]" : "text-red-600"}`}>{msg}</p>}
      </div>

      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6">
        <h3 className="text-lg font-bold text-[#2B46A2] mb-3">CT objednávky ({active.length})</h3>
        {active.length === 0 ? <p className="text-sm text-slate-400">Zatiaľ žiadne CT objednávky.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse min-w-[560px]">
              <thead><tr className="text-left text-xs text-[#767676] border-b border-[#E0E4EF]">
                <th className="py-2 pr-3">Termín</th><th className="py-2 pr-3">Pacient</th><th className="py-2 pr-3">Telefón</th>
                <th className="py-2 pr-3">Lekár</th><th className="py-2 pr-3">Stav</th><th className="py-2"></th></tr></thead>
              <tbody>
                {active.map((o) => (
                  <tr key={o.id} className="border-b border-[#F0F2F5]">
                    <td className="py-2 pr-3 whitespace-nowrap font-mono">{o.date} {o.time}</td>
                    <td className="py-2 pr-3">{o.patientName}</td>
                    <td className="py-2 pr-3">{o.phone}</td>
                    <td className="py-2 pr-3">{o.doctor || "—"}</td>
                    <td className="py-2 pr-3">{o.status === "confirmed" ? "Potvrdená" : "Nová"}</td>
                    <td className="py-2 text-right space-x-2 whitespace-nowrap">
                      {o.status !== "confirmed" && <button onClick={() => data.setStatus(o.id, "confirmed")} className="bg-[#2B46A2] text-white text-xs font-semibold px-3 py-1.5 rounded">Potvrdiť</button>}
                      <button onClick={() => data.setStatus(o.id, "rejected")} className="bg-red-600 text-white text-xs font-semibold px-3 py-1.5 rounded">Zrušiť</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CtApp({ isStaff }) {
  const [view, setView] = useState("book");
  const data = useCtData(isStaff);
  return (
    <div className="space-y-4">
      <div className="bg-[#FFF6E0] border border-[#E0C878] text-[#856404] rounded-[10px] px-4 py-3 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
        <span>Testovacia sekcia — CT objednávanie (bez poplatku). Nie je verejná.</span>
        <a href="#/sprava" className="text-[#2B46A2] hover:underline">← Späť do správy</a>
      </div>
      <div className="flex gap-2">
        <button onClick={() => setView("book")} className={`px-4 py-2 rounded-[10px] text-sm font-bold transition-colors ${view === "book" ? "bg-[#2B46A2] text-white" : "bg-[#F0F2F5] text-[#444444]"}`}>Objednať sa</button>
        <button onClick={() => setView("admin")} className={`px-4 py-2 rounded-[10px] text-sm font-bold transition-colors ${view === "admin" ? "bg-[#2B46A2] text-white" : "bg-[#F0F2F5] text-[#444444]"}`}>Správa termínov</button>
      </div>
      {view === "book" ? <CtBookingView data={data} /> : <CtAdmin data={data} />}
    </div>
  );
}
