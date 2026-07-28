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
// Štandardná príprava na vyšetrenie — predloha, ktorú si pracovisko môže
// upraviť v Nastaveniach (cenník → stĺpec inštrukcie). Vkladá sa do
// potvrdzovacieho e-mailu pacientovi.
const PREP_FASTING = "Príďte nalačno (min. 6 hodín nejedzte). Deň vopred vynechajte nadúvajúce jedlá (strukoviny, kapustu, čerstvé pečivo) a sýtené nápoje. Ranné lieky zapite malým množstvom vody. 2 hodiny pred vyšetrením vypite cca 0,5 l neperlivej vody. Pred vyšetrením nefajčite a nežujte žuvačku.";
const PREP_BLADDER = "Hodinu pred vyšetrením vypite 0,5–0,7 l tekutín a nemočte — vyšetrenie vyžaduje naplnený močový mechúr.";
const PREP_NONE_NECK = "Osobitná príprava nie je potrebná. Zvoľte si voľný odev okolo krku (rozopínateľný golier), šperky z krku nechajte doma.";
const PREP_NONE_LIMBS = "Osobitná príprava nie je potrebná. Zvoľte si pohodlný odev, ktorý sa dá ľahko vyzliecť z vyšetrovaných končatín.";
const PREP_DOCS = "Prineste si všetku dostupnú zdravotnú dokumentáciu, CD/USB so snímkami z predchádzajúcich vyšetrení a aktuálny zoznam užívaných liekov.";

export const standardInstructions = {
  abdomen: PREP_FASTING,
  kidneys: PREP_BLADDER,
  pelvis: PREP_BLADDER,
  soft: "Osobitná príprava nie je potrebná.",
  thyroid: PREP_NONE_NECK,
  neck: PREP_NONE_NECK,
  carotid: PREP_NONE_NECK,
  upper1: PREP_NONE_LIMBS,
  upper2: PREP_NONE_LIMBS,
  lower1: PREP_NONE_LIMBS,
  lower2: PREP_NONE_LIMBS,
  renal: PREP_FASTING,
  aorta: PREP_FASTING,
  tos: PREP_NONE_LIMBS,
  complete_vessels: PREP_NONE_LIMBS,
  compressions: PREP_FASTING + " " + PREP_DOCS,
  consultation: PREP_DOCS,
};

const defaultPricelist = [
  // cievne vyšetrenia navrchu — poradie si pracovisko mení v Nastaveniach
  { id: "carotid", label: "Dopplerova ultrasonografia extrakraniálnych mozgových tepien (karotíd a vertebrálnych artérií)", priceSelf: 50, priceReferral: 30 },
  { id: "lower1", label: "Dopplerova ultrasonografia žíl alebo tepien dolných končatín (jedna končatina)", priceSelf: 40, priceReferral: 30 },
  { id: "lower2", label: "Dopplerova ultrasonografia žíl alebo tepien dolných končatín (obe končatiny)", priceSelf: 50, priceReferral: 30 },
  { id: "upper1", label: "Dopplerova ultrasonografia žíl alebo tepien horných končatín (jedna končatina)", priceSelf: 40, priceReferral: 30 },
  { id: "upper2", label: "Dopplerova ultrasonografia žíl alebo tepien horných končatín (obe končatiny)", priceSelf: 50, priceReferral: 30 },
  { id: "tos", label: "Dopplerova ultrasonografia na vylúčenie TOS (žilový alebo tepnový typ)", priceSelf: 100, priceReferral: 30 },
  { id: "renal", label: "USG brucha s vyšetrením renálnych artérií", priceSelf: 60, priceReferral: 30 },
  { id: "aorta", label: "USG brucha s vyšetrením brušnej aorty", priceSelf: 50, priceReferral: 30 },
  { id: "complete_vessels", label: "Kompletné sonografické vyšetrenie ciev (tepny a žily krku, dolných končatín a brušnej aorty)", priceSelf: 100, priceReferral: null },
  { id: "compressions", label: "Kompletné sonografické vyšetrenie abdominálnych cievnych kompresií + konzultácia", priceSelf: 350, priceReferral: null },
  { id: "abdomen", label: "USG brucha a brušnej dutiny", priceSelf: 45, priceReferral: 30 },
  { id: "kidneys", label: "USG obličiek a močového mechúra", priceSelf: 40, priceReferral: 30 },
  { id: "pelvis", label: "USG orgánov malej panvy", priceSelf: 40, priceReferral: 30 },
  { id: "soft", label: "USG mäkkých tkanív", priceSelf: 40, priceReferral: 30 },
  { id: "thyroid", label: "USG štítnej žľazy", priceSelf: 40, priceReferral: 30 },
  { id: "neck", label: "USG orgánov krku (štítna žľaza, slinné žľazy, lymfatické uzliny)", priceSelf: 50, priceReferral: 30 },
  { id: "consultation", label: "USG vyšetrenie a komplexná rádiologická konzultácia prinesených materiálov", priceSelf: 90, priceReferral: null },
];
// čerstvé inštalácie a demo majú štandardnú prípravu predvyplnenú
defaultPricelist.forEach((p) => { p.instructions = standardInstructions[p.id] || ""; p.durationSlots = p.durationSlots || 1; });

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

// Základná bunka rozvrhu v minútach. Trvanie vyšetrenia v cenníku
// je násobkom tejto hodnoty a obsadenosť sa počíta po týchto bunkách.
export const BASE_SLOT_MIN = 5;

// posun času "HH:MM" o dané minúty
export function addMinutes(t, mins) {
  const [h, m] = (t || "00:00").split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// 10-min bunky, ktoré objednávka obsadzuje (podľa trvania vyšetrenia)
export function orderCellTimes(order) {
  const n = Math.max(1, Math.round((order.durationMin || BASE_SLOT_MIN) / BASE_SLOT_MIN));
  return Array.from({ length: n }, (_, i) => addMinutes(order.time, i * BASE_SLOT_MIN));
}

// Lekár = { name, email, location, examTypeIds }. examTypeIds prázdne = robí
// všetky vyšetrenia; location = ambulancia/miesto, kam má pacient prísť.
// Staršie dáta (obyčajné mená) sa znormalizujú.
export function normalizeDoctors(list) {
  return (Array.isArray(list) ? list : [])
    .map((d) => (typeof d === "string"
      ? { name: d.trim(), email: "", location: "", examTypeIds: [] }
      : { name: (d.name || "").trim(), email: (d.email || "").trim(), location: (d.location || "").trim(), examTypeIds: Array.isArray(d.examTypeIds) ? d.examTypeIds : [] }))
    .filter((d) => d.name);
}

// Ambulancia daného lekára (prázdny reťazec, ak nie je vyplnená)
export function doctorLocation(doctors, doctorName) {
  if (!doctorName) return "";
  const d = normalizeDoctors(doctors).find((x) => x.name === doctorName);
  return d ? d.location : "";
}

// Robí daný lekár (podľa mena) toto vyšetrenie? Neznámy lekár / prázdny zoznam = áno.
export function doctorDoesExam(doctors, doctorName, examTypeId) {
  if (!doctorName) return true;
  const d = normalizeDoctors(doctors).find((x) => x.name === doctorName);
  if (!d || d.examTypeIds.length === 0) return true;
  return d.examTypeIds.includes(examTypeId);
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
      <div className="bg-red-50 border border-red-300 p-4 rounded-[10px] text-sm text-red-700">
        QR kód sa nepodarilo vygenerovať — skontrolujte IBAN v nastaveniach správy. ({error})
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-[10px] p-3 inline-block shadow-sm">
      {dataUrl
        ? <img src={dataUrl} alt="QR platba" width={260} height={260} />
        : <div className="w-[260px] h-[260px] flex items-center justify-center text-slate-400">Generujem QR…</div>}
    </div>
  );
};

// --- 4. PACIENTSKY SPRIEVODCA (štýl Bookio) ---

