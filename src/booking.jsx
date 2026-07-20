import { useState, useEffect, useMemo } from "react";
import { encode, PaymentOptions, CurrencyCode } from "bysquare/pay";
import QRCode from "qrcode";

// --- 1. KONFIGURÁCIA ---

const USG_ORDERS_KEY = "usgOrders_v1";
const USG_OPEN_SLOTS_KEY = "usgOpenSlots_v2";
const USG_SETTINGS_KEY = "usgSettings_v1";
const USG_PRICELIST_KEY = "usgPricelist_v2";

// Cenník platených USG vyšetrení v rámci doplnkových ordinačných hodín (NÚSCH, a.s., platnosť od 01.03.2026)
// priceSelf = samoplatca cena s DPH, priceReferral = doplatok + žiadanka cena s DPH (null = so žiadankou nedostupné)
const defaultPricelist = [
  { id: "abdomen", label: "USG brucha a brušnej dutiny", priceSelf: 45, priceReferral: 30 },
  { id: "kidneys", label: "USG obličiek a močového mechúra", priceSelf: 40, priceReferral: 30 },
  { id: "pelvis", label: "USG orgánov malej panvy", priceSelf: 40, priceReferral: 30 },
  { id: "soft", label: "USG mäkkých tkanív", priceSelf: 40, priceReferral: 30 },
  { id: "thyroid", label: "USG štítnej žľazy", priceSelf: 40, priceReferral: 30 },
  { id: "neck", label: "USG orgánov krku (štítna žľaza, slinné žľazy, lymfatické uzliny)", priceSelf: 50, priceReferral: 30 },
  { id: "carotid", label: "Dopplerova ultrasonografia extrakraniálnych mozgových tepien (karotíd a vertebrálnych artérií)", priceSelf: 50, priceReferral: 30 },
  { id: "upper1", label: "Dopplerova ultrasonografia žíl alebo tepien horných končatín (jedna končatina)", priceSelf: 40, priceReferral: 30 },
  { id: "upper2", label: "Dopplerova ultrasonografia žíl alebo tepien horných končatín (obe končatiny)", priceSelf: 50, priceReferral: 30 },
  { id: "lower1", label: "Dopplerova ultrasonografia žíl alebo tepien dolných končatín (jedna končatina)", priceSelf: 40, priceReferral: 30 },
  { id: "lower2", label: "Dopplerova ultrasonografia žíl alebo tepien dolných končatín (obe končatiny)", priceSelf: 50, priceReferral: 30 },
  { id: "renal", label: "USG brucha s vyšetrením renálnych artérií", priceSelf: 60, priceReferral: 30 },
  { id: "aorta", label: "USG brucha s vyšetrením brušnej aorty", priceSelf: 50, priceReferral: 30 },
  { id: "tos", label: "Dopplerova ultrasonografia na vylúčenie TOS (žilový alebo tepnový typ)", priceSelf: 100, priceReferral: 30 },
  { id: "complete_vessels", label: "Kompletné sonografické vyšetrenie ciev (tepny a žily krku, dolných končatín a brušnej aorty)", priceSelf: 100, priceReferral: null },
  { id: "compressions", label: "Kompletné sonografické vyšetrenie abdominálnych cievnych kompresií + konzultácia", priceSelf: 350, priceReferral: null },
  { id: "consultation", label: "USG vyšetrenie a komplexná rádiologická konzultácia prinesených materiálov", priceSelf: 90, priceReferral: null },
];

function normalizePricelist(list) {
  if (Array.isArray(list) && list.length > 0 && list.every((i) => i && typeof i.priceSelf === "number")) {
    return list;
  }
  return defaultPricelist;
}

const insuranceOptions = [
  { id: "25", label: "25 - VšZP" },
  { id: "24", label: "24 - Dôvera" },
  { id: "27", label: "27 - Union" },
  { id: "other", label: "Iná / bez poistenia" },
];

const usgStatuses = {
  new: { label: "Nová", badge: "bg-yellow-600", border: "border-yellow-500" },
  confirmed: { label: "Potvrdená", badge: "bg-green-600", border: "border-green-500" },
  rejected: { label: "Zamietnutá", badge: "bg-red-600", border: "border-red-500" },
  done: { label: "Vykonaná", badge: "bg-blue-600", border: "border-blue-500" },
  noshow: { label: "Neprišiel", badge: "bg-slate-500", border: "border-slate-400" },
};

const defaultSettings = {
  iban: "SK3112000000198742637541", // DEMO IBAN — nastavte vlastný v správe!
  beneficiary: "NÚSCH, a.s.",
  doctors: [], // mená lekárov priraditeľných k termínom
};

// Sloty po 20 minút, ktoré môže pracovisko otvoriť
const SLOT_START_MINUTES = 7 * 60 + 30;
const SLOT_END_MINUTES = 14 * 60 + 30;
const SLOT_LENGTH_MINUTES = 20;
const EXAM_DURATION_LABEL = "20 min";

export function generateWindowSlots(fromTime, toTime, stepMinutes) {
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const from = toMin(fromTime);
  const to = toMin(toTime);
  const step = Number(stepMinutes);
  const slots = [];
  if (!step || step < 5 || from >= to) return slots;
  for (let m = from; m + step <= to; m += step) {
    slots.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return slots;
}

function generateDaySlots() {
  const slots = [];
  for (let m = SLOT_START_MINUTES; m + SLOT_LENGTH_MINUTES <= SLOT_END_MINUTES; m += SLOT_LENGTH_MINUTES) {
    slots.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return slots;
}

const allDaySlots = generateDaySlots();

// --- 2. POMOCNÉ FUNKCIE ---

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateHuman(isoDate) {
  if (!isoDate) return "";
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("sk-SK", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

function formatDateShort(isoDate) {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("sk-SK", {
    weekday: "short", day: "numeric", month: "numeric",
  });
}

function formatPrice(price) {
  return `${price.toFixed(2).replace(".", ",")} €`;
}

function loadJson(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.error(`Nepodarilo sa načítať ${key}`, e);
  }
  return fallback;
}

function isSlotOccupying(order) {
  return order.status !== "rejected";
}

// Kontrola slovenského/českého rodného čísla: formát, mesiac (+20/+50/+70),
// platný dátum a deliteľnosť 11 (10-miestne; s historickou výnimkou do r. 1985).
export function validateBirthNumber(input) {
  const clean = String(input).replace(/[\s/]/g, "");
  if (!/^\d{9,10}$/.test(clean)) return "Rodné číslo zadajte v tvare RRMMDD/XXXX.";
  const yy = parseInt(clean.slice(0, 2), 10);
  let mm = parseInt(clean.slice(2, 4), 10);
  const dd = parseInt(clean.slice(4, 6), 10);
  if (mm > 70) mm -= 70;
  else if (mm > 50) mm -= 50;
  else if (mm > 20) mm -= 20;
  if (mm < 1 || mm > 12) return "Rodné číslo má neplatný mesiac.";
  if (clean.length === 9) {
    if (yy > 53) return "9-miestne rodné číslo môžu mať len osoby narodené do roku 1953.";
  } else {
    const first9 = parseInt(clean.slice(0, 9), 10);
    const check = parseInt(clean[9], 10);
    const wholeOk = Number(clean) % 11 === 0;
    const legacyOk = first9 % 11 === 10 && check === 0;
    if (!wholeOk && !legacyOk) return "Rodné číslo nie je platné (nesedí kontrolný súčet).";
  }
  const year = clean.length === 9 ? 1900 + yy : yy + (yy < 54 ? 2000 : 1900);
  const date = new Date(year, mm - 1, dd);
  if (date.getFullYear() !== year || date.getMonth() !== mm - 1 || date.getDate() !== dd) {
    return "Rodné číslo obsahuje neplatný dátum narodenia.";
  }
  if (date > new Date()) return "Rodné číslo obsahuje dátum v budúcnosti.";
  return null;
}

// --- 3. QR PLATBA (PAY by square) ---

const PaymentQr = ({ order, settings }) => {
  const [dataUrl, setDataUrl] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setDataUrl(null);
    setError("");
    try {
      const qrString = encode({
        payments: [{
          type: PaymentOptions.PaymentOrder,
          amount: order.price,
          currencyCode: CurrencyCode.EUR,
          variableSymbol: order.variableSymbol,
          paymentNote: `USG ${order.patient.name} ${order.date} ${order.time}`,
          beneficiary: { name: settings.beneficiary },
          bankAccounts: [{ iban: settings.iban.replace(/\s/g, "") }],
        }],
      });
      QRCode.toDataURL(qrString, { width: 260, margin: 2 })
        .then((url) => { if (alive) setDataUrl(url); })
        .catch((e) => { if (alive) setError(String(e)); });
    } catch (e) {
      setError(String(e));
    }
    return () => { alive = false; };
  }, [order, settings]);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-300 p-4 rounded-lg text-sm text-red-700">
        QR kód sa nepodarilo vygenerovať — skontrolujte IBAN v nastaveniach správy. ({error})
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 inline-block shadow-sm">
      {dataUrl
        ? <img src={dataUrl} alt="QR platba" width={260} height={260} />
        : <div className="w-[260px] h-[260px] flex items-center justify-center text-slate-400">Generujem QR…</div>}
    </div>
  );
};

