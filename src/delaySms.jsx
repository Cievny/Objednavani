import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient.js";
import { Btn, Callout } from "./ui.jsx";

// Hromadná SMS „meškáme pre akútneho pacienta" (meskanie-001) — USG, angio, CT.
// Personál ju pošle z Prehľadu všetkým dnešným ešte nevybaveným pacientom.
// Text je pevný (skladá ho databáza), voliť sa dá len odhad meškania.
// Demo režim (bez databázy): počíta príjemcov z dnešných objednávok v prehliadači.

const LABEL = { usg: "USG", angio: "angiologia", ct: "CT" };
const DELAYS = [null, 15, 30, 45, 60, 90, 120];
const DEMO_LOG = "delaySmsLog_v1";
const NEED_SQL = "SMS o meškaní ešte nie je zapnutá v databáze — spustite supabase/meskanie-001.sql.";

export const delaySmsText = (clinic, delay) =>
  `NUSCH ${LABEL[clinic]}: Ospravedlnujeme sa, pre akutneho pacienta dnes meskame${delay ? ` asi ${delay} min` : ""}. Vas termin plati, prosime o trpezlivost. Dakujeme za pochopenie.`;

const loadLog = () => { try { return JSON.parse(localStorage.getItem(DEMO_LOG) || "[]"); } catch { return []; } };
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

// rows (demo): [{ phone, status, notify, requestedBy }] — dnešné objednávky ambulancie
async function callDelaySms(clinic, delay, dryRun, rows) {
  if (supabase) {
    const { data, error } = await supabase.rpc("clinic_delay_sms", { p_clinic: clinic, p_delay_min: delay, p_dry_run: dryRun });
    if (error) throw new Error(error.code === "PGRST202" ? NEED_SQL : error.message);
    return data || {};
  }
  const todays = (rows || []).filter((r) => ["new", "confirmed"].includes(r.status) && !(r.requestedBy && r.status === "new"));
  const num = (p) => String(p || "").replace(/\D/g, "").replace(/^00/, "").replace(/^0/, "421");
  const ok = todays.filter((r) => r.notify !== false && num(r.phone).length >= 11);
  const count = new Set(ok.map((r) => num(r.phone))).size;
  const log = loadLog().filter((l) => l.clinic === clinic && l.day === todayKey());
  const last = log[log.length - 1] || null;
  const wait = last ? Math.max(0, Math.ceil((last.at + 10 * 60e3 - Date.now()) / 60e3)) : 0;
  const text = delaySmsText(clinic, delay);
  if (dryRun) return { sent: false, count, skipped: todays.length - ok.length, text, wait_min: wait, last: last && { at: new Date(last.at).toISOString(), by: "demo", count: last.count, delay_min: last.delay } };
  if (wait > 0) throw new Error(`SMS o meškaní bola odoslaná pred chvíľou. Ďalšiu môžete poslať o ${wait} min.`);
  if (log.length >= 5) throw new Error("Dnes už bolo odoslaných 5 SMS o meškaní — viac sa poslať nedá.");
  if (count === 0) throw new Error("Dnes nie je komu poslať SMS (žiadni nevybavení pacienti s mobilným číslom).");
  localStorage.setItem(DEMO_LOG, JSON.stringify([...loadLog(), { clinic, day: todayKey(), at: Date.now(), count, delay }]));
  return { sent: true, count, skipped: todays.length - ok.length, text, wait_min: 10, last: { at: new Date().toISOString(), by: "demo", count, delay_min: delay } };
}