const UsgHero = () => (
  <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-8 mb-4 text-slate-800">
    <div className="bg-[#FFF6E0] border border-[#E0C878] text-[#856404] rounded-[10px] px-4 py-3 mb-4 text-sm font-semibold">
      Skúšobná prevádzka: objednávkový systém zatiaľ testujeme. Vytvorené objednávky nie sú záväzné
      a pracovisko vás môže kontaktovať s upresnením. Ďakujeme za pochopenie.
    </div>
    <p className="text-xs font-bold tracking-widest text-[#2B46A2] uppercase mb-1">Národný ústav srdcových a cievnych chorôb, a.s.</p>
    <h2 className="text-2xl md:text-3xl font-extrabold text-[#2B46A2] mb-2">
      Cievne USG vyšetrenie tam, kde cievam rozumejú najlepšie
    </h2>
    <p className="text-slate-600 mb-5">
      Objednajte sa online na sonografické vyšetrenie ciev priamo v NÚSCH — bez čakania v rade,
      s termínom, ktorý si vyberiete sami, a platbou vopred cez QR kód.
    </p>
    <div className="grid md:grid-cols-3 gap-3">
      <div className="bg-[#f5f8fb] border border-slate-200 rounded-[10px] p-4">
        <p className="font-bold text-slate-800 text-sm mb-1">Skúsení odborníci</p>
        <p className="text-xs text-slate-600">
          Vyšetrenie vykonávajú lekári s dlhoročnou praxou v cievnej diagnostike na moderných ultrazvukových prístrojoch.
        </p>
      </div>
      <div className="bg-[#f5f8fb] border border-slate-200 rounded-[10px] p-4">
        <p className="font-bold text-slate-800 text-sm mb-1">Tradícia a špecializácia</p>
        <p className="text-xs text-slate-600">
          NÚSCH je špičkové slovenské pracovisko pre srdce a cievy — diagnostike cievnych ochorení sa venujeme desaťročia.
        </p>
      </div>
      <div className="bg-[#f5f8fb] border border-slate-200 rounded-[10px] p-4">
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
              done ? "bg-emerald-500 text-white" : active ? "bg-[#2B46A2] text-white" : "bg-slate-200 text-slate-500"
            }`}>
              {done ? "✓" : stepNum}
            </div>
            <span className={`text-[11px] mt-1 font-semibold whitespace-nowrap ${active ? "text-[#2B46A2]" : done ? "text-emerald-600" : "text-slate-400"}`}>
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
                isSelected ? "bg-[#2B46A2] text-white"
                : available ? "bg-[#F0F4FF] text-[#2B46A2] hover:bg-[#d8e8f6]"
                : "text-[#444444] cursor-default"
              } ${isToday && !isSelected ? "ring-1 ring-[#2B46A2]" : ""}`}
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

  // Voľné ZAČIATKY: vyšetrenie trvá durationSlots × 10 min, takže
  // všetky pokryté 10-min bunky musia byť otvorené (ten istý lekár)
  // a žiadna nesmie byť obsadená.
  const freeSlotsFor = (isoDate) => {
    const open = openSlots[isoDate] || [];
    const openByTime = new Map(open.map((slot) => [slot.time, slot]));
    const taken = takenByDate.get(isoDate) || new Set();
    const need = examType?.durationSlots || 1;
    return open.filter((slot) => {
      if (examType && !doctorDoesExam(settings.doctors, slot.doctor, examType.id)) return false;
      for (let i = 0; i < need; i++) {
        const cell = openByTime.get(addMinutes(slot.time, i * BASE_SLOT_MIN));
        if (!cell || cell.doctor !== slot.doctor || taken.has(cell.time)) return false;
      }
      return true;
    });
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
      durationMin: (examType?.durationSlots || 1) * BASE_SLOT_MIN,
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

  const inputCls = "w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 focus:ring-2 focus:ring-[#2B46A2] focus:border-[#2B46A2] outline-none";
  const labelCls = "block text-sm font-semibold text-slate-600 mb-1";

  return (
    <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-8 text-slate-800">
      <StepIndicator current={step} />

      {/* KROK 1 — VYŠETRENIE */}
      {step === 1 && (
        <div className="space-y-5">
          <div>
            <h3 className="text-lg font-bold text-[#2B46A2] mb-1">Máte žiadanku od lekára?</h3>
            <p className="text-sm text-slate-500 mb-3">
              Ide o platené vyšetrenia v rámci doplnkových ordinačných hodín. So žiadankou (výmenným lístkom)
              platíte len doplatok, bez žiadanky plnú cenu podľa cenníka.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={() => chooseReferral("yes")}
                className={`flex-1 p-4 rounded-[10px] border-2 text-left transition-colors ${
                  form.hasReferral === "yes" ? "border-[#2B46A2] bg-[#F0F4FF]" : "border-slate-200 hover:border-[#8fb8dd]"
                }`}
              >
                <span className="font-bold text-slate-800">Áno, mám žiadanku</span>
                <span className="block text-xs text-slate-500 mt-1">platí sa doplatok podľa cenníka</span>
              </button>
              <button
                type="button"
                onClick={() => chooseReferral("no")}
                className={`flex-1 p-4 rounded-[10px] border-2 text-left transition-colors ${
                  form.hasReferral === "no" ? "border-[#2B46A2] bg-[#F0F4FF]" : "border-slate-200 hover:border-[#8fb8dd]"
                }`}
              >
                <span className="font-bold text-slate-800">Nie, nemám žiadanku</span>
                <span className="block text-xs text-slate-500 mt-1">samoplatca — plná cena podľa cenníka</span>
              </button>
            </div>
          </div>

          {form.hasReferral && (
            <div>
              <h3 className="text-lg font-bold text-[#2B46A2] mb-3">Vyberte vyšetrenie</h3>
              <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                {examChoices.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setField("examTypeId", t.id)}
                    className={`w-full flex items-center justify-between gap-3 p-4 rounded-[10px] border-2 text-left transition-colors ${
                      form.examTypeId === t.id ? "border-[#2B46A2] bg-[#F0F4FF]" : "border-slate-200 hover:border-[#8fb8dd]"
                    }`}
                  >
                    <span>
                      <span className="font-semibold text-slate-800 text-sm">{t.label}</span>
                      <span className="block text-xs text-slate-400 mt-0.5">⏱ {EXAM_DURATION_LABEL}</span>
                    </span>
                    <span className="text-[#2B46A2] font-bold whitespace-nowrap">{formatPrice(priceFor(t))}</span>
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
          <h3 className="text-lg font-bold text-[#2B46A2] mb-1">Vyberte termín</h3>
          <p className="text-sm text-slate-500 mb-4">
            {examType?.label} · <span className="font-semibold text-[#2B46A2]">{examType && formatPrice(priceFor(examType))}</span>
          </p>
          {firstAvailableIso === null ? (
            <p className="text-slate-500 bg-slate-50 border border-slate-200 p-4 rounded-[10px]">
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
                    {(examType?.durationSlots || 1) > 1 && (
                      <p className="text-xs text-slate-500 mb-2">Toto vyšetrenie trvá približne {(examType.durationSlots || 1) * BASE_SLOT_MIN} minút — čas nižšie je začiatok vyšetrenia.</p>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      {freeSlotsFor(form.date).map((slot) => (
                        <button
                          key={slot.time}
                          type="button"
                          onClick={() => setField("time", slot.time)}
                          className={`py-2 px-2 rounded-[10px] text-sm font-bold border-2 transition-colors ${
                            form.time === slot.time
                              ? "border-[#2B46A2] bg-[#2B46A2] text-white"
                              : "border-[#E0E4EF] text-[#2B46A2] hover:border-[#2B46A2]"
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
          <h3 className="text-lg font-bold text-[#2B46A2]">Vaše údaje</h3>
          <div className="bg-[#F0F4FF] border border-[#E0E4EF] rounded-[10px] p-3 text-sm text-slate-700">
            <strong>{examType?.label}</strong> — {formatDateHuman(form.date)} o {form.time} ·{" "}
            <span className="font-bold text-[#2B46A2]">{examType && formatPrice(priceFor(examType))}</span>
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
              className="w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-[10px] file:border-0 file:bg-[#F0F4FF] file:text-[#2B46A2] file:font-semibold hover:file:bg-[#d8e8f6] file:cursor-pointer"
            />
            <p className="text-xs text-slate-400 mt-1">Najviac {MAX_FILES} súbory, každý do {MAX_FILE_MB} MB (PDF, JPG, PNG). Prílohy vidí len personál pracoviska.</p>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between text-sm bg-slate-50 border border-slate-200 rounded-[10px] px-3 py-1.5">
                    <span className="truncate">📎 {f.name} <span className="text-slate-400 text-xs">({Math.max(1, Math.round(f.size / 1024))} kB)</span></span>
                    <button type="button" onClick={() => removeFile(i)} className="text-red-500 hover:text-red-700 font-bold ml-2">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {isReferral && (
            <div className="border border-emerald-300 bg-emerald-50 rounded-[10px] p-3 space-y-3">
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
            <input type="checkbox" required className="mt-0.5 w-4 h-4 accent-[#2B46A2]" />
            <span>
              Oboznámil/a som sa s{" "}
              <a href="#/podmienky" target="_blank" rel="noreferrer" className="text-[#2B46A2] font-semibold hover:underline">Podmienkami online objednávania</a>
              {" "}a s{" "}
              <a href="#/osobne-udaje" target="_blank" rel="noreferrer" className="text-[#2B46A2] font-semibold hover:underline">Informáciami o spracúvaní osobných údajov</a>. *
            </span>
          </label>
        </form>
      )}

      {/* KROK 4 — PLATBA */}
      {step === 4 && createdOrder && (
        <div className="space-y-4 text-center">
          <div className="bg-emerald-50 border border-emerald-300 p-5 rounded-[10px] space-y-1">
            <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500 text-white flex items-center justify-center text-2xl font-bold">✓</div>
            <h3 className="text-xl font-bold text-emerald-700">Rezervácia odoslaná</h3>
            <p className="text-slate-700">
              <strong>{createdOrder.exam.label}</strong><br />
              {formatDateHuman(createdOrder.date)} o {createdOrder.time}
              {createdOrder.doctor && <><br /><span className="text-sm text-slate-500">Vyšetruje: {createdOrder.doctor}</span></>}
              {doctorLocation(settings.doctors, createdOrder.doctor) && (
                <><br /><span className="text-sm font-semibold text-[#2B46A2]">Miesto: {doctorLocation(settings.doctors, createdOrder.doctor)}</span></>
              )}
            </p>
            <p className="text-xs text-slate-500">Číslo objednávky: <strong>{createdOrder.id}</strong></p>
          </div>

          <div className="border border-slate-200 rounded-[10px] p-5 space-y-3">
            <h3 className="text-lg font-bold text-[#2B46A2]">
              {createdOrder.hasReferral ? "Platba doplatku (so žiadankou)" : "Platba za vyšetrenie (samoplatca)"}
            </h3>
            <p className="text-3xl font-bold text-[#2B46A2]">{formatPrice(createdOrder.price)}</p>
            <p className="text-sm text-slate-500">Naskenujte QR kód v aplikácii vašej banky (PAY by square):</p>
            <PaymentQr order={createdOrder} settings={settings} />
            <div className="bg-slate-50 border border-slate-200 rounded-[10px] p-3 text-left text-sm space-y-1 max-w-md mx-auto text-slate-700">
              <p><strong>IBAN:</strong> {settings.iban}</p>
              <p><strong>Príjemca:</strong> {settings.beneficiary}</p>
              <p><strong>Variabilný symbol:</strong> {createdOrder.variableSymbol}</p>
              <p><strong>Suma:</strong> {formatPrice(createdOrder.price)}</p>
              {settings.iban === defaultSettings.iban && (
                <p className="text-red-600 font-bold">⚠ DEMO IBAN — toto NIE JE účet NÚSCH. Skutočný IBAN musí pracovisko nastaviť v správe pred spustením.</p>
              )}
            </div>
            {createdOrder.hasReferral && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-300 p-3 rounded-[10px]">
                <strong>Nezabudnite si na vyšetrenie priniesť žiadanku (výmenný lístok)</strong> — bez nej platí plná samoplatcovská cena.
              </p>
            )}
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-300 p-3 rounded-[10px]">
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
                `LOCATION:NÚSCH\\, a.s.\\, Pod Krásnou hôrkou 1\\, Bratislava${doctorLocation(settings.doctors, createdOrder.doctor) ? ` — ${doctorLocation(settings.doctors, createdOrder.doctor).replace(/,/g, "\\,")}` : ""}`,
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
            className="w-full bg-white border-2 border-[#2B46A2] text-[#2B46A2] hover:bg-[#F0F4FF] font-bold py-3 px-6 rounded-[10px] text-lg transition duration-200"
          >
            Pridať do kalendára
          </button>
          <button onClick={resetWizard} className="w-full bg-[#2B46A2] hover:bg-[#1E3580] text-white font-bold py-3 px-6 rounded-[10px] text-lg shadow transition duration-200">
            Nová objednávka
          </button>
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-300 text-red-700 p-3 rounded-[10px] font-semibold mt-4">{error}</div>}

      {/* NAVIGÁCIA */}
      {step < 4 && (
        <div className="flex justify-between items-center mt-6 pt-4 border-t border-slate-100">
          {step > 1 ? (
            <button type="button" onClick={goBack} className="text-slate-500 hover:text-slate-700 font-semibold px-4 py-3 transition-colors">
              ‹ Späť
            </button>
          ) : <span />}
          {step < 3 && (
            <button type="button" onClick={goNext} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white font-bold py-3 px-8 rounded-[10px] shadow transition duration-200">
              Pokračovať ›
            </button>
          )}
          {step === 3 && (
            <button type="submit" form="patient-details-form" disabled={busy} className="bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white font-bold py-3 px-8 rounded-[10px] shadow transition duration-200">
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

// rýchly filter so súčtom — používa záložka Objednávky
const FilterChip = ({ active, onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-3 py-1.5 rounded-[10px] text-xs font-semibold transition-colors ${active ? "bg-[#2B46A2] text-white" : "bg-[#F0F2F5] text-[#444444] hover:bg-[#E0E4EF]"}`}
  >
    {label}
  </button>
);

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
    <div className={`bg-[#F8F9FC] border border-[#E0E4EF] rounded-[10px] p-4 border-l-4 ${status.border} space-y-2`}>
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
        <strong className="text-[#2B46A2]">{order.exam.label}</strong> — {formatDateHuman(order.date)} o {order.time}
        {order.price != null && (
          <span className="text-yellow-300 font-bold ml-2">
            {formatPrice(order.price)}{order.hasReferral ? " (doplatok)" : ""}
          </span>
        )}
      </p>
      {order.doctor && <p className="text-sm text-teal-300">Lekár: {order.doctor}</p>}
      <p className="text-sm text-[#444444] italic">{order.exam.reason}</p>
      {order.hasReferral && order.exam.referrerName && (
        <p className="text-xs text-slate-400">
          Žiadanka od: {order.exam.referrerName}{order.exam.referrerFacility && `, ${order.exam.referrerFacility}`}
        </p>
      )}
      <p className="text-xs text-slate-400">
        Tel. {order.patient.phone}{order.patient.email && ` · ${order.patient.email}`}
        {order.variableSymbol && ` · VS ${order.variableSymbol}`} · objednávka {order.id}
      </p>
      {order.statusNote && <p className="text-xs text-[#856404]">Poznámka: {order.statusNote}</p>}
      {Array.isArray(order.attachments) && order.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {order.attachments.map((a, i) => (
            <button
              key={i}
              onClick={() => onOpenAttachment && onOpenAttachment(a)}
              className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-xs font-semibold px-2 py-1 rounded transition-colors"
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
            <button onClick={() => onSetStatus(order.id, "done")} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white text-sm font-semibold px-3 py-2 rounded transition-colors">Vykonané</button>
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
        {order.status === "rejected" && (
          <button
            onClick={() => onSetStatus(order.id, "new", "Obnovené z koša")}
            className="bg-[#2B46A2] hover:bg-[#1E3580] text-white text-sm font-semibold px-3 py-2 rounded transition-colors"
          >
            Obnoviť z koša
          </button>
        )}
      </div>
      {order.status === "rejected" && (
        <p className="text-xs text-[#856404]">
          V koši — definitívne sa vymaže {order.rejectedAt
            ? new Date(new Date(order.rejectedAt).getTime() + 7 * 86400000).toLocaleDateString("sk-SK")
            : "7 dní po zrušení"}. Ak je pôvodný termín medzičasom obsadený, obnovenie vypíše chybu.
        </p>
      )}

      {resched && (
        <div className="bg-[#F0F2F5] rounded-[10px] p-3 space-y-2 border border-purple-600">
          <p className="text-sm font-semibold text-purple-300">Presunúť na iný termín:</p>
          <input
            type="date"
            value={reschedDate}
            min={toISODate(new Date())}
            onChange={(e) => setReschedDate(e.target.value)}
            className="p-2 bg-[#F0F2F5] border border-[#E0E4EF] rounded-[10px] text-white text-sm"
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
    instructions: r.instructions || "",
    durationSlots: r.durationSlots || 1,
  }));
  const [rows, setRows] = useState(() => toDrafts(pricelist));
  const [saved, setSaved] = useState(false);
  const pricelistKey = JSON.stringify(pricelist);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(toDrafts(pricelist)); }, [pricelistKey]);

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
    setRows((prev) => [...prev, { id: `item-${Date.now()}`, label: "", priceSelf: "", priceReferral: "", instructions: "", durationSlots: 1 }]);
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
        instructions: (r.instructions || "").trim(),
        durationSlots: Number(r.durationSlots) || 1,
      }))
      .filter((r) => r.label && r.priceSelf != null);
    onSave(cleaned);
    setRows(toDrafts(cleaned));
    setSaved(true);
  };

  return (
    <div className="bg-[#F8F9FC] border border-[#E0E4EF] p-4 rounded-[10px] space-y-3">
      <h3 className="text-lg font-bold text-[#2B46A2]">Cenník vyšetrení</h3>
      <p className="text-sm text-slate-400">
        Prvá cena = samoplatca (bez žiadanky), druhá = doplatok so žiadankou. Ak doplatok necháte prázdny,
        vyšetrenie sa so žiadankou nebude ponúkať (len samoplatca). Do poľa <strong>Inštrukcie</strong> napíšte,
        kam má pacient prísť a ako sa pripraviť — text sa vloží do potvrdzovacieho e-mailu daného vyšetrenia.
      </p>
      <div className="hidden sm:flex gap-2 text-xs text-slate-400 font-semibold pr-12 pl-8">
        <span className="flex-1">Názov vyšetrenia (šípkami meníte poradie v ponuke)</span>
        <span className="w-24">Trvanie</span>
        <span className="w-24 text-right">Samoplatca</span>
        <span className="w-24 text-right">Doplatok</span>
      </div>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={row.id} className="bg-white border border-[#E0E4EF] rounded-[10px] p-2 space-y-2">
            <div className="flex gap-2 items-center">
              <div className="flex flex-col gap-0.5">
                <button type="button" onClick={() => { setSaved(false); setRows((prev) => { if (i === 0) return prev; const n = [...prev]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; }); }} disabled={i === 0} className="px-1.5 rounded bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] disabled:opacity-30 text-xs leading-4" title="Posunúť vyššie">↑</button>
                <button type="button" onClick={() => { setSaved(false); setRows((prev) => { if (i === prev.length - 1) return prev; const n = [...prev]; [n[i], n[i + 1]] = [n[i + 1], n[i]]; return n; }); }} disabled={i === rows.length - 1} className="px-1.5 rounded bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] disabled:opacity-30 text-xs leading-4" title="Posunúť nižšie">↓</button>
              </div>
              <input
                value={row.label}
                onChange={(e) => updateRow(i, "label", e.target.value)}
                className="flex-1 p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
                placeholder="Názov vyšetrenia"
              />
              <select
                value={row.durationSlots}
                onChange={(e) => updateRow(i, "durationSlots", Number(e.target.value))}
                className="w-24 p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
                title="Trvanie vyšetrenia (násobok 5-min slotu)"
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => <option key={n} value={n}>{n * BASE_SLOT_MIN} min</option>)}
              </select>
              <input
                value={row.priceSelf}
                onChange={(e) => updateRow(i, "priceSelf", e.target.value)}
                className="w-20 sm:w-24 p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm text-right"
                placeholder="Cena €"
                inputMode="decimal"
              />
              <input
                value={row.priceReferral}
                onChange={(e) => updateRow(i, "priceReferral", e.target.value)}
                className="w-20 sm:w-24 p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm text-right"
                placeholder="—"
                inputMode="decimal"
              />
              <button type="button" onClick={() => removeRow(i)} className="bg-[#D32821] hover:bg-[#B01F19] text-white px-3 py-2 rounded text-sm transition-colors" title="Odstrániť položku">✕</button>
            </div>
            <textarea
              value={row.instructions}
              onChange={(e) => updateRow(i, "instructions", e.target.value)}
              rows={2}
              className="w-full p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
              placeholder="Inštrukcie do e-mailu — napr. „Príďte na 2. poschodie, blok B, amb. č. 214. Buďte nalačno aspoň 6 hodín.“"
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={addRow} className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-sm font-semibold px-3 py-2 rounded transition-colors">
          + Pridať položku
        </button>
        <button
          type="button"
          onClick={() => setRows((prev) => prev.map((r) => (
            (r.instructions || "").trim() === "" && standardInstructions[r.id]
              ? { ...r, instructions: standardInstructions[r.id] }
              : r
          )))}
          className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-sm font-semibold px-3 py-2 rounded transition-colors"
          title="Doplní štandardnú prípravu len do prázdnych polí — vlastné texty neprepíše"
        >
          Predvyplniť štandardnú prípravu
        </button>
        <button type="button" onClick={handleSave} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white text-sm font-semibold px-4 py-2 rounded transition-colors">
          Uložiť cenník
        </button>
        {saved && <span className="text-green-400 text-sm self-center">✓ Uložené</span>}
      </div>
    </div>
  );
};

const StatTile = ({ label, value, accent }) => (
  <div className="bg-[#F8F9FC] border border-[#E0E4EF] rounded-[10px] p-3 text-center">
    <p className={`text-2xl font-bold ${accent || "text-white"}`}>{value}</p>
    <p className="text-xs text-slate-400">{label}</p>
  </div>
);


// Správa používateľov a rolí — len pre superadmina. Kontá sa
// zakladajú pozvánkou v Supabase; tu sa im prideľuje rola.
const roleLabels = { superadmin: "Superadmin", sestra: "Sestra", lekar: "Lekár", "": "— bez roly (bez prístupu)" };

const UsersTab = ({ onListStaff, onSetStaffRole, onRemoveStaffRole, doctors }) => {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const data = await onListStaff();
      setRows(data);
    } catch (e) {
      setMsg(e?.message || String(e));
      setRows([]);
    }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const apply = async (fn, okMsg) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      setMsg("✓ " + okMsg);
      await refresh();
    } catch (e) {
      setMsg(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (rows === null) {
    return (
      <div className="space-y-2">
        <h3 className="text-lg font-bold">Používatelia a roly</h3>
        <p className="text-slate-400">Načítavam…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold">Používatelia a roly</h3>
      <p className="text-xs text-slate-400">
        Nové konto najprv pozvite v Supabase (Authentication → Users → Invite user) — po prvom prihlásení sa objaví
        v tomto zozname a tu mu priradíte rolu. Bez roly sa do správy nedostane. Superadmin vidí všetko; sestra
        objednávky, termíny a poradie cenníka; lekár len svoje objednávky a svoju štatistiku.
      </p>
      {rows.length === 0 && !msg && <p className="text-slate-400">Žiadne kontá.</p>}
      <div className="space-y-2">
        {rows.map((u) => (
          <div key={u.email} className="bg-white border border-[#E0E4EF] rounded-[10px] p-3 flex flex-wrap items-center gap-2">
            <span className="flex-1 min-w-[180px] text-sm font-semibold truncate">{u.email}</span>
            <select
              value={u.role}
              disabled={busy}
              onChange={(e) => {
                const role = e.target.value;
                if (!role) { apply(() => onRemoveStaffRole(u.email), `Rola odobratá: ${u.email}`); return; }
                if (role === "lekar") {
                  setRows((prev) => prev.map((r) => (r.email === u.email ? { ...r, role, pendingDoctor: true } : r)));
                  return;
                }
                apply(() => onSetStaffRole(u.email, role), `Rola uložená: ${u.email} → ${roleLabels[role]}`);
              }}
              className="p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
            >
              {["", "superadmin", "sestra", "lekar"].map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
            </select>
            {(u.role === "lekar" || u.pendingDoctor) && (
              <select
                value={u.doctorName || ""}
                disabled={busy}
                onChange={(e) => {
                  const name = e.target.value;
                  if (name) apply(() => onSetStaffRole(u.email, "lekar", name), `${u.email} → Lekár (${name})`);
                }}
                className="p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
                title="Ktorý lekár z Nastavení je toto konto"
              >
                <option value="">— vyberte lekára —</option>
                {doctors.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-[#16A34A]" : "text-[#D32821]"}`}>{msg}</p>}
    </div>
  );
};

// Ručné overenie platieb z Prehľadu: spustí párovanie s Fio bankou
// a ukáže stav všetkých aktívnych objednávok. Automat beží aj sám
// každých 5 minút — toto je kontrola „teraz hneď".
const PaymentsCheck = ({ onCheckPayments }) => {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setRows(await onCheckPayments());
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-[#F8F9FC] border border-[#E0E4EF] rounded-[10px] p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-bold text-[#2B46A2]">Platby</h3>
        <button
          onClick={run}
          disabled={busy}
          className="bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white text-sm font-semibold px-4 py-2 rounded-[10px] transition-colors"
        >
          {busy ? "Overujem…" : "Overiť platby"}
        </button>
        <span className="text-xs text-[#767676]">Párovanie s bankou beží automaticky každých 5 minút — tlačidlo je okamžitá kontrola. Pri čerstvej platbe overte o pol minúty ešte raz.</span>
      </div>
      {error && <p className="text-sm text-[#D32821] font-semibold">{error}</p>}
      {rows !== null && (
        rows.length === 0 ? (
          <p className="text-sm text-[#767676]">Žiadne aktívne objednávky.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[#767676] border-b border-[#E0E4EF]">
                  <th className="py-1.5 pr-3">Termín</th>
                  <th className="py-1.5 pr-3">Pacient</th>
                  <th className="py-1.5 pr-3">Cena</th>
                  <th className="py-1.5 pr-3">Stav</th>
                  <th className="py-1.5">Platba</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F0F2F5]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{r.when}</td>
                    <td className="py-1.5 pr-3">{r.patient}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{r.price.toFixed(2).replace(".", ",")} €</td>
                    <td className="py-1.5 pr-3">
                      {r.paid
                        ? <span className="font-bold text-[#16A34A]">Zaplatené</span>
                        : <span className="font-bold text-[#856404]">Čaká</span>}
                    </td>
                    <td className="py-1.5 text-xs text-[#444444]">{r.payment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
};

// Mesačná štatistika na odmeny — počíta VYKONANÉ a ZAPLATENÉ vyšetrenia.
// Lekárovi databáza (RLS) vráti len jeho riadky, superadminovi všetko.
const StatsTab = ({ onGetMonthlyStats, pricelist }) => {
  const [month, setMonth] = useState(() => toISODate(new Date()).slice(0, 7));
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError("");
    const from = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const to = toISODate(new Date(y, m, 0));
    Promise.resolve(onGetMonthlyStats(from, to))
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) setError(e?.message || String(e)); });
    return () => { alive = false; };
  }, [month, onGetMonthlyStats]);

  const labelFor = (id) => pricelist.find((p) => p.id === id)?.label || id;
  const byDoctor = new Map();
  (rows || []).forEach((r) => {
    const key = r.doctor || "(bez lekára)";
    if (!byDoctor.has(key)) byDoctor.set(key, { count: 0, eur: 0, exams: [] });
    const d = byDoctor.get(key);
    d.count += r.count;
    d.eur += r.eur;
    d.exams.push(r);
  });
  const total = (rows || []).reduce((a, r) => ({ count: a.count + r.count, eur: a.eur + r.eur }), { count: 0, eur: 0 });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-bold">Štatistika vyšetrení</h3>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
        />
      </div>
      <p className="text-xs text-slate-400">Počítajú sa vyšetrenia so stavom Vykonané, ktoré boli zaplatené. Súčty ostávajú dostupné aj po výmaze objednávok (anonymná štatistika bez údajov pacientov).</p>
      {error && <p className="text-sm text-[#D32821] font-semibold">{error}</p>}
      {rows === null && !error ? (
        <p className="text-slate-400">Načítavam…</p>
      ) : byDoctor.size === 0 ? (
        <p className="text-slate-400">Za zvolený mesiac zatiaľ nie sú žiadne vykonané a zaplatené vyšetrenia.</p>
      ) : (
        <div className="space-y-3">
          {[...byDoctor.entries()].sort((a, b) => b[1].eur - a[1].eur).map(([doc, d]) => (
            <div key={doc} className="bg-white border border-[#E0E4EF] rounded-[10px] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-bold">{doc}</span>
                <span className="text-sm">
                  <b>{d.count}</b> vyšetrení · <b className="text-[#16A34A]">{d.eur.toFixed(2).replace(".", ",")} €</b>
                </span>
              </div>
              <details className="mt-1 text-xs text-[#444444]">
                <summary className="cursor-pointer select-none">Rozpis podľa vyšetrení</summary>
                <ul className="mt-1 space-y-0.5">
                  {d.exams.map((r) => (
                    <li key={r.examTypeId}>{labelFor(r.examTypeId)}: {r.count}× · {r.eur.toFixed(2).replace(".", ",")} €</li>
                  ))}
                </ul>
              </details>
            </div>
          ))}
          {byDoctor.size > 1 && (
            <p className="text-right text-sm font-bold border-t border-[#E0E4EF] pt-2">
              Spolu: {total.count} vyšetrení · <span className="text-[#16A34A]">{total.eur.toFixed(2).replace(".", ",")} €</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
};

// Editor LEN poradia cenníka (pre sestru) — ceny a texty needituje
const PricelistOrderEditor = ({ pricelist, onSaveOrder }) => {
  const [rows, setRows] = useState(pricelist);
  const [msg, setMsg] = useState("");
  const priceKey = pricelist.map((p) => p.id).join("|");
  useEffect(() => { setRows(pricelist); }, [priceKey]);

  const move = (i, delta) => setRows((prev) => {
    const j = i + delta;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const save = async () => {
    setMsg("");
    try {
      await onSaveOrder(rows);
      setMsg("✓ Poradie uložené.");
    } catch (e) {
      setMsg(e?.message || String(e));
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-bold">Poradie vyšetrení v ponuke</h3>
      <p className="text-xs text-slate-400">Šípkami zmeňte poradie, v akom pacient vidí vyšetrenia. Ceny a texty môže meniť len správca.</p>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={r.id} className="flex items-center gap-2 bg-white border border-[#E0E4EF] rounded-[10px] px-3 py-1.5 text-sm">
            <span className="w-6 text-right text-slate-400">{i + 1}.</span>
            <span className="flex-1 truncate">{r.label}</span>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="px-2 py-0.5 rounded bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] disabled:opacity-30" title="Posunúť vyššie">↑</button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="px-2 py-0.5 rounded bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] disabled:opacity-30" title="Posunúť nižšie">↓</button>
          </div>
        ))}
      </div>
      <button type="button" onClick={save} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white font-bold px-4 py-2 rounded-[10px] text-sm transition-colors">
        Uložiť poradie
      </button>
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-[#16A34A]" : "text-[#D32821]"}`}>{msg}</p>}
    </div>
  );
};

const AdminView = ({ orders, openSlots, settings, pricelist, onOpenWindow, onCloseSlot, onCloseDay, onSetStatus, onSetPaid, onReschedule, onSaveSettings, onSavePricelist, onSavePricelistOrder, onGetMonthlyStats, onListStaff, onSetStaffRole, onRemoveStaffRole, onCheckPayments, isSupabase = false, onOpenAttachment, role = "superadmin" }) => {
  const todayIso = toISODate(new Date());
  const [tab, setTab] = useState("overview");
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [dayDetailId, setDayDetailId] = useState(null);
  const [weekStart, setWeekStart] = useState(todayIso);
  const [winFrom, setWinFrom] = useState(todayIso);
  const [winTo, setWinTo] = useState(todayIso);
  const [winTimeFrom, setWinTimeFrom] = useState("07:30");
  const [winTimeTo, setWinTimeTo] = useState("14:30");
  const [winDoctor, setWinDoctor] = useState("");
  const [winSkipWeekends, setWinSkipWeekends] = useState(true);
  const [fStatus, setFStatus] = useState("all");
  const [fPaid, setFPaid] = useState("all");
  const [fText, setFText] = useState("");
  const [fDate, setFDate] = useState("");
  const [ibanDraft, setIbanDraft] = useState(settings.iban);
  const [beneficiaryDraft, setBeneficiaryDraft] = useState(settings.beneficiary);
  const [doctorsDraft, setDoctorsDraft] = useState(() => normalizeDoctors(settings.doctors));
  const [actionError, setActionError] = useState("");
  const [actionInfo, setActionInfo] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  // nastavenia sa načítavajú z databázy až po prvom vykreslení — drafty dorovnať
  const doctorsKey = JSON.stringify(settings.doctors || []);
  useEffect(() => { setIbanDraft(settings.iban); }, [settings.iban]);
  useEffect(() => { setBeneficiaryDraft(settings.beneficiary); }, [settings.beneficiary]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDoctorsDraft(normalizeDoctors(settings.doctors)); }, [doctorsKey]);

  // každá akcia viditeľne potvrdí úspech alebo vypíše presnú chybu
  const run = async (fn, okMessage) => {
    setActionError("");
    setActionInfo("");
    setActionBusy(true);
    try {
      await fn();
      if (okMessage) {
        setActionInfo(okMessage);
        setTimeout(() => setActionInfo(""), 4000);
      }
    } catch (e) {
      setActionError(e?.message || String(e));
    } finally {
      setActionBusy(false);
    }
  };
  const doSetStatus = (...args) => run(() => onSetStatus(...args), "Uložené.");
  const doSetPaid = (...args) => run(() => onSetPaid(...args), "Platba zaznamenaná.");
  const doReschedule = (...args) => run(() => onReschedule(...args), "Termín presunutý.");
  const doCloseSlot = (...args) => run(() => onCloseSlot(...args), "Termín zatvorený.");
  const doCloseDay = (...args) => run(() => onCloseDay(...args), "Voľné termíny dňa zatvorené.");
  const doOpenAttachment = (...args) => run(() => onOpenAttachment(...args));

  const doctors = normalizeDoctors(settings.doctors);

  const freeSlotsFor = (iso) => {
    const open = openSlots[iso] || [];
    const taken = new Set(orders.filter((o) => o.date === iso && isSlotOccupying(o)).flatMap(orderCellTimes));
    return open.filter((slot) => !taken.has(slot.time));
  };

  const pending = orders
    .filter((o) => o.status === "new")
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  // rozdelenie žiadostí: zaplatené (pripravené na potvrdenie) vs. čakajúce na platbu
  const pendingPaid = pending.filter((o) => o.paid || !(o.price > 0));
  const pendingUnpaid = pending.filter((o) => !o.paid && o.price > 0);

  const todayProgram = orders
    .filter((o) => o.date === todayIso && (o.status === "confirmed" || o.status === "new"))
    .sort((a, b) => a.time.localeCompare(b.time));

  const next7 = (() => {
    const end = new Date(); end.setDate(end.getDate() + 7);
    const endIso = toISODate(end);
    return orders.filter((o) => isSlotOccupying(o) && o.date >= todayIso && o.date <= endIso).length;
  })();

  const unpaidCount = orders.filter((o) => isSlotOccupying(o) && !o.paid && o.price > 0 && (o.status === "new" || o.status === "confirmed")).length;

  // text a dátum filtrujú základ; počty na čipoch stavov/platby sa
  // počítajú z tohto základu, aby sedeli s tým, čo personál vidí
  const textDateFiltered = orders
    .filter((o) => !fDate || o.date === fDate)
    .filter((o) => {
      const q = fText.trim().toLowerCase();
      if (!q) return true;
      return o.patient.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q) || o.patient.phone.replace(/\s/g, "").includes(q.replace(/\s/g, "")) || (o.doctor || "").toLowerCase().includes(q);
    });
  const statusCounts = textDateFiltered.reduce((acc, o) => { acc[o.status] = (acc[o.status] || 0) + 1; return acc; }, {});
  const paidCount = textDateFiltered.filter((o) => o.paid).length;
  const filteredOrders = textDateFiltered
    .filter((o) => fStatus === "all" || o.status === fStatus)
    .filter((o) => fPaid === "all" || (fPaid === "paid" ? o.paid : !o.paid))
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  // zoskupenie podľa dňa — hlavička dňa + objednávky zoradené podľa času
  const ordersByDay = [];
  filteredOrders.forEach((o) => {
    const last = ordersByDay[ordersByDay.length - 1];
    if (last && last.date === o.date) last.items.push(o);
    else ordersByDay.push({ date: o.date, items: [o] });
  });

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

  const shiftIso = (iso, days) => {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + days);
    return toISODate(d);
  };

  // Zlúčené úseky dňa: susedné 5-min bunky jednej objednávky (resp.
  // súvislé voľno jedného lekára) tvoria jeden blok. Voľný blok si
  // pamätá svoje bunky, aby sa dal zavrieť naraz. Používa týždenný
  // aj denný pohľad.
  const daySegmentsFor = (iso) => {
    const cells = (openSlots[iso] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
    const orderByCell = new Map(
      orders.filter((o) => o.date === iso && isSlotOccupying(o)).flatMap((o) => orderCellTimes(o).map((t) => [t, o]))
    );
    const segments = [];
    cells.forEach((cell) => {
      const order = orderByCell.get(cell.time) || null;
      const last = segments[segments.length - 1];
      const merges = last && last.end === cell.time && (
        (order && last.order && last.order.id === order.id) ||
        (!order && !last.order && last.doctor === cell.doctor)
      );
      if (merges) {
        last.end = addMinutes(cell.time, BASE_SLOT_MIN);
        if (!order) last.cells.push(cell.time);
      } else {
        segments.push({ start: cell.time, end: addMinutes(cell.time, BASE_SLOT_MIN), order, doctor: cell.doctor, cells: order ? [] : [cell.time] });
      }
    });
    const open = cells.length;
    const free = freeSlotsFor(iso).length;
    return { iso, open, free, booked: open - free, segments };
  };

  const week = Array.from({ length: 7 }, (_, i) => daySegmentsFor(shiftIso(weekStart, i)));
  const daySeg = daySegmentsFor(selectedDate);

  // zavrie všetky voľné 5-min bunky jedného bloku naraz
  const doCloseSegment = (iso, cellTimes) => run(async () => {
    for (const t of cellTimes) await onCloseSlot(iso, t);
  }, "Voľný blok zatvorený.");

  const handleOpenWindow = () => {
    run(() => onOpenWindow({
      dateFrom: winFrom, dateTo: winTo,
      timeFrom: winTimeFrom, timeTo: winTimeTo,
      doctor: winDoctor,
      skipWeekends: winSkipWeekends,
    }), "Termíny otvorené a uložené.");
    setSelectedDate(winFrom);
  };

  // Záložky podľa roly: superadmin všetko; sestra bez štatistiky a
  // nastavení (poradie cenníka má vlastnú záložku); lekár len svoje
  // objednávky (filtruje databáza) a svoju štatistiku.
  const allTabs = [
    { id: "overview", label: `Prehľad${pending.length > 0 ? ` (${pending.length})` : ""}`, roles: ["superadmin", "sestra", "lekar"] },
    { id: "calendar", label: "Kalendár", roles: ["superadmin", "sestra"] },
    { id: "orders", label: "Objednávky", roles: ["superadmin", "sestra", "lekar"] },
    { id: "stats", label: "Štatistika", roles: ["superadmin", "lekar"] },
    { id: "order", label: "Poradie cenníka", roles: ["sestra"] },
    { id: "settings", label: "Nastavenia", roles: ["superadmin"] },
    ...(isSupabase ? [{ id: "users", label: "Používatelia", roles: ["superadmin"] }] : []),
  ];
  const tabs = allTabs.filter((t) => t.roles.includes(role));

  const inputDark = "p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm";

  if (role === "none") {
    return (
      <p className="text-center text-[#444444] py-10">
        Vášmu kontu zatiaľ nebola priradená rola. Kontaktujte správcu systému.
      </p>
    );
  }
  // ak rola nemá zvolenú záložku, spadne na prvú povolenú
  const view = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? "overview");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-[10px] text-sm font-bold transition-colors ${view === t.id ? "bg-[#2B46A2] text-white" : "bg-[#F0F2F5] text-[#444444] hover:bg-[#E0E4EF]"}`}
          >
            {t.label}
          </button>
        ))}
        {actionBusy && <span className="self-center text-xs text-slate-400">ukladám…</span>}
      </div>
      {actionError && (
        <div className="bg-red-900/70 border border-red-500 text-red-100 text-sm font-semibold p-3 rounded-[10px]">
          ⚠ Akcia zlyhala: {actionError}
        </div>
      )}
      {actionInfo && (
        <div className="bg-emerald-900/60 border border-emerald-500 text-emerald-100 text-sm font-semibold p-3 rounded-[10px]">
          ✓ {actionInfo}
        </div>
      )}

      {view === "overview" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <StatTile label="dnešný program" value={todayProgram.length} accent="text-[#2B46A2]" />
            <StatTile label="na potvrdenie" value={pendingPaid.length} accent="text-[#16A34A]" />
            <StatTile label="čakajú na platbu" value={pendingUnpaid.length} accent="text-[#856404]" />
            <StatTile label="nezaplatené" value={unpaidCount} accent="text-[#856404]" />
            <StatTile label="objednaní — 7 dní" value={next7} accent="text-purple-300" />
          </div>

          {isSupabase && ["superadmin", "sestra"].includes(role) && (
            <PaymentsCheck onCheckPayments={onCheckPayments} />
          )}

          <div>
            <h3 className="text-lg font-bold text-[#2B46A2] mb-2">Dnešný program — {formatDateHuman(todayIso)}</h3>
            {todayProgram.length === 0
              ? <p className="text-slate-400 bg-white border border-[#E0E4EF] p-4 rounded-[10px]">Dnes nie sú objednaní žiadni pacienti.</p>
              : (
                <div className="space-y-2">
                  {todayProgram.map((o) => (
                    <div key={o.id} className="flex items-center gap-3 bg-[#F8F9FC] border border-[#E0E4EF] rounded-[10px] px-4 py-2">
                      <span className="font-mono font-bold text-lg text-[#2B46A2] w-16">{o.time}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">{o.patient.name} <span className="text-slate-400 text-xs">{formatBirth(o.patient)}</span></p>
                        <p className="text-xs text-slate-400 truncate">{o.exam.label}{o.doctor && ` · ${o.doctor}`}</p>
                      </div>
                      <PaidBadge order={o} />
                      <span className={`${usgStatuses[o.status].badge} text-xs font-bold px-2 py-1 rounded shrink-0`}>{usgStatuses[o.status].label}</span>
                      {o.status === "confirmed" && (
                        <button onClick={() => doSetStatus(o.id, "done")} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white text-xs font-semibold px-2 py-1 rounded shrink-0">Vykonané</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </div>

          <div>
            <h3 className="text-lg font-bold text-[#16A34A] mb-2">Zaplatené — pripravené na potvrdenie ({pendingPaid.length})</h3>
            {pendingPaid.length === 0
              ? <p className="text-slate-400 bg-white border border-[#E0E4EF] p-4 rounded-[10px]">Žiadna zaplatená žiadosť nečaká na potvrdenie.</p>
              : <div className="space-y-3">{pendingPaid.map((o) => (<UsgOrderCard key={o.id} order={o} onSetStatus={doSetStatus} onSetPaid={doSetPaid} onReschedule={doReschedule} freeSlotsFor={freeSlotsFor} onOpenAttachment={doOpenAttachment} />))}</div>}
          </div>

          <div>
            <h3 className="text-lg font-bold text-[#856404] mb-2">Zadané — čakajú na platbu ({pendingUnpaid.length})</h3>
            <p className="text-xs text-slate-400 mb-2">Platby z účtu sa párujú automaticky každých 5 minút; tlačidlom „Overiť platby" vyššie stiahnete stav hneď.</p>
            {pendingUnpaid.length === 0
              ? <p className="text-slate-400 bg-white border border-[#E0E4EF] p-4 rounded-[10px]">Žiadna žiadosť nečaká na platbu.</p>
              : <div className="space-y-3">{pendingUnpaid.map((o) => (<UsgOrderCard key={o.id} order={o} onSetStatus={doSetStatus} onSetPaid={doSetPaid} onReschedule={doReschedule} freeSlotsFor={freeSlotsFor} onOpenAttachment={doOpenAttachment} />))}</div>}
          </div>
        </div>
      )}

      {view === "calendar" && (
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold text-[#2B46A2]">Týždenný prehľad</h3>
              <div className="flex gap-2">
                <button onClick={() => setWeekStart((w) => shiftIso(w, -7))} className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-sm font-semibold px-3 py-1.5 rounded-[10px] transition-colors">‹ Predchádzajúci</button>
                <button onClick={() => setWeekStart(todayIso)} className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-sm font-semibold px-3 py-1.5 rounded-[10px] transition-colors">Dnes</button>
                <button onClick={() => setWeekStart((w) => shiftIso(w, 7))} className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-sm font-semibold px-3 py-1.5 rounded-[10px] transition-colors">Nasledujúci ›</button>
              </div>
            </div>
            <div className="grid grid-cols-7 gap-2 overflow-x-auto min-w-[640px] lg:min-w-0">
              {week.map((d) => (
                <div key={d.iso} className="min-w-[88px]">
                  <button
                    onClick={() => setSelectedDate(d.iso)}
                    title={d.iso}
                    className={`w-full px-1 py-2 rounded-[10px] text-xs font-semibold text-center transition-colors border ${
                      selectedDate === d.iso ? "border-[#2B46A2] bg-[#F0F4FF] text-[#2B46A2]" : d.open === 0 ? "border-[#E0E4EF] bg-[#F0F2F5] text-[#767676]" : "border-[#E0E4EF] bg-white text-[#1A1A2E]"
                    }${d.iso === todayIso ? " ring-2 ring-[#2B46A2]/40" : ""}`}
                  >
                    {formatDateShort(d.iso)}
                    <span className="block font-normal">{d.open === 0 ? "zatvorené" : `${d.booked}/${d.open} obsadené`}</span>
                  </button>
                  <div className="mt-1 space-y-1">
                    {d.segments.map((seg) => seg.order ? (
                      <button
                        key={seg.start}
                        onClick={() => { setSelectedDate(d.iso); setDayDetailId(seg.order.id); }}
                        title={`${seg.start}–${seg.end} ${seg.order.patient.name}`}
                        className="w-full text-left bg-[#2B46A2] hover:bg-[#1E3580] text-white rounded-[8px] px-1.5 py-1 text-[11px] leading-tight transition-colors"
                      >
                        <span className="font-bold">{seg.start}–{seg.end}</span>
                        <span className="block truncate">{seg.order.patient.name}</span>
                      </button>
                    ) : (
                      <div
                        key={seg.start}
                        title={seg.doctor || undefined}
                        className="w-full border border-dashed border-[#2B46A2]/40 text-[#2B46A2] rounded-[8px] px-1.5 py-1 text-[11px] leading-tight bg-white"
                      >
                        {seg.start}–{seg.end}
                        {seg.doctor && <span className="block truncate text-[#767676]">{seg.doctor}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <details className="bg-[#F8F9FC] border border-[#E0E4EF] rounded-[10px] p-4 group">
            <summary className="text-sm font-bold text-[#2B46A2] cursor-pointer select-none list-none flex items-center gap-2">
              <span className="inline-block transition-transform group-open:rotate-90">▸</span> Otvoriť termíny
            </summary>
            <div className="space-y-3 mt-3">
            <p className="text-xs text-slate-400">Zvoľte deň (alebo rozsah dní), časové okno a prípadne lekára. Termíny sa otvoria v 5-minútovej mriežke.</p>
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
                <label className="block text-xs text-slate-400 mb-1">Mriežka</label>
                <p className="text-sm text-[#444444] py-2">5 min — dĺžku určuje cenník</p>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-slate-400 mb-1">Lekár</label>
                <select value={winDoctor} onChange={(e) => setWinDoctor(e.target.value)} className={`w-full ${inputDark}`}>
                  <option value="">— neurčený —</option>
                  {doctors.map((d) => (<option key={d.name} value={d.name}>{d.name}</option>))}
                </select>
              </div>
              <label className="flex items-end gap-2 text-xs text-[#444444] pb-2 cursor-pointer">
                <input type="checkbox" checked={winSkipWeekends} onChange={(e) => setWinSkipWeekends(e.target.checked)} className="w-4 h-4 accent-green-500" />
                preskočiť víkendy
              </label>
            </div>
            {doctors.length === 0 && (
              <p className="text-xs text-[#856404]">Tip: lekárov na priraďovanie pridáte v záložke Nastavenia.</p>
            )}
            <button onClick={handleOpenWindow} className="bg-[#2B46A2] hover:bg-[#1E3580] text-white text-sm font-semibold px-4 py-2 rounded-[10px] transition-colors">
              Otvoriť termíny
            </button>
            </div>
          </details>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h3 className="text-lg font-bold text-[#2B46A2]">Deň: {formatDateHuman(selectedDate)}</h3>
              <div className="flex items-center gap-2">
                <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className={inputDark} />
                <button onClick={() => doCloseDay(selectedDate)} className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-sm font-semibold px-3 py-2 rounded transition-colors">
                  Zavrieť voľné
                </button>
              </div>
            </div>
            {daySeg.segments.length === 0
              ? <p className="text-slate-400 bg-white border border-[#E0E4EF] p-4 rounded-[10px]">V tento deň nie sú otvorené žiadne termíny.</p>
              : (
                <div className="space-y-1.5">
                  <p className="text-xs text-slate-400">{daySeg.booked}/{daySeg.open} obsadené · obsadené bloky otvoríte kliknutím, voľné bloky zavriete krížikom</p>
                  {daySeg.segments.map((seg) => {
                    if (seg.order) {
                      const active = dayDetailId === seg.order.id;
                      return (
                        <button
                          key={seg.start}
                          type="button"
                          onClick={() => setDayDetailId(active ? null : seg.order.id)}
                          className={`w-full flex items-center gap-3 text-left px-3 py-2 rounded-[10px] border text-white transition-colors ${active ? "bg-[#1E3580] border-[#2B46A2] ring-2 ring-[#2B46A2]/50" : "bg-[#2B46A2] border-[#1E3580] hover:bg-[#1E3580]"}`}
                        >
                          <span className="font-mono font-bold text-sm shrink-0 w-28 whitespace-nowrap">{seg.start}–{seg.end}</span>
                          <span className="flex-1 min-w-0">
                            <span className="block font-semibold truncate">{seg.order.patient.name}</span>
                            <span className="block text-xs opacity-80 truncate">{seg.order.exam.label}{seg.order.doctor ? ` · ${seg.order.doctor}` : ""}</span>
                          </span>
                          <PaidBadge order={seg.order} />
                          <span className={`${usgStatuses[seg.order.status].badge} text-xs font-bold px-2 py-1 rounded shrink-0`}>{usgStatuses[seg.order.status].label}</span>
                        </button>
                      );
                    }
                    return (
                      <div key={seg.start} className="w-full flex items-center gap-3 px-3 py-2 rounded-[10px] border border-dashed border-[#16A34A]/60 bg-[#F0FDF4]">
                        <span className="font-mono font-bold text-sm text-[#16A34A] shrink-0 w-28 whitespace-nowrap">{seg.start}–{seg.end}</span>
                        <span className="flex-1 min-w-0 text-sm text-[#16A34A] truncate">voľné{seg.doctor ? ` · ${seg.doctor}` : ""}</span>
                        <button
                          onClick={() => doCloseSegment(selectedDate, seg.cells)}
                          title="Zavrieť termín"
                          className="text-[#D32821] hover:text-[#B01F19] text-xs font-semibold shrink-0"
                        >
                          ✕ Zavrieť
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            {dayDetailId && (() => {
              const o = orders.find((x) => x.id === dayDetailId);
              if (!o || o.date !== selectedDate) return null;
              return (
                <div className="mt-3">
                  <p className="text-xs text-slate-400 mb-1">Detail objednávky — {o.time}</p>
                  <UsgOrderCard order={o} onSetStatus={doSetStatus} onSetPaid={doSetPaid} onReschedule={doReschedule} freeSlotsFor={freeSlotsFor} onOpenAttachment={doOpenAttachment} />
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {view === "orders" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={fText}
              onChange={(e) => setFText(e.target.value)}
              placeholder="Hľadať: meno, telefón, lekár, číslo objednávky…"
              className={`flex-1 min-w-48 ${inputDark}`}
            />
            <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} className={inputDark} />
            {fDate && <button onClick={() => setFDate("")} className="text-xs text-slate-400 hover:text-[#1A1A2E]">✕ dátum</button>}
          </div>
          <div className="flex flex-wrap gap-1.5 items-center">
            <FilterChip active={fStatus === "all"} onClick={() => setFStatus("all")} label={`Všetky (${textDateFiltered.length})`} />
            {Object.entries(usgStatuses).map(([key, st]) => (
              <FilterChip key={key} active={fStatus === key} onClick={() => setFStatus(key)} label={`${key === "rejected" ? "Kôš" : st.label} (${statusCounts[key] || 0})`} />
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-slate-400 mr-1">Platba:</span>
            <FilterChip active={fPaid === "all"} onClick={() => setFPaid("all")} label="Všetko" />
            <FilterChip active={fPaid === "paid"} onClick={() => setFPaid("paid")} label={`Zaplatené (${paidCount})`} />
            <FilterChip active={fPaid === "unpaid"} onClick={() => setFPaid("unpaid")} label={`Nezaplatené (${textDateFiltered.length - paidCount})`} />
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">{filteredOrders.length} objednávok</p>
            <button onClick={exportCsv} className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-xs font-semibold px-3 py-2 rounded transition-colors">
              ⬇ Export CSV
            </button>
          </div>
          {filteredOrders.length === 0
            ? <p className="text-slate-400 bg-white border border-[#E0E4EF] p-4 rounded-[10px]">Žiadne objednávky nezodpovedajú filtrom.</p>
            : (
              <div className="space-y-4">
                {ordersByDay.map((day) => (
                  <div key={day.date}>
                    <h4 className="text-sm font-bold text-[#2B46A2] border-b border-[#E0E4EF] pb-1 mb-2">
                      {formatDateHuman(day.date)} — {day.items.length} {day.items.length === 1 ? "objednávka" : day.items.length < 5 ? "objednávky" : "objednávok"}
                    </h4>
                    <div className="space-y-3">
                      {day.items.map((o) => (<UsgOrderCard key={o.id} order={o} onSetStatus={doSetStatus} onSetPaid={doSetPaid} onReschedule={doReschedule} freeSlotsFor={freeSlotsFor} onOpenAttachment={doOpenAttachment} />))}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {view === "stats" && (
        <StatsTab onGetMonthlyStats={onGetMonthlyStats} pricelist={pricelist} />
      )}

      {view === "order" && (
        <PricelistOrderEditor pricelist={pricelist} onSaveOrder={onSavePricelistOrder} />
      )}

      {view === "users" && (
        <UsersTab onListStaff={onListStaff} onSetStaffRole={onSetStaffRole} onRemoveStaffRole={onRemoveStaffRole} doctors={doctors} />
      )}

      {view === "settings" && (
        <div className="space-y-5">
          <div className="bg-[#F8F9FC] border border-[#E0E4EF] p-4 rounded-[10px] space-y-3">
            <h3 className="text-lg font-bold text-[#2B46A2]">Lekári</h3>
            <p className="text-sm text-slate-400">
              Ku každému lekárovi vyberte vyšetrenia, ktoré robí — pacient po zvolení vyšetrenia uvidí len
              termíny lekárov, ktorí ho vykonávajú. Ak nevyberiete žiadne, lekár robí všetky. Pracovné dni
              lekára nastavíte otvorením termínov preňho v záložke Kalendár.
            </p>
            <div className="space-y-2">
              {doctorsDraft.map((doc, di) => (
                <div key={di} className="bg-white border border-[#E0E4EF] rounded-[10px] p-2 space-y-2">
                  <div className="flex gap-2 items-center">
                    <input
                      value={doc.name}
                      onChange={(e) => setDoctorsDraft((prev) => prev.map((d, i) => i === di ? { ...d, name: e.target.value } : d))}
                      className="flex-1 p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
                      placeholder="MUDr. Meno Priezvisko"
                    />
                    <button type="button" onClick={() => setDoctorsDraft((prev) => prev.filter((_, i) => i !== di))} className="bg-[#D32821] hover:bg-[#B01F19] text-white px-3 py-2 rounded text-sm transition-colors" title="Odstrániť lekára">✕</button>
                  </div>
                  <input
                    type="email"
                    value={doc.email || ""}
                    onChange={(e) => setDoctorsDraft((prev) => prev.map((d, i) => i === di ? { ...d, email: e.target.value } : d))}
                    className="w-full p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
                    placeholder="E-mail lekára (naň príde upozornenie o objednávke na jeho termín)"
                  />
                  <input
                    value={doc.location || ""}
                    onChange={(e) => setDoctorsDraft((prev) => prev.map((d, i) => i === di ? { ...d, location: e.target.value } : d))}
                    className="w-full p-2 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] text-sm"
                    placeholder="Ambulancia / miesto vyšetrenia (napr. Ambulancia č. 12, 2. posch., pavilón A)"
                  />
                  <details className="text-sm">
                    <summary className="cursor-pointer text-[#444444] select-none">
                      Vyšetrenia: {doc.examTypeIds.length === 0 ? "všetky" : `${doc.examTypeIds.length} vybraných`}
                    </summary>
                    <div className="grid sm:grid-cols-2 gap-1 mt-2 max-h-52 overflow-y-auto pr-1">
                      {pricelist.map((t) => {
                        const checked = doc.examTypeIds.includes(t.id);
                        return (
                          <label key={t.id} className="flex items-start gap-2 text-xs text-[#1A1A2E] cursor-pointer bg-[#F0F2F5] rounded p-1.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setDoctorsDraft((prev) => prev.map((d, i) => {
                                if (i !== di) return d;
                                const next = checked ? d.examTypeIds.filter((x) => x !== t.id) : [...d.examTypeIds, t.id];
                                return { ...d, examTypeIds: next };
                              }))}
                              className="mt-0.5 w-4 h-4 accent-[#2B46A2]"
                            />
                            <span>{t.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setDoctorsDraft((prev) => [...prev, { name: "", examTypeIds: [] }])}
              className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-sm font-semibold px-3 py-2 rounded transition-colors"
            >
              + Pridať lekára
            </button>
          </div>
          <PricelistEditor pricelist={pricelist} onSave={onSavePricelist} />
          <div className="bg-[#F8F9FC] border border-[#E0E4EF] p-4 rounded-[10px] space-y-3">
            <h3 className="text-lg font-bold text-[#2B46A2]">Nastavenia platby</h3>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold text-[#1A1A2E]">IBAN pracoviska</label>
                <input value={ibanDraft} onChange={(e) => setIbanDraft(e.target.value)} className="w-full p-3 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E] font-mono text-sm" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-[#1A1A2E]">Názov príjemcu</label>
                <input value={beneficiaryDraft} onChange={(e) => setBeneficiaryDraft(e.target.value)} className="w-full p-3 bg-white border border-[#767676] rounded-[10px] text-[#1A1A2E]" />
              </div>
            </div>
            <button
              onClick={() => run(() => onSaveSettings({
                iban: ibanDraft.trim(),
                beneficiary: beneficiaryDraft.trim(),
                doctors: normalizeDoctors(doctorsDraft),
              }), "Nastavenia aj zoznam lekárov uložené.")}
              className="bg-[#2B46A2] hover:bg-[#1E3580] text-white text-sm font-semibold px-4 py-2 rounded transition-colors"
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
const OrderLookup = ({ onLookup, onCancel, settings = defaultSettings }) => {
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
    <details className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] mt-4 text-slate-800">
      <summary className="p-5 font-bold text-[#2B46A2] cursor-pointer select-none">Už máte objednávku? Overiť stav alebo zrušiť</summary>
      <div className="px-5 pb-5 space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <input
            value={orderId}
            onChange={(e) => { setOrderId(e.target.value); setFound(null); setMessage(""); }}
            placeholder="Číslo objednávky (USG-…)"
            className="p-3 bg-white border border-slate-300 rounded-[10px] focus:ring-2 focus:ring-[#2B46A2] outline-none"
          />
          <input
            value={phone}
            onChange={(e) => { setPhone(e.target.value); setFound(null); setMessage(""); }}
            placeholder="Telefón zadaný pri objednávke"
            className="p-3 bg-white border border-slate-300 rounded-[10px] focus:ring-2 focus:ring-[#2B46A2] outline-none"
          />
        </div>
        <button onClick={search} disabled={busy} className="bg-[#2B46A2] hover:bg-[#004a87] disabled:opacity-60 text-white font-bold px-5 py-2.5 rounded-[10px] transition-colors">
          {busy ? "Pracujem…" : "Vyhľadať"}
        </button>
        {message && <p className="text-sm text-red-600 font-semibold">{message}</p>}
        {found && (
          <div className="border border-slate-200 rounded-[10px] p-4 space-y-2">
            <p className="font-bold">{found.exam.label}</p>
            <p className="text-sm">{formatDateHuman(found.date)} o {found.time} · {formatPrice(found.price)}{found.hasReferral ? " (doplatok so žiadankou)" : ""}</p>
            {found.doctor && (
              <p className="text-sm">
                Lekár: {found.doctor}
                {doctorLocation(settings.doctors, found.doctor) && (
                  <span className="font-semibold text-[#2B46A2]"> · Miesto: {doctorLocation(settings.doctors, found.doctor)}</span>
                )}
              </p>
            )}
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
              <>
                <button onClick={cancel} disabled={busy} className="bg-[#D32821] hover:bg-[#B01F19] disabled:opacity-60 text-white text-sm font-bold px-4 py-2 rounded-[10px] transition-colors">
                  Zrušiť objednávku
                </button>
                <p className="text-xs text-slate-500">
                  Pri zrušení najneskôr 48 hodín pred termínom vraciame platbu v plnej výške; neskoršie zrušenie
                  upravujú <a href="#/podmienky" target="_blank" rel="noreferrer" className="text-[#2B46A2] font-semibold hover:underline">podmienky objednávania</a>.
                </p>
              </>
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