// --- 4. PACIENTSKY SPRIEVODCA (štýl Bookio) ---

const UsgHero = () => (
  <div className="bg-white rounded-2xl shadow-xl p-5 md:p-8 mb-4 text-slate-800">
    <p className="text-xs font-bold tracking-widest text-[#e2001a] uppercase mb-1">Národný ústav srdcových a cievnych chorôb, a.s.</p>
    <h2 className="text-2xl md:text-3xl font-extrabold text-[#003d7c] mb-2">
      Cievne USG vyšetrenie tam, kde cievam rozumejú najlepšie
    </h2>
    <p className="text-slate-600 mb-5">
      Objednajte sa online na sonografické vyšetrenie ciev priamo v NÚSCH — bez čakania v rade,
      s termínom, ktorý si vyberiete sami, a platbou vopred cez QR kód.
    </p>
    <div className="grid md:grid-cols-3 gap-3">
      <div className="bg-[#f5f8fb] border border-slate-200 rounded-xl p-4">
        <div className="text-2xl mb-1">🩺</div>
        <p className="font-bold text-slate-800 text-sm mb-1">Skúsení odborníci</p>
        <p className="text-xs text-slate-600">
          Vyšetrenie vykonávajú lekári s dlhoročnou praxou v cievnej diagnostike na moderných ultrazvukových prístrojoch.
        </p>
      </div>
      <div className="bg-[#f5f8fb] border border-slate-200 rounded-xl p-4">
        <div className="text-2xl mb-1">🏥</div>
        <p className="font-bold text-slate-800 text-sm mb-1">Tradícia a špecializácia</p>
        <p className="text-xs text-slate-600">
          NÚSCH je špičkové slovenské pracovisko pre srdce a cievy — diagnostike cievnych ochorení sa venujeme desaťročia.
        </p>
      </div>
      <div className="bg-[#f5f8fb] border border-slate-200 rounded-xl p-4">
        <div className="text-2xl mb-1">🤝</div>
        <p className="font-bold text-slate-800 text-sm mb-1">Starostlivosť, ktorá nekončí nálezom</p>
        <p className="text-xs text-slate-600">
          Pri pozitívnom náleze na vyšetrenie priamo nadväzuje ďalšia diagnostika a liečba u našich špecialistov — všetko pod jednou strechou.
        </p>
      </div>
    </div>
  </div>
);

const wizardSteps = ["Vyšetrenie", "Termín", "Vaše údaje", "Platba"];

