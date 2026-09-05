import { useState, useEffect } from "react";
import { PatientView, AdminView, UsgHero, OrderLookup } from "./booking.jsx";
import { VopPage, PrivacyPage } from "./legal.jsx";
import { useAuth, useBookingData } from "./data.js";
import AdhocPaymentApp from "./adhoc.jsx";
import CtApp from "./ct.jsx";
import CheckinView from "./checkin.jsx";
import { AngioPatientApp, AngioAdminApp, CLINIC_NAME as ANGIO_NAME } from "./angio.jsx";

// Provizórny prístupový kód pre demo režim bez Supabase — nie je to reálne
// zabezpečenie. V Supabase režime ho nahrádza prihlásenie cez Supabase Auth.
const APP_VERSION = "v77";

// Režim nasadenia: "patient" = verejná stránka len s objednávaním,
// "admin" = interný systém pracoviska na samostatnej adrese,
// bez nastavenia = kombinovaná verzia (lokálny vývoj / demo).
const APP_MODE = import.meta.env.VITE_APP_MODE || "combined";

// Beta nasadenie (objednanie.cievny.sk/beta/) — zdieľa produkčnú databázu,
// odlišuje sa štítkom v hlavičke a noindexom, aby sa nemýlila s produkciou
const IS_BETA = import.meta.env.VITE_BETA === "1";

const ADMIN_ACCESS_CODE = "nusch2026";
const ADMIN_UNLOCK_KEY = "usgAdminUnlocked_v1";

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash;
}

// Demo režim: jednoduchý prístupový kód
const CodeGate = ({ onUnlock }) => {
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (code === ADMIN_ACCESS_CODE) {
      sessionStorage.setItem(ADMIN_UNLOCK_KEY, "1");
      onUnlock();
    } else {
      setError(true);
    }
  };

  return (
    <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-8 max-w-md mx-auto text-center">
      <h2 className="text-xl font-bold text-[#2B46A2] mb-2">Prístup pre pracovisko</h2>
      <p className="text-sm text-slate-500 mb-4">Zadajte prístupový kód sonografického pracoviska.</p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="password"
          value={code}
          onChange={(e) => { setCode(e.target.value); setError(false); }}
          className="w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 text-center tracking-widest focus:ring-2 focus:ring-[#2B46A2] outline-none"
          placeholder="Prístupový kód"
          autoFocus
        />
        {error && <p className="text-sm text-red-600 font-semibold">Nesprávny kód.</p>}
        <button type="submit" className="w-full bg-[#2B46A2] hover:bg-[#1E3580] text-white font-bold py-3 rounded-[10px] transition-colors">
          Vstúpiť
        </button>
      </form>
    </div>
  );
};

// Supabase režim: prihlásenie personálu e-mailom a heslom
const LoginGate = ({ auth }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await auth.signIn(email.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-8 max-w-md mx-auto text-center">
      <h2 className="text-xl font-bold text-[#2B46A2] mb-2">Prihlásenie pracoviska</h2>
      <p className="text-sm text-slate-500 mb-4">Prístup majú len pozvané kontá personálu (@nusch.sk).</p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => { setEmail(e.target.value); setError(""); }}
          className="w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 focus:ring-2 focus:ring-[#2B46A2] outline-none"
          placeholder="meno.priezvisko@nusch.sk"
          autoFocus
        />
        <input
          type="password"
          required
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          className="w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 focus:ring-2 focus:ring-[#2B46A2] outline-none"
          placeholder="Heslo"
        />
        {error && <p className="text-sm text-red-600 font-semibold">{error}</p>}
        <button type="submit" disabled={busy} className="w-full bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white font-bold py-3 rounded-[10px] transition-colors">
          {busy ? "Prihlasujem…" : "Prihlásiť sa"}
        </button>
      </form>
    </div>
  );
};

