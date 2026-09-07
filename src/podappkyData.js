import { useState, useEffect, useCallback } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import { defaultSettings, toISODate, loadJson, genSlots, normalizeDoctors } from "./booking.jsx";

// predvyplnené CT typy vyšetrení (demo aj prvé naplnenie)
export const defaultCtPricelist = [
  { id: "ct_hlava", label: "CT hlavy / mozgu", instructions: "Osobitná príprava nie je potrebná. Prineste si žiadanku a predchádzajúce nálezy.", durationSlots: 3 },
  { id: "ct_hrudnik", label: "CT hrudníka", instructions: "Prineste si žiadanku a predchádzajúce snímky.", durationSlots: 3 },
  { id: "ct_brucho", label: "CT brucha a malej panvy", instructions: "Príďte nalačno (min. 4 hodiny nejedzte). Prineste si žiadanku.", durationSlots: 4 },
  { id: "ct_angio", label: "CT angiografia", instructions: "Príďte nalačno. Prineste žiadanku, nálezy a hodnotu kreatinínu.", durationSlots: 4 },
  { id: "ct_chrbtica", label: "CT chrbtice", instructions: "Osobitná príprava nie je potrebná. Prineste si žiadanku.", durationSlots: 3 },
];

// predvyplnené typy návštev Angiologickej ambulancie č. 1
// description = krátky jednoriadkový popis (pacient pri výbere),
// instructions = pokyny/príprava (idú do potvrdzovacieho e-mailu a pripomienky)
export const defaultAngioPricelist = [
  { id: "ang_prve", label: "Prvé angiologické vyšetrenie", description: "Komplexné vyšetrenie ciev pri nových ťažkostiach", instructions: "Prineste si žiadanku, zoznam liekov a predchádzajúce nálezy (USG, CT, MR).", durationSlots: 6 },
  { id: "ang_kontrola", label: "Kontrolné angiologické vyšetrenie", description: "Kontrola u pacientov v našej starostlivosti", instructions: "Prineste si zoznam liekov a nové nálezy od poslednej kontroly.", durationSlots: 3 },
  { id: "ang_usg_dk", label: "USG ciev dolných končatín", description: "Ultrazvuk tepien a žíl nôh", instructions: "Osobitná príprava nie je potrebná. Prineste si žiadanku.", durationSlots: 4 },
  { id: "ang_usg_krk", label: "USG krčných ciev", description: "Ultrazvuk krčných tepien", instructions: "Osobitná príprava nie je potrebná. Prineste si žiadanku.", durationSlots: 4 },
  { id: "ang_konzult", label: "Konzultácia", description: "Konzultácia nálezov a ďalšieho postupu", instructions: "Prineste si dokumentáciu, ktorú chcete prekonzultovať.", durationSlots: 3 },
].map((p) => ({ ...p, requiresReferral: true }));

// Spoločné pokyny angio (jeden pokyn na riadok) — rovnaký text ako seed v angio-004.sql
export const DEFAULT_ANGIO_NOTES = [
  "Príďte 10 minút vopred s kartičkou poistenca a dokladom totožnosti.",
  "Zmena alebo zrušenie termínu: online, najneskôr 24 hodín vopred (tlačidlo v e-maili). Telefón/SMS len v naozaj nutných prípadoch – ozveme sa späť.",
  "Položky „po dohovore\" objednávame až po dohode s nami.",
  "Vyšetrenia nalačno dávame prednostne na ráno.",
  "Lieky na riedenie krvi nikdy nevysadzujte sami – o postupe rozhodneme spolu.",
  "Čas termínu je orientačný – ako pracovisko najvyššieho typu ho výnimočne posunieme pre akútny zákrok; o zmenách vás informujeme vopred.",
].join("\n");

// ============================================================
// Dátová vrstva pre pod-appky (oddelené od USG):
//   A) ad-hoc platby (adhoc_payments)
//   B) ambulancie bez poplatku — CT a Angiologická amb. č. 1
//      (jedna továreň useClinicData, dve konfigurácie)
// Nezasahuje do useBookingData ani do produkčných tabuliek.
// ============================================================

