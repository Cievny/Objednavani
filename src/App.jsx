import { useState, useEffect } from "react";
import { useBookingData, PatientView, AdminView, UsgHero } from "./booking.jsx";

// Provizórny prístupový kód pre stránku pracoviska — nahradí ho skutočné
// prihlásenie (Supabase Auth). Je to len zábrana proti náhodnému preklikaniu,
// nie reálne zabezpečenie.
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

const AdminGate = ({ children }) => {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(ADMIN_UNLOCK_KEY) === "1");
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);

  if (unlocked) return children;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (code === ADMIN_ACCESS_CODE) {
      sessionStorage.setItem(ADMIN_UNLOCK_KEY, "1");
      setUnlocked(true);
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

export default function App() {
  const hash = useHashRoute();
  const data = useBookingData();
  const isAdmin = hash.startsWith("#/sprava");

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
            className={`py-3 text-sm font-bold border-b-[3px] transition-colors ${!isAdmin ? "text-[#e2001a] border-[#e2001a]" : "text-[#003d7c] border-transparent hover:text-[#e2001a]"}`}
          >
            Objednať sa
          </a>
          <a
            href="#/sprava"
            className={`py-3 text-sm font-bold border-b-[3px] transition-colors ${isAdmin ? "text-[#e2001a] border-[#e2001a]" : "text-[#003d7c] border-transparent hover:text-[#e2001a]"}`}
          >
            Pre pracovisko{data.pendingCount > 0 && isAdmin === false ? ` (${data.pendingCount})` : ""}
          </a>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto p-4 md:p-6">
        {isAdmin ? (
          <AdminGate>
            <div className="bg-slate-800 text-white rounded-2xl p-5 md:p-6 shadow-xl">
              <AdminView
                orders={data.orders}
                openSlots={data.openSlots}
                settings={data.settings}
                pricelist={data.pricelist}
                onToggleSlot={data.toggleSlot}
                onOpenDay={data.openDay}
                onCloseDay={data.closeDay}
                onSetStatus={data.setStatus}
                onSaveSettings={data.saveSettings}
                onSavePricelist={data.savePricelist}
              />
            </div>
          </AdminGate>
        ) : (
          <>
            <UsgHero />
            <PatientView
              orders={data.orders}
              openSlots={data.openSlots}
              settings={data.settings}
              pricelist={data.pricelist}
              onSubmit={data.addOrder}
            />
          </>
        )}
      </main>

      <footer className="max-w-5xl mx-auto px-4 py-6 text-center text-xs text-slate-400">
        NÚSCH, a.s. · Pod Krásnou hôrkou 1, Bratislava · Prototyp — dáta sú zatiaľ uložené len v tomto prehliadači
      </footer>
    </div>
  );
}
