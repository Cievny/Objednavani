import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient.js";
import { MonthCalendar, toISODate, earliestTimeFor, computeOfferedSlots, insuranceOptions, normalizePhone, BirthDateInput } from "./booking.jsx";
import { useCtData, CT_ORDERS_KEY } from "./podappkyData.js";
import { inputCls, labelCls, Btn, Card, Callout, StatusChip } from "./ui.jsx";
import { readZiadankaPdf, parseZiadanka, matchCtExam } from "./ziadanka.js";

// CT objednávanie pre lekárov NÚSCH (ct-lekari-001).
// CT nie je verejné: lekári sa prihlásia spoločným heslom (nastavuje superadmin
// v správe CT → Nastavenia), vyberú voľný otvorený termín a pošlú žiadosť za
// pacienta s klinickou otázkou, údajmi o kontraste a žiadankou. Žiadosť potvrdí
// CT pracovisko; pacient dostane SMS / e-mail až po potvrdení.

const TOKEN_KEY = "ctDocToken_v1";        // sessionStorage — prihlásenie platí do zatvorenia karty (server: 12 h)
const REQUESTER_KEY = "ctDocRequester_v1"; // localStorage — meno a klapka lekára (pohodlie)
const DEMO_PW_KEY = "ctDocPassword_v1";    // demo režim bez databázy
const EXPIRED = "Prihlásenie vypršalo — zadajte heslo znova.";
const CHECK_MSG = "Skontrolujte a doplňte zvýraznené polia.";

const loadJson = (k, fb, store = localStorage) => { try { const v = store.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const DOW = ["nedeľa", "pondelok", "utorok", "streda", "štvrtok", "piatok", "sobota"];
const fmtDay = (iso) => { if (!iso) return ""; const d = new Date(`${iso}T12:00:00`); return `${DOW[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`; };
const newCtId = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b = new Uint8Array(10); window.crypto.getRandomValues(b);
  return "CT-" + Array.from(b, (x) => abc[x % 32]).join("");
};
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error("Súbor sa nepodarilo načítať.")); r.readAsDataURL(file);
});

// ---------- API (Supabase RPC; demo: localStorage) ----------
export const ctDoctorApi = {
  async login(password) {
    if (!supabase) {
      const pw = localStorage.getItem(DEMO_PW_KEY);
      if (!pw) return { ok: false, error: "Prístup pre lekárov ešte nie je nastavený — kontaktujte CT pracovisko." };
      if (password !== pw) return { ok: false, error: "Nesprávne heslo." };
      return { ok: true, token: "demo-" + Date.now(), expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString() };
    }
    const { data, error } = await supabase.rpc("ct_doctor_login", { p_password: password });
    if (error) throw new Error(error.message);
    return data || { ok: false, error: "Prihlásenie zlyhalo." };
  },

  async createOrder(token, o, files) {
    const id = newCtId();
    if (!supabase) {
      const pl = loadJson("ctPricelist_v1", []);
      const item = pl.find((p) => p.id === o.examTypeId) || { label: o.examLabel || "", durationSlots: o.durationSlots || 3 };
      const attachments = [];
      for (const f of files) attachments.push({ name: f.name, dataUrl: await readAsDataUrl(f) });
      const list = loadJson(CT_ORDERS_KEY, []);
      const durationMin = (item.durationSlots || 3) * 5;
      const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
      const a = toMin(o.time), b = a + durationMin;
      if (list.some((x) => x.status !== "rejected" && x.date === o.date && toMin(x.time) < b && toMin(x.time) + (x.durationMin || 15) > a)) {
        throw new Error("Vybraný termín bol medzičasom obsadený. Vyberte iný.");
      }
      const cell = (loadJson("ctOpenSlots_v1", {})[o.date] || []).find((c) => c.time === o.time);
      list.push({ id, examTypeId: o.examTypeId, exam: { typeId: o.examTypeId, label: item.label }, patientName: o.patientName, birthDate: o.birthDate,
        insurance: o.insurance, phone: o.phone, email: o.email, reason: o.indication, date: o.date, time: o.time, doctor: cell?.doctor || "",
        status: "new", statusNote: "", durationMin, attachments, createdAt: new Date().toISOString(),
        requestedBy: o.requestedBy, clinical: o.clinical, notifyPatient: o.notify, createdBy: "" });
      localStorage.setItem(CT_ORDERS_KEY, JSON.stringify(list));
      return id;
    }
    const attachments = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const path = `${id}/${i}-${f.name.replace(/[^\w.-]+/g, "_").slice(-80)}`;
      const { error: upErr } = await supabase.storage.from("prilohy").upload(path, f, { contentType: f.type || undefined });
      if (upErr) throw new Error(`Žiadanku ${f.name} sa nepodarilo nahrať: ${upErr.message}`);
      attachments.push({ name: f.name, path });
    }
    const { error } = await supabase.rpc("ct_doctor_create_order", {
      p_token: token, p_id: id, p_requested_by: o.requestedBy, p_exam_type_id: o.examTypeId,
      p_patient_name: o.patientName, p_birth_date: o.birthDate, p_insurance: o.insurance, p_phone: o.phone, p_email: o.email,
      p_indication: o.indication, p_clinical: o.clinical, p_slot_date: o.date, p_slot_time: o.time,
      p_attachments: attachments, p_notify: o.notify,
    });
    if (error) {
      const e = new Error(error.message);
      if (error.code === "23P01" || /obsaden/i.test(error.message || "")) e.code = "SLOT_TAKEN";
      throw e;
    }
    return id;
  },

  async list(token) {
    if (!supabase) {
      const from = toISODate(new Date(Date.now() - 7 * 864e5));
      return loadJson(CT_ORDERS_KEY, []).filter((o) => o.date >= from)
        .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
        .map((o) => ({ id: o.id, date: o.date, time: o.time, durationMin: o.durationMin, exam: o.exam?.label || "", patient: o.patientName,
          birthYear: o.birthDate ? Number(String(o.birthDate).slice(0, 4)) : null, status: o.status, note: o.statusNote || "", requestedBy: o.requestedBy || "" }));
    }
    const { data, error } = await supabase.rpc("ct_doctor_list", { p_token: token });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data : [];
  },

  // personál (správa CT → Nastavenia)
  async passwordInfo() {
    if (!supabase) return { set: Boolean(localStorage.getItem(DEMO_PW_KEY)), updatedAt: localStorage.getItem(DEMO_PW_KEY + "_at") || "", updatedBy: "demo", activeSessions: 0 };
    const { data, error } = await supabase.rpc("ct_doctor_password_info");
    if (error) throw new Error(error.code === "PGRST202" ? "CT pre lekárov ešte nie je zapnuté v databáze (spustite supabase/ct-lekari-001.sql)." : error.message);
    return data || { set: false };
  },
  async setPassword(pw) {
    if (!supabase) {
      if (String(pw || "").length < 8) throw new Error("Heslo musí mať 8 až 100 znakov.");
      localStorage.setItem(DEMO_PW_KEY, pw); localStorage.setItem(DEMO_PW_KEY + "_at", new Date().toISOString()); return;
    }
    const { error } = await supabase.rpc("ct_set_doctor_password", { p_password: pw });
    if (error) throw new Error(error.message);
  },
};

