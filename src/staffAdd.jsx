import { useMemo, useState } from "react";
import { BirthDateInput, insuranceOptions, addMinutes } from "./booking.jsx";
import { inputCls, labelCls, Btn, Card, Callout } from "./ui.jsx";
import { showToast } from "./toast.jsx";

// Ručné pridanie pacienta personálom (rucne-001) — USG, angio aj CT.
// Lekár alebo sestra objedná pacienta napr. na kontrolu: bez SMS overenia,
// bez povinnej žiadanky, aj na dnes a aj mimo otvorených termínov.
// Server odmietne len prekrytie s iným pacientom; notifikácie pacientovi
// (SMS, e-mail, pripomienka deň vopred) sa dajú pri objednávke vypnúť.

const DOW = ["nedeľa", "pondelok", "utorok", "streda", "štvrtok", "piatok", "sobota"];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDay = (iso) => { if (!iso) return ""; const d = new Date(`${iso}T12:00:00`); return `${DOW[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`; };
const eur = (n) => `${Number(n).toFixed(2).replace(".", ",").replace(",00", "")} €`;
const cellsFor = (time, durationMin) => Array.from({ length: Math.max(1, Math.ceil(durationMin / 5)) }, (_, i) => addMinutes(time, i * 5));

// všetky začiatky v otvorených bunkách dňa, kde sa celé trvanie zmestí k jednému lekárovi
function freeStarts(openCells, taken, durationMin) {
  const open = openCells.slice().sort((a, b) => a.time.localeCompare(b.time));
  const byTime = new Map(open.map((c) => [c.time, c]));
  const n = Math.max(1, Math.ceil(durationMin / 5));
  return open.filter((c) => {
    for (let i = 0; i < n; i++) {
      const cell = byTime.get(addMinutes(c.time, i * 5));
      if (!cell || (cell.doctor || "") !== (c.doctor || "") || taken.has(cell.time)) return false;
    }
    return true;
  });
}

