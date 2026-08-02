import { useState, useEffect, useCallback } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import { defaultSettings, toISODate, loadJson } from "./booking.jsx";

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

  return { isSupabase: isSupabaseConfigured, settings, payments, createPayment, markPaid, reload };
}

// ---------- B) CT OBJEDNÁVANIE ----------
export function useCtData(isStaff) {
  const [openSlots, setOpenSlots] = useState(() => (isSupabaseConfigured ? {} : loadJson(CT_SLOTS_KEY, {})));
  const [orders, setOrders] = useState(() => (isSupabaseConfigured ? [] : loadJson(CT_ORDERS_KEY, [])));
  const [occupiedRemote, setOccupiedRemote] = useState([]);

  const reload = useCallback(async () => {
    if (!supabase) { setOpenSlots(loadJson(CT_SLOTS_KEY, {})); setOrders(loadJson(CT_ORDERS_KEY, [])); return; }
    const slotsRes = await supabase.from("ct_open_slots").select("slot_date, slot_time, doctor");
    if (!slotsRes.error) setOpenSlots(groupSlots(slotsRes.data));
    if (isStaff) {
      const { data, error } = await supabase.from("ct_orders").select("*").order("slot_date").order("slot_time");
      if (!error) setOrders((data || []).map((r) => ({
        id: r.id, patientName: r.patient_name, phone: r.phone || "", email: r.email || "", reason: r.reason || "",
        date: r.slot_date, time: (r.slot_time || "").slice(0, 5), doctor: r.doctor || "", status: r.status,
      })));
    } else {
      const { data, error } = await supabase.rpc("ct_get_booked_slots");
      if (!error) setOccupiedRemote((data || []).map((r) => ({ date: r.slot_date, time: (r.slot_time || "").slice(0, 5) })));
    }
  }, [isStaff]);
  useEffect(() => { reload(); }, [reload]);

  const occupied = isSupabaseConfigured && !isStaff
    ? occupiedRemote
    : orders.filter((o) => o.status !== "rejected").map((o) => ({ date: o.date, time: o.time }));

  // personál otvorí CT termíny (jednotlivé začiatky, krok v minútach)
  const openWindow = async ({ dateFrom, dateTo, times, doctor = "" }) => {
    const days = [];
    const d = new Date(`${dateFrom}T12:00:00`); const end = new Date(`${dateTo}T12:00:00`);
    while (d <= end) { const dow = d.getDay(); if (dow !== 0 && dow !== 6) days.push(toISODate(d)); d.setDate(d.getDate() + 1); }
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

  const createOrder = async (order) => {
    if (!supabase) {
      const rec = { ...order, status: "new" };
      const list = [...loadJson(CT_ORDERS_KEY, []), rec];
      localStorage.setItem(CT_ORDERS_KEY, JSON.stringify(list)); setOrders(list); return order.id;
    }
    const { error } = await supabase.rpc("ct_create_order", {
      p_id: order.id, p_patient_name: order.patientName, p_birth_date: order.birthDate || null,
      p_insurance: order.insurance || "", p_phone: order.phone, p_email: order.email || "",
      p_reason: order.reason || "", p_slot_date: order.date, p_slot_time: order.time,
    });
    if (error) throw new Error(error.code === "23505" || error.code === "23P01" ? "Vybraný termín bol medzičasom obsadený. Vyberte iný." : error.message);
    await reload();
    return order.id;
  };

  const setStatus = async (id, status) => {
    if (!supabase) {
      const list = loadJson(CT_ORDERS_KEY, []).map((o) => (o.id === id ? { ...o, status } : o));
      localStorage.setItem(CT_ORDERS_KEY, JSON.stringify(list)); setOrders(list); return;
    }
    const patch = status === "rejected" ? { status, rejected_at: new Date().toISOString() } : { status };
    const { error } = await supabase.from("ct_orders").update(patch).eq("id", id);
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
    if (!supabase) { await setStatus(id, "rejected"); return; }
    const { error } = await supabase.rpc("ct_cancel_order", { p_id: id, p_phone: phone });
    if (error) throw new Error(error.message);
    await reload();
  };

  return { isSupabase: isSupabaseConfigured, openSlots, orders, occupied, openWindow, createOrder, setStatus, lookupOrder, cancelOrder, reload };
}
