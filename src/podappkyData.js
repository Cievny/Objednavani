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

// ============================================================
// Dátová vrstva pre TESTOVACIE pod-appky (oddelené od USG):
//   A) ad-hoc platby (adhoc_payments)
//   B) CT objednávanie (ct_open_slots, ct_orders)
// Nezasahuje do useBookingData ani do produkčných tabuliek.
// ============================================================

const ADHOC_KEY = "adhocPayments_v1";
const CT_ORDERS_KEY = "ctOrders_v1";
const CT_SLOTS_KEY = "ctOpenSlots_v1";
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

// ---------- B) CT OBJEDNÁVANIE (plná vetva ako USG) ----------
const CT_PRICELIST_KEY = "ctPricelist_v1";
const CT_DOCTORS_KEY = "ctDoctors_v1";

export function useCtData(isStaff) {
  const [openSlots, setOpenSlots] = useState(() => (isSupabaseConfigured ? {} : loadJson(CT_SLOTS_KEY, {})));
  const [orders, setOrders] = useState(() => (isSupabaseConfigured ? [] : loadJson(CT_ORDERS_KEY, [])));
  const [occupiedRemote, setOccupiedRemote] = useState([]);
  const [pricelist, setPricelist] = useState(() => (isSupabaseConfigured ? defaultCtPricelist : loadJson(CT_PRICELIST_KEY, defaultCtPricelist)));
  const [doctors, setDoctors] = useState(() => (isSupabaseConfigured ? [] : normalizeDoctors(loadJson(CT_DOCTORS_KEY, []))));

  const reload = useCallback(async () => {
    if (!supabase) {
      setOpenSlots(loadJson(CT_SLOTS_KEY, {})); setOrders(loadJson(CT_ORDERS_KEY, []));
      setPricelist(loadJson(CT_PRICELIST_KEY, defaultCtPricelist));
      setDoctors(normalizeDoctors(loadJson(CT_DOCTORS_KEY, [])));
      return;
    }
    const [slotsRes, priceRes] = await Promise.all([
      supabase.from("ct_open_slots").select("slot_date, slot_time, doctor"),
      supabase.from("ct_pricelist").select("*").eq("active", true).order("sort_order"),
    ]);
    if (!slotsRes.error) setOpenSlots(groupSlots(slotsRes.data));
    if (!priceRes.error && priceRes.data.length > 0) setPricelist(priceRes.data.map((r) => ({
      id: r.id, label: r.label, instructions: r.instructions || "", durationSlots: Math.max(1, Number(r.duration_slots) || 3),
    })));
    // CT lekári: personál z settings.ct_doctors (aj s e-mailmi), pacient cez public_ct_doctors bez e-mailov
    if (isStaff) {
      const { data } = await supabase.from("settings").select("value").eq("key", "ct_doctors").maybeSingle();
      let list = []; try { list = JSON.parse(data?.value || "[]"); } catch { list = []; }
      setDoctors(normalizeDoctors(list));
    } else {
      const { data } = await supabase.rpc("public_ct_doctors");
      setDoctors(normalizeDoctors(Array.isArray(data) ? data : []));
    }
    if (isStaff) {
      const { data, error } = await supabase.from("ct_orders").select("*").order("slot_date").order("slot_time");
      if (!error) setOrders((data || []).map((r) => ({
        id: r.id, patientName: r.patient_name, birthDate: r.birth_date || "", insurance: r.insurance || "",
        phone: r.phone || "", email: r.email || "", reason: r.reason || "",
        exam: { typeId: r.exam_type_id || "", label: r.exam_label || "" },
        date: r.slot_date, time: (r.slot_time || "").slice(0, 5), doctor: r.doctor || "", status: r.status,
        statusNote: r.status_note || "", durationMin: r.duration_min == null ? 15 : Number(r.duration_min),
        rejectedAt: r.rejected_at || "",
      })));
    } else {
      const { data, error } = await supabase.rpc("ct_get_booked_slots");
      if (!error) setOccupiedRemote((data || []).map((r) => ({ date: r.slot_date, time: (r.slot_time || "").slice(0, 5) })));
    }
  }, [isStaff]);
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

  // personál otvorí CT termíny (5-min mriežka ako USG)
  const openWindow = async ({ dateFrom, dateTo, timeFrom, timeTo, doctor = "", skipWeekends = true }) => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return;
    const times = genSlots(timeFrom, timeTo, 5);
    if (times.length === 0) return;
    const days = [];
    const d = new Date(`${dateFrom}T12:00:00`); const end = new Date(`${dateTo}T12:00:00`);
    while (d <= end) { const dow = d.getDay(); if (!skipWeekends || (dow !== 0 && dow !== 6)) days.push(toISODate(d)); d.setDate(d.getDate() + 1); }
    if (!supabase) {
      const next = { ...loadJson(CT_SLOTS_KEY, {}) };
      days.forEach((iso) => {
        const byTime = new Map((next[iso] || []).map((s) => [s.time, s]));
        times.forEach((t) => { if (!byTime.has(t)) byTime.set(t, { time: t, doctor }); });
        next[iso] = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
      });
      localStorage.setItem(CT_SLOTS_KEY, JSON.stringify(next)); setOpenSlots(next); return;
    }
    const rows = [];
    days.forEach((iso) => times.forEach((t) => rows.push({ slot_date: iso, slot_time: t, doctor })));
    const { error } = await supabase.from("ct_open_slots").upsert(rows, { onConflict: "slot_date,slot_time", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    await reload();
  };

  const closeSlot = async (date, time) => {
    if (!supabase) {
      const next = { ...loadJson(CT_SLOTS_KEY, {}) };
      next[date] = (next[date] || []).filter((s) => s.time !== time);
      localStorage.setItem(CT_SLOTS_KEY, JSON.stringify(next)); setOpenSlots(next); return;
    }
    const { error } = await supabase.from("ct_open_slots").delete().eq("slot_date", date).eq("slot_time", time);
    if (error) throw new Error(error.message);
    await reload();
  };

  const createOrder = async (order) => {
    if (!supabase) {
      const item = (loadJson(CT_PRICELIST_KEY, defaultCtPricelist)).find((p) => p.id === order.examTypeId);
      const rec = { ...order, status: "new", exam: { typeId: order.examTypeId, label: item?.label || "" },
        durationMin: (item?.durationSlots || 3) * 5 };
      const list = [...loadJson(CT_ORDERS_KEY, []), rec];
      localStorage.setItem(CT_ORDERS_KEY, JSON.stringify(list)); setOrders(list); return order.id;
    }
    const { error } = await supabase.rpc("ct_create_order", {
      p_id: order.id, p_exam_type_id: order.examTypeId, p_patient_name: order.patientName, p_birth_date: order.birthDate || null,
      p_insurance: order.insurance || "", p_phone: order.phone, p_email: order.email || "",
      p_reason: order.reason || "", p_slot_date: order.date, p_slot_time: order.time,
    });
    if (error) throw new Error(error.code === "23505" || error.code === "23P01" ? "Vybraný termín bol medzičasom obsadený. Vyberte iný." : error.message);
    await reload();
    return order.id;
  };

  const setStatus = async (id, status, statusNote = "") => {
    if (!supabase) {
      const list = loadJson(CT_ORDERS_KEY, []).map((o) => (o.id === id
        ? { ...o, status, statusNote, rejectedAt: status === "rejected" ? new Date().toISOString() : "" } : o));
      localStorage.setItem(CT_ORDERS_KEY, JSON.stringify(list)); setOrders(list); return;
    }
    const { error } = await supabase.from("ct_orders").update({ status, status_note: statusNote }).eq("id", id);
    if (error) throw new Error(error.message);
    await reload();
  };

  const reschedule = async (id, date, time) => {
    if (!supabase) {
      const list = loadJson(CT_ORDERS_KEY, []).map((o) => (o.id === id ? { ...o, date, time, statusNote: "Presunuté pracoviskom" } : o));
      localStorage.setItem(CT_ORDERS_KEY, JSON.stringify(list)); setOrders(list); return;
    }
    const { error } = await supabase.rpc("ct_reschedule", { p_id: id, p_slot_date: date, p_slot_time: time });
    if (error) throw new Error(error.message);
    await reload();
  };

  const savePricelist = async (list) => {
    if (!supabase) { localStorage.setItem(CT_PRICELIST_KEY, JSON.stringify(list)); setPricelist(list); return; }
    const rows = list.map((it, i) => ({ id: it.id, label: it.label, instructions: it.instructions || "",
      duration_slots: Math.max(1, it.durationSlots || 3), active: true, sort_order: i }));
    const { error } = await supabase.from("ct_pricelist").upsert(rows, { onConflict: "id" });
    if (error) throw new Error(error.message);
    if (rows.length > 0) {
      const ids = rows.map((r) => `"${r.id}"`).join(",");
      await supabase.from("ct_pricelist").update({ active: false }).not("id", "in", `(${ids})`);
    }
    await reload();
  };

  const saveDoctors = async (list) => {
    if (!supabase) { localStorage.setItem(CT_DOCTORS_KEY, JSON.stringify(list)); setDoctors(normalizeDoctors(list)); return; }
    const { error } = await supabase.from("settings").upsert([{ key: "ct_doctors", value: JSON.stringify(list || []) }], { onConflict: "key" });
    if (error) throw new Error(error.message);
    await reload();
  };

  const lookupOrder = async (id, phone) => {
    const digits = (phone || "").replace(/\D/g, "");
    if (!id || digits.length < 9) return null;
    if (!supabase) {
      const o = orders.find((x) => x.id.toUpperCase() === id.toUpperCase() && x.phone.replace(/\D/g, "").slice(-9) === digits.slice(-9));
      return o || null;
    }
    const { data, error } = await supabase.rpc("ct_lookup_order", { p_id: id, p_phone: phone });
    if (error) throw new Error(error.message);
    return data ? { id: data.id, status: data.status, date: data.slot_date, time: (data.slot_time || "").slice(0, 5), doctor: data.doctor || "" } : null;
  };

  const cancelOrder = async (id, phone) => {
    if (!supabase) { await setStatus(id, "rejected", "Zrušené pacientom"); return; }
    const { error } = await supabase.rpc("ct_cancel_order", { p_id: id, p_phone: phone });
    if (error) throw new Error(error.message);
    await reload();
  };

  const pendingCount = orders.filter((o) => o.status === "new").length;

  return {
    isSupabase: isSupabaseConfigured, openSlots, orders, occupied, pricelist, doctors, pendingCount,
    openWindow, closeSlot, createOrder, setStatus, reschedule, savePricelist, saveDoctors,
    lookupOrder, cancelOrder, reload,
  };
}
