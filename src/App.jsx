import { useState, useEffect } from "react";
import { PatientView, AdminView, UsgHero, OrderLookup } from "./booking.jsx";
import { useAuth, useBookingData } from "./data.js";

// Provizórny prístupový kód pre demo režim bez Supabase — nie je to reálne
// zabezpečenie. V Supabase režime ho nahrádza prihlásenie cez Supabase Auth.
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
    <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md mx-auto text-center">
      <h2 className="text-xl font-bold text-[#003d7c] mb-2">Prístup pre pracovisko</h2>
      <p className="text-sm text-slate-500 mb-4">Zadajte prístupový kód sonografického pracoviska.</p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="password"
          value={code}
          onChange={(e) => { setCode(e.target.value); setError(false); }}
          className="w-full p-3 bg-white border border-slate-300 rounded-lg text-slate-800 text-center tracking-widest focus:ring-2 focus:ring-[#005ca9] outline-none"
          placeholder="Prístupový kód"
          autoFocus
        />
        {error && <p className="text-sm text-red-600 font-semibold">Nesprávny kód.</p>}
        <button type="submit" className="w-full bg-[#e2001a] hover:bg-[#c00017] text-white font-bold py-3 rounded-xl transition-colors">
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
    <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md mx-auto text-center">
      <h2 className="text-xl font-bold text-[#003d7c] mb-2">Prihlásenie pracoviska</h2>
      <p className="text-sm text-slate-500 mb-4">Prístup majú len pozvané kontá personálu (@nusch.sk).</p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => { setEmail(e.target.value); setError(""); }}
          className="w-full p-3 bg-white border border-slate-300 rounded-lg text-slate-800 focus:ring-2 focus:ring-[#005ca9] outline-none"
          placeholder="meno.priezvisko@nusch.sk"
          autoFocus
        />
        <input
          type="password"
          required
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          className="w-full p-3 bg-white border border-slate-300 rounded-lg text-slate-800 focus:ring-2 focus:ring-[#005ca9] outline-none"
          placeholder="Heslo"
        />
        {error && <p className="text-sm text-red-600 font-semibold">{error}</p>}
        <button type="submit" disabled={busy} className="w-full bg-[#e2001a] hover:bg-[#c00017] disabled:opacity-60 text-white font-bold py-3 rounded-xl transition-colors">
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

  const isAdminRoute = hash.startsWith("#/sprava");
  const isStaff = auth.isSupabase ? Boolean(auth.session) : codeUnlocked;
  const data = useBookingData(isStaff);

  const adminContent = (
    <div className="bg-slate-800 text-white rounded-2xl p-5 md:p-6 shadow-xl">
      {auth.isSupabase && (
        <div className="flex items-center justify-between gap-2 mb-4 text-xs text-slate-400">
          <span>Prihlásený: {auth.session?.user?.email}</span>
          <button onClick={auth.signOut} className="bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold px-3 py-1.5 rounded transition-colors">
            Odhlásiť sa
          </button>
        </div>
      )}
      <AdminView
        orders={data.orders}
        openSlots={data.openSlots}
        settings={data.settings}
        pricelist={data.pricelist}
        onToggleSlot={data.toggleSlot}
        onOpenDay={data.openDay}
        onOpenRange={data.openRange}
        onCloseDay={data.closeDay}
        onSetStatus={data.setStatus}
        onReschedule={data.reschedule}
        onSaveSettings={data.saveSettings}
        onSavePricelist={data.savePricelist}
      />
    </div>
  );

  const renderAdmin = () => {
    if (auth.isSupabase) {
      if (!auth.ready) return <p className="text-center text-slate-400 py-10">Načítavam…</p>;
      return auth.session ? adminContent : <LoginGate auth={auth} />;
    }
    return codeUnlocked ? adminContent : <CodeGate onUnlock={() => setCodeUnlocked(true)} />;
  };

  return (
    <div className="bg-[#f2f4f7] text-slate-900 min-h-screen font-sans">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <svg viewBox="0 0 24 24" className="w-9 h-9 shrink-0" aria-hidden="true">
            <path fill="#e2001a" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
          </svg>
          <div>
            <p className="font-extrabold text-[#003d7c] leading-tight text-sm md:text-base">Národný ústav srdcových a cievnych chorôb, a.s.</p>
            <p className="text-xs text-slate-500">Objednávanie na USG vyšetrenia</p>
          </div>
        </div>
      </header>

      <nav className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 flex gap-6">
          <a
            href="#/"
            className={`py-3 text-sm font-bold border-b-[3px] transition-colors ${!isAdminRoute ? "text-[#e2001a] border-[#e2001a]" : "text-[#003d7c] border-transparent hover:text-[#e2001a]"}`}
          >
            Objednať sa
          </a>
          <a
            href="#/sprava"
            className={`py-3 text-sm font-bold border-b-[3px] transition-colors ${isAdminRoute ? "text-[#e2001a] border-[#e2001a]" : "text-[#003d7c] border-transparent hover:text-[#e2001a]"}`}
          >
            Pre pracovisko{isStaff && data.pendingCount > 0 ? ` (${data.pendingCount})` : ""}
          </a>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto p-4 md:p-6">
        {isAdminRoute ? renderAdmin() : (
          <>
            <UsgHero />
            {data.isSupabase && data.loading ? (
              <div className="bg-white rounded-2xl shadow-xl p-8 text-center text-slate-400">Načítavam voľné termíny…</div>
            ) : (
              <PatientView
                occupied={data.occupied}
                openSlots={data.openSlots}
                settings={data.settings}
                pricelist={data.pricelist}
                onSubmit={data.addOrder}
              />
            )}
            <OrderLookup onLookup={data.lookupOrder} onCancel={data.cancelOrder} />
          </>
        )}
      </main>

      <footer className="max-w-5xl mx-auto px-4 py-6 text-center text-xs text-slate-400">
        NÚSCH, a.s. · Pod Krásnou hôrkou 1, Bratislava ·{" "}
        {data.isSupabase
          ? "Dáta sú uložené v zabezpečenej databáze v EÚ (Supabase)."
          : "Prototyp — dáta sú zatiaľ uložené len v tomto prehliadači."}
      </footer>
    </div>
  );
}
