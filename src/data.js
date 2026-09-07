import { useState, useEffect, useCallback } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import {
  defaultSettings, defaultPricelist, normalizePricelist,
  generateWindowSlots, isSlotOccupying, toISODate, loadJson, normalizeDoctors,
  USG_ORDERS_KEY, USG_OPEN_SLOTS_KEY, USG_SETTINGS_KEY, USG_PRICELIST_KEY,
} from "./booking.jsx";

// ============================================================
// Dátová vrstva. Dva režimy:
//  - Supabase (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY v .env)
//  - localStorage (demo bez servera), keď kľúče chýbajú
// Pacient v Supabase režime NIKDY nečíta cudzie objednávky —
// obsadenosť, overenie aj zrušenie idú cez RPC funkcie
// (supabase/schema.sql), ktoré vracajú len nevyhnutné údaje.
// ============================================================

// --- mapovanie riadkov DB (snake_case) na tvar aplikácie ---

const orderFromRow = (r) => ({
  id: r.id,
  createdAt: r.created_at,
  status: r.status,
  statusNote: r.status_note || "",
  hasReferral: r.has_referral,
  exam: {
    typeId: r.exam_type_id,
    label: r.exam_label,
    reason: r.reason || "",
    referrerName: r.referrer_name || "",
    referrerFacility: r.referrer_facility || "",
  },
  price: r.price == null ? null : Number(r.price),
  patient: {
    name: r.patient_name,
    birthDate: r.birth_date || "",
    insurance: r.insurance || "",
    phone: r.phone || "",
    email: r.email || "",
  },
  date: r.slot_date,
  time: (r.slot_time || "").slice(0, 5),
  variableSymbol: r.variable_symbol || "",
  doctor: r.doctor || "",
  paid: Boolean(r.paid),
  attachments: Array.isArray(r.attachments) ? r.attachments : [],
  durationMin: r.duration_min == null ? 10 : Number(r.duration_min),
  rejectedAt: r.rejected_at || "",
  paidAt: r.paid_at || "",
  arrivedAt: r.arrived_at || "",
});

const lookupFromJson = (j) => j && ({
  id: j.id,
  status: j.status,
  statusNote: j.status_note || "",
  hasReferral: j.has_referral,
  exam: { label: j.exam_label, typeId: j.exam_type_id || null },
  durationMin: j.duration_min == null ? 10 : Number(j.duration_min),
  price: j.price == null ? null : Number(j.price),
  date: j.slot_date,
  time: (j.slot_time || "").slice(0, 5),
  doctor: j.doctor || "",
  paid: Boolean(j.paid),
});

// kniha faktúr — riadok DB → tvar aplikácie (faktúra si nesie kópiu
// fakturačných údajov dodávateľa platných v čase vystavenia)
const invoiceFromRow = (r) => ({
  number: r.number,
  year: Number(r.year),
  seq: Number(r.seq),
  kind: r.kind,
  relatedNumber: r.related_number || "",
  orderId: r.order_id,
  patientName: r.patient_name,
  patientEmail: r.patient_email || "",
  itemDesc: r.item_desc,
  amount: Number(r.amount),
  issueDate: r.issue_date,
  deliveryDate: r.delivery_date || "",
  paymentDate: r.payment_date || "",
  paymentVs: r.payment_vs || "",
  taxable: Boolean(r.taxable),
  supplier: {
    name: r.supplier_name || "", address: r.supplier_address || "",
    ico: r.supplier_ico || "", dic: r.supplier_dic || "",
    or: r.supplier_or || "", pzs: r.supplier_pzs || "", iban: r.supplier_iban || "",
  },
});

// demo režim: lokálna kniha faktúr zrkadlí logiku databázového triggeru
const DEMO_INVOICES_KEY = "usgInvoices_v1";
const invoiceSettingsReady = (s) =>
  ["invoiceName", "invoiceAddress", "invoiceIco", "invoiceDic", "invoiceOr", "invoicePzs"]
    .every((k) => ((s && s[k]) || "").trim() !== "");