// adresa stránky pre lekárov (pacientska verzia; zo správy /sprava/ o úroveň vyššie)
export const ctDoctorUrl = () => `${window.location.origin}${window.location.pathname.replace(/sprava\/?$/, "")}#/ct-lekar`;

// ---------- Prihlásenie ----------
function DoctorLogin({ onLogin, notice }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    if (!pw) { setErr("Zadajte heslo."); return; }
    setBusy(true); setErr("");
    try {
      const r = await ctDoctorApi.login(pw);
      if (!r?.ok) { setErr(r?.error || "Prihlásenie zlyhalo."); return; }
      onLogin({ token: r.token, exp: new Date(r.expires_at).getTime() });
    } catch (e2) { setErr(e2?.message || String(e2)); } finally { setBusy(false); }
  };
  return (
    <Card className="max-w-md mx-auto" data-testid="ctdoc-login">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-brand">CT objednávanie pre lekárov NÚSCH</h1>
          <p className="text-sm text-muted mt-1">Stránka nie je určená pacientom. Heslo vám poskytne CT pracovisko.</p>
        </div>
        {notice && <Callout tone="warn">{notice}</Callout>}
        <div>
          <label className={labelCls} htmlFor="ctdoc-pw">Heslo pre lekárov</label>
          <input id="ctdoc-pw" type="password" autoComplete="current-password" className={inputCls} value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} data-testid="ctdoc-pw" />
        </div>
        {err && <Callout tone="danger" role="alert" data-testid="ctdoc-login-error">{err}</Callout>}
        <Btn type="submit" block disabled={busy} data-testid="ctdoc-login-submit">{busy ? "Overujem…" : "Prihlásiť sa"}</Btn>
      </form>
    </Card>
  );
}

// ---------- Nová žiadosť ----------
const emptyPatient = { name: "", birthDate: "", insurance: "25", phone: "", email: "" };
const emptyClinical = { indication: "", contrast: null, creatinine: "", egfr: "", labDate: "", allergy: "", metformin: null };

