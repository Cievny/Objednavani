import { useState, useEffect, useCallback } from "react";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import {
  defaultSettings, defaultPricelist, normalizePricelist,
  allDaySlots, isSlotOccupying, toISODate, loadJson,
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
});

const lookupFromJson = (j) => j && ({
  id: j.id,
  status: j.status,
  statusNote: j.status_note || "",
  hasReferral: j.has_referral,
  exam: { label: j.exam_label },
  price: j.price == null ? null : Number(j.price),
  date: j.slot_date,
  time: (j.slot_time || "").slice(0, 5),
});

const pricelistFromRows = (rows) =>
  rows.map((r) => ({
    id: r.id,
    label: r.label,
    priceSelf: Number(r.price_self),
    priceReferral: r.price_referral == null ? null : Number(r.price_referral),
  }));

const groupSlots = (rows) => {
  const map = {};
  rows.forEach((r) => {
    const t = r.slot_time.slice(0, 5);
    (map[r.slot_date] = map[r.slot_date] || []).push(t);
  });
  Object.values(map).forEach((arr) => arr.sort());
  return map;
};

const friendlyDbError = (error) => {
  if (!error) return null;
  if (error.code === "23505") return new Error("Vybraný termín bol medzičasom obsadený. Vyberte iný.");
  return new Error(error.message || "Operácia zlyhala. Skúste to znova.");
};

const throwIf = (error) => { const e = friendlyDbError(error); if (e) throw e; };

// --- prihlásenie personálu (Supabase Auth) ---

export function useAuth() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error("Nesprávny e-mail alebo heslo.");
  };
  const signOut = () => supabase?.auth.signOut();

  return { isSupabase: isSupabaseConfigured, session, ready, signIn, signOut };
}

// --- hlavný hook s dátami a akciami ---