const demoIssueInvoice = (order, kind, s) => {
  if (!invoiceSettingsReady(s) || !(order.price > 0)) return;
  const list = loadJson(DEMO_INVOICES_KEY, []);
  const has = (k) => list.some((i) => i.orderId === order.id && i.kind === k);
  let related = "";
  if (kind === "faktura" && has("faktura")) return;
  if (kind === "dobropis") {
    const f = list.find((i) => i.orderId === order.id && i.kind === "faktura");
    if (!f || has("dobropis")) return;
    related = f.number;
  }
  const year = new Date().getFullYear();
  const seq = list.filter((i) => i.year === year).length + 1;
  list.push({
    number: `${year}/${String(seq).padStart(4, "0")}`, year, seq, kind, relatedNumber: related,
    orderId: order.id, patientName: order.patient.name, patientEmail: order.patient.email || "",
    itemDesc: order.hasReferral
      ? "Doplatok za poskytnutie USG vyšetrenia v doplnkových ordinačných hodinách"
      : "USG vyšetrenie",
    amount: kind === "dobropis" ? -order.price : order.price,
    issueDate: toISODate(new Date()), deliveryDate: order.date, paymentDate: toISODate(new Date()),
    paymentVs: order.variableSymbol || "", taxable: false,
    supplier: {
      name: s.invoiceName, address: s.invoiceAddress, ico: s.invoiceIco,
      dic: s.invoiceDic, or: s.invoiceOr, pzs: s.invoicePzs, iban: s.iban || "",
    },
  });
  localStorage.setItem(DEMO_INVOICES_KEY, JSON.stringify(list));
};

const pricelistFromRows = (rows) =>
  rows.map((r) => ({
    id: r.id,
    label: r.label,
    priceSelf: Number(r.price_self),
    priceReferral: r.price_referral == null ? null : Number(r.price_referral),
    instructions: r.instructions || "",
    durationSlots: r.duration_slots == null ? 2 : Math.max(2, Number(r.duration_slots)),
  }));

const groupSlots = (rows) => {
  const map = {};
  rows.forEach((r) => {
    (map[r.slot_date] = map[r.slot_date] || []).push({ time: r.slot_time.slice(0, 5), doctor: r.doctor || "" });
  });
  Object.values(map).forEach((arr) => arr.sort((a, b) => a.time.localeCompare(b.time)));
  return map;
};

// staré lokálne dáta mali sloty ako reťazce — znormalizujeme na objekty
const normalizeLocalSlots = (map) => {
  const out = {};
  Object.entries(map || {}).forEach(([date, arr]) => {
    out[date] = (arr || []).map((s) => (typeof s === "string" ? { time: s, doctor: "" } : s));
  });
  return out;
};

const friendlyDbError = (error) => {
  if (!error) return null;
  if (error.code === "23505" || error.code === "23P01") return new Error("Vybraný termín bol medzičasom obsadený. Vyberte iný.");
  return new Error(error.message || "Operácia zlyhala. Skúste to znova.");
};

const throwIf = (error) => { const e = friendlyDbError(error); if (e) throw e; };

// --- prihlásenie personálu (Supabase Auth) ---

export function useAuth() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!isSupabaseConfigured);
  // rola personálu: superadmin / sestra / lekar; "none" = konto bez
  // priradenej roly (prístup odmietne aj databáza cez RLS).
  // Demo režim bez Supabase sa správa ako superadmin.
  const [role, setRole] = useState(isSupabaseConfigured ? null : "superadmin");
  const [doctorName, setDoctorName] = useState("");

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase) return;
    if (!session) { setRole(null); setDoctorName(""); return; }
    supabase.from("staff_roles").select("role, doctor_name").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => {
        setRole(data?.role || "none");
        setDoctorName(data?.doctor_name || "");
      });
  }, [session]);

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error("Nesprávny e-mail alebo heslo.");
  };
  const signOut = () => supabase?.auth.signOut();

  return { isSupabase: isSupabaseConfigured, session, ready, signIn, signOut, role, doctorName };
}

