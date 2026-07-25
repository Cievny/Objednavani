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
  doctor: j.doctor || "",
  paid: Boolean(j.paid),
});

const pricelistFromRows = (rows) =>
  rows.map((r) => ({
    id: r.id,
    label: r.label,
    priceSelf: Number(r.price_self),
    priceReferral: r.price_referral == null ? null : Number(r.price_referral),
    instructions: r.instructions || "",
    durationSlots: r.duration_slots == null ? 1 : Number(r.duration_slots),
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
  if (error.code === "23505") return new Error("Vybraný termín bol medzičasom obsadený. Vyberte iný.");
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
      let doctors = [];
      try { doctors = JSON.parse(kv.doctors || "[]"); } catch { doctors = []; }
      setSettings({
        iban: kv.iban || defaultSettings.iban,
        beneficiary: kv.beneficiary || defaultSettings.beneficiary,
        doctors: normalizeDoctors(doctors),
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
    const n = Math.max(1, Math.round((o.durationMin || 10) / 10));
    return Array.from({ length: n }, (_, i) => {
      const mins = h * 60 + m + i * 10;
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
      return;
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
    let { error } = await supabase.rpc("create_order", { ...rpcParams, p_attachments: attachments });
    if (error && /create_order/i.test(error.message || "")) {
      // server ešte bez podpory príloh (nespustená migrácia) — objednávka prejde bez nich
      ({ error } = await supabase.rpc("create_order", rpcParams));
    }
    throwIf(error);
    await reload();
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
      window.open(data.signedUrl, "_blank");
    }
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

  // otvorenie termínov: okno (deň/rozsah + čas od–do + interval + lekár)
  const openWindow = async ({ dateFrom, dateTo, timeFrom, timeTo, stepMinutes, doctor = "", skipWeekends = true }) => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return;
    const times = generateWindowSlots(timeFrom, timeTo, stepMinutes);
    if (times.length === 0) return;
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
          times.forEach((t) => byTime.set(t, { time: t, doctor }));
          next[iso] = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
        });
        return next;
      });
      return;
    }
    const rows = [];
    days.forEach((iso) => times.forEach((t) => rows.push({ slot_date: iso, slot_time: t, doctor })));
    const { error } = await supabase.from("open_slots").upsert(rows, { onConflict: "slot_date,slot_time" });
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
    const bookedTimes = new Set(orders.filter((o) => o.date === date && isSlotOccupying(o)).map((o) => o.time));
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
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, paid, paidAt } : o)));
      return;
    }
    const { error } = await supabase.from("orders").update({ paid, paid_at: paidAt }).eq("id", orderId);
    throwIf(error);
    await reload();
  };

  const saveSettings = async (next) => {
    if (!supabase) { setSettings(next); return; }
    const { error } = await supabase.from("settings").upsert(
      [
        { key: "iban", value: next.iban },
        { key: "beneficiary", value: next.beneficiary },
        { key: "doctors", value: JSON.stringify(next.doctors || []) },
      ],
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

  const pendingCount = orders.filter((o) => o.status === "new").length;

  return {
    isSupabase: isSupabaseConfigured, loading,
    orders, occupied, openSlots, settings, pricelist, pendingCount,
    addOrder, setStatus, setPaid, reschedule, openWindow, closeSlot, closeDay,
    saveSettings, savePricelist, savePricelistOrder, getMonthlyStats,
    lookupOrder, cancelOrder, openAttachment,
  };
}