export function useBookingData(isStaff) {
  const [orders, setOrders] = useState(() => (isSupabaseConfigured ? [] : loadJson(USG_ORDERS_KEY, [])));
  const [occupiedRemote, setOccupiedRemote] = useState([]);
  const [openSlots, setOpenSlots] = useState(() => (isSupabaseConfigured ? {} : loadJson(USG_OPEN_SLOTS_KEY, {})));
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
      supabase.from("open_slots").select("slot_date, slot_time"),
      supabase.from("pricelist").select("*").eq("active", true).order("sort_order"),
      supabase.from("settings").select("key, value"),
    ]);
    if (!slotsRes.error) setOpenSlots(groupSlots(slotsRes.data));
    if (!priceRes.error && priceRes.data.length > 0) setPricelist(pricelistFromRows(priceRes.data));
    if (!settingsRes.error && settingsRes.data.length > 0) {
      const kv = Object.fromEntries(settingsRes.data.map((r) => [r.key, r.value]));
      setSettings({ iban: kv.iban || defaultSettings.iban, beneficiary: kv.beneficiary || defaultSettings.beneficiary });
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

  // obsadené termíny pre pacientsky kalendár
  const occupied = isSupabaseConfigured && !isStaff
    ? occupiedRemote
    : orders.filter(isSlotOccupying).map((o) => ({ date: o.date, time: o.time }));

  // --- akcie ---

  const addOrder = async (order) => {
    if (!supabase) { setOrders((prev) => [...prev, order]); return; }
    const { error } = await supabase.rpc("create_order", {
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
    });
    throwIf(error);
    await reload();
  };

  const setStatus = async (orderId, status, statusNote = "") => {
    if (!supabase) {
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status, statusNote } : o)));
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
    const prev = orders.find((o) => o.id === orderId);
    const { error } = await supabase.from("orders")
      .update({ slot_date: date, slot_time: time, status_note: prev ? `Presunuté z ${prev.date} ${prev.time}` : "Presunuté" })
      .eq("id", orderId);
    throwIf(error);
    await reload();
  };

  const toggleSlot = async (date, slot) => {
    if (!supabase) {
      setOpenSlots((prev) => {
        const day = prev[date] || [];
        const next = day.includes(slot) ? day.filter((t) => t !== slot) : [...day, slot].sort();
        return { ...prev, [date]: next };
      });
      return;
    }
    const isOpen = (openSlots[date] || []).includes(slot);
    const { error } = isOpen
      ? await supabase.from("open_slots").delete().eq("slot_date", date).eq("slot_time", slot)
      : await supabase.from("open_slots").insert({ slot_date: date, slot_time: slot });
    throwIf(error);
    await reload();
  };

  const upsertSlots = async (rows) => {
    const { error } = await supabase.from("open_slots").upsert(rows, { onConflict: "slot_date,slot_time", ignoreDuplicates: true });
    throwIf(error);
    await reload();
  };

  const openDay = async (date) => {
    if (!supabase) { setOpenSlots((prev) => ({ ...prev, [date]: [...allDaySlots] })); return; }
    await upsertSlots(allDaySlots.map((t) => ({ slot_date: date, slot_time: t })));
  };

  const openRange = async (from, to) => {
    if (!from || !to || from > to) return;
    if (!supabase) {
      setOpenSlots((prev) => {
        const next = { ...prev };
        const d = new Date(`${from}T12:00:00`);
        const end = new Date(`${to}T12:00:00`);
        while (d <= end) {
          const day = d.getDay();
          if (day !== 0 && day !== 6) next[toISODate(d)] = [...allDaySlots];
          d.setDate(d.getDate() + 1);
        }
        return next;
      });
      return;
    }
    const rows = [];
    const d = new Date(`${from}T12:00:00`);
    const end = new Date(`${to}T12:00:00`);
    while (d <= end) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) {
        const iso = toISODate(d);
        allDaySlots.forEach((t) => rows.push({ slot_date: iso, slot_time: t }));
      }
      d.setDate(d.getDate() + 1);
    }
    if (rows.length > 0) await upsertSlots(rows);
  };

  const closeDay = async (date) => {
    const bookedTimes = new Set(orders.filter((o) => o.date === date && isSlotOccupying(o)).map((o) => o.time));
    if (!supabase) {
      setOpenSlots((prev) => ({ ...prev, [date]: (prev[date] || []).filter((t) => bookedTimes.has(t)) }));
      return;
    }
    const freeTimes = (openSlots[date] || []).filter((t) => !bookedTimes.has(t));
    if (freeTimes.length === 0) return;
    const { error } = await supabase.from("open_slots").delete().eq("slot_date", date).in("slot_time", freeTimes);
    throwIf(error);
    await reload();
  };

  const saveSettings = async (next) => {
    if (!supabase) { setSettings(next); return; }
    const { error } = await supabase.from("settings").upsert(
      [{ key: "iban", value: next.iban }, { key: "beneficiary", value: next.beneficiary }],
      { onConflict: "key" }
    );
    throwIf(error);
    await reload();
  };

  const savePricelist = async (list) => {
    if (!supabase) { setPricelist(list); return; }
    const rows = list.map((item, i) => ({
      id: item.id, label: item.label,
      price_self: item.priceSelf, price_referral: item.priceReferral,
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

  const cancelOrder = async (orderId, phone) => {
    if (!supabase) { await setStatus(orderId, "rejected", "Zrušené pacientom"); return; }
    const { error } = await supabase.rpc("cancel_order", { p_id: orderId, p_phone: phone });
    throwIf(error);
    await reload();
  };

  const pendingCount = orders.filter((o) => o.status === "new").length;

  return {
    isSupabase: isSupabaseConfigured, loading,
    orders, occupied, openSlots, settings, pricelist, pendingCount,
    addOrder, setStatus, reschedule, toggleSlot, openDay, openRange, closeDay,
    saveSettings, savePricelist, lookupOrder, cancelOrder,
  };
}