// --- hlavný hook s dátami a akciami ---

export function useBookingData(isStaff) {
  const [orders, setOrders] = useState(() => (isSupabaseConfigured ? [] : loadJson(USG_ORDERS_KEY, [])));
  const [occupiedRemote, setOccupiedRemote] = useState([]);
  const [openSlots, setOpenSlots] = useState(() => (isSupabaseConfigured ? {} : normalizeLocalSlots(loadJson(USG_OPEN_SLOTS_KEY, {}))));
  const [settings, setSettings] = useState(() => (isSupabaseConfigured ? defaultSettings : loadJson(USG_SETTINGS_KEY, defaultSettings)));
  const [pricelist, setPricelist] = useState(() => (isSupabaseConfigured ? defaultPricelist : normalizePricelist(loadJson(USG_PRICELIST_KEY, defaultPricelist))));
  const [loading, setLoading] = useState(isSupabaseConfigured);

  // localStorage perzistencia (len demo režim)
  useEffect(() => { if (!isSupabaseConfigured) localStorage.setItem(USG_ORDERS_KEY, JSON.stringify(orders)); }, [orders]);
  useEffect(() => { if (!isSupabaseConfigured) localStorage.setItem(USG_OPEN_SLOTS_KEY, JSON.stringify(openSlots)); }, [openSlots]);
  useEffect(() => { if (!isSupabaseConfigured) localStorage.setItem(USG_SETTINGS_KEY, JSON.stringify(settings)); }, [settings]);
  useEffect(() => { if (!isSupabaseConfigured) localStorage.setItem(USG_PRICELIST_KEY, JSON.stringify(pricelist)); }, [pricelist]);

  const reload = useCallback(async () => {
    if (!supabase) return;
    const [slotsRes, priceRes, settingsRes] = await Promise.all([
      supabase.from("open_slots").select("slot_date, slot_time, doctor"),
      supabase.from("pricelist").select("*").eq("active", true).order("sort_order"),
      supabase.from("settings").select("key, value"),
    ]);
    if (!slotsRes.error) setOpenSlots(groupSlots(slotsRes.data));
    if (!priceRes.error && priceRes.data.length > 0) setPricelist(pricelistFromRows(priceRes.data));
    if (!settingsRes.error && settingsRes.data.length > 0) {
      const kv = Object.fromEntries(settingsRes.data.map((r) => [r.key, r.value]));
      // Personál číta zoznam lekárov (aj s e-mailmi) priamo z settings;
      // pacient (anon) ho nevidí — dostane cez public_doctors() bez e-mailov.
      let doctors = [];
      if (isStaff) {
        try { doctors = JSON.parse(kv.doctors || "[]"); } catch { doctors = []; }
      } else {
        const { data: docs } = await supabase.rpc("public_doctors");
        doctors = Array.isArray(docs) ? docs : [];
      }
      setSettings({
        iban: kv.iban || defaultSettings.iban,
        beneficiary: kv.beneficiary || defaultSettings.beneficiary,
        doctors: normalizeDoctors(doctors),
        referralFrom: (kv.referral_from || "").slice(0, 5), // normalizuj „14:00:00" → „14:00"
        invoiceName: kv.invoice_name || "",
        invoiceAddress: kv.invoice_address || "",
        invoiceIco: kv.invoice_ico || "",
        invoiceDic: kv.invoice_dic || "",
        invoiceOr: kv.invoice_or || "",
        invoicePzs: kv.invoice_pzs || "",
        smsVerify: kv.usg_sms_verify === "on", // overenie telefónu SMS kódom (usg-otp-001)
      });
    }
    if (isStaff) {
      const { data, error } = await supabase.from("orders").select("*").order("slot_date").order("slot_time");
      if (!error) setOrders(data.map(orderFromRow));
    } else {
      const { data, error } = await supabase.rpc("get_booked_slots");
      if (!error) setOccupiedRemote(data.map((r) => ({ date: r.slot_date, time: r.slot_time.slice(0, 5) })));
    }
    setLoading(false);
  }, [isStaff]);

  useEffect(() => { reload(); }, [reload]);

  // realtime pre personál, periodické obnovenie pre pacienta
  useEffect(() => {
    if (!supabase) return;
    if (isStaff) {
      const channel = supabase
        .channel("booking-changes")
        .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, reload)
        .on("postgres_changes", { event: "*", schema: "public", table: "open_slots" }, reload)
        .subscribe();
      return () => { supabase.removeChannel(channel); };
    }
    const interval = setInterval(reload, 30000);
    window.addEventListener("focus", reload);
    return () => { clearInterval(interval); window.removeEventListener("focus", reload); };
  }, [isStaff, reload]);

  // obsadené termíny pre pacientsky kalendár — objednávka obsadzuje
  // všetky 10-min bunky svojho trvania
  const expandOrderCells = (o) => {
    const [h, m] = (o.time || "00:00").split(":").map(Number);
    const n = Math.max(1, Math.round((o.durationMin || 10) / 5));
    return Array.from({ length: n }, (_, i) => {
      const mins = h * 60 + m + i * 5;
      return { date: o.date, time: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}` };
    });
  };
  const occupied = isSupabaseConfigured && !isStaff
    ? occupiedRemote
    : orders.filter(isSlotOccupying).flatMap(expandOrderCells);

  // --- akcie ---

  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Súbor sa nepodarilo načítať."));
      reader.readAsDataURL(file);
    });

  const addOrder = async (order, files = []) => {
    if (!supabase) {
      const attachments = [];
      for (const f of files) {
        if (f.size > 2 * 1024 * 1024) throw new Error(`Súbor ${f.name}: v demo režime je maximálna veľkosť prílohy 2 MB.`);
        attachments.push({ name: f.name, dataUrl: await readAsDataUrl(f) });
      }
      setOrders((prev) => [...prev, { ...order, attachments }]);
      return order.variableSymbol; // demo: ponechá klientský VS
    }
    const attachments = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const safeName = f.name.replace(/[^\w.\-]+/g, "_").slice(-80);
      const path = `${order.id}/${i}-${safeName}`;
      const { error: upError } = await supabase.storage.from("prilohy").upload(path, f, { contentType: f.type || undefined });
      if (upError) throw new Error(`Prílohu ${f.name} sa nepodarilo nahrať: ${upError.message}`);
      attachments.push({ name: f.name, path });
    }
    const rpcParams = {
      p_id: order.id,
      p_exam_type_id: order.exam.typeId,
      p_exam_label: order.exam.label,
      p_price: order.price,
      p_has_referral: order.hasReferral,
      p_reason: order.exam.reason,
      p_referrer_name: order.exam.referrerName,
      p_referrer_facility: order.exam.referrerFacility,
      p_patient_name: order.patient.name,
      p_birth_date: order.patient.birthDate,
      p_insurance: order.patient.insurance,
      p_phone: order.patient.phone,
      p_email: order.patient.email,
      p_slot_date: order.date,
      p_slot_time: order.time,
      p_variable_symbol: order.variableSymbol,
    };
    let { data, error } = await supabase.rpc("create_order", { ...rpcParams, p_attachments: attachments });
    // Iba ak server naozaj nepozná parameter p_attachments (nespustená migrácia),
    // zopakuj bez príloh. Inak (rate-limit, validácia…) chybu NEskrývaj a NEzahoď žiadanku.
    const missingAttachParam = error && (error.code === "PGRST202" || /p_attachments/i.test(error.message || ""));
    if (missingAttachParam) {
      ({ data, error } = await supabase.rpc("create_order", rpcParams));
    }
    throwIf(error);
    await reload();
    // Nová verzia create_order vracia serverom pridelený ČÍSELNÝ variabilný
    // symbol. Stará verzia (pred migráciou fio-parovanie-002) vracia číslo
    // objednávky USG-… — to VS nie je, vtedy ostáva klientský číselný VS.
    return typeof data === "string" && /^\d{1,10}$/.test(data) ? data : order.variableSymbol;
  };

  const openAttachment = async (attachment) => {
    if (attachment?.dataUrl) {
      const a = document.createElement("a");
      a.href = attachment.dataUrl;
      a.download = attachment.name || "priloha";
      a.click();
      return;
    }
    if (attachment?.path && supabase) {
      const { data, error } = await supabase.storage.from("prilohy").createSignedUrl(attachment.path, 300);
      throwIf(error);
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    }
  };

  const setStatus = async (orderId, status, statusNote = "") => {
    if (!supabase) {
      // demo: storno zaplatenej objednávky vystaví dobropis (ako DB trigger)
      if (status === "rejected") {
        const o = orders.find((x) => x.id === orderId);
        if (o && o.paid && o.price > 0) demoIssueInvoice(o, "dobropis", settings);
      }
      setOrders((prev) => prev.map((o) => (o.id === orderId
        ? { ...o, status, statusNote, rejectedAt: status === "rejected" ? new Date().toISOString() : "" }
        : o)));
      return;
    }
    const { error } = await supabase.from("orders").update({ status, status_note: statusNote }).eq("id", orderId);
    throwIf(error);
    await reload();
  };

  const reschedule = async (orderId, date, time) => {
    if (!supabase) {
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, date, time, statusNote: `Presunuté z ${o.date} ${o.time}` } : o)));
      return;
    }
    // reschedule_order kontroluje, či sa celé trvanie zmestí do otvorených
    // súvislých buniek (rovnako ako pri vytvorení objednávky)
    let { error } = await supabase.rpc("reschedule_order", { p_id: orderId, p_slot_date: date, p_slot_time: time });
    if (error && error.code === "PGRST202") {
      // migrácia reschedule-001 ešte nie je v databáze — pôvodný priamy update
      const prev = orders.find((o) => o.id === orderId);
      ({ error } = await supabase.from("orders")
        .update({ slot_date: date, slot_time: time, status_note: prev ? `Presunuté z ${prev.date} ${prev.time}` : "Presunuté" })
        .eq("id", orderId));
    }
    throwIf(error);
    await reload();
  };

  // otvorenie termínov: okno (deň/rozsah + čas od–do + interval + lekár)
  // Mriežka je vždy 5 minút (BASE_SLOT_MIN) — interval sa nedá zvoliť,
  // aby nemohli vzniknúť riedke bunky, v ktorých dlhšie vyšetrenia
  // nenájdu súvislé miesto. Dĺžku vyšetrenia určuje cenník.
  const openWindow = async ({ dateFrom, dateTo, timeFrom, timeTo, doctor = "", skipWeekends = true }) => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) throw new Error("Zadajte platný rozsah dní — „deň do“ nesmie byť pred „deň od“.");
    // zarovnanie časov na 5-min mriežku (napr. 07:33 → 07:35), aby sa
    // otvorené bunky neprekladali s existujúcou mriežkou dňa
    const align5 = (t) => {
      const [h, m] = String(t || "").split(":").map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return t;
      const tot = Math.round((h * 60 + m) / 5) * 5;
      return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
    };
    const times = generateWindowSlots(align5(timeFrom), align5(timeTo), 5);
    if (times.length === 0) throw new Error("Zadajte platné časové okno — „čas do“ musí byť neskôr ako „čas od“.");
    const days = [];
    const d = new Date(`${dateFrom}T12:00:00`);
    const end = new Date(`${dateTo}T12:00:00`);
    while (d <= end) {
      const dow = d.getDay();
      if (!skipWeekends || (dow !== 0 && dow !== 6)) days.push(toISODate(d));
      d.setDate(d.getDate() + 1);
    }
    if (!supabase) {
      setOpenSlots((prev) => {
        const next = { ...prev };
        days.forEach((iso) => {
          const byTime = new Map((next[iso] || []).map((slot) => [slot.time, slot]));
          times.forEach((t) => { if (!byTime.has(t)) byTime.set(t, { time: t, doctor }); }); // neprepisuj existujúce bunky
          next[iso] = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
        });
        return next;
      });
      return;
    }
    const rows = [];
    days.forEach((iso) => times.forEach((t) => rows.push({ slot_date: iso, slot_time: t, doctor })));
    // ignoreDuplicates: existujúce bunky (aj s priradeným lekárom či
    // obsadené objednávkou) sa NEPREPÍŠU — otvorenie okna pre iného lekára
    // tak nezmení lekára na dňoch, kde už niekto ordinuje
    const { error } = await supabase.from("open_slots").upsert(rows, { onConflict: "slot_date,slot_time", ignoreDuplicates: true });
    throwIf(error);
    await reload();
  };

  const closeSlot = async (date, time) => {
    if (!supabase) {
      setOpenSlots((prev) => ({ ...prev, [date]: (prev[date] || []).filter((slot) => slot.time !== time) }));
      return;
    }
    const { error } = await supabase.from("open_slots").delete().eq("slot_date", date).eq("slot_time", time);
    throwIf(error);
    await reload();
  };

  const closeDay = async (date) => {
    // celé trvanie objednávky (nie len začiatok) — inak by „Zavrieť voľné"
    // zmazalo bunky, na ktorých objednávka reálne sedí
    const bookedTimes = new Set(
      orders.filter((o) => o.date === date && isSlotOccupying(o)).flatMap(expandOrderCells).map((c) => c.time)
    );
    if (!supabase) {
      setOpenSlots((prev) => ({ ...prev, [date]: (prev[date] || []).filter((slot) => bookedTimes.has(slot.time)) }));
      return;
    }
    const freeTimes = (openSlots[date] || []).map((slot) => slot.time).filter((t) => !bookedTimes.has(t));
    if (freeTimes.length === 0) return;
    const { error } = await supabase.from("open_slots").delete().eq("slot_date", date).in("slot_time", freeTimes);
    throwIf(error);
    await reload();
  };

  const setPaid = async (orderId, paid = true) => {
    const paidAt = paid ? new Date().toISOString() : null;
    if (!supabase) {
      // demo: prijatie platby vystaví faktúru (ako DB trigger)
      if (paid) {
        const o = orders.find((x) => x.id === orderId);
        if (o) demoIssueInvoice(o, "faktura", settings);
      }
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, paid, paidAt } : o)));
      return;
    }
    const { error } = await supabase.from("orders").update({ paid, paid_at: paidAt }).eq("id", orderId);
    throwIf(error);
    await reload();
  };

  // zmena lekára objednávky — termín a čas sa nemenia; e-mail/SMS
  // pacientovi posiela databázový trigger
  const changeDoctor = async (orderId, doctor) => {
    if (!supabase) {
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, doctor } : o)));
      return;
    }
    const { error } = await supabase.from("orders").update({ doctor }).eq("id", orderId);
    throwIf(error);
    await reload();
  };

  const saveSettings = async (next) => {
    // demo: merge — sekcie ukladajú len svoje polia, ostatné sa nesmú stratiť
    if (!supabase) { setSettings((prev) => ({ ...prev, ...next })); return; }
    const rows = [
      { key: "iban", value: next.iban },
      { key: "beneficiary", value: next.beneficiary },
      { key: "doctors", value: JSON.stringify(next.doctors || []) },
    ];
    // doplatkové hodiny posiela len sekcia „Nastavenia platby"
    if (next.referralFrom !== undefined) {
      rows.push({ key: "referral_from", value: next.referralFrom || "" });
    }
    if (next.smsVerify !== undefined) {
      rows.push({ key: "usg_sms_verify", value: next.smsVerify ? "on" : "off" });
    }
    // fakturačné údaje posiela len sekcia „Fakturačné údaje"
    if (next.invoiceName !== undefined) {
      rows.push(
        { key: "invoice_name", value: next.invoiceName || "" },
        { key: "invoice_address", value: next.invoiceAddress || "" },
        { key: "invoice_ico", value: next.invoiceIco || "" },
        { key: "invoice_dic", value: next.invoiceDic || "" },
        { key: "invoice_or", value: next.invoiceOr || "" },
        { key: "invoice_pzs", value: next.invoicePzs || "" },
      );
    }
    const { error } = await supabase.from("settings").upsert(rows, { onConflict: "key" });
    throwIf(error);
    await reload();
  };

  const savePricelist = async (list) => {
    if (!supabase) { setPricelist(list); return; }
    const rows = list.map((item, i) => ({
      id: item.id, label: item.label,
      price_self: item.priceSelf, price_referral: item.priceReferral,
      instructions: item.instructions || "",
      duration_slots: item.durationSlots || 1,
      active: true, sort_order: i,
    }));
    const { error } = await supabase.from("pricelist").upsert(rows, { onConflict: "id" });
    throwIf(error);
    if (rows.length > 0) {
      const ids = rows.map((r) => `"${r.id}"`).join(",");
      await supabase.from("pricelist").update({ active: false }).not("id", "in", `(${ids})`);
    }
    await reload();
  };

  const lookupOrder = async (orderId, phone) => {
    const digits = phone.replace(/\D/g, "");
    if (!orderId || digits.length < 9) return null;
    if (!supabase) {
      const o = orders.find((x) => x.id.toUpperCase() === orderId.toUpperCase() && x.patient.phone.replace(/\D/g, "").slice(-9) === digits.slice(-9));
      return o || null;
    }
    const { data, error } = await supabase.rpc("lookup_order", { p_id: orderId, p_phone: phone });
    throwIf(error);
    return lookupFromJson(data);
  };

  // zmena termínu pacientom (48 h pravidlo a obsadenosť stráži databáza)
  const patientReschedule = async (orderId, phone, date, time) => {
    if (!supabase) {
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, date, time, statusNote: "Presunuté pacientom" } : o)));
      return;
    }
    const { error } = await supabase.rpc("patient_reschedule", { p_id: orderId, p_phone: phone, p_slot_date: date, p_slot_time: time });
    throwIf(error);
    await reload();
  };

  const cancelOrder = async (orderId, phone) => {
    if (!supabase) { await setStatus(orderId, "rejected", "Zrušené pacientom"); return; }
    const { error } = await supabase.rpc("cancel_order", { p_id: orderId, p_phone: phone });
    throwIf(error);
    await reload();
  };

  // len poradie cenníka (povolené aj sestre — RPC update_pricelist_order)
  const savePricelistOrder = async (list) => {
    if (!supabase) { setPricelist(list); return; }
    const payload = list.map((item, i) => ({ id: item.id, sort_order: i }));
    const { error } = await supabase.rpc("update_pricelist_order", { p_order: payload });
    throwIf(error);
    await reload();
  };

  // mesačná štatistika na odmeny: vykonané + zaplatené vyšetrenia.
  // Supabase: RPC (RLS obmedzí lekára na jeho riadky); demo: z localStorage.
  const getMonthlyStats = async (fromIso, toIso) => {
    if (!supabase) {
      const map = {};
      orders.forEach((o) => {
        if (o.status !== "done" || !o.paid) return;
        if (o.date < fromIso || o.date > toIso) return;
        const key = `${o.doctor}||${o.exam.typeId}`;
        map[key] = map[key] || { doctor: o.doctor || "", examTypeId: o.exam.typeId, count: 0, eur: 0 };
        map[key].count += 1;
        map[key].eur += o.price || 0;
      });
      return Object.values(map);
    }
    const { data, error } = await supabase.rpc("doctor_monthly_stats", { p_from: fromIso, p_to: toIso });
    throwIf(error);
    return (data || []).map((r) => ({
      doctor: r.doctor || "", examTypeId: r.exam_type_id,
      count: Number(r.done_paid_cnt), eur: Number(r.paid_eur),
    }));
  };

  // správa rolí (len superadmin; kontrolu vynucuje databázová funkcia)
  const listStaff = async () => {
    if (!supabase) return null; // demo režim správu používateľov nemá
    const { data, error } = await supabase.rpc("list_staff");
    throwIf(error);
    return (data || []).map((r) => ({ email: r.email, role: r.role || "", doctorName: r.doctor_name || "" }));
  };
  const setStaffRole = async (email, role, doctorName = "") => {
    if (!supabase) throw new Error("Správa používateľov funguje len v ostrej prevádzke (Supabase).");
    const { error } = await supabase.rpc("set_staff_role", { p_email: email, p_role: role, p_doctor_name: doctorName });
    throwIf(error);
  };
  const removeStaffRole = async (email) => {
    if (!supabase) throw new Error("Správa používateľov funguje len v ostrej prevádzke (Supabase).");
    const { error } = await supabase.rpc("remove_staff_role", { p_email: email });
    throwIf(error);
  };

  // kniha faktúr (číta ju len superadmin — v Supabase to vynucuje RLS)
  const listInvoices = async () => {
    if (!supabase) return loadJson(DEMO_INVOICES_KEY, []);
    const { data, error } = await supabase.from("invoices").select("*")
      .order("year", { ascending: false }).order("seq", { ascending: false });
    throwIf(error);
    return (data || []).map(invoiceFromRow);
  };

  // dovystavenie faktúr pre objednávky zaplatené pred vyplnením
  // fakturačných údajov (alebo pred nasadením fakturácie)
  const issueMissingInvoices = async () => {
    if (!supabase) {
      if (!invoiceSettingsReady(settings)) throw new Error("Najprv vyplňte fakturačné údaje v Nastaveniach.");
      const before = loadJson(DEMO_INVOICES_KEY, []).length;
      orders.forEach((o) => {
        if (!o.paid || !(o.price > 0)) return;
        demoIssueInvoice(o, "faktura", settings);
        if (o.status === "rejected") demoIssueInvoice(o, "dobropis", settings);
      });
      return loadJson(DEMO_INVOICES_KEY, []).length - before;
    }
    const { data, error } = await supabase.rpc("issue_missing_invoices");
    throwIf(error);
    return Number(data) || 0;
  };

  // ručné overenie platieb (RPC check_payments: spustí párovanie s bankou
  // a vráti stav všetkých aktívnych objednávok)
  const checkPayments = async () => {
    if (!supabase) throw new Error("Overenie platieb funguje len v ostrej prevádzke (Supabase + Fio).");
    const { data, error } = await supabase.rpc("check_payments");
    throwIf(error);
    await reload();
    return (data || []).map((r) => ({
      id: r.objednavka,
      patient: r.pacient,
      when: r.termin,
      price: Number(r.cena),
      vs: r.vs,
      paid: Boolean(r.zaplatene),
      payment: r.platba || "",
    }));
  };

  const pendingCount = orders.filter((o) => o.status === "new").length;

  // overenie telefónu SMS kódom — demo režim: pevný kód 123456
  const sendOtp = async (phone) => {
    if (!supabase) { sessionStorage.setItem("usgDemoOtp", "123456"); return { demoCode: "123456" }; }
    const { error } = await supabase.rpc("send_phone_otp", { p_phone: phone });
    throwIf(error);
    return {};
  };
  const verifyOtp = async (phone, code) => {
    if (!supabase) {
      if (String(code || "").trim() === sessionStorage.getItem("usgDemoOtp")) return { ok: true, token: "demo-token" };
      return { ok: false, error: "Nesprávny kód. Skúste znova." };
    }
    const { data, error } = await supabase.rpc("verify_phone_otp", { p_phone: phone, p_code: code });
    throwIf(error);
    return data && typeof data === "object" ? data : { ok: false, error: "Overenie zlyhalo." };
  };

  return {
    isSupabase: isSupabaseConfigured, loading, sendOtp, verifyOtp,
    orders, occupied, openSlots, settings, pricelist, pendingCount,
    addOrder, setStatus, setPaid, reschedule, changeDoctor, openWindow, closeSlot, closeDay,
    saveSettings, savePricelist, savePricelistOrder, getMonthlyStats,
    listStaff, setStaffRole, removeStaffRole, checkPayments,
    lookupOrder, cancelOrder, patientReschedule, openAttachment,
    listInvoices, issueMissingInvoices,
  };
}