const StepIndicator = ({ current }) => (
  <div className="flex items-center justify-between mb-6">
    {wizardSteps.map((label, i) => {
      const stepNum = i + 1;
      const done = stepNum < current;
      const active = stepNum === current;
      return (
        <div key={label} className="flex items-center flex-1 last:flex-none">
          <div className="flex flex-col items-center">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm transition-colors ${
              done ? "bg-emerald-500 text-white" : active ? "bg-[#e2001a] text-white" : "bg-slate-200 text-slate-500"
            }`}>
              {done ? "✓" : stepNum}
            </div>
            <span className={`text-[11px] mt-1 font-semibold whitespace-nowrap ${active ? "text-[#e2001a]" : done ? "text-emerald-600" : "text-slate-400"}`}>
              {label}
            </span>
          </div>
          {i < wizardSteps.length - 1 && (
            <div className={`flex-1 h-0.5 mx-2 mb-4 ${stepNum < current ? "bg-emerald-400" : "bg-slate-200"}`} />
          )}
        </div>
      );
    })}
  </div>
);

const MonthCalendar = ({ monthDate, onMonthChange, isAvailable, selected, onSelect }) => {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // pondelok = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayIso = toISODate(new Date());
  const monthLabel = firstDay.toLocaleDateString("sk-SK", { month: "long", year: "numeric" });

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={() => onMonthChange(-1)} className="w-9 h-9 rounded-full hover:bg-slate-100 text-slate-600 font-bold text-lg transition-colors">‹</button>
        <span className="font-bold text-slate-800 capitalize">{monthLabel}</span>
        <button type="button" onClick={() => onMonthChange(1)} className="w-9 h-9 rounded-full hover:bg-slate-100 text-slate-600 font-bold text-lg transition-colors">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-slate-400 mb-1">
        {["Po", "Ut", "St", "Št", "Pi", "So", "Ne"].map((d) => (<span key={d} className="py-1">{d}</span>))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (day === null) return <span key={`empty-${i}`} />;
          const iso = toISODate(new Date(year, month, day));
          const available = isAvailable(iso);
          const isSelected = selected === iso;
          const isToday = iso === todayIso;
          return (
            <button
              key={iso}
              type="button"
              title={iso}
              disabled={!available}
              onClick={() => onSelect(iso)}
              className={`aspect-square rounded-full text-sm font-semibold transition-colors ${
                isSelected ? "bg-[#005ca9] text-white"
                : available ? "bg-[#eaf2fa] text-[#005ca9] hover:bg-[#d8e8f6]"
                : "text-slate-300 cursor-default"
              } ${isToday && !isSelected ? "ring-1 ring-[#005ca9]" : ""}`}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const emptyForm = {
  hasReferral: "", // "yes" = so žiadankou (doplatok), "no" = samoplatca (plná cena)
  examTypeId: "",
  reason: "",
  referrerName: "",
  referrerFacility: "",
  patientName: "",
  birthDate: "",
  insurance: "25",
  phone: "",
  email: "",
  date: "",
  time: "",
};

const PatientView = ({ occupied, openSlots, settings, pricelist, onSubmit }) => {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(emptyForm);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdOrder, setCreatedOrder] = useState(null);

  const MAX_FILES = 3;
  const MAX_FILE_MB = 5;
  const handleFilePick = (e) => {
    setError("");
    const picked = Array.from(e.target.files || []);
    const ok = [];
    for (const f of picked) {
      if (!/\.(pdf|jpe?g|png)$/i.test(f.name)) { setError(`Súbor ${f.name}: povolené sú len PDF, JPG a PNG.`); continue; }
      if (f.size > MAX_FILE_MB * 1024 * 1024) { setError(`Súbor ${f.name} je väčší ako ${MAX_FILE_MB} MB.`); continue; }
      ok.push(f);
    }
    setFiles((prev) => [...prev, ...ok].slice(0, MAX_FILES));
    e.target.value = "";
  };
  const removeFile = (index) => setFiles((prev) => prev.filter((_, i) => i !== index));

  const isReferral = form.hasReferral === "yes";
  const examChoices = isReferral ? pricelist.filter((t) => t.priceReferral != null) : pricelist;
  const examType = examChoices.find((t) => t.id === form.examTypeId) || null;
  const priceFor = (t) => (isReferral ? t.priceReferral : t.priceSelf);

  const setField = (field, value) => setForm((f) => ({ ...f, [field]: value }));
  const chooseReferral = (value) => setForm((f) => ({ ...f, hasReferral: value, examTypeId: "" }));

  const takenByDate = useMemo(() => {
    const map = new Map();
    occupied.forEach(({ date, time }) => {
      if (!map.has(date)) map.set(date, new Set());
      map.get(date).add(time);
    });
    return map;
  }, [occupied]);

  const freeSlotsFor = (isoDate) => {
    const open = openSlots[isoDate] || [];
    const taken = takenByDate.get(isoDate) || new Set();
    return open.filter((slot) => !taken.has(slot.time));
  };

  const todayIso = toISODate(new Date());
  const isDayAvailable = (iso) => iso >= todayIso && freeSlotsFor(iso).length > 0;

  const firstAvailableIso = useMemo(() => {
    const d = new Date();
    for (let i = 0; i < 180; i++) {
      const iso = toISODate(d);
      if (isDayAvailable(iso)) return iso;
      d.setDate(d.getDate() + 1);
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSlots, takenByDate]);

  const [monthDate, setMonthDate] = useState(() => {
    const base = firstAvailableIso ? new Date(`${firstAvailableIso}T12:00:00`) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const shiftMonth = (delta) => setMonthDate((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));

  const goNext = () => {
    setError("");
    if (step === 1) {
      if (!form.hasReferral) return setError("Vyberte, či máte žiadanku od lekára.");
      if (!examType) return setError("Vyberte typ vyšetrenia.");
    }
    if (step === 2) {
      if (!form.date || !form.time) return setError("Vyberte si deň a čas.");
      if (!freeSlotsFor(form.date).some((slot) => slot.time === form.time)) {
        setField("time", "");
        return setError("Vybraný termín už nie je dostupný. Vyberte iný.");
      }
    }
    setStep((s) => s + 1);
  };
  const goBack = () => { setError(""); setStep((s) => Math.max(1, s - 1)); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    const chosenSlot = freeSlotsFor(form.date).find((slot) => slot.time === form.time);
    if (!chosenSlot) {
      setStep(2);
      setField("time", "");
      return setError("Vybraný termín už nie je dostupný. Vyberte iný.");
    }
    if (form.phone.replace(/\D/g, "").length < 9) {
      return setError("Zadajte platné telefónne číslo (aspoň 9 číslic).");
    }
    const order = {
      id: `USG-${Date.now().toString(36).toUpperCase()}`,
      variableSymbol: String(Date.now()).slice(-10),
      createdAt: new Date().toISOString(),
      status: "new",
      statusNote: "",
      hasReferral: isReferral,
      doctor: chosenSlot.doctor || "",
      paid: false,
      exam: {
        typeId: examType.id,
        label: examType.label,
        reason: form.reason.trim(),
        referrerName: isReferral ? form.referrerName.trim() : "",
        referrerFacility: isReferral ? form.referrerFacility.trim() : "",
      },
      price: priceFor(examType),
      patient: {
        name: form.patientName.trim(),
        birthDate: form.birthDate,
        insurance: form.insurance,
        phone: form.phone.trim(),
        email: form.email.trim(),
      },
      date: form.date,
      time: form.time,
    };
    setBusy(true);
    try {
      await onSubmit(order, files);
      setCreatedOrder(order);
      setStep(4);
      setFiles([]);
    } catch (err) {
      setError(err?.message || "Objednávku sa nepodarilo odoslať. Skúste to znova.");
    } finally {
      setBusy(false);
    }
  };

  const resetWizard = () => { setCreatedOrder(null); setForm(emptyForm); setStep(1); setError(""); };

  const inputCls = "w-full p-3 bg-white border border-slate-300 rounded-lg text-slate-800 focus:ring-2 focus:ring-[#005ca9] focus:border-[#005ca9] outline-none";
  const labelCls = "block text-sm font-semibold text-slate-600 mb-1";

  return (
    <div className="bg-white rounded-2xl shadow-xl p-5 md:p-8 text-slate-800">
      <StepIndicator current={step} />

      {/* KROK 1 — VYŠETRENIE */}
      {step === 1 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-lg font-bold text-[#003d7c] mb-1">Máte žiadanku od lekára?</h3>
            <p className="text-sm text-slate-500 mb-3">
              Ide o platené vyšetrenia v rámci doplnkových ordinačných hodín. So žiadankou (výmenným lístkom)
              platíte len doplatok, bez žiadanky plnú cenu podľa cenníka.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={() => chooseReferral("yes")}
                className={`flex-1 p-4 rounded-xl border-2 text-left transition-colors ${
                  form.hasReferral === "yes" ? "border-[#005ca9] bg-[#eaf2fa]" : "border-slate-200 hover:border-[#8fb8dd]"
                }`}
              >
                <span className="font-bold text-slate-800">Áno, mám žiadanku</span>
                <span className="block text-xs text-slate-500 mt-1">platí sa doplatok podľa cenníka</span>
              </button>
              <button
                type="button"
                onClick={() => chooseReferral("no")}
                className={`flex-1 p-4 rounded-xl border-2 text-left transition-colors ${
                  form.hasReferral === "no" ? "border-[#005ca9] bg-[#eaf2fa]" : "border-slate-200 hover:border-[#8fb8dd]"
                }`}
              >
                <span className="font-bold text-slate-800">Nie, nemám žiadanku</span>
                <span className="block text-xs text-slate-500 mt-1">samoplatca — plná cena podľa cenníka</span>
              </button>
            </div>
          </div>

          {form.hasReferral && (
            <div>
              <h3 className="text-lg font-bold text-[#003d7c] mb-3">Vyberte vyšetrenie</h3>
              <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                {examChoices.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setField("examTypeId", t.id)}
                    className={`w-full flex items-center justify-between gap-3 p-4 rounded-xl border-2 text-left transition-colors ${
                      form.examTypeId === t.id ? "border-[#005ca9] bg-[#eaf2fa]" : "border-slate-200 hover:border-[#8fb8dd]"
                    }`}
                  >
                    <span>
                      <span className="font-semibold text-slate-800 text-sm">{t.label}</span>
                      <span className="block text-xs text-slate-400 mt-0.5">⏱ {EXAM_DURATION_LABEL}</span>
                    </span>
                    <span className="text-[#005ca9] font-bold whitespace-nowrap">{formatPrice(priceFor(t))}</span>
                  </button>
                ))}
              </div>
              {isReferral && (
                <p className="text-xs text-slate-400 mt-2">
                  Niektoré vyšetrenia sú dostupné len ako samoplatcovské — v tomto zozname sa nezobrazujú.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* KROK 2 — TERMÍN */}
      {step === 2 && (
        <div>
          <h3 className="text-lg font-bold text-[#003d7c] mb-1">Vyberte termín</h3>
          <p className="text-sm text-slate-500 mb-4">
            {examType?.label} · <span className="font-semibold text-[#005ca9]">{examType && formatPrice(priceFor(examType))}</span>
          </p>
          {firstAvailableIso === null ? (
            <p className="text-slate-500 bg-slate-50 border border-slate-200 p-4 rounded-xl">
              Momentálne nie sú otvorené žiadne termíny na objednávanie. Skúste to prosím neskôr.
            </p>
          ) : (
            <div className="grid md:grid-cols-2 gap-6">
              <MonthCalendar
                monthDate={monthDate}
                onMonthChange={shiftMonth}
                isAvailable={isDayAvailable}
                selected={form.date}
                onSelect={(iso) => { setField("date", iso); setField("time", ""); }}
              />
              <div>
                {form.date ? (
                  <>
                    <p className="font-semibold text-slate-700 mb-2 capitalize">{formatDateHuman(form.date)}</p>
                    <div className="grid grid-cols-3 gap-2">
                      {freeSlotsFor(form.date).map((slot) => (
                        <button
                          key={slot.time}
                          type="button"
                          onClick={() => setField("time", slot.time)}
                          className={`py-2 px-2 rounded-lg text-sm font-bold border-2 transition-colors ${
                            form.time === slot.time
                              ? "border-[#005ca9] bg-[#005ca9] text-white"
                              : "border-[#b3d1ec] text-[#005ca9] hover:border-[#005ca9]"
                          }`}
                        >
                          {slot.time}
                          {slot.doctor && <span className="block text-[10px] font-normal opacity-80 truncate">{slot.doctor}</span>}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-slate-400 text-sm mt-8 text-center">← Vyberte deň v kalendári.<br />Modré dni majú voľné termíny.</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* KROK 3 — ÚDAJE */}
      {step === 3 && (
        <form id="patient-details-form" onSubmit={handleSubmit} className="space-y-4">
          <h3 className="text-lg font-bold text-[#003d7c]">Vaše údaje</h3>
          <div className="bg-[#eaf2fa] border border-[#b3d1ec] rounded-xl p-3 text-sm text-slate-700">
            <strong>{examType?.label}</strong> — {formatDateHuman(form.date)} o {form.time} ·{" "}
            <span className="font-bold text-[#005ca9]">{examType && formatPrice(priceFor(examType))}</span>
            {isReferral && " (doplatok so žiadankou)"}
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Meno a priezvisko *</label>
              <input required value={form.patientName} onChange={(e) => setField("patientName", e.target.value)} className={inputCls} placeholder="Ján Novák" />
            </div>
            <div>
              <label className={labelCls}>Dátum narodenia *</label>
              <input type="date" required value={form.birthDate} onChange={(e) => setField("birthDate", e.target.value)} max={toISODate(new Date())} className={inputCls} />
              <p className="text-xs text-slate-400 mt-1">Rodné číslo od vás nepýtame — doplní sa až pri vyšetrení alebo zo žiadanky.</p>
            </div>
            <div>
              <label className={labelCls}>Zdravotná poisťovňa</label>
              <select value={form.insurance} onChange={(e) => setField("insurance", e.target.value)} className={inputCls}>
                {insuranceOptions.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Telefón *</label>
              <input required value={form.phone} onChange={(e) => setField("phone", e.target.value)} className={inputCls} placeholder="+421 900 000 000" />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>E-mail *</label>
              <input type="email" required value={form.email} onChange={(e) => setField("email", e.target.value)} className={inputCls} placeholder="jan.novak@..." />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Dôvod vyšetrenia / ťažkosti *</label>
              <textarea required rows={3} value={form.reason} onChange={(e) => setField("reason", e.target.value)} className={inputCls} placeholder="Popíšte svoje ťažkosti alebo dôvod, pre ktorý žiadate vyšetrenie…" />
            </div>
          </div>
          <div>
            <label className={labelCls}>Prílohy — žiadanka, lekárske správy (voliteľné)</label>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              multiple
              onChange={handleFilePick}
              className="w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-[#eaf2fa] file:text-[#005ca9] file:font-semibold hover:file:bg-[#d8e8f6] file:cursor-pointer"
            />
            <p className="text-xs text-slate-400 mt-1">Najviac {MAX_FILES} súbory, každý do {MAX_FILE_MB} MB (PDF, JPG, PNG). Prílohy vidí len personál pracoviska.</p>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                    <span className="truncate">📎 {f.name} <span className="text-slate-400 text-xs">({Math.max(1, Math.round(f.size / 1024))} kB)</span></span>
                    <button type="button" onClick={() => removeFile(i)} className="text-red-500 hover:text-red-700 font-bold ml-2">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {isReferral && (
            <div className="border border-emerald-300 bg-emerald-50 rounded-xl p-3 space-y-3">
              <p className="text-emerald-700 font-semibold text-sm">Údaje zo žiadanky:</p>
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Odporúčajúci lekár *</label>
                  <input required value={form.referrerName} onChange={(e) => setField("referrerName", e.target.value)} className={inputCls} placeholder="MUDr. …" />
                </div>
                <div>
                  <label className={labelCls}>Ambulancia / pracovisko</label>
                  <input value={form.referrerFacility} onChange={(e) => setField("referrerFacility", e.target.value)} className={inputCls} placeholder="Ambulancia všeobecného lekára, …" />
                </div>
              </div>
              <p className="text-xs text-slate-500">Originál žiadanky si prineste so sebou na vyšetrenie.</p>
            </div>
          )}
          <label className="flex items-start gap-2 text-xs text-slate-500 cursor-pointer">
            <input type="checkbox" required className="mt-0.5 w-4 h-4 accent-[#005ca9]" />
            <span>Potvrdzujem, že som sa oboznámil/a s informáciami o spracúvaní osobných údajov na účely objednania a vykonania vyšetrenia. *</span>
          </label>
        </form>
      )}

      {/* KROK 4 — PLATBA */}
      {step === 4 && createdOrder && (
        <div className="space-y-4 text-center">
          <div className="bg-emerald-50 border border-emerald-300 p-5 rounded-xl space-y-1">
            <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500 text-white flex items-center justify-center text-2xl font-bold">✓</div>
            <h3 className="text-xl font-bold text-emerald-700">Rezervácia odoslaná</h3>
            <p className="text-slate-700">
              <strong>{createdOrder.exam.label}</strong><br />
              {formatDateHuman(createdOrder.date)} o {createdOrder.time}
              {createdOrder.doctor && <><br /><span className="text-sm text-slate-500">Vyšetruje: {createdOrder.doctor}</span></>}
            </p>
            <p className="text-xs text-slate-500">Číslo objednávky: <strong>{createdOrder.id}</strong></p>
          </div>

          <div className="border border-slate-200 rounded-xl p-5 space-y-3">
            <h3 className="text-lg font-bold text-[#003d7c]">
              {createdOrder.hasReferral ? "Platba doplatku (so žiadankou)" : "Platba za vyšetrenie (samoplatca)"}
            </h3>
            <p className="text-3xl font-bold text-[#005ca9]">{formatPrice(createdOrder.price)}</p>
            <p className="text-sm text-slate-500">Naskenujte QR kód v aplikácii vašej banky (PAY by square):</p>
            <PaymentQr order={createdOrder} settings={settings} />
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-left text-sm space-y-1 max-w-md mx-auto text-slate-700">
              <p><strong>IBAN:</strong> {settings.iban}</p>
              <p><strong>Príjemca:</strong> {settings.beneficiary}</p>
              <p><strong>Variabilný symbol:</strong> {createdOrder.variableSymbol}</p>
              <p><strong>Suma:</strong> {formatPrice(createdOrder.price)}</p>
              {settings.iban === defaultSettings.iban && (
                <p className="text-red-600 font-bold">⚠ DEMO IBAN — toto NIE JE účet NÚSCH. Skutočný IBAN musí pracovisko nastaviť v správe pred spustením.</p>
              )}
            </div>
            {createdOrder.hasReferral && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-300 p-3 rounded-lg">
                <strong>Nezabudnite si na vyšetrenie priniesť žiadanku (výmenný lístok)</strong> — bez nej platí plná samoplatcovská cena.
              </p>
            )}
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-300 p-3 rounded-lg">
              Termín je rezervovaný a bude <strong>potvrdený po prijatí platby</strong>. Ak platba nepríde do 24 hodín, rezervácia môže byť zrušená.
            </p>
          </div>

          <button
            onClick={() => {
              const d = createdOrder.date.replace(/-/g, "");
              const [h, m] = createdOrder.time.split(":").map(Number);
              const pad = (n) => String(n).padStart(2, "0");
              const endMin = h * 60 + m + 20;
              const ics = [
                "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NUSCH//USG//SK", "BEGIN:VEVENT",
                `UID:${createdOrder.id}@nusch`, `DTSTART:${d}T${pad(h)}${pad(m)}00`,
                `DTEND:${d}T${pad(Math.floor(endMin / 60))}${pad(endMin % 60)}00`,
                `SUMMARY:USG vyšetrenie — NÚSCH (${createdOrder.exam.label})`,
                "LOCATION:NÚSCH\\, a.s.\\, Pod Krásnou hôrkou 1\\, Bratislava",
                `DESCRIPTION:Objednávka ${createdOrder.id}${createdOrder.doctor ? `\\nLekár: ${createdOrder.doctor}` : ""}`,
                "END:VEVENT", "END:VCALENDAR",
              ].join("\r\n");
              const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "usg-termin.ics";
              a.click();
              URL.revokeObjectURL(a.href);
            }}
            className="w-full bg-white border-2 border-[#005ca9] text-[#005ca9] hover:bg-[#eaf2fa] font-bold py-3 px-6 rounded-xl text-lg transition duration-200"
          >
            📅 Pridať do kalendára
          </button>
          <button onClick={resetWizard} className="w-full bg-[#e2001a] hover:bg-[#c00017] text-white font-bold py-3 px-6 rounded-xl text-lg shadow transition duration-200">
            Nová objednávka
          </button>
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-300 text-red-700 p-3 rounded-lg font-semibold mt-4">{error}</div>}

      {/* NAVIGÁCIA */}
      {step < 4 && (
        <div className="flex justify-between items-center mt-6 pt-4 border-t border-slate-100">
          {step > 1 ? (
            <button type="button" onClick={goBack} className="text-slate-500 hover:text-slate-700 font-semibold px-4 py-3 transition-colors">
              ‹ Späť
            </button>
          ) : <span />}
          {step < 3 && (
            <button type="button" onClick={goNext} className="bg-[#e2001a] hover:bg-[#c00017] text-white font-bold py-3 px-8 rounded-xl shadow transition duration-200">
              Pokračovať ›
            </button>
          )}
          {step === 3 && (
            <button type="submit" form="patient-details-form" disabled={busy} className="bg-[#e2001a] hover:bg-[#c00017] disabled:opacity-60 text-white font-bold py-3 px-8 rounded-xl shadow transition duration-200">
              {busy ? "Odosielam…" : "Odoslať a prejsť na platbu ›"}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// --- 5. SPRÁVA (pohľad sonografického pracoviska) ---

function formatBirth(patient) {
  if (patient.birthNumber) return patient.birthNumber;
  if (patient.birthDate) return "nar. " + new Date(patient.birthDate + "T12:00:00").toLocaleDateString("sk-SK");
  return "";
}

const PaidBadge = ({ order }) => {
  if (order.price == null || order.price <= 0) return null;
  return order.paid
    ? <span className="bg-emerald-700 text-emerald-100 text-xs font-bold px-2 py-1 rounded">ZAPLATENÉ</span>
    : <span className="bg-amber-700 text-amber-100 text-xs font-bold px-2 py-1 rounded">NEZAPLATENÉ</span>;
};

const UsgOrderCard = ({ order, onSetStatus, onSetPaid, onReschedule, freeSlotsFor, onOpenAttachment }) => {
  const status = usgStatuses[order.status];
  const [resched, setResched] = useState(false);
  const [reschedDate, setReschedDate] = useState(order.date);
  const canAct = order.status === "new" || order.status === "confirmed";
  const reschedSlots = resched && freeSlotsFor ? freeSlotsFor(reschedDate) : [];

  return (
    <div className={`bg-slate-700 rounded-lg p-4 border-l-4 ${status.border} space-y-2`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-bold text-lg">{order.patient.name}</span>
          <span className="text-slate-400 text-sm ml-2">{formatBirth(order.patient)}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold px-2 py-1 rounded ${order.hasReferral ? "bg-green-800 text-green-200" : "bg-blue-800 text-blue-200"}`}>
            {order.hasReferral ? "ŽIADANKA" : "SAMOPLATCA"}
          </span>
          <PaidBadge order={order} />
          <span className={`${status.badge} text-xs font-bold px-2 py-1 rounded`}>{status.label}</span>
        </div>
      </div>
      <p className="text-sm">
        <strong className="text-blue-300">{order.exam.label}</strong> — {formatDateHuman(order.date)} o {order.time}
        {order.price != null && (
          <span className="text-yellow-300 font-bold ml-2">
            {formatPrice(order.price)}{order.hasReferral ? " (doplatok)" : ""}
          </span>
        )}
      </p>
      {order.doctor && <p className="text-sm text-teal-300">Lekár: {order.doctor}</p>}
      <p className="text-sm text-slate-300 italic">{order.exam.reason}</p>
      {order.hasReferral && order.exam.referrerName && (
        <p className="text-xs text-slate-400">
          Žiadanka od: {order.exam.referrerName}{order.exam.referrerFacility && `, ${order.exam.referrerFacility}`}
        </p>
      )}
      <p className="text-xs text-slate-400">
        Tel. {order.patient.phone}{order.patient.email && ` · ${order.patient.email}`}
        {order.variableSymbol && ` · VS ${order.variableSymbol}`} · objednávka {order.id}
      </p>
      {order.statusNote && <p className="text-xs text-amber-300">Poznámka: {order.statusNote}</p>}
      {Array.isArray(order.attachments) && order.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {order.attachments.map((a, i) => (
            <button
              key={i}
              onClick={() => onOpenAttachment && onOpenAttachment(a)}
              className="bg-slate-600 hover:bg-slate-500 text-white text-xs font-semibold px-2 py-1 rounded transition-colors"
            >
              📎 {a.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {!order.paid && order.price > 0 && canAct && (
          <button onClick={() => onSetPaid(order.id, true)} className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold px-3 py-2 rounded transition-colors">
            💰 Platba prijatá
          </button>
        )}
        {order.status === "new" && (
          <button onClick={() => onSetStatus(order.id, "confirmed")} className="bg-green-600 hover:bg-green-500 text-white text-sm font-semibold px-3 py-2 rounded transition-colors">
            Potvrdiť termín
          </button>
        )}
        {order.status === "confirmed" && (
          <>
            <button onClick={() => onSetStatus(order.id, "done")} className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-3 py-2 rounded transition-colors">Vykonané</button>
            <button onClick={() => onSetStatus(order.id, "noshow")} className="bg-slate-500 hover:bg-slate-400 text-white text-sm font-semibold px-3 py-2 rounded transition-colors">Neprišiel</button>
          </>
        )}
        {canAct && onReschedule && (
          <button onClick={() => { setResched(!resched); setReschedDate(order.date); }} className="bg-purple-700 hover:bg-purple-600 text-white text-sm font-semibold px-3 py-2 rounded transition-colors">
            {resched ? "Zavrieť presun" : "Presunúť"}
          </button>
        )}
        {canAct && (
          <button
            onClick={() => {
              const reason = window.prompt("Dôvod zrušenia (voliteľné):") ?? "";
              onSetStatus(order.id, "rejected", reason || "Zrušené pracoviskom");
            }}
            className="bg-red-600 hover:bg-red-500 text-white text-sm font-semibold px-3 py-2 rounded transition-colors"
          >
            Zrušiť
          </button>
        )}
      </div>

      {resched && (
        <div className="bg-slate-800 rounded-lg p-3 space-y-2 border border-purple-600">
          <p className="text-sm font-semibold text-purple-300">Presunúť na iný termín:</p>
          <input
            type="date"
            value={reschedDate}
            min={toISODate(new Date())}
            onChange={(e) => setReschedDate(e.target.value)}
            className="p-2 bg-slate-900 border border-slate-600 rounded-lg text-white text-sm"
          />
          {reschedSlots.length === 0
            ? <p className="text-xs text-slate-400">V tento deň nie sú voľné otvorené termíny.</p>
            : (
              <div className="flex flex-wrap gap-2">
                {reschedSlots.map((slot) => (
                  <button
                    key={slot.time}
                    onClick={() => { onReschedule(order.id, reschedDate, slot.time); setResched(false); }}
                    className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold px-3 py-2 rounded transition-colors"
                  >
                    {slot.time}{slot.doctor ? ` · ${slot.doctor}` : ""}
                  </button>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
};

const PricelistEditor = ({ pricelist, onSave }) => {
  const toDrafts = (list) => list.map((r) => ({
    ...r,
    priceSelf: String(r.priceSelf),
    priceReferral: r.priceReferral == null ? "" : String(r.priceReferral),
  }));
  const [rows, setRows] = useState(() => toDrafts(pricelist));
  const [saved, setSaved] = useState(false);

  const updateRow = (index, field, value) => {
    setSaved(false);
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };
  const removeRow = (index) => {
    setSaved(false);
    setRows((prev) => prev.filter((_, i) => i !== index));
  };
  const addRow = () => {
    setSaved(false);
    setRows((prev) => [...prev, { id: `item-${Date.now()}`, label: "", priceSelf: "", priceReferral: "" }]);
  };

  const parsePrice = (value) => {
    const num = parseFloat(String(value).replace(",", "."));
    return isNaN(num) || num < 0 ? null : num;
  };

  const handleSave = () => {
    const cleaned = rows
      .map((r) => ({
        id: r.id,
        label: r.label.trim(),
        priceSelf: parsePrice(r.priceSelf),
        priceReferral: r.priceReferral.trim() === "" ? null : parsePrice(r.priceReferral),
      }))
      .filter((r) => r.label && r.priceSelf != null);
    onSave(cleaned);
    setRows(toDrafts(cleaned));
    setSaved(true);
  };

  return (
    <div className="bg-slate-700 p-4 rounded-lg space-y-3">
      <h3 className="text-lg font-bold text-blue-300">Cenník vyšetrení</h3>
      <p className="text-sm text-slate-400">
        Prvá cena = samoplatca (bez žiadanky), druhá = doplatok so žiadankou. Ak doplatok necháte prázdny,
        vyšetrenie sa so žiadankou nebude ponúkať (len samoplatca).
      </p>
      <div className="hidden sm:flex gap-2 text-xs text-slate-400 font-semibold pr-12">
        <span className="flex-1">Názov vyšetrenia</span>
        <span className="w-24 text-right">Samoplatca</span>
        <span className="w-24 text-right">Doplatok</span>
      </div>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={row.id} className="flex gap-2 items-center">
            <input
              value={row.label}
              onChange={(e) => updateRow(i, "label", e.target.value)}
              className="flex-1 p-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
              placeholder="Názov vyšetrenia"
            />
            <input
              value={row.priceSelf}
              onChange={(e) => updateRow(i, "priceSelf", e.target.value)}
              className="w-24 p-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm text-right"
              placeholder="Cena €"
              inputMode="decimal"
            />
            <input
              value={row.priceReferral}
              onChange={(e) => updateRow(i, "priceReferral", e.target.value)}
              className="w-24 p-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm text-right"
              placeholder="—"
              inputMode="decimal"
            />
            <button type="button" onClick={() => removeRow(i)} className="bg-red-700 hover:bg-red-600 text-white px-3 py-2 rounded text-sm transition-colors" title="Odstrániť položku">✕</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={addRow} className="bg-slate-600 hover:bg-slate-500 text-white text-sm font-semibold px-3 py-2 rounded transition-colors">
          + Pridať položku
        </button>
        <button type="button" onClick={handleSave} className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded transition-colors">
          Uložiť cenník
        </button>
        {saved && <span className="text-green-400 text-sm self-center">✓ Uložené</span>}
      </div>
    </div>
  );
};

const StatTile = ({ label, value, accent }) => (
  <div className="bg-slate-700 rounded-lg p-3 text-center">
    <p className={`text-2xl font-bold ${accent || "text-white"}`}>{value}</p>
    <p className="text-xs text-slate-400">{label}</p>
  </div>
);

const intervalOptions = [10, 15, 20, 30, 45, 60];

const AdminView = ({ orders, openSlots, settings, pricelist, onOpenWindow, onCloseSlot, onCloseDay, onSetStatus, onSetPaid, onReschedule, onSaveSettings, onSavePricelist, onOpenAttachment }) => {
  const todayIso = toISODate(new Date());
  const [tab, setTab] = useState("overview");
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [winFrom, setWinFrom] = useState(todayIso);
  const [winTo, setWinTo] = useState(todayIso);
  const [winTimeFrom, setWinTimeFrom] = useState("07:30");
  const [winTimeTo, setWinTimeTo] = useState("14:30");
  const [winStep, setWinStep] = useState(20);
  const [winDoctor, setWinDoctor] = useState("");
  const [winSkipWeekends, setWinSkipWeekends] = useState(true);
  const [fStatus, setFStatus] = useState("all");
  const [fPaid, setFPaid] = useState("all");
  const [fText, setFText] = useState("");
  const [fDate, setFDate] = useState("");
  const [ibanDraft, setIbanDraft] = useState(settings.iban);
  const [beneficiaryDraft, setBeneficiaryDraft] = useState(settings.beneficiary);
  const [doctorsDraft, setDoctorsDraft] = useState((settings.doctors || []).join("\n"));

  const doctors = settings.doctors || [];

  const freeSlotsFor = (iso) => {
    const open = openSlots[iso] || [];
    const taken = new Set(orders.filter((o) => o.date === iso && isSlotOccupying(o)).map((o) => o.time));
    return open.filter((slot) => !taken.has(slot.time));
  };

  const pending = orders
    .filter((o) => o.status === "new")
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const todayProgram = orders
    .filter((o) => o.date === todayIso && (o.status === "confirmed" || o.status === "new"))
    .sort((a, b) => a.time.localeCompare(b.time));

  const next7 = (() => {
    const end = new Date(); end.setDate(end.getDate() + 7);
    const endIso = toISODate(end);
    return orders.filter((o) => isSlotOccupying(o) && o.date >= todayIso && o.date <= endIso).length;
  })();

  const unpaidCount = orders.filter((o) => isSlotOccupying(o) && !o.paid && o.price > 0 && (o.status === "new" || o.status === "confirmed")).length;

  const filteredOrders = orders
    .filter((o) => fStatus === "all" || o.status === fStatus)
    .filter((o) => fPaid === "all" || (fPaid === "paid" ? o.paid : !o.paid))
    .filter((o) => !fDate || o.date === fDate)
    .filter((o) => {
      const q = fText.trim().toLowerCase();
      if (!q) return true;
      return o.patient.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q) || o.patient.phone.replace(/\s/g, "").includes(q.replace(/\s/g, "")) || (o.doctor || "").toLowerCase().includes(q);
    })
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const exportCsv = () => {
    const rows = [["Dátum", "Čas", "Lekár", "Stav", "Zaplatené", "Pacient", "Narodený", "Telefón", "E-mail", "Vyšetrenie", "Cena €", "Žiadanka", "VS", "Objednávka", "Poznámka"]];
    filteredOrders.forEach((o) => rows.push([
      o.date, o.time, o.doctor || "", usgStatuses[o.status].label, o.paid ? "áno" : "nie", o.patient.name,
      o.patient.birthNumber || o.patient.birthDate || "", o.patient.phone, o.patient.email,
      o.exam.label, o.price, o.hasReferral ? "áno" : "nie", o.variableSymbol || "", o.id, o.statusNote || "",
    ]));
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `usg-objednavky-${toISODate(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const dayOpen = (openSlots[selectedDate] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
  const dayOrders = new Map(
    orders.filter((o) => o.date === selectedDate && isSlotOccupying(o)).map((o) => [o.time, o])
  );

  const strip = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = toISODate(d);
    const open = (openSlots[iso] || []).length;
    const free = freeSlotsFor(iso).length;
    return { iso, open, free, booked: open - free };
  });

  const handleOpenWindow = () => {
    onOpenWindow({
      dateFrom: winFrom, dateTo: winTo,
      timeFrom: winTimeFrom, timeTo: winTimeTo,
      stepMinutes: winStep, doctor: winDoctor,
      skipWeekends: winSkipWeekends,
    });
    setSelectedDate(winFrom);
  };

  const tabs = [
    { id: "overview", label: `Prehľad${pending.length > 0 ? ` (${pending.length})` : ""}` },
    { id: "calendar", label: "Kalendár" },
    { id: "orders", label: "Objednávky" },
    { id: "settings", label: "Nastavenia" },
  ];

  const inputDark = "p-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${tab === t.id ? "bg-[#e2001a] text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <StatTile label="dnešný program" value={todayProgram.length} accent="text-blue-300" />
            <StatTile label="nové žiadosti" value={pending.length} accent="text-yellow-300" />
            <StatTile label="nezaplatené" value={unpaidCount} accent="text-amber-300" />
            <StatTile label="objednaní — 7 dní" value={next7} accent="text-purple-300" />
          </div>

          <div>
            <h3 className="text-lg font-bold text-blue-300 mb-2">Dnešný program — {formatDateHuman(todayIso)}</h3>
            {todayProgram.length === 0
              ? <p className="text-slate-400 bg-slate-700/50 p-4 rounded-lg">Dnes nie sú objednaní žiadni pacienti.</p>
              : (
                <div className="space-y-2">
                  {todayProgram.map((o) => (
                    <div key={o.id} className="flex items-center gap-3 bg-slate-700 rounded-lg px-4 py-2">
                      <span className="font-mono font-bold text-lg text-blue-300 w-16">{o.time}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">{o.patient.name} <span className="text-slate-400 text-xs">{formatBirth(o.patient)}</span></p>
                        <p className="text-xs text-slate-400 truncate">{o.exam.label}{o.doctor && ` · ${o.doctor}`}</p>
                      </div>
                      <PaidBadge order={o} />
                      <span className={`${usgStatuses[o.status].badge} text-xs font-bold px-2 py-1 rounded shrink-0`}>{usgStatuses[o.status].label}</span>
                      {o.status === "confirmed" && (
                        <button onClick={() => onSetStatus(o.id, "done")} className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-2 py-1 rounded shrink-0">Vykonané</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </div>

          <div>
            <h3 className="text-lg font-bold text-yellow-300 mb-2">Nové žiadosti ({pending.length})</h3>
            {pending.length === 0
              ? <p className="text-slate-400 bg-slate-700/50 p-4 rounded-lg">Žiadne žiadosti nečakajú na spracovanie.</p>
              : <div className="space-y-3">{pending.map((o) => (<UsgOrderCard key={o.id} order={o} onSetStatus={onSetStatus} onSetPaid={onSetPaid} onReschedule={onReschedule} freeSlotsFor={freeSlotsFor} onOpenAttachment={onOpenAttachment} />))}</div>}
          </div>
        </div>
      )}

      {tab === "calendar" && (
        <div className="space-y-5">
          <div>
            <h3 className="text-lg font-bold text-blue-300 mb-2">Najbližších 14 dní</h3>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {strip.map((d) => (
                <button
                  key={d.iso}
                  onClick={() => setSelectedDate(d.iso)}
                  title={d.iso}
                  className={`shrink-0 px-3 py-2 rounded-lg text-xs font-semibold text-center transition-colors border ${
                    selectedDate === d.iso ? "border-[#e2001a]" : "border-transparent"
                  } ${d.open === 0 ? "bg-slate-800 text-slate-500" : d.free > 0 ? "bg-green-900/40 text-green-200" : "bg-blue-900/40 text-blue-200"}`}
                >
                  {formatDateShort(d.iso)}
                  <span className="block font-normal">{d.open === 0 ? "zatvorené" : `${d.booked}/${d.open} obsadené`}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-slate-700 rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-bold text-green-300">Otvoriť termíny</h3>
            <p className="text-xs text-slate-400">Zvoľte deň (alebo rozsah dní), časové okno, interval medzi termínmi a prípadne lekára.</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Deň od</label>
                <input type="date" value={winFrom} onChange={(e) => { setWinFrom(e.target.value); if (e.target.value > winTo) setWinTo(e.target.value); }} className={`w-full ${inputDark}`} />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Deň do</label>
                <input type="date" value={winTo} onChange={(e) => setWinTo(e.target.value)} className={`w-full ${inputDark}`} />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Čas od</label>
                <input type="time" value={winTimeFrom} onChange={(e) => setWinTimeFrom(e.target.value)} className={`w-full ${inputDark}`} />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Čas do</label>
                <input type="time" value={winTimeTo} onChange={(e) => setWinTimeTo(e.target.value)} className={`w-full ${inputDark}`} />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Interval</label>
                <select value={winStep} onChange={(e) => setWinStep(Number(e.target.value))} className={`w-full ${inputDark}`}>
                  {intervalOptions.map((m) => (<option key={m} value={m}>{m} min</option>))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-slate-400 mb-1">Lekár</label>
                <select value={winDoctor} onChange={(e) => setWinDoctor(e.target.value)} className={`w-full ${inputDark}`}>
                  <option value="">— neurčený —</option>
                  {doctors.map((d) => (<option key={d} value={d}>{d}</option>))}
                </select>
              </div>
              <label className="flex items-end gap-2 text-xs text-slate-300 pb-2 cursor-pointer">
                <input type="checkbox" checked={winSkipWeekends} onChange={(e) => setWinSkipWeekends(e.target.checked)} className="w-4 h-4 accent-green-500" />
                preskočiť víkendy
              </label>
            </div>
            {doctors.length === 0 && (
              <p className="text-xs text-amber-300">Tip: lekárov na priraďovanie pridáte v záložke Nastavenia.</p>
            )}
            <button onClick={handleOpenWindow} className="bg-green-700 hover:bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded transition-colors">
              Otvoriť termíny
            </button>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h3 className="text-lg font-bold text-blue-300">Deň: {formatDateHuman(selectedDate)}</h3>
              <div className="flex items-center gap-2">
                <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className={inputDark} />
                <button onClick={() => onCloseDay(selectedDate)} className="bg-slate-600 hover:bg-slate-500 text-white text-sm font-semibold px-3 py-2 rounded transition-colors">
                  Zavrieť voľné
                </button>
              </div>
            </div>
            {dayOpen.length === 0
              ? <p className="text-slate-400 bg-slate-700/50 p-4 rounded-lg">V tento deň nie sú otvorené žiadne termíny.</p>
              : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {dayOpen.map((slot) => {
                    const booked = dayOrders.get(slot.time);
                    if (booked) {
                      return (
                        <div key={slot.time} className="p-2 rounded-lg text-sm bg-blue-900/70 border border-blue-500 text-center">
                          <span className="font-mono font-bold">{slot.time}</span>
                          <span className="block text-xs truncate">{booked.patient.name}</span>
                          <span className="block text-[10px] opacity-75">{usgStatuses[booked.status].label}{booked.paid ? " · zaplatené" : booked.price > 0 ? " · nezaplatené" : ""}</span>
                        </div>
                      );
                    }
                    return (
                      <div key={slot.time} className="p-2 rounded-lg text-sm bg-green-900/40 border border-green-700 text-center relative">
                        <span className="font-mono font-bold text-green-200">{slot.time}</span>
                        <span className="block text-[10px] text-green-300 truncate">{slot.doctor || "voľný termín"}</span>
                        <button
                          onClick={() => onCloseSlot(selectedDate, slot.time)}
                          title="Zavrieť termín"
                          className="absolute top-1 right-1 text-green-300 hover:text-white text-xs leading-none"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
        </div>
      )}

      {tab === "orders" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={fText}
              onChange={(e) => setFText(e.target.value)}
              placeholder="Hľadať: meno, telefón, lekár, číslo objednávky…"
              className={`flex-1 min-w-48 ${inputDark}`}
            />
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={inputDark}>
              <option value="all">Všetky stavy</option>
              {Object.entries(usgStatuses).map(([key, st]) => (<option key={key} value={key}>{st.label}</option>))}
            </select>
            <select value={fPaid} onChange={(e) => setFPaid(e.target.value)} className={inputDark}>
              <option value="all">Platba: všetko</option>
              <option value="paid">Zaplatené</option>
              <option value="unpaid">Nezaplatené</option>
            </select>
            <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} className={inputDark} />
            {fDate && <button onClick={() => setFDate("")} className="text-xs text-slate-400 hover:text-white">✕ dátum</button>}
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">{filteredOrders.length} objednávok</p>
            <button onClick={exportCsv} className="bg-slate-600 hover:bg-slate-500 text-white text-xs font-semibold px-3 py-2 rounded transition-colors">
              ⬇ Export CSV
            </button>
          </div>
          {filteredOrders.length === 0
            ? <p className="text-slate-400 bg-slate-700/50 p-4 rounded-lg">Žiadne objednávky nezodpovedajú filtrom.</p>
            : <div className="space-y-3">{filteredOrders.map((o) => (<UsgOrderCard key={o.id} order={o} onSetStatus={onSetStatus} onSetPaid={onSetPaid} onReschedule={onReschedule} freeSlotsFor={freeSlotsFor} onOpenAttachment={onOpenAttachment} />))}</div>}
        </div>
      )}

      {tab === "settings" && (
        <div className="space-y-5">
          <div className="bg-slate-700 p-4 rounded-lg space-y-3">
            <h3 className="text-lg font-bold text-blue-300">Lekári</h3>
            <p className="text-sm text-slate-400">Jeden lekár na riadok. Ponúkajú sa pri otváraní termínov a pacient meno vidí pri výbere času.</p>
            <textarea
              rows={4}
              value={doctorsDraft}
              onChange={(e) => setDoctorsDraft(e.target.value)}
              placeholder={"MUDr. Jana Nováková\nMUDr. Peter Kováč"}
              className="w-full p-3 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
            />
          </div>
          <PricelistEditor pricelist={pricelist} onSave={onSavePricelist} />
          <div className="bg-slate-700 p-4 rounded-lg space-y-3">
            <h3 className="text-lg font-bold text-blue-300">Nastavenia platby</h3>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold text-slate-200">IBAN pracoviska</label>
                <input value={ibanDraft} onChange={(e) => setIbanDraft(e.target.value)} className="w-full p-3 bg-slate-800 border border-slate-600 rounded-lg text-white font-mono text-sm" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-200">Názov príjemcu</label>
                <input value={beneficiaryDraft} onChange={(e) => setBeneficiaryDraft(e.target.value)} className="w-full p-3 bg-slate-800 border border-slate-600 rounded-lg text-white" />
              </div>
            </div>
            <button
              onClick={() => onSaveSettings({
                iban: ibanDraft.trim(),
                beneficiary: beneficiaryDraft.trim(),
                doctors: doctorsDraft.split("\n").map((d) => d.trim()).filter(Boolean),
              })}
              className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded transition-colors"
            >
              Uložiť nastavenia (vrátane lekárov)
            </button>
            {settings.iban === defaultSettings.iban && (
              <p className="text-yellow-300 text-sm bg-yellow-900/40 p-2 rounded">⚠ Používa sa DEMO IBAN — pred spustením nastavte skutočný účet pracoviska.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Overenie / zrušenie objednávky pacientom (podľa čísla objednávky + telefónu)
const OrderLookup = ({ onLookup, onCancel }) => {
  const [orderId, setOrderId] = useState("");
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true); setMessage(""); setFound(null);
    try {
      const order = await onLookup(orderId.trim(), phone);
      if (!order) setMessage("Objednávku sme nenašli — skontrolujte číslo objednávky aj telefón.");
      else setFound(order);
    } catch (e) {
      setMessage(e?.message || "Vyhľadanie zlyhalo. Skúste to znova.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm("Naozaj chcete objednávku zrušiť?")) return;
    setBusy(true);
    try {
      await onCancel(found.id, phone);
      setFound({ ...found, status: "rejected", statusNote: "Zrušené pacientom" });
    } catch (e) {
      setMessage(e?.message || "Zrušenie zlyhalo. Skúste to znova.");
    } finally {
      setBusy(false);
    }
  };

  const canCancel = found && (found.status === "new" || found.status === "confirmed");

  return (
    <details className="bg-white rounded-2xl shadow-xl mt-4 text-slate-800">
      <summary className="p-5 font-bold text-[#003d7c] cursor-pointer select-none">Už máte objednávku? Overiť stav alebo zrušiť</summary>
      <div className="px-5 pb-5 space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <input
            value={orderId}
            onChange={(e) => { setOrderId(e.target.value); setFound(null); setMessage(""); }}
            placeholder="Číslo objednávky (USG-…)"
            className="p-3 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#005ca9] outline-none"
          />
          <input
            value={phone}
            onChange={(e) => { setPhone(e.target.value); setFound(null); setMessage(""); }}
            placeholder="Telefón zadaný pri objednávke"
            className="p-3 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#005ca9] outline-none"
          />
        </div>
        <button onClick={search} disabled={busy} className="bg-[#005ca9] hover:bg-[#004a87] disabled:opacity-60 text-white font-bold px-5 py-2.5 rounded-lg transition-colors">
          {busy ? "Pracujem…" : "Vyhľadať"}
        </button>
        {message && <p className="text-sm text-red-600 font-semibold">{message}</p>}
        {found && (
          <div className="border border-slate-200 rounded-xl p-4 space-y-2">
            <p className="font-bold">{found.exam.label}</p>
            <p className="text-sm">{formatDateHuman(found.date)} o {found.time} · {formatPrice(found.price)}{found.hasReferral ? " (doplatok so žiadankou)" : ""}</p>
            {found.doctor && <p className="text-sm">Lekár: {found.doctor}</p>}
            <p className="text-sm">
              Stav: <strong>{usgStatuses[found.status].label}</strong>
              {found.statusNote && <span className="text-slate-500"> ({found.statusNote})</span>}
            </p>
            {found.price > 0 && (
              <p className="text-sm">
                Platba: <strong className={found.paid ? "text-emerald-600" : "text-amber-600"}>{found.paid ? "Zaplatené" : "Čaká na platbu"}</strong>
              </p>
            )}
            {canCancel && (
              <button onClick={cancel} disabled={busy} className="bg-[#e2001a] hover:bg-[#c00017] disabled:opacity-60 text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors">
                Zrušiť objednávku
              </button>
            )}
          </div>
        )}
      </div>
    </details>
  );
};

// --- 6. EXPORTY ---
// Dátová vrstva (localStorage / Supabase) žije v src/data.js.
export {
  PatientView, AdminView, UsgHero, OrderLookup, usgStatuses,
  defaultSettings, defaultPricelist, normalizePricelist,
  allDaySlots, isSlotOccupying, toISODate, loadJson,
  USG_ORDERS_KEY, USG_OPEN_SLOTS_KEY, USG_SETTINGS_KEY, USG_PRICELIST_KEY,
};