const hhmm = (iso) => { try { return new Date(iso).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const pac = (n) => (n === 1 ? "1 pacientovi" : `${n} pacientom`);

export function DelaySms({ clinic, demoRows = [] }) {
  const [open, setOpen] = useState(false);
  const [delay, setDelay] = useState(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(null);
  const rowsRef = useRef(demoRows); rowsRef.current = demoRows;
  const closeRef = useRef(null);

  // náhľad (počet príjemcov, presný text, posledné odoslanie) pri otvorení a zmene odhadu
  useEffect(() => {
    if (!open || sent) return undefined;
    let alive = true;
    setBusy(true); setErr("");
    callDelaySms(clinic, delay, true, rowsRef.current)
      .then((r) => { if (alive) setInfo(r); })
      .catch((e) => { if (alive) { setInfo(null); setErr(e?.message || String(e)); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [open, delay, clinic, sent]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const start = () => { setSent(null); setInfo(null); setErr(""); setDelay(null); setOpen(true); };
  const send = async () => {
    setSending(true); setErr("");
    try { setSent(await callDelaySms(clinic, delay, false, rowsRef.current)); }
    catch (e) { setErr(e?.message || String(e)); }
    finally { setSending(false); }
  };
  const wait = info?.wait_min || 0;
  const canSend = !busy && !sending && info && info.count > 0 && wait === 0;

  return (
    <>
      <button type="button" onClick={start} data-testid="delay-sms-open" title="Poslať dnešným pacientom SMS, že pre akútneho pacienta meškáme"
        className="shrink-0 text-xs font-semibold text-warn bg-warn-soft border border-warn/30 hover:border-warn px-3 py-1.5 rounded-lg">📣 SMS: meškáme</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-ink/40 p-3 overflow-y-auto" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delay-sms-title" data-testid="delay-sms-dialog"
            className="w-full max-w-lg bg-white rounded-xl border border-line shadow-xl p-5 space-y-4 text-left">
            <div>
              <h3 id="delay-sms-title" className="text-lg font-semibold text-brand">SMS pacientom: meškáme pre akútneho pacienta</h3>
              <p className="text-sm text-muted mt-1">Dostanú ju všetci dnešní pacienti, ktorí ešte nie sú vybavení (stav nová alebo potvrdená) a majú mobilné číslo.</p>
            </div>

            {sent ? (
              <Callout tone="success" data-testid="delay-sms-sent">✓ SMS odoslaná {pac(sent.count)}.{sent.skipped > 0 ? ` ${sent.skipped} pacientov ju nedostalo (vypnuté správy alebo chýba mobil) — povedzte im to osobne.` : ""}</Callout>
            ) : (<>
              <fieldset>
                <legend className="text-sm font-semibold text-ink mb-1.5">Odhad meškania</legend>
                <div className="flex flex-wrap gap-1.5">
                  {DELAYS.map((d) => (
                    <button key={d ?? "x"} type="button" aria-pressed={delay === d} onClick={() => setDelay(d)} data-testid={`delay-sms-min-${d ?? "none"}`}
                      className={`text-sm font-semibold px-3 py-1.5 rounded-lg border transition-colors ${delay === d ? "bg-brand text-white border-brand" : "bg-white text-ink border-line hover:border-brand"}`}>
                      {d ? `${d} min` : "bez odhadu"}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div>
                <p className="text-sm font-semibold text-ink mb-1">Text SMS</p>
                <p className="text-sm bg-soft border border-line rounded-lg p-3 font-mono break-words" data-testid="delay-sms-text">{info?.text || delaySmsText(clinic, delay)}</p>
                <p className="text-xs text-muted mt-1">Text je pevný, bez diakritiky (jedna SMS). Odosielateľ: NUSCH.</p>
              </div>
              {info && (
                <p className="text-sm text-ink" data-testid="delay-sms-count">
                  Príjemcovia: <b>{info.count}</b>{info.skipped > 0 ? <span className="text-muted"> · {info.skipped} bez SMS (vypnuté správy alebo chýba mobil)</span> : null}
                </p>
              )}
              {info?.last && (
                <Callout tone="warn" data-testid="delay-sms-last">
                  Dnes už bola odoslaná o {hhmm(info.last.at)} ({pac(info.last.count)}{info.last.by ? `, ${info.last.by}` : ""}).
                  {wait > 0 ? ` Ďalšiu môžete poslať o ${wait} min.` : ""}
                </Callout>
              )}
              {info && info.count === 0 && !err && <Callout tone="info">Dnes nie je komu poslať SMS — žiadni nevybavení pacienti s mobilným číslom.</Callout>}
            </>)}
            {err && <Callout tone="danger" role="alert" data-testid="delay-sms-error">{err}</Callout>}

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Btn variant="secondary" onClick={() => setOpen(false)} ref={closeRef} data-testid="delay-sms-close">{sent ? "Zavrieť" : "Zrušiť"}</Btn>
              {!sent && <Btn onClick={send} disabled={!canSend} data-testid="delay-sms-send">{sending ? "Odosielam…" : info?.count ? `Odoslať SMS ${pac(info.count)}` : "Odoslať SMS"}</Btn>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