const ADHOC_KEY = "adhocPayments_v1";
export const CT_ORDERS_KEY = "ctOrders_v1";
export const ANGIO_ORDERS_KEY = "angioOrders_v1";
const DEMO_INVOICES_KEY = "usgInvoices_v1"; // spoločná demo kniha faktúr

const groupSlots = (rows) => {
  const map = {};
  (rows || []).forEach((r) => {
    (map[r.slot_date] = map[r.slot_date] || []).push({ time: (r.slot_time || "").slice(0, 5), doctor: r.doctor || "" });
  });
  Object.values(map).forEach((a) => a.sort((x, y) => x.time.localeCompare(y.time)));
  return map;
};

// spoločné načítanie nastavení (IBAN, príjemca) — pre QR
function useSharedSettings() {
  const [settings, setSettings] = useState(defaultSettings);
  useEffect(() => {
    if (!supabase) return;
    supabase.from("settings").select("key, value").then(({ data, error }) => {
      if (error || !data) return;
      const kv = Object.fromEntries(data.map((r) => [r.key, r.value]));
      setSettings((prev) => ({ ...prev, iban: kv.iban || prev.iban, beneficiary: kv.beneficiary || prev.beneficiary }));
    });
  }, []);
  return settings;
}

// ---------- A) AD-HOC PLATBY ----------
export function useAdhocData() {
  const settings = useSharedSettings();
  const [payments, setPayments] = useState(() => (isSupabaseConfigured ? [] : loadJson(ADHOC_KEY, [])));

  const reload = useCallback(async () => {
    if (!supabase) { setPayments(loadJson(ADHOC_KEY, [])); return; }
    const { data, error } = await supabase.from("adhoc_payments").select("*").order("created_at", { ascending: false });
    if (!error) setPayments((data || []).map((r) => ({
      id: r.id, itemName: r.item_name, amount: Number(r.amount), variableSymbol: r.variable_symbol,
      patientName: r.patient_name || "", email: r.email || "", paid: Boolean(r.paid),
      paidAt: r.paid_at || "", createdAt: r.created_at,
    })));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // vytvorí platbu, vráti { id, variableSymbol }
  const createPayment = async (itemName, amount, patientName, email) => {
    if (!supabase) {
      const id = "PAY-" + Math.random().toString(36).slice(2, 10).toUpperCase();
      const variableSymbol = String(Date.now()).slice(-10);
      const rec = { id, itemName, amount: Number(amount), variableSymbol, patientName, email, paid: false, createdAt: new Date().toISOString() };
      const list = [rec, ...loadJson(ADHOC_KEY, [])];
      localStorage.setItem(ADHOC_KEY, JSON.stringify(list));
      setPayments(list);
      return { id, variableSymbol };
    }
    const { data, error } = await supabase.rpc("create_adhoc_payment", {
      p_item_name: itemName, p_amount: Number(amount), p_patient_name: patientName || "", p_email: email || "",
    });
    if (error) throw new Error(error.message || "Platbu sa nepodarilo vytvoriť.");
    await reload();
    return { id: data.id, variableSymbol: data.variable_symbol };
  };

  // manuálne „platba prijatá" (test bez banky) — vystaví faktúru
  const markPaid = async (id) => {
    if (!supabase) {
      const list = loadJson(ADHOC_KEY, []).map((p) => (p.id === id ? { ...p, paid: true, paidAt: new Date().toISOString() } : p));
      localStorage.setItem(ADHOC_KEY, JSON.stringify(list));
      const p = list.find((x) => x.id === id);
      if (p) {
        const inv = loadJson(DEMO_INVOICES_KEY, []);
        if (!inv.some((i) => i.orderId === id)) {
          const year = new Date().getFullYear();
          const seq = inv.filter((i) => i.year === year).length + 1;
          inv.push({ number: `${year}/${String(seq).padStart(4, "0")}`, year, seq, kind: "faktura", relatedNumber: "",
            orderId: id, patientName: p.patientName, patientEmail: p.email, itemDesc: p.itemName, amount: p.amount,
            issueDate: toISODate(new Date()), deliveryDate: toISODate(new Date()), paymentDate: toISODate(new Date()),
            paymentVs: p.variableSymbol, taxable: false, supplier: {} });
          localStorage.setItem(DEMO_INVOICES_KEY, JSON.stringify(inv));
        }
      }
      setPayments(list);
      return;
    }
    const { error } = await supabase.rpc("mark_adhoc_paid", { p_id: id });
    if (error) throw new Error(error.message || "Platbu sa nepodarilo potvrdiť.");
    await reload();
  };

  // opätovné poslanie výzvy na úhradu pacientovi
  const resendEmail = async (id) => {
    if (!supabase) return; // demo: e-maily sa neposielajú
    const { error } = await supabase.rpc("resend_adhoc_email", { p_id: id });
    if (error) throw new Error(error.message || "E-mail sa nepodarilo poslať.");
  };

  return { isSupabase: isSupabaseConfigured, settings, payments, createPayment, markPaid, resendEmail, reload };
}

// ---------- B) AMBULANCIE BEZ POPLATKU — konfigurácie ----------
// Každá ambulancia má vlastné tabuľky, RPC, settings kľúč lekárov
// a demo localStorage kľúče; logika je spoločná (useClinicData).
const CT_CFG = {
  keys: { slots: "ctOpenSlots_v1", orders: CT_ORDERS_KEY, pricelist: "ctPricelist_v1", doctors: "ctDoctors_v1" },
  tables: { slots: "ct_open_slots", orders: "ct_orders", pricelist: "ct_pricelist" },
  rpc: { doctors: "public_ct_doctors", booked: "ct_get_booked_slots", create: "ct_create_order",
    reschedule: "ct_reschedule", lookup: "ct_lookup_order", cancel: "ct_cancel_order" },
  doctorsKey: "ct_doctors",
  defaultPricelist: defaultCtPricelist,
};

const ANGIO_CFG = {
  keys: { slots: "angioOpenSlots_v1", orders: ANGIO_ORDERS_KEY, pricelist: "angioPricelist_v1", doctors: "angioDoctors_v1", notes: "angioNotes_v1", smsVerify: "angioSmsVerify_v1" },
  tables: { slots: "angio_open_slots", orders: "angio_orders", pricelist: "angio_pricelist" },
  rpc: { doctors: "public_angio_doctors", booked: "angio_get_booked_slots", create: "angio_create_order",
    reschedule: "angio_reschedule", lookup: "angio_lookup_order", cancel: "angio_cancel_order",
    sendOtp: "angio_send_otp", verifyOtp: "angio_verify_otp", patientReschedule: "angio_patient_reschedule" },
  smsVerifyKey: "angio_sms_verify", // overenie telefónu SMS kódom (angio-005), 'on'/'off', verejne čitateľné
  doctorsKey: "angio_doctors",
  defaultPricelist: defaultAngioPricelist,
  extendedPricelist: true, // stĺpce angio_pricelist.description (angio-003) a requires_referral (angio-004)
  notesKey: "angio_common_notes", // spoločné pokyny v settings (angio-004), verejne čitateľné
  defaultNotes: DEFAULT_ANGIO_NOTES,
};

export function useCtData(isStaff) { return useClinicData(CT_CFG, isStaff); }
export function useAngioData(isStaff) { return useClinicData(ANGIO_CFG, isStaff); }

// ---------- spoločná dátová vrstva ambulancie (plná vetva ako USG) ----------
function useClinicData(cfg, isStaff) {
  const K = cfg.keys, T = cfg.tables, R = cfg.rpc;
  const [openSlots, setOpenSlots] = useState(() => (isSupabaseConfigured ? {} : loadJson(K.slots, {})));
  const [orders, setOrders] = useState(() => (isSupabaseConfigured ? [] : loadJson(K.orders, [])));
  const [occupiedRemote, setOccupiedRemote] = useState([]);
  const [pricelist, setPricelist] = useState(() => (isSupabaseConfigured ? cfg.defaultPricelist : loadJson(K.pricelist, cfg.defaultPricelist)));
  const [doctors, setDoctors] = useState(() => (isSupabaseConfigured ? [] : normalizeDoctors(loadJson(K.doctors, []))));
  // spoločné pokyny pre pacientov (len ambulancie s cfg.notesKey)
  const loadNotesDemo = () => { const v = localStorage.getItem(K.notes || ""); return v == null ? (cfg.defaultNotes || "") : v; };
  const [notes, setNotes] = useState(() => (!cfg.notesKey ? "" : isSupabaseConfigured ? "" : loadNotesDemo()));
  // overenie telefónu SMS kódom — demo: localStorage 'on'/'off' (predvolene vypnuté)
  const loadSmsVerifyDemo = () => localStorage.getItem(K.smsVerify || "") === "on";
  const [smsVerify, setSmsVerify] = useState(() => (!cfg.smsVerifyKey || isSupabaseConfigured ? false : loadSmsVerifyDemo()));

  const reload = useCallback(async () => {
    if (!supabase) {
      setOpenSlots(loadJson(K.slots, {})); setOrders(loadJson(K.orders, []));
      setPricelist(loadJson(K.pricelist, cfg.defaultPricelist));
      setDoctors(normalizeDoctors(loadJson(K.doctors, [])));
      if (cfg.notesKey) setNotes(loadNotesDemo());
      if (cfg.smsVerifyKey) setSmsVerify(loadSmsVerifyDemo());
      return;
    }
    if (cfg.notesKey || cfg.smsVerifyKey) {
      // kľúče sú vo verejnom whiteliste settings (angio-004/005) — číta aj pacient bez prihlásenia
      const keys = [cfg.notesKey, cfg.smsVerifyKey].filter(Boolean);
      const { data, error } = await supabase.from("settings").select("key, value").in("key", keys);
      if (!error) {
        const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
        if (cfg.notesKey) setNotes(!(cfg.notesKey in m) ? (cfg.defaultNotes || "") : (m[cfg.notesKey] || ""));
        if (cfg.smsVerifyKey) setSmsVerify(m[cfg.smsVerifyKey] === "on");
      }
    }
    const [slotsRes, priceRes] = await Promise.all([
      supabase.from(T.slots).select("slot_date, slot_time, doctor"),
      supabase.from(T.pricelist).select("*").eq("active", true).order("sort_order"),
    ]);
    if (!slotsRes.error) setOpenSlots(groupSlots(slotsRes.data));
    if (!priceRes.error && priceRes.data.length > 0) setPricelist(priceRes.data.map((r) => ({
      id: r.id, label: r.label, description: r.description || "", about: r.about || "", instructions: r.instructions || "",
      requiresReferral: r.requires_referral !== false, // CT stĺpec nemá → vždy true
      durationSlots: Math.max(1, Number(r.duration_slots) || 3),
    })));
    // lekári: personál z settings (aj s e-mailmi), pacient cez public RPC bez e-mailov
    if (isStaff) {
      const { data } = await supabase.from("settings").select("value").eq("key", cfg.doctorsKey).maybeSingle();
      let list = []; try { list = JSON.parse(data?.value || "[]"); } catch { list = []; }
      setDoctors(normalizeDoctors(list));
    } else {
      const { data } = await supabase.rpc(R.doctors);
      setDoctors(normalizeDoctors(Array.isArray(data) ? data : []));
    }
    if (isStaff) {
      const { data, error } = await supabase.from(T.orders).select("*").order("slot_date").order("slot_time");
      if (!error) setOrders((data || []).map((r) => ({
        id: r.id, patientName: r.patient_name, birthDate: r.birth_date || "", insurance: r.insurance || "",
        phone: r.phone || "", email: r.email || "", reason: r.reason || "",
        exam: { typeId: r.exam_type_id || "", label: r.exam_label || "" },
        date: r.slot_date, time: (r.slot_time || "").slice(0, 5), doctor: r.doctor || "", status: r.status,
        statusNote: r.status_note || "", durationMin: r.duration_min == null ? 15 : Number(r.duration_min),
        rejectedAt: r.rejected_at || "",
        arrivedAt: r.arrived_at || "",
        createdAt: r.created_at || "",
        attachments: Array.isArray(r.attachments) ? r.attachments : [],
      })));
    } else {
      const { data, error } = await supabase.rpc(R.booked);
      if (!error) setOccupiedRemote((data || []).map((r) => ({ date: r.slot_date, time: (r.slot_time || "").slice(0, 5) })));
    }
  }, [isStaff, cfg]);
  useEffect(() => { reload(); }, [reload]);

  // obsadené 5-min bunky (rozvinuté podľa trvania) — pre pacientsky kalendár
  const expandCells = (o) => {
    const [h, m] = (o.time || "00:00").split(":").map(Number);
    const n = Math.max(1, Math.round((o.durationMin || 15) / 5));
    return Array.from({ length: n }, (_, i) => {
      const t = h * 60 + m + i * 5;
      return { date: o.date, time: `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` };
    });
  };
  const occupied = isSupabaseConfigured && !isStaff
    ? occupiedRemote
    : orders.filter((o) => o.status !== "rejected").flatMap(expandCells);

  // personál otvorí termíny (5-min mriežka ako USG)
  const openWindow = async ({ dateFrom, dateTo, timeFrom, timeTo, doctor = "", skipWeekends = true }) => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) throw new Error("Zadajte platný rozsah dní — „deň do“ nesmie byť pred „deň od“.");
    const align5 = (t) => {
      const [h, m] = String(t || "").split(":").map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return t;
      const tot = Math.round((h * 60 + m) / 5) * 5;
      return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
    };
    const times = genSlots(align5(timeFrom), align5(timeTo), 5);
    if (times.length === 0) throw new Error("Zadajte platné časové okno — „čas do“ musí byť neskôr ako „čas od“.");
    const days = [];
    const d = new Date(`${dateFrom}T12:00:00`); const end = new Date(`${dateTo}T12:00:00`);
    while (d <= end) { const dow = d.getDay(); if (!skipWeekends || (dow !== 0 && dow !== 6)) days.push(toISODate(d)); d.setDate(d.getDate() + 1); }
    if (!supabase) {
      const next = { ...loadJson(K.slots, {}) };
      days.forEach((iso) => {
        const byTime = new Map((next[iso] || []).map((s) => [s.time, s]));
        times.forEach((t) => { if (!byTime.has(t)) byTime.set(t, { time: t, doctor }); });
        next[iso] = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
      });
      localStorage.setItem(K.slots, JSON.stringify(next)); setOpenSlots(next); return;
    }
    const rows = [];
    days.forEach((iso) => times.forEach((t) => rows.push({ slot_date: iso, slot_time: t, doctor })));
    const { error } = await supabase.from(T.slots).upsert(rows, { onConflict: "slot_date,slot_time", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    await reload();
  };

  const closeSlot = async (date, time) => {
    if (!supabase) {
      const next = { ...loadJson(K.slots, {}) };
      next[date] = (next[date] || []).filter((s) => s.time !== time);
      localStorage.setItem(K.slots, JSON.stringify(next)); setOpenSlots(next); return;
    }
    const { error } = await supabase.from(T.slots).delete().eq("slot_date", date).eq("slot_time", time);
    if (error) throw new Error(error.message);
    await reload();
  };

  const readAsDataUrl = (file) => new Promise((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error("Súbor sa nepodarilo načítať.")); r.readAsDataURL(file);
  });

  const createOrder = async (order, files = []) => {
    if (!supabase) {
      if (cfg.smsVerifyKey && loadSmsVerifyDemo() && !isStaff && order.verifyToken !== "demo-token") {
        throw new Error("Telefónne číslo nie je overené. Nechajte si poslať SMS kód a zadajte ho.");
      }
      const item = (loadJson(K.pricelist, cfg.defaultPricelist)).find((p) => p.id === order.examTypeId);
      const attachments = [];
      for (const f of files) {
        if (f.size > 5 * 1024 * 1024) throw new Error(`Súbor ${f.name}: v demo režime je maximum 5 MB.`);
        attachments.push({ name: f.name, dataUrl: await readAsDataUrl(f) });
      }
      const rec = { ...order, status: "new", exam: { typeId: order.examTypeId, label: item?.label || "" },
        durationMin: (item?.durationSlots || 3) * 5, attachments, createdAt: new Date().toISOString() };
      const list = [...loadJson(K.orders, []), rec];
      localStorage.setItem(K.orders, JSON.stringify(list)); setOrders(list); return order.id;
    }
    // nahratie príloh do spoločného storage bucketu 'prilohy' (cesta = <ID objednávky>/)
    const attachments = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const safe = f.name.replace(/[^\w.\-]+/g, "_").slice(-80);
      const path = `${order.id}/${i}-${safe}`;
      const { error: upErr } = await supabase.storage.from("prilohy").upload(path, f, { contentType: f.type || undefined });
      if (upErr) throw new Error(`Prílohu ${f.name} sa nepodarilo nahrať: ${upErr.message}`);
      attachments.push({ name: f.name, path });
    }
    const { error } = await supabase.rpc(R.create, {
      p_id: order.id, p_exam_type_id: order.examTypeId, p_patient_name: order.patientName, p_birth_date: order.birthDate || null,
      p_insurance: order.insurance || "", p_phone: order.phone, p_email: order.email || "",
      p_reason: order.reason || "", p_slot_date: order.date, p_slot_time: order.time, p_attachments: attachments,
      // p_verify_token existuje až po angio-005 — posiela sa len keď je overovanie zapnuté
      ...(cfg.smsVerifyKey && smsVerify ? { p_verify_token: order.verifyToken || null } : {}),
    });
    if (error) throw new Error(error.code === "23505" || error.code === "23P01" ? "Vybraný termín bol medzičasom obsadený. Vyberte iný." : error.message);
    await reload();
    return order.id;
  };

  const openAttachment = async (att) => {
    if (att?.dataUrl) { const a = document.createElement("a"); a.href = att.dataUrl; a.download = att.name || "priloha"; a.click(); return; }
    if (att?.path && supabase) {
      const { data, error } = await supabase.storage.from("prilohy").createSignedUrl(att.path, 300);
      if (error) throw new Error(error.message);
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    }
  };

  const setStatus = async (id, status, statusNote = "") => {
    if (!supabase) {
      const list = loadJson(K.orders, []).map((o) => (o.id === id
        ? { ...o, status, statusNote, rejectedAt: status === "rejected" ? new Date().toISOString() : "" } : o));
      localStorage.setItem(K.orders, JSON.stringify(list)); setOrders(list); return;
    }
    const { error } = await supabase.from(T.orders).update({ status, status_note: statusNote }).eq("id", id);
    if (error) throw new Error(error.message);
    await reload();
  };

  const reschedule = async (id, date, time) => {
    if (!supabase) {
      const list = loadJson(K.orders, []).map((o) => (o.id === id ? { ...o, date, time, statusNote: "Presunuté pracoviskom" } : o));
      localStorage.setItem(K.orders, JSON.stringify(list)); setOrders(list); return;
    }
    const { error } = await supabase.rpc(R.reschedule, { p_id: id, p_slot_date: date, p_slot_time: time });
    if (error) throw new Error(error.message);
    await reload();
  };

  const savePricelist = async (list) => {
    if (!supabase) { localStorage.setItem(K.pricelist, JSON.stringify(list)); setPricelist(list); return; }
    const rows = list.map((it, i) => ({ id: it.id, label: it.label, instructions: it.instructions || "",
      ...(cfg.extendedPricelist ? { description: it.description || "", about: it.about || "", requires_referral: it.requiresReferral !== false } : {}),
      duration_slots: Math.max(1, it.durationSlots || 3), active: true, sort_order: i }));
    const { error } = await supabase.from(T.pricelist).upsert(rows, { onConflict: "id" });
    if (error) throw new Error(error.message);
    if (rows.length > 0) {
      const ids = rows.map((r) => `"${r.id}"`).join(",");
      await supabase.from(T.pricelist).update({ active: false }).not("id", "in", `(${ids})`);
    }
    await reload();
  };

  const saveDoctors = async (list) => {
    if (!supabase) { localStorage.setItem(K.doctors, JSON.stringify(list)); setDoctors(normalizeDoctors(list)); return; }
    const { error } = await supabase.from("settings").upsert([{ key: cfg.doctorsKey, value: JSON.stringify(list || []) }], { onConflict: "key" });
    if (error) throw new Error(error.message);
    await reload();
  };

  const saveNotes = async (text) => {
    if (!cfg.notesKey) return;
    const value = String(text || "");
    if (!supabase) { localStorage.setItem(K.notes, value); setNotes(value); return; }
    const { error } = await supabase.from("settings").upsert([{ key: cfg.notesKey, value }], { onConflict: "key" });
    if (error) throw new Error(error.message);
    await reload();
  };

  const saveSmsVerify = async (on) => {
    if (!cfg.smsVerifyKey) return;
    const value = on ? "on" : "off";
    if (!supabase) { localStorage.setItem(K.smsVerify, value); setSmsVerify(on); return; }
    const { error } = await supabase.from("settings").upsert([{ key: cfg.smsVerifyKey, value }], { onConflict: "key" });
    if (error) throw new Error(error.message);
    await reload();
  };

  // OTP: demo režim používa pevný kód 123456 a token "demo-token"
  const sendOtp = async (phone) => {
    if (!supabase) { sessionStorage.setItem("angioDemoOtp", "123456"); return { demoCode: "123456" }; }
    const { error } = await supabase.rpc(R.sendOtp, { p_phone: phone });
    if (error) throw new Error(error.message);
    return {};
  };
  const verifyOtp = async (phone, code) => {
    if (!supabase) {
      if (String(code || "").trim() === sessionStorage.getItem("angioDemoOtp")) return { ok: true, token: "demo-token" };
      return { ok: false, error: "Nesprávny kód. Skúste znova." };
    }
    const { data, error } = await supabase.rpc(R.verifyOtp, { p_phone: phone, p_code: code });
    if (error) throw new Error(error.message);
    return data && typeof data === "object" ? data : { ok: false, error: "Overenie zlyhalo." };
  };

  const lookupOrder = async (id, phone) => {
    const digits = (phone || "").replace(/\D/g, "");
    if (!id || digits.length < 9) return null;
    if (!supabase) {
      const o = orders.find((x) => x.id.toUpperCase() === id.toUpperCase() && x.phone.replace(/\D/g, "").slice(-9) === digits.slice(-9));
      return o || null;
    }
    const { data, error } = await supabase.rpc(R.lookup, { p_id: id, p_phone: phone });
    if (error) throw new Error(error.message);
    return data ? { id: data.id, status: data.status, date: data.slot_date, time: (data.slot_time || "").slice(0, 5), doctor: data.doctor || "",
      exam: { typeId: data.exam_type_id || "", label: data.exam_label || "" }, durationMin: Number(data.duration_min) || 15 } : null;
  };

  // zmena termínu pacientom (číslo objednávky + telefón) — angio-007; potvrdená → nová
  const patientReschedule = async (id, phone, date, time) => {
    const digits = (phone || "").replace(/\D/g, "").slice(-9);
    if (!supabase) {
      const list = loadJson(K.orders, []);
      const i = list.findIndex((x) => x.id.toUpperCase() === String(id).toUpperCase() && x.phone.replace(/\D/g, "").slice(-9) === digits);
      if (i < 0) throw new Error("Objednávku sme nenašli. Skontrolujte číslo a telefón.");
      if (!["new", "confirmed"].includes(list[i].status)) throw new Error("Túto objednávku už nie je možné meniť.");
      if (new Date(`${list[i].date}T${list[i].time}:00`) - Date.now() < 24 * 3600 * 1000) throw new Error("Termín možno online zmeniť najneskôr 24 hodín vopred. V naozaj nutnom prípade nám napíšte SMS na 0949 000 677 (uveďte číslo objednávky) – ozveme sa vám späť.");
      list[i] = { ...list[i], date, time, status: "new", statusNote: `Termín zmenil pacient (pôvodne ${list[i].date} ${list[i].time})` };
      localStorage.setItem(K.orders, JSON.stringify(list)); setOrders(list); return;
    }
    const { error } = await supabase.rpc(R.patientReschedule, { p_id: id, p_phone: phone, p_slot_date: date, p_slot_time: time });
    if (error) throw new Error(error.message);
    await reload();
  };

  const cancelOrder = async (id, phone) => {
    if (!supabase) { await setStatus(id, "rejected", "Zrušené pacientom"); return; }
    const { error } = await supabase.rpc(R.cancel, { p_id: id, p_phone: phone });
    if (error) throw new Error(error.message);
    await reload();
  };

  const pendingCount = orders.filter((o) => o.status === "new").length;

  return {
    isSupabase: isSupabaseConfigured, openSlots, orders, occupied, pricelist, doctors, notes, smsVerify, pendingCount,
    openWindow, closeSlot, createOrder, setStatus, reschedule, savePricelist, saveDoctors, saveNotes,
    saveSmsVerify, sendOtp, verifyOtp, patientReschedule,
    lookupOrder, cancelOrder, openAttachment, reload,
  };
}
