import { useCallback, useEffect, useState } from "react";

// Malá plávajúca notifikácia („toast") — potvrdenie uloženia kdekoľvek v správe.
// showToast(text) sa dá volať odkiaľkoľvek; <Toaster /> je raz v App.
// useMsg() nahrádza useState("") pre správy: úspešné („✓ …") sa navyše zobrazia ako toast,
// inline text pod tlačidlom ostáva (čítačky, testy).
const EVT = "app:toast";
export function showToast(text, kind = "ok") {
  if (typeof window === "undefined" || !text) return;
  window.dispatchEvent(new CustomEvent(EVT, { detail: { text: String(text), kind } }));
}

export function useMsg() {
  const [msg, set] = useState("");
  const setMsg = useCallback((m) => {
    set(m);
    if (typeof m === "string" && m.startsWith("✓")) showToast(m.replace(/^✓\s*/, ""));
  }, []);
  return [msg, setMsg];
}

export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    let n = 0;
    const onToast = (e) => {
      const id = ++n;
      setItems((l) => [...l.slice(-2), { id, ...e.detail }]);
      setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), 2600);
    };
    window.addEventListener(EVT, onToast);
    return () => window.removeEventListener(EVT, onToast);
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none px-4 w-full max-w-md" aria-live="polite" role="status">
      {items.map((t) => (
        <div key={t.id} data-testid="toast" className={`toast-in pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold shadow-lg ${t.kind === "ok" ? "bg-success text-white" : "bg-danger text-white"}`}>
          <span aria-hidden="true">{t.kind === "ok" ? "✓" : "!"}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