function NewRequest({ data, token, onExpired, onShowList }) {
  const todayIso = toISODate(new Date());
  const [req, setReq] = useState(() => loadJson(REQUESTER_KEY, { name: "", contact: "" }));
  const [examTypeId, setExamTypeId] = useState("");
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [showCal, setShowCal] = useState(false); // kalendár len na vyžiadanie — predvolene 3 najbližšie termíny
  const [pat, setPat] = useState(emptyPatient);
  const [cl, setCl] = useState(emptyClinical);
  const [files, setFiles] = useState([]);
  const [notify, setNotify] = useState(true);
  const [errs, setErrs] = useState({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const clear = (k) => setErrs((x) => { if (!x[k]) return x; const n = { ...x }; delete n[k]; return n; });
  // polia vyplnené zo žiadanky (PDF) — zvýraznené, kým ich lekár neupraví
  const [pf, setPf] = useState(() => new Set());
  const [fromPdf, setFromPdf] = useState(null); // { filled, warnings, info } alebo { error }
  const [reading, setReading] = useState(false);
  const unmark = (k) => setPf((x) => { if (!x.has(k)) return x; const n = new Set(x); n.delete(k); return n; });
  const hl = (k) => (pf.has(k) && !errs[k] ? " bg-brand-soft" : "");
  const setP = (k, v) => { setPat((p) => ({ ...p, [k]: v })); clear(k); unmark(k); };
  const setC = (k, v) => { setCl((p) => ({ ...p, [k]: v })); clear(k); unmark(k); };
  useEffect(() => { try { localStorage.setItem(REQUESTER_KEY, JSON.stringify(req)); } catch { /* */ } }, [req]);
  // po opravení všetkých polí zmizne aj súhrnná hláška
  useEffect(() => { if (Object.keys(errs).length === 0) setMsg((m) => (m === CHECK_MSG ? "" : m)); }, [errs]);

  const exam = data.pricelist.find((p) => p.id === examTypeId) || null;
  const durationMin = (exam?.durationSlots || 3) * 5;
  const takenByDate = useMemo(() => {
    const m = new Map();
    data.occupied.forEach(({ date: d, time: t }) => { if (!m.has(d)) m.set(d, new Set()); m.get(d).add(t); });
    return m;
  }, [data.occupied]);
  const offered = (iso) => !exam ? [] : computeOfferedSlots({ openSlots: data.openSlots, takenSet: takenByDate.get(iso) || new Set(),
    doctors: data.doctors, examTypeId, durationMin, iso, minTime: earliestTimeFor(iso, ""), limit: Infinity });
  const isAvailable = (iso) => iso >= todayIso && offered(iso).length > 0;
  // tri najbližšie dni s voľnými termínmi vybraného vyšetrenia, každý so všetkými voľnými časmi
  const nearestDays = useMemo(() => {
    if (!exam) return [];
    const out = [];
    for (const d of Object.keys(data.openSlots).filter((x) => x >= todayIso).sort()) {
      const times = offered(d);
      if (times.length) out.push({ date: d, times });
      if (out.length === 3) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examTypeId, data.openSlots, takenByDate]);
  const pickedNearest = nearestDays.some((n) => n.date === date && n.times.some((t) => t.time === time));
  // kalendár otvoriť na mesiaci prvého voľného dňa vybraného vyšetrenia
  useEffect(() => {
    if (!exam) return;
    const days = Object.keys(data.openSlots).filter((d) => d >= todayIso).sort();
    // deň už vybraný (napr. zo žiadanky) má prednosť pred prvým voľným dňom
    const first = date && offered(date).length > 0 ? date : days.find((d) => offered(d).length > 0);
    if (first) { const d = new Date(`${first}T12:00:00`); setMonthDate(new Date(d.getFullYear(), d.getMonth(), 1)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examTypeId, data.openSlots]);

  // žiadanka z DOCTUSu (PDF s textom): prečítať v prehliadači a predvyplniť formulár
  const readPdf = async (e) => {
    const f = (e.target.files || [])[0]; e.target.value = "";
    if (!f) return;
    if (!/\.pdf$/i.test(f.name)) { setFromPdf({ error: "Vyberte PDF súbor žiadanky." }); return; }
    if (f.size > 5 * 1024 * 1024) { setFromPdf({ error: "Súbor je väčší ako 5 MB." }); return; }
    setFiles((p) => (p.some((x) => x.name === f.name && x.size === f.size) ? p : [...p, f].slice(0, 3))); clear("files");
    setReading(true); setFromPdf(null);
    let z = null;
    try { z = parseZiadanka(await readZiadankaPdf(f)); } catch { z = null; }
    setReading(false);
    if (!z) { setFromPdf({ error: "Z tohto PDF sa údaje nepodarilo prečítať (asi sken alebo iný formát). Žiadanka je priložená — údaje vyplňte ručne." }); return; }
    const filled = [], warnings = [], info = [], mark = new Set();
    const p = { ...pat }, c = { ...cl };
    const put = (obj, k, v, lbl) => { if (v === null || v === undefined || v === "") return; obj[k] = String(v); mark.add(k); filled.push(lbl); };
    put(p, "name", z.patientName, "meno pacienta");
    put(p, "birthDate", z.birthDate, "dátum narodenia");
    if (z.insurance) put(p, "insurance", z.insurance, "poisťovňa");
    put(p, "phone", z.phone, "telefón");
    put(p, "email", z.email, "e-mail");
    const ind = [z.question, z.diagnosisCode ? `Dg. ${z.diagnosisCode} ${z.diagnosisText}`.trim() : "", z.previousCt ? `Predchádzajúce CT: ${z.previousCt}` : ""].filter(Boolean).join("\n");
    put(c, "indication", ind, "klinická otázka a diagnóza");
    if (z.contrast) { c.contrast = true; mark.add("contrast"); filled.push("kontrast (CTA)"); }
    if (z.creatinine) { put(c, "creatinine", String(z.creatinine).replace(".", ","), "kreatinín"); }
    if (z.egfr) { put(c, "egfr", String(z.egfr).replace(".", ","), "eGFR"); }
    if (z.creatinine || z.egfr) put(c, "labDate", z.labDate, "dátum odberu");
    if (z.allergyAnswer) { c.allergy = z.allergyAnswer; mark.add("allergy"); filled.push("alergia"); }
    else if (z.allergy) info.push(`Alergická anamnéza na žiadanke: „${z.allergy}" — vyberte odpoveď.`);
    if (z.labDate && z.labDate < toISODate(new Date(Date.now() - 365 * 864e5))) warnings.push("Laboratórny výsledok na žiadanke je starší ako rok — doplňte aktuálny kreatinín alebo eGFR a dátum odberu.");
    if (c.contrast) info.push("Metformín žiadanka neuvádza — vyberte odpoveď.");
    setPat(p); setCl(c);
    if (!req.name.trim() && (z.orderedBy || z.senderDoctor)) { setReq((r) => ({ ...r, name: z.orderedBy || z.senderDoctor })); filled.push("objednávajúci lekár"); }
    if (!req.contact.trim() && z.senderDept) { setReq((r) => ({ ...r, contact: z.senderDept })); filled.push("pracovisko"); }
    const m = matchCtExam(z, data.pricelist);
    if (m) {
      setExamTypeId(m.id); setTime(""); mark.add("exam"); filled.push(`typ CT (${m.label})`);
      const planned = z.plannedDate && z.plannedDate >= todayIso ? z.plannedDate : "";
      const plannedFree = planned && computeOfferedSlots({ openSlots: data.openSlots, takenSet: takenByDate.get(planned) || new Set(), doctors: data.doctors,
        examTypeId: m.id, durationMin: (m.durationSlots || 3) * 5, iso: planned, minTime: earliestTimeFor(planned, ""), limit: Infinity }).length > 0;
      if (plannedFree) {
        setDate(planned); setShowCal(true); const d = new Date(`${planned}T12:00:00`); setMonthDate(new Date(d.getFullYear(), d.getMonth(), 1));
        info.push(`Deň zo žiadanky (${fmtDay(planned)}) má voľné termíny — vyberte čas.`);
      } else { setDate(""); if (planned) info.push(`Na žiadanke je dátum ${fmtDay(planned)}, ten deň však nemá voľný termín — vyberte iný.`); }
    } else if (z.requestedExams.length) info.push(`Požadované na žiadanke: ${z.requestedExams.join("; ")} — vyberte typ CT.`);
    if (z.heightWeight) info.push(`Výška/váha: ${z.heightWeight}.`);
    setPf(mark); setErrs({}); setMsg("");
    setFromPdf({ filled, warnings, info });
  };

  const pickFiles = (e) => {
    const ok = [];
    for (const f of Array.from(e.target.files || [])) {
      if (!/\.(pdf|jpe?g|png)$/i.test(f.name)) { setMsg(`Súbor ${f.name}: povolené sú len PDF, JPG a PNG.`); continue; }
      if (f.size > 5 * 1024 * 1024) { setMsg(`Súbor ${f.name} je väčší ako 5 MB.`); continue; }
      ok.push(f);
    }
    setFiles((p) => [...p, ...ok].slice(0, 3)); clear("files"); e.target.value = "";
  };

  const submit = async () => {
    const e = {};
    if (req.name.trim().length < 3) e.reqName = "Zadajte svoje meno (napr. MUDr. Ján Novák).";
    if (req.contact.trim().length < 2) e.reqContact = "Zadajte klapku alebo telefón, na ktorom vás CT pracovisko zastihne.";
    if (!exam) e.exam = "Vyberte CT vyšetrenie.";
    if (!date || !time) e.slot = "Vyberte deň a čas termínu.";
    if (pat.name.trim().length < 3) e.name = "Zadajte meno a priezvisko pacienta.";
    if (!pat.birthDate) e.birthDate = "Zadajte dátum narodenia (DD.MM.RRRR).";
    if (pat.phone.replace(/\D/g, "").length < 9) e.phone = "Zadajte telefón pacienta (napr. 0905 123 456).";
    if (pat.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(pat.email.trim())) e.email = "E-mail nie je platný — opravte ho alebo nechajte prázdny.";
    if (cl.indication.trim().length < 5) e.indication = "Napíšte klinickú otázku / indikáciu.";
    if (cl.contrast === null) e.contrast = "Vyberte, či sa má podať kontrastná látka.";
    if (cl.contrast === true) {
      if (!(Number(String(cl.creatinine).replace(",", ".")) > 0) && !(Number(String(cl.egfr).replace(",", ".")) > 0)) e.renal = "Uveďte kreatinín alebo eGFR.";
      if (!cl.labDate || cl.labDate > todayIso) e.labDate = "Uveďte dátum odberu.";
      else if (cl.labDate < toISODate(new Date(Date.now() - 365 * 864e5))) e.labDate = "Výsledok je starší ako rok — uveďte aktuálny.";
      if (!cl.allergy) e.allergy = "Vyberte odpoveď.";
      if (cl.metformin === null) e.metformin = "Vyberte odpoveď.";
    }
    if (files.length === 0) e.files = "Priložte žiadanku (PDF alebo fotku).";
    setErrs(e);
    if (Object.keys(e).length) { setMsg(CHECK_MSG); return; }
    setBusy(true); setMsg("");
    const num = (v) => { const n = Number(String(v).replace(",", ".")); return n > 0 ? n : null; };
    const clinical = cl.contrast
      ? { contrast: true, creatinine: num(cl.creatinine), egfr: num(cl.egfr), labDate: cl.labDate, allergy: cl.allergy, metformin: cl.metformin }
      : { contrast: false };
    try {
      const id = await ctDoctorApi.createOrder(token, {
        requestedBy: `${req.name.trim()}, ${req.contact.trim()}`, examTypeId, examLabel: exam.label, durationSlots: exam.durationSlots,
        patientName: pat.name.trim().replace(/\s+/g, " "), birthDate: pat.birthDate, insurance: pat.insurance, phone: normalizePhone(pat.phone),
        email: pat.email.trim(), indication: cl.indication.trim(), clinical, date, time, notify,
      }, files);
      setDone({ id, date, time, label: exam.label, patient: pat.name.trim() });
      await data.reload?.();
    } catch (err) {
      const m = err?.message || String(err);
      if (/vypršalo/i.test(m)) { onExpired(m); return; }
      setMsg(m);
      if (err?.code === "SLOT_TAKEN" || /obsaden/i.test(m)) { setTime(""); await data.reload?.(); }
    } finally { setBusy(false); }
  };

  const reset = () => { setDone(null); setPf(new Set()); setFromPdf(null); setShowCal(false); setExamTypeId(""); setDate(""); setTime(""); setPat(emptyPatient); setCl(emptyClinical); setFiles([]); setNotify(true); setErrs({}); setMsg(""); };
  const bad = (k) => (errs[k] ? " border-danger ring-1 ring-danger/40" : "");
  const Err = ({ k }) => (errs[k] ? <p className="text-xs text-danger mt-1" role="alert">{errs[k]}</p> : null);
  const choice = (on, err) => `text-sm font-semibold px-3 py-1.5 rounded-lg border transition-colors ${on ? "bg-brand text-white border-brand" : `bg-white text-ink hover:border-brand ${err ? "border-danger" : "border-line"}`}`;
  const H = ({ n, children }) => <h2 className="text-base font-semibold text-brand mb-3">{n}. {children}</h2>;

  if (done) {
    return (
      <Card data-testid="ctdoc-done" className="text-center space-y-2">
        <h2 className="text-xl font-semibold text-success">Žiadosť o CT je odoslaná</h2>
        <p className="text-ink"><b>{done.patient}</b> · {done.label}</p>
        <p className="text-ink">Termín: <b>{fmtDay(done.date)} o {done.time}</b> — rezervovaný, čaká na potvrdenie CT pracoviskom.</p>
        <p className="text-sm text-muted">Číslo žiadosti: <span className="font-mono">{done.id}</span>. {notify ? "Pacient dostane SMS (a e-mail) až po potvrdení." : "Pacientovi systém nič neposiela — termín mu oznámte sami."}</p>
        <div className="flex flex-wrap justify-center gap-2 pt-3">
          <Btn onClick={reset} data-testid="ctdoc-new">Nová žiadosť</Btn>
          <Btn variant="secondary" onClick={onShowList}>Objednaní pacienti</Btn>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="ctdoc-form">
      <Card className="border-brand/40" data-testid="ctdoc-pdf-card">
        <h2 className="text-base font-semibold text-brand mb-1">Máte žiadanku z DOCTUSu v PDF?</h2>
        <p className="text-sm text-muted mb-3">Nahrajte ju a formulár sa vyplní sám — meno, dátum narodenia, poisťovňa, telefón, diagnóza, klinická otázka, typ CT a kreatinín. Žiadanka sa zároveň priloží. Súbor sa číta len vo vašom prehliadači.</p>
        <label className={`inline-flex items-center gap-2 cursor-pointer font-semibold rounded-lg px-4 py-2 text-sm ${reading ? "bg-soft text-muted" : "bg-brand hover:bg-brand-dark text-white"}`}>
          <input type="file" accept=".pdf,application/pdf" className="sr-only" onChange={readPdf} disabled={reading} data-testid="ctdoc-pdf" />
          {reading ? "Čítam žiadanku…" : "📄 Nahrať žiadanku (PDF)"}
        </label>
        {fromPdf?.error && <Callout tone="warn" className="mt-3" data-testid="ctdoc-pdf-error">{fromPdf.error}</Callout>}
        {fromPdf?.filled && (
          <div className="mt-3 space-y-2" data-testid="ctdoc-pdf-result">
            <Callout tone="success">Zo žiadanky sme vyplnili: {fromPdf.filled.join(", ")}. Vyplnené polia sú podfarbené — skontrolujte ich, prípadne opravte.</Callout>
            {fromPdf.warnings.map((w) => <Callout key={w} tone="warn">{w}</Callout>)}
            {fromPdf.info.length > 0 && <ul className="text-sm text-ink list-disc pl-5 space-y-0.5">{fromPdf.info.map((t) => <li key={t}>{t}</li>)}</ul>}
          </div>
        )}
      </Card>

      <Card>
        <H n={1}>Objednávajúci lekár</H>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="ctdoc-req-name">Meno lekára <span className="text-danger">*</span></label>
            <input id="ctdoc-req-name" className={inputCls + bad("reqName")} placeholder="MUDr. Ján Novák" value={req.name} onChange={(e) => { setReq((r) => ({ ...r, name: e.target.value })); clear("reqName"); }} data-testid="ctdoc-req-name" />
            <Err k="reqName" />
          </div>
          <div>
            <label className={labelCls} htmlFor="ctdoc-req-contact">Pracovisko / klapka <span className="text-danger">*</span></label>
            <input id="ctdoc-req-contact" className={inputCls + bad("reqContact")} placeholder="napr. kardiológia, kl. 123" value={req.contact} onChange={(e) => { setReq((r) => ({ ...r, contact: e.target.value })); clear("reqContact"); }} data-testid="ctdoc-req-contact" />
            <Err k="reqContact" />
          </div>
        </div>
        <p className="text-xs text-muted mt-2">Meno a klapku si prehliadač zapamätá. CT pracovisko vás podľa nich kontaktuje, ak bude treba niečo doplniť.</p>
      </Card>

      <Card>
        <H n={2}>Vyšetrenie a termín</H>
        {data.pricelist.length === 0 && <p className="text-sm text-muted">Načítavam typy CT vyšetrení…</p>}
        <div className="flex flex-wrap gap-2" role="group" aria-label="CT vyšetrenie">
          {data.pricelist.map((p) => (
            <button key={p.id} type="button" aria-pressed={examTypeId === p.id} data-testid="ctdoc-exam"
              onClick={() => { setExamTypeId(p.id); setDate(""); setTime(""); clear("exam"); clear("slot"); }}
              className={choice(examTypeId === p.id, errs.exam)}>{p.label} <span className="font-normal opacity-70">· {p.durationSlots * 5} min</span></button>
          ))}
        </div>
        <Err k="exam" />
        {exam && (
          <div className="mt-4 space-y-3">
            <p className="text-sm font-semibold text-ink">Najbližšie dni s voľnými termínmi</p>
            {nearestDays.length === 0
              ? <p className="text-sm text-muted" data-testid="ctdoc-no-slots">Na toto vyšetrenie momentálne nie sú voľné CT termíny. Kontaktujte CT pracovisko.</p>
              : (
                <div className="grid md:grid-cols-3 gap-3">
                  {nearestDays.map((n) => (
                    <div key={n.date} data-testid="ctdoc-day" className={`rounded-lg border-2 p-3 ${n.date === date && time ? "border-brand bg-brand-soft" : errs.slot ? "border-danger" : "border-line"}`}>
                      <p className="text-sm font-semibold text-ink mb-2">{fmtDay(n.date)}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {n.times.map((t) => {
                          const on = n.date === date && t.time === time;
                          return (
                            <button key={t.time} type="button" aria-pressed={on} data-testid="ctdoc-day-time" title={t.doctor || undefined}
                              onClick={() => { setDate(n.date); setTime(t.time); clear("slot"); }}
                              className={`px-2.5 py-1.5 rounded-lg text-sm font-semibold font-mono border transition-colors ${on ? "bg-brand text-white border-brand" : "bg-white text-brand border-line hover:border-brand"}`}>
                              {t.time}
                            </button>
                          );
                        })}
                      </div>
                      {[...new Set(n.times.map((t) => t.doctor).filter(Boolean))].length > 0 && (
                        <p className="text-xs text-muted mt-2">{[...new Set(n.times.map((t) => t.doctor).filter(Boolean))].join(", ")}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            {nearestDays.length > 0 && (
              <button type="button" onClick={() => setShowCal((v) => !v)} className="text-sm font-semibold text-brand hover:underline" data-testid="ctdoc-other">
                {showCal ? "▴ Skryť kalendár" : "Iný termín — vybrať v kalendári ▾"}
              </button>
            )}
            {date && time && !pickedNearest && <p className="text-sm text-ink">Vybraný termín: <b>{fmtDay(date)} o {time}</b></p>}
            {showCal && (
              <div className="grid md:grid-cols-2 gap-5 pt-1">
                <div>
                  <MonthCalendar monthDate={monthDate} onMonthChange={(delta) => setMonthDate((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
                    isAvailable={isAvailable} selected={date} onSelect={(iso) => { setDate(iso); setTime(""); clear("slot"); }} />
                  <p className="text-xs text-muted mt-2">Modré dni majú voľné otvorené CT termíny.</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink mb-2">{date ? `Voľné časy — ${fmtDay(date)}` : "Vyberte deň v kalendári"}</p>
                  <div className="flex flex-wrap gap-2">
                    {date && offered(date).map((s2) => (
                      <button key={s2.time} type="button" aria-pressed={time === s2.time} data-testid="ctdoc-time" onClick={() => { setTime(s2.time); clear("slot"); }}
                        className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${time === s2.time ? "bg-brand text-white border-brand" : "bg-white text-brand border-line hover:border-brand"}`}>
                        {s2.time}{s2.doctor ? <span className="block text-xs font-normal opacity-70">{s2.doctor}</span> : null}
                      </button>
                    ))}
                    {date && offered(date).length === 0 && <p className="text-sm text-muted">V tento deň už nie sú voľné časy.</p>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <Err k="slot" />
      </Card>

      <Card>
        <H n={3}>Pacient</H>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="ctdoc-name">Meno a priezvisko <span className="text-danger">*</span></label>
            <input id="ctdoc-name" className={inputCls + bad("name") + hl("name")} autoComplete="off" value={pat.name} onChange={(e) => setP("name", e.target.value)} data-testid="ctdoc-name" />
            <Err k="name" />
          </div>
          <div>
            <label className={labelCls} htmlFor="ctdoc-birth">Dátum narodenia <span className="text-danger">*</span></label>
            <BirthDateInput id="ctdoc-birth" data-testid="ctdoc-birth" autoComplete="off" className={inputCls + bad("birthDate") + hl("birthDate")} value={pat.birthDate} onChange={(v) => setP("birthDate", v)} />
            <Err k="birthDate" />
          </div>
          <div>
            <label className={labelCls} htmlFor="ctdoc-ins">Zdravotná poisťovňa</label>
            <select id="ctdoc-ins" className={inputCls + hl("insurance")} value={pat.insurance} onChange={(e) => setP("insurance", e.target.value)}>
              {insuranceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ctdoc-phone">Telefón pacienta <span className="text-danger">*</span></label>
            <input id="ctdoc-phone" type="tel" autoComplete="off" className={inputCls + bad("phone") + hl("phone")} value={pat.phone} onChange={(e) => setP("phone", e.target.value)} data-testid="ctdoc-phone" />
            <Err k="phone" />
          </div>
          <div>
            <label className={labelCls} htmlFor="ctdoc-email">E-mail pacienta <span className="font-normal text-muted">(nepovinné)</span></label>
            <input id="ctdoc-email" type="email" autoComplete="off" className={inputCls + bad("email") + hl("email")} value={pat.email} onChange={(e) => setP("email", e.target.value)} data-testid="ctdoc-email" />
            <Err k="email" />
          </div>
        </div>
      </Card>

      <Card>
        <H n={4}>Klinické údaje</H>
        <div className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="ctdoc-ind">Klinická otázka / indikácia <span className="text-danger">*</span></label>
            <textarea id="ctdoc-ind" rows={3} maxLength={2000} className={inputCls + bad("indication") + hl("indication")} placeholder="napr. vylúčiť disekciu aorty; kontrola po EVAR" value={cl.indication} onChange={(e) => setC("indication", e.target.value)} data-testid="ctdoc-indication" />
            <Err k="indication" />
          </div>
          <fieldset>
            <legend className={labelCls}>Kontrastná látka <span className="text-danger">*</span></legend>
            <div className="flex gap-2">
              <button type="button" aria-pressed={cl.contrast === false} onClick={() => setC("contrast", false)} className={choice(cl.contrast === false, errs.contrast)} data-testid="ctdoc-contrast-no">Bez kontrastu</button>
              <button type="button" aria-pressed={cl.contrast === true} onClick={() => setC("contrast", true)} className={choice(cl.contrast === true, errs.contrast)} data-testid="ctdoc-contrast-yes">S kontrastom</button>
            </div>
            <Err k="contrast" />
          </fieldset>
          {cl.contrast === true && (
            <div className="border border-line rounded-lg p-3 space-y-3 bg-soft">
              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <label className={labelCls} htmlFor="ctdoc-crea">Kreatinín <span className="font-normal text-muted">(µmol/l)</span></label>
                  <input id="ctdoc-crea" inputMode="decimal" className={inputCls + bad("renal") + hl("creatinine")} value={cl.creatinine} onChange={(e) => { setC("creatinine", e.target.value); clear("renal"); }} data-testid="ctdoc-creatinine" />
                </div>
                <div>
                  <label className={labelCls} htmlFor="ctdoc-egfr">eGFR <span className="font-normal text-muted">(ml/min/1,73 m²)</span></label>
                  <input id="ctdoc-egfr" inputMode="decimal" className={inputCls + bad("renal") + hl("egfr")} value={cl.egfr} onChange={(e) => { setC("egfr", e.target.value); clear("renal"); }} data-testid="ctdoc-egfr" />
                </div>
                <div>
                  <label className={labelCls} htmlFor="ctdoc-lab">Dátum odberu <span className="text-danger">*</span></label>
                  <input id="ctdoc-lab" type="date" max={todayIso} className={inputCls + bad("labDate") + hl("labDate")} value={cl.labDate} onChange={(e) => setC("labDate", e.target.value)} data-testid="ctdoc-labdate" />
                  <Err k="labDate" />
                </div>
              </div>
              {errs.renal ? <Err k="renal" /> : <p className="text-xs text-muted">Stačí kreatinín alebo eGFR.</p>}
              <fieldset>
                <legend className={labelCls}>Alergia na jódovú kontrastnú látku <span className="text-danger">*</span></legend>
                <div className="flex flex-wrap gap-2">
                  {[["nie", "Nie"], ["ano", "Áno"], ["nevie", "Nevie sa"]].map(([v, l]) => (
                    <button key={v} type="button" aria-pressed={cl.allergy === v} onClick={() => setC("allergy", v)} className={choice(cl.allergy === v, errs.allergy)} data-testid={`ctdoc-allergy-${v}`}>{l}</button>
                  ))}
                </div>
                <Err k="allergy" />
              </fieldset>
              <fieldset>
                <legend className={labelCls}>Užíva metformín <span className="text-danger">*</span></legend>
                <div className="flex gap-2">
                  <button type="button" aria-pressed={cl.metformin === false} onClick={() => setC("metformin", false)} className={choice(cl.metformin === false, errs.metformin)} data-testid="ctdoc-metformin-no">Nie</button>
                  <button type="button" aria-pressed={cl.metformin === true} onClick={() => setC("metformin", true)} className={choice(cl.metformin === true, errs.metformin)} data-testid="ctdoc-metformin-yes">Áno</button>
                </div>
                <Err k="metformin" />
              </fieldset>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <H n={5}>Žiadanka a odoslanie</H>
        <div className={`rounded-lg p-3 border ${errs.files ? "border-danger bg-danger-soft" : "border-line bg-soft"}`}>
          <label className={labelCls} htmlFor="ctdoc-files">Žiadanka <span className="text-danger">*</span> <span className="font-normal text-muted">(PDF, JPG, PNG — najviac 3 súbory po 5 MB)</span></label>
          <input id="ctdoc-files" type="file" accept=".pdf,.jpg,.jpeg,.png" multiple onChange={pickFiles} data-testid="ctdoc-files"
            className="block w-full text-sm text-muted file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-brand-soft file:text-brand file:font-semibold" />
          <Err k="files" />
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={i} className="flex items-center justify-between text-sm bg-white border border-line rounded-lg px-3 py-1.5">
                  <span className="truncate">{f.name}</span>
                  <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="text-danger text-xs font-semibold shrink-0 ml-2" aria-label={`Odstrániť ${f.name}`}>✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="flex items-start gap-2 text-sm text-ink cursor-pointer mt-4">
          <input type="checkbox" className="mt-1 accent-brand" checked={notify} onChange={(e) => setNotify(e.target.checked)} data-testid="ctdoc-notify" />
          <span>Po potvrdení termínu CT pracoviskom poslať pacientovi SMS{pat.email.trim() ? " a e-mail" : ""} a pripomienku deň vopred</span>
        </label>
        {!notify && <p className="text-xs text-warn mt-1 ml-6">Pacient nedostane žiadnu správu — termín mu oznámte sami.</p>}
        {msg && <Callout tone="danger" role="alert" className="mt-4" data-testid="ctdoc-error">{msg}</Callout>}
        <div className="flex flex-wrap items-center gap-3 mt-4">
          <Btn size="lg" onClick={submit} disabled={busy} data-testid="ctdoc-submit">{busy ? "Odosielam…" : "Odoslať žiadosť o termín"}</Btn>
          {exam && date && time && <span className="text-sm text-muted">{exam.label} · {fmtDay(date)} o {time}</span>}
        </div>
      </Card>
    </div>
  );
}

// ---------- Objednaní pacienti ----------
const LIST_STATUS = { new: "Čaká na potvrdenie", confirmed: "Potvrdené", done: "Vykonané", noshow: "Nedostavil sa", rejected: "Zrušené" };
function OrderList({ token, onExpired }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const load = async () => {
    setErr("");
    try { setRows(await ctDoctorApi.list(token)); }
    catch (e) { const m = e?.message || String(e); if (/vypršalo/i.test(m)) onExpired(m); else setErr(m); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [token]);
  const list = (rows || []).filter((r) => { const s = q.trim().toLowerCase(); return !s || `${r.patient} ${r.requestedBy} ${r.exam} ${r.id}`.toLowerCase().includes(s); });
  return (
    <Card data-testid="ctdoc-list">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-lg font-semibold text-brand">Objednaní pacienti na CT</h2>
        <Btn variant="secondary" size="sm" onClick={load}>↻ Obnoviť</Btn>
      </div>
      <input className={inputCls + " mb-3"} placeholder="Hľadať pacienta, lekára, vyšetrenie…" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <Callout tone="danger" role="alert">{err}</Callout>}
      {rows === null ? <p className="text-sm text-muted">Načítavam…</p>
        : list.length === 0 ? <p className="text-sm text-muted">Žiadne CT objednávky.</p>
        : (
          <div className="divide-y divide-line">
            {list.map((r) => (
              <div key={r.id} className="py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="ctdoc-row">
                <div className="w-40 shrink-0 text-sm"><b className="text-ink">{fmtDay(r.date)}</b><span className="block font-mono text-muted">{r.time}</span></div>
                <div className="flex-1 min-w-[12rem]">
                  <p className="font-semibold text-ink">{r.patient}{r.birthYear ? <span className="font-normal text-muted"> · nar. {r.birthYear}</span> : null}</p>
                  <p className="text-xs text-muted">{r.exam}{r.requestedBy ? ` · objednal ${r.requestedBy}` : ""}</p>
                  {r.status === "rejected" && r.note && <p className="text-xs text-danger">Dôvod: {r.note}</p>}
                </div>
                <StatusChip status={r.status} label={LIST_STATUS[r.status] || r.status} />
              </div>
            ))}
          </div>
        )}
      <p className="text-xs text-muted mt-3">Zobrazujú sa CT termíny od 7 dní dozadu. Presun alebo zrušenie termínu vybaví CT pracovisko.</p>
    </Card>
  );
}

// ---------- Stránka ----------
export default function CtDoctorApp() {
  const [session, setSession] = useState(() => { const s = loadJson(TOKEN_KEY, null, sessionStorage); return s && s.exp > Date.now() ? s : null; });
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("new");
  const data = useCtData(false);
  const login = (s) => { try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s)); } catch { /* */ } setNotice(""); setSession(s); };
  const logout = (why = "") => { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* */ } setSession(null); setNotice(typeof why === "string" ? why : ""); };
  if (!session) return <DoctorLogin onLogin={login} notice={notice} />;
  const tabBtn = (id, label) => (
    <button type="button" onClick={() => setTab(id)} data-testid={`ctdoc-tab-${id}`}
      className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${tab === id ? "bg-brand text-white" : "bg-soft text-ink hover:bg-line"}`}>{label}</button>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-brand mr-auto">CT objednávanie pre lekárov NÚSCH</h1>
        {tabBtn("new", "Nová žiadosť")}
        {tabBtn("list", "Objednaní pacienti")}
        <Btn variant="secondary" onClick={() => logout("")} data-testid="ctdoc-logout">Odhlásiť sa</Btn>
      </div>
      {data.loadError && <Callout tone="danger">CT termíny sa nepodarilo načítať ({data.loadError}).</Callout>}
      {tab === "new"
        ? <NewRequest data={data} token={session.token} onExpired={(m) => logout(m || EXPIRED)} onShowList={() => setTab("list")} />
        : <OrderList token={session.token} onExpired={(m) => logout(m || EXPIRED)} />}
    </div>
  );
}
