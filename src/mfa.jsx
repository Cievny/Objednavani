import { useEffect, useState } from "react";
import { inputCls } from "./ui.jsx";
import QRCode from "qrcode";

// Dvojfaktorové overenie personálu (TOTP) — audit vlna 8.
//  • MfaEnroll: prvé prihlásenie bez faktora → QR do autentifikátora + kód
//  • MfaChallenge: prihlásenie s faktorom → 6-miestny kód (AAL2)
// Databáza (mfa_ok) pri settings.mfa_enforce = 'on' bez AAL2 nič nevydá.

const box = "bg-white rounded-xl border border-line p-8 max-w-md mx-auto text-center space-y-3";
const input = inputCls + " text-center tracking-[0.4em] text-xl font-mono";
const btn = "w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors";

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
      <h2 className="text-xl font-semibold text-brand">Nastavenie dvojfaktorového overenia</h2>
      <p className="text-sm text-muted">
        Prístup k údajom pacientov vyžaduje druhý faktor. Naskenujte QR kód v aplikácii
        <b> Google Authenticator</b>, <b>Microsoft Authenticator</b> alebo <b>Authy</b> a zadajte 6-miestny kód.
      </p>
      {!factor && !error && <p className="text-muted">Pripravujem…</p>}
      {qr && <img src={qr} alt="QR kód pre autentifikátor" className="mx-auto rounded-lg" width="220" height="220" />}
      {factor?.secret && (
        <p className="text-xs text-muted break-all">
          Bez kamery zadajte kľúč ručne: <span className="font-mono select-all" data-testid="mfa-secret">{factor.secret}</span>
        </p>
      )}
      <form onSubmit={submit} className="space-y-3">
        <input
          inputMode="numeric" autoComplete="one-time-code" value={code}
          onChange={(e) => { setCode(onlyDigits(e.target.value)); setError(""); }}
          className={input} placeholder="000000" data-testid="mfa-code" autoFocus
        />
        {error && <p className="text-sm text-danger font-semibold">{error}</p>}
        <button type="submit" disabled={busy || !factor || code.length !== 6} className={btn}>
          {busy ? "Overujem…" : "Aktivovať a pokračovať"}
        </button>
      </form>
      <button onClick={auth.signOut} className="text-sm text-muted hover:underline">Odhlásiť sa</button>
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
      <h2 className="text-xl font-semibold text-brand">Overovací kód</h2>
      <p className="text-sm text-muted">Zadajte 6-miestny kód z aplikácie autentifikátora.</p>
      <form onSubmit={submit} className="space-y-3">
        <input
          inputMode="numeric" autoComplete="one-time-code" value={code}
          onChange={(e) => { setCode(onlyDigits(e.target.value)); setError(""); }}
          className={input} placeholder="000000" data-testid="mfa-code" autoFocus
        />
        {error && <p className="text-sm text-danger font-semibold">{error}</p>}
        <button type="submit" disabled={busy || code.length !== 6} className={btn}>
          {busy ? "Overujem…" : "Potvrdiť"}
        </button>
      </form>
      <p className="text-xs text-muted">Stratili ste prístup k autentifikátoru? Kontaktujte superadmina — faktor vám zruší v Supabase (Authentication → Users).</p>
      <button onClick={auth.signOut} className="text-sm text-muted hover:underline">Odhlásiť sa</button>
    </div>
  );
};
