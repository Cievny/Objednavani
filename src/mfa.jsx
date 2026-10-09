import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Dvojfaktorové overenie personálu (TOTP) — audit vlna 8.
//  • MfaEnroll: prvé prihlásenie bez faktora → QR do autentifikátora + kód
//  • MfaChallenge: prihlásenie s faktorom → 6-miestny kód (AAL2)
// Databáza (mfa_ok) pri settings.mfa_enforce = 'on' bez AAL2 nič nevydá.

const box = "bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-8 max-w-md mx-auto text-center space-y-3";
const input = "w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 text-center tracking-[0.4em] text-xl font-mono focus:ring-2 focus:ring-[#2B46A2] outline-none";
const btn = "w-full bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white font-bold py-3 rounded-[10px] transition-colors";

const onlyDigits = (s) => String(s || "").replace(/\D/g, "").slice(0, 6);

export const MfaEnroll = ({ auth }) => {
  const [factor, setFactor] = useState(null); // { id, secret, uri }
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    auth.mfaEnroll()
      .then((f) => {
        if (!alive) return;
        setFactor(f);
        if (f?.uri) QRCode.toDataURL(f.uri, { width: 220, margin: 1 }).then((u) => alive && setQr(u)).catch(() => {});
      })
      .catch((e) => alive && setError(e?.message || String(e)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!factor) return;
    setBusy(true); setError("");
    try {
      await auth.mfaVerify(factor.id, code);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={box} data-testid="mfa-enroll">
      <h2 className="text-xl font-bold text-[#2B46A2]">Nastavenie dvojfaktorového overenia</h2>
      <p className="text-sm text-slate-600">
        Prístup k údajom pacientov vyžaduje druhý faktor. Naskenujte QR kód v aplikácii
        <b> Google Authenticator</b>, <b>Microsoft Authenticator</b> alebo <b>Authy</b> a zadajte 6-miestny kód.
      </p>
      {!factor && !error && <p className="text-slate-400">Pripravujem…</p>}
      {qr && <img src={qr} alt="QR kód pre autentifikátor" className="mx-auto rounded" width="220" height="220" />}
      {factor?.secret && (
        <p className="text-xs text-slate-500 break-all">
          Bez kamery zadajte kľúč ručne: <span className="font-mono select-all" data-testid="mfa-secret">{factor.secret}</span>
        </p>
      )}
      <form onSubmit={submit} className="space-y-3">
        <input
          inputMode="numeric" autoComplete="one-time-code" value={code}
          onChange={(e) => { setCode(onlyDigits(e.target.value)); setError(""); }}
          className={input} placeholder="000000" data-testid="mfa-code" autoFocus
        />
        {error && <p className="text-sm text-red-600 font-semibold">{error}</p>}
        <button type="submit" disabled={busy || !factor || code.length !== 6} className={btn}>
          {busy ? "Overujem…" : "Aktivovať a pokračovať"}
        </button>
      </form>
      <button onClick={auth.signOut} className="text-sm text-slate-500 hover:underline">Odhlásiť sa</button>
    </div>
  );
};

export const MfaChallenge = ({ auth }) => {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await auth.mfaVerify(null, code);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={box} data-testid="mfa-challenge">
      <h2 className="text-xl font-bold text-[#2B46A2]">Overovací kód</h2>
      <p className="text-sm text-slate-600">Zadajte 6-miestny kód z aplikácie autentifikátora.</p>
      <form onSubmit={submit} className="space-y-3">
        <input
          inputMode="numeric" autoComplete="one-time-code" value={code}
          onChange={(e) => { setCode(onlyDigits(e.target.value)); setError(""); }}
          className={input} placeholder="000000" data-testid="mfa-code" autoFocus
        />
        {error && <p className="text-sm text-red-600 font-semibold">{error}</p>}
        <button type="submit" disabled={busy || code.length !== 6} className={btn}>
          {busy ? "Overujem…" : "Potvrdiť"}
        </button>
      </form>
      <p className="text-xs text-slate-400">Stratili ste prístup k autentifikátoru? Kontaktujte superadmina — faktor vám zruší v Supabase (Authentication → Users).</p>
      <button onClick={auth.signOut} className="text-sm text-slate-500 hover:underline">Odhlásiť sa</button>
    </div>
  );
};