export function StaffAddOrder({ kind = "clinic", pricelist = [], doctors = [], openSlots = {}, occupied = [], defaultDoctor = "", initial = {}, onSubmit, onClose }) {
  const todayIso = isoOf(new Date());
  const [f, setF] = useState(() => ({
    examTypeId: initial.examTypeId || pricelist[0]?.id || "",
    payment: "free",
    date: initial.date && initial.date >= todayIso ? initial.date : todayIso,
    time: initial.time || "",
    doctor: initial.doctor ?? defaultDoctor ?? "",
    patientName: "", birthDate: "", phone: "", email: "", insurance: "", reason: "", notify: true,
  }));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setErrors((e) => ({ ...e, [k]: "" })); setErr(""); };

  const isUsg = kind === "usg";
  const exam = pricelist.find((p) => p.id === f.examTypeId);
  const durationMin = Math.max(5, (exam?.durationSlots || (isUsg ? 2 : 3)) * 5);
  const taken = useMemo(() => new Set(occupied.filter((o) => o.date === f.date).map((o) => o.time)), [occupied, f.date]);
  const starts = useMemo(() => freeStarts(openSlots[f.date] || [], taken, durationMin), [openSlots, f.date, taken, durationMin]);
  const timeOk = /^\d{2}:\d{2}$/.test(f.time) && Number(f.time.slice(3)) % 5 === 0;
  const overlap = timeOk && cellsFor(f.time, durationMin).some((t) => taken.has(t));
  const price = !isUsg ? 0 : f.payment === "referral" ? exam?.priceReferral : f.payment === "self" ? exam?.priceSelf : 0;
  const paid = isUsg && Number(price) > 0;

  const validate = () => {
    const e = {};
    if (!exam) e.examTypeId = "Vyberte vyšetrenie.";
    if (isUsg && f.payment === "referral" && exam && exam.priceReferral == null) e.payment = "Toto vyšetrenie je len pre samoplatcov.";
    if (!f.date || f.date < todayIso) e.date = "Vyberte dnešný alebo neskorší deň.";
    if (!timeOk) e.time = "Zadajte čas po 5 minútach (napr. 09:05).";
    else if (overlap) e.time = "V tomto čase je už objednaný iný pacient.";
    if (f.patientName.trim().length < 3) e.patientName = "Zadajte meno a priezvisko.";
    if (!f.birthDate) e.birthDate = "Zadajte dátum narodenia (DD.MM.RRRR).";
    if (f.phone.replace(/\D/g, "").length < 9) e.phone = "Zadajte telefónne číslo (napr. 0949 123 456).";
    if (f.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) e.email = "E-mail nie je platný — opravte ho alebo nechajte pole prázdne.";
    else if (paid && f.notify && !f.email.trim()) e.email = "Pri platenom vyšetrení zadajte e-mail — pošleme naň platobné údaje.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    if (busy || !validate()) return;
    setBusy(true); setErr("");
    try {
      const res = await onSubmit({
        examTypeId: f.examTypeId, payment: isUsg ? f.payment : undefined,
        date: f.date, time: f.time, doctor: f.doctor,
        patientName: f.patientName.trim().replace(/\s+/g, " "), birthDate: f.birthDate,
        phone: f.phone.trim(), email: f.email.trim(), insurance: f.insurance, reason: f.reason.trim(), notify: f.notify,
      });
      showToast(`Pacient pridaný: ${f.patientName.trim()}, ${fmtDay(f.date)} o ${f.time}`);
      onClose?.(res);
    } catch (e2) {
      setErr(e2?.message || String(e2));
    } finally {
      setBusy(false);
    }
  };

  const errCls = (k) => (errors[k] ? " border-danger" : "");
  const errP = (k) => errors[k] && <p className="text-xs text-danger mt-1" role="alert">{errors[k]}</p>;
  const chip = (on) => `text-sm font-semibold px-3 py-1.5 rounded-lg border transition-colors ${on ? "bg-brand text-white border-brand" : "bg-white border-line text-ink hover:border-brand"}`;

  return (
    <Card pad="md" className="border-brand/40" data-testid="staff-add-form">
      <form onSubmit={submit} noValidate className="space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-brand">Pridať pacienta</h3>
            <p className="text-xs text-muted">Bez SMS overenia a bez povinnej žiadanky. Dá sa aj na dnes a mimo otvorených termínov.</p>
          </div>
          <button type="button" onClick={() => onClose?.(null)} className="shrink-0 text-muted hover:text-ink text-xl leading-none px-2" aria-label="Zavrieť formulár">✕</button>
        </div>

        {/* 1. vyšetrenie (+ platba pri USG) */}
        <div className="grid gap-3">
          <div>
            <label className={labelCls} htmlFor="sa-exam">Vyšetrenie <span className="text-danger" aria-hidden="true">*</span></label>
            <select id="sa-exam" data-testid="sa-exam" className={inputCls + errCls("examTypeId")} value={f.examTypeId} onChange={(e) => set("examTypeId", e.target.value)}>
              {pricelist.length === 0 && <option value="">— cenník sa načítava —</option>}
              {pricelist.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {errP("examTypeId")}
          </div>
          {isUsg && (
            <fieldset>
              <legend className={labelCls}>Platba</legend>
              <div className="flex flex-wrap gap-2">
                <button type="button" data-testid="sa-pay-free" aria-pressed={f.payment === "free"} onClick={() => set("payment", "free")} className={chip(f.payment === "free")}>Bez platby (kontrola)</button>
                {exam?.priceReferral != null && (
                  <button type="button" data-testid="sa-pay-referral" aria-pressed={f.payment === "referral"} onClick={() => set("payment", "referral")} className={chip(f.payment === "referral")}>So žiadankou · doplatok {eur(exam.priceReferral)}</button>
                )}
                {exam && (
                  <button type="button" data-testid="sa-pay-self" aria-pressed={f.payment === "self"} onClick={() => set("payment", "self")} className={chip(f.payment === "self")}>Samoplatca · {eur(exam.priceSelf)}</button>
                )}
              </div>
              {errP("payment")}
              <p className="text-xs text-muted mt-1">
                {paid ? "Pacient dostane e-mail s platobnými údajmi ako pri online objednávke; termín sa potvrdí po prijatí platby."
                  : "Termín je hneď potvrdený, pacient nič neplatí."}
              </p>
            </fieldset>
          )}
        </div>

        {/* 2. termín */}
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls} htmlFor="sa-date">Dátum <span className="text-danger" aria-hidden="true">*</span></label>
              <input id="sa-date" data-testid="sa-date" type="date" min={todayIso} className={inputCls + errCls("date")} value={f.date} onChange={(e) => set("date", e.target.value)} />
              {errP("date")}
            </div>
            <div>
              <label className={labelCls} htmlFor="sa-time">Čas <span className="text-danger" aria-hidden="true">*</span></label>
              <input id="sa-time" data-testid="sa-time" type="time" step={300} className={inputCls + errCls("time")} value={f.time} onChange={(e) => set("time", e.target.value)} />
              {errP("time")}
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className={labelCls} htmlFor="sa-doctor">Lekár</label>
              <select id="sa-doctor" data-testid="sa-doctor" className={inputCls} value={f.doctor} onChange={(e) => set("doctor", e.target.value)}>
                <option value="">— podľa termínu —</option>
                {doctors.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                {f.doctor && !doctors.some((d) => d.name === f.doctor) && <option value={f.doctor}>{f.doctor}</option>}
              </select>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Voľné otvorené termíny {fmtDay(f.date)} ({durationMin} min):</p>
            {starts.length === 0
              ? <p className="text-xs text-muted" data-testid="sa-no-starts">Žiadne — zadajte čas ručne (napr. kontrola mimo ordinačných hodín).</p>
              : (
                <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                  {starts.map((s) => (
                    <button key={s.time} type="button" data-testid="sa-start" aria-pressed={f.time === s.time}
                      onClick={() => { set("time", s.time); if (s.doctor) set("doctor", s.doctor); }}
                      className={`text-xs font-semibold px-2.5 py-1 rounded-lg border ${f.time === s.time ? "bg-brand text-white border-brand" : "bg-success-soft border-success/40 text-success hover:border-brand"}`}>
                      {s.time}{s.doctor ? ` · ${s.doctor}` : ""}
                    </button>
                  ))}
                </div>
              )}
          </div>
        </div>

        {/* 3. pacient */}
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="sa-name">Meno a priezvisko <span className="text-danger" aria-hidden="true">*</span></label>
            <input id="sa-name" data-testid="sa-name" className={inputCls + errCls("patientName")} autoComplete="off" value={f.patientName} onChange={(e) => set("patientName", e.target.value)} />
            {errP("patientName")}
          </div>
          <div>
            <label className={labelCls} htmlFor="sa-birth">Dátum narodenia <span className="text-danger" aria-hidden="true">*</span></label>
            <BirthDateInput id="sa-birth" data-testid="sa-birth" autoComplete="off" value={f.birthDate} onChange={(v) => set("birthDate", v)} className={inputCls + errCls("birthDate")} />
            {errP("birthDate")}
          </div>
          <div>
            <label className={labelCls} htmlFor="sa-phone">Telefón <span className="text-danger" aria-hidden="true">*</span></label>
            <input id="sa-phone" data-testid="sa-phone" type="tel" autoComplete="off" className={inputCls + errCls("phone")} value={f.phone} onChange={(e) => set("phone", e.target.value)} />
            {errP("phone")}
          </div>
          <div>
            <label className={labelCls} htmlFor="sa-email">E-mail{paid && f.notify ? <span className="text-danger" aria-hidden="true"> *</span> : <span className="font-normal text-muted"> (nepovinné)</span>}</label>
            <input id="sa-email" data-testid="sa-email" type="email" autoComplete="off" className={inputCls + errCls("email")} value={f.email} onChange={(e) => set("email", e.target.value)} />
            {errP("email")}
          </div>
          <div>
            <label className={labelCls} htmlFor="sa-insurance">Poisťovňa</label>
            <select id="sa-insurance" data-testid="sa-insurance" className={inputCls} value={f.insurance} onChange={(e) => set("insurance", e.target.value)}>
              <option value="">—</option>
              {insuranceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="sa-reason">Poznámka <span className="font-normal text-muted">(nepovinné, vidí len personál)</span></label>
            <textarea id="sa-reason" data-testid="sa-reason" rows={2} maxLength={2000} className={inputCls} placeholder="napr. kontrola po zákroku o 3 mesiace" value={f.reason} onChange={(e) => set("reason", e.target.value)} />
          </div>
        </div>

        {/* 4. notifikácie */}
        <div>
          <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
            <input type="checkbox" data-testid="sa-notify" className="mt-1 accent-brand" checked={f.notify} onChange={(e) => set("notify", e.target.checked)} />
            <span>Poslať pacientovi potvrdenie (SMS{f.email.trim() ? " a e-mail" : ""}) a pripomienku deň vopred</span>
          </label>
          {!f.notify && <p className="text-xs text-warn mt-1 ml-6">Pacient nedostane žiadnu SMS ani e-mail — termín mu oznámte sami.</p>}
        </div>

        {err && <Callout tone="danger" role="alert" data-testid="sa-error">{err}</Callout>}

        <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-line">
          <p className="text-sm text-ink flex-1 min-w-[12rem] pt-3" data-testid="sa-summary">
            {timeOk ? <><b>{fmtDay(f.date)} o {f.time}</b> · {durationMin} min{f.doctor ? ` · ${f.doctor}` : ""}</> : <span className="text-muted">Vyberte čas.</span>}
            {isUsg && exam && <span className="text-muted"> · {paid ? eur(price) : "bez platby"}</span>}
          </p>
          <div className="flex gap-2 pt-3">
            <Btn variant="secondary" onClick={() => onClose?.(null)}>Zrušiť</Btn>
            <Btn type="submit" disabled={busy} data-testid="sa-submit">{busy ? "Ukladám…" : "Pridať pacienta"}</Btn>
          </div>
        </div>
      </form>
    </Card>
  );
}