export default function App() {
  const hash = useHashRoute();
  const auth = useAuth();
  const [codeUnlocked, setCodeUnlocked] = useState(() => sessionStorage.getItem(ADMIN_UNLOCK_KEY) === "1");

  // beta: odlíšiť v titulku a nedovoliť indexovanie vyhľadávačmi
  // (statický noindex vkladá aj build cez vite — tu len doplníme, ak chýba)
  useEffect(() => {
    if (!IS_BETA) return;
    if (!document.title.startsWith("BETA")) document.title = `BETA — ${document.title}`;
    if (!document.querySelector('meta[name="robots"]')) {
      const m = document.createElement("meta");
      m.name = "robots";
      m.content = "noindex";
      document.head.appendChild(m);
    }
  }, []);

  const isAdminRoute = APP_MODE === "admin" ? true : APP_MODE === "patient" ? false : hash.startsWith("#/sprava");
  // Právne stránky (VOP a ochrana osobných údajov) — dostupné z pätičky a z formulára
  const legalPage = hash.startsWith("#/podmienky") ? "vop" : hash.startsWith("#/osobne-udaje") ? "privacy" : null;
  // Deep-link z e-mailov: #/objednavka/USG-… otvorí overenie objednávky s predvyplneným číslom
  const orderLinkId = hash.startsWith("#/objednavka/") ? decodeURIComponent(hash.slice("#/objednavka/".length)) : "";
  // Skryté testovacie pod-appky (neuvedené v navigácii, len pre prihlásený personál)
  // Testovacie pod-appky nie sú súčasťou pacientskej stránky — v patient
  // builde nesmú byť dosiahnuteľné ani cez hash (audit vlna 6)
  const isPayRoute = APP_MODE !== "patient" && hash.startsWith("#/platba");
  const isCtRoute = APP_MODE !== "patient" && hash.startsWith("#/ct");
  // QR check-in v čakárni — verejná stránka (pacient ju otvára z QR na stojane)
  const isCheckinRoute = hash.startsWith("#/som-tu");
  // Angiologická ambulancia č. 1 (#/angio1) — verejné objednávanie bez poplatku;
  // správa sa určuje ako pri USG: admin build = vždy správa, patient build = vždy
  // pacient, combined = #/angio1 pacient, #/angio1/sprava správa
  const isAngioRoute = hash.startsWith("#/angio1");
  const isAngioAdmin = APP_MODE === "admin" ? true : APP_MODE === "patient" ? false : hash.startsWith("#/angio1/sprava");
  const angioAdminHref = APP_MODE === "combined" ? "#/angio1/sprava" : "#/angio1";
  const isStaff = auth.isSupabase ? Boolean(auth.session) : codeUnlocked;
  const data = useBookingData(isStaff);

  const adminContent = (
    <div className="bg-white rounded-[15px] p-5 md:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.08)]">
      {auth.isSupabase && (
        <div className="flex items-center justify-between gap-2 mb-4 text-xs text-[#767676]">
          <span>Prihlásený: {auth.session?.user?.email}</span>
          <button onClick={auth.signOut} className="bg-[#F0F2F5] hover:bg-[#E0E4EF] text-[#444444] font-semibold px-3 py-1.5 rounded-[8px] transition-colors">
            Odhlásiť sa
          </button>
        </div>
      )}
      {/* Diskrétne odkazy na skryté testovacie pod-appky (len pre personál) */}
      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
        <span className="text-[#856404] bg-[#FFF6E0] border border-[#E0C878] rounded px-2 py-0.5 font-semibold">Testovacie</span>
        <a href="#/platba" className="text-[#2B46A2] font-semibold hover:underline">Ad-hoc platba za výkon</a>
        <span className="text-slate-300">·</span>
        <a href="#/ct" className="text-[#2B46A2] font-semibold hover:underline">CT objednávanie (bez poplatku)</a>
        <span className="text-slate-300">·</span>
        <a href={angioAdminHref} className="text-[#2B46A2] font-semibold hover:underline">{ANGIO_NAME} — správa</a>
      </div>
      <AdminView
        orders={data.orders}
        openSlots={data.openSlots}
        settings={data.settings}
        pricelist={data.pricelist}
        onOpenWindow={data.openWindow}
        onCloseSlot={data.closeSlot}
        onCloseDay={data.closeDay}
        onSetStatus={data.setStatus}
        onSetPaid={data.setPaid}
        onReschedule={data.reschedule}
        onChangeDoctor={data.changeDoctor}
        onSaveSettings={data.saveSettings}
        onSavePricelist={data.savePricelist}
        onSavePricelistOrder={data.savePricelistOrder}
        onGetMonthlyStats={data.getMonthlyStats}
        onListStaff={data.listStaff}
        onSetStaffRole={data.setStaffRole}
        onRemoveStaffRole={data.removeStaffRole}
        onCheckPayments={data.checkPayments}
        onListInvoices={data.listInvoices}
        onIssueMissingInvoices={data.issueMissingInvoices}
        isSupabase={data.isSupabase}
        onOpenAttachment={data.openAttachment}
        role={auth.role || "none"}
      />
    </div>
  );

  const renderAdmin = () => {
    if (auth.isSupabase) {
      if (!auth.ready) return <p className="text-center text-slate-400 py-10">Načítavam…</p>;
      if (!auth.session) return <LoginGate auth={auth} />;
      if (auth.role === null) return <p className="text-center text-slate-400 py-10">Načítavam…</p>;
      return adminContent;
    }
    return codeUnlocked ? adminContent : <CodeGate onUnlock={() => setCodeUnlocked(true)} />;
  };

  // skryté pod-appky sú prístupné až po prihlásení personálu (počas testu neverejné)
  // — vyžadujú skutočnú rolu personálu, nielen prihlásené konto (nie „bez roly")
  const renderGated = (node) => {
    if (auth.isSupabase) {
      if (!auth.ready) return <p className="text-center text-slate-400 py-10">Načítavam…</p>;
      if (!auth.session) return <LoginGate auth={auth} />;
      if (auth.role === null) return <p className="text-center text-slate-400 py-10">Načítavam…</p>;
      if (!["superadmin", "sestra", "lekar"].includes(auth.role)) {
        return <p className="text-center text-slate-500 py-10">Tento účet nemá pridelenú rolu personálu. Požiadajte správcu o prístup.</p>;
      }
      return node;
    }
    return codeUnlocked ? node : <CodeGate onUnlock={() => setCodeUnlocked(true)} />;
  };

  return (
    <div className="bg-[#F8F9FC] text-slate-900 min-h-screen font-sans">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <img src="logo-nusch.png" alt="Logo NÚSCH" className="w-10 h-10 shrink-0" />
          <div>
            <p className="font-extrabold text-[#2B46A2] leading-tight text-sm md:text-base">Národný ústav srdcových a cievnych chorôb, a.s.</p>
            <p className="text-xs text-slate-500">{isAngioRoute ? ANGIO_NAME : APP_MODE === "admin" ? "Interný systém — objednávky na USG" : "Objednávanie na USG vyšetrenia"}</p>
          </div>
          {IS_BETA && (
            <span className="ml-auto shrink-0 bg-[#FFF6E0] border border-[#E0C878] text-[#856404] text-xs font-extrabold px-3 py-1.5 rounded-[8px]">
              BETA — testovacia verzia
            </span>
          )}
        </div>
      </header>

      {/* Pacientska verzia má jedinú stránku — lišta s jednou záložkou by bola len šum */}
      {APP_MODE !== "patient" && (
      <nav className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 flex gap-6">
          {APP_MODE === "combined" ? (
            <>
              <a
                href="#/"
                className={`py-3 text-sm font-bold border-b-[3px] transition-colors ${!isAdminRoute ? "text-[#2B46A2] border-[#2B46A2]" : "text-[#2B46A2] border-transparent hover:text-[#2B46A2]"}`}
              >
                Objednať sa
              </a>
              <a
                href="#/sprava"
                className={`py-3 text-sm font-bold border-b-[3px] transition-colors ${isAdminRoute ? "text-[#2B46A2] border-[#2B46A2]" : "text-[#2B46A2] border-transparent hover:text-[#2B46A2]"}`}
              >
                Pre pracovisko{isStaff && data.pendingCount > 0 ? ` (${data.pendingCount})` : ""}
              </a>
            </>
          ) : (
            <span className="py-3 text-sm font-bold text-[#2B46A2] border-b-[3px] border-[#2B46A2]">
              {APP_MODE === "admin" ? `Správa objednávok${isStaff && data.pendingCount > 0 ? ` (${data.pendingCount})` : ""}` : "Objednať sa"}
            </span>
          )}
        </div>
      </nav>
      )}

      <main className={`${isAdminRoute || isPayRoute || isCtRoute || (isAngioRoute && isAngioAdmin) ? "max-w-5xl" : "max-w-[720px]"} mx-auto p-2 sm:p-4 md:p-6`}>
        {legalPage === "vop" ? <VopPage /> : legalPage === "privacy" ? <PrivacyPage />
          : isCheckinRoute ? <CheckinView />
          : isAngioRoute ? (isAngioAdmin
              ? renderGated(<AngioAdminApp role={auth.isSupabase ? (auth.role || "none") : "superadmin"} backHref={APP_MODE === "combined" ? "#/sprava" : "#/"} />)
              : <AngioPatientApp />)
          : isPayRoute ? renderGated(<AdhocPaymentApp />)
          : isCtRoute ? renderGated(<CtApp isStaff={isStaff} role={auth.isSupabase ? (auth.role || "none") : "superadmin"} />)
          : isAdminRoute ? renderAdmin() : (
          <>
            <UsgHero />
            {data.isSupabase && data.loading ? (
              <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-8 text-center text-slate-400">Načítavam voľné termíny…</div>
            ) : (
              <PatientView
                occupied={data.occupied}
                openSlots={data.openSlots}
                settings={data.settings}
                pricelist={data.pricelist}
                onSubmit={data.addOrder}
              />
            )}
            <OrderLookup onLookup={data.lookupOrder} onCancel={data.cancelOrder} onReschedule={data.patientReschedule} openSlots={data.openSlots} occupied={data.occupied} settings={data.settings} initialOrderId={orderLinkId} defaultOpen={Boolean(orderLinkId)} />
          </>
        )}
      </main>

      <footer className="max-w-5xl mx-auto px-4 py-6 text-center text-xs text-slate-400">
        <p className="mb-1">
          <a href="#/podmienky" className="text-[#2B46A2] font-semibold hover:underline">Podmienky online objednávania</a>
          {" · "}
          <a href="#/osobne-udaje" className="text-[#2B46A2] font-semibold hover:underline">Ochrana osobných údajov</a>
        </p>
        NÚSCH, a.s. · Pod Krásnou hôrkou 1, Bratislava ·{" "}
        {data.isSupabase
          ? "Dáta sú uložené v zabezpečenej databáze v EÚ (Supabase)."
          : "Prototyp — dáta sú zatiaľ uložené len v tomto prehliadači."}{" "}
        · {APP_VERSION}
      </footer>
    </div>
  );
}
