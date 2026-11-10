import { useEffect, useState } from "react";
import { useMsg } from "./toast.jsx";
import { normalizeDoctors } from "./booking.jsx";
import { useCtData } from "./podappkyData.js";
import { AngioAdmin } from "./angio.jsx";
import { ctDoctorApi, ctDoctorUrl } from "./ctDoctor.jsx";

import { inputSmCls as inp } from "./ui.jsx";

// ---------- Karta CT objednávky (správa) ----------
// Karta a správa CT: od v112 sa používa zdieľaná správa z angio.jsx (AngioAdmin, clinic="ct").

// Prístup lekárov NÚSCH (ct-lekari-001): spoločné heslo nastavuje superadmin
function DoctorAccessCard({ isSuper }) {
  const [info, setInfo] = useState(null);
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useMsg();
  const url = ctDoctorUrl();
  const load = () => ctDoctorApi.passwordInfo().then(setInfo).catch((e) => setInfo({ error: e.message }));
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (pw.length < 8) { setMsg("Heslo musí mať aspoň 8 znakov."); return; }
    if (info?.set && !window.confirm("Nastaviť nové heslo? Všetci prihlásení lekári budú odhlásení a budú potrebovať nové heslo.")) return;
    try { await ctDoctorApi.setPassword(pw); setPw(""); setMsg("✓ Heslo pre lekárov uložené."); load(); } catch (e) { setMsg(e.message); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(url); setMsg("✓ Odkaz skopírovaný."); } catch { setMsg("Odkaz sa nepodarilo skopírovať."); } };
  const when = info?.updatedAt ? new Date(info.updatedAt).toLocaleString("sk-SK", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="bg-white rounded-xl border border-line p-5 space-y-3" data-testid="ct-doctor-access">
      <h3 className="text-lg font-semibold text-brand">Prístup pre lekárov NÚSCH</h3>
      <p className="text-sm text-ink">Lekári posielajú žiadosti o CT termín na stránke <a href={url} target="_blank" rel="noreferrer" className="text-brand font-semibold hover:underline break-all" data-testid="ct-doctor-link">{url}</a> so spoločným heslom. Žiadosti sa tu objavia ako „Nová" — potvrďte, presuňte alebo zrušte ich.</p>
      <button type="button" onClick={copy} className="text-xs bg-soft hover:bg-line text-ink font-semibold px-3 py-1.5 rounded-lg">📋 Kopírovať odkaz</button>
      {info?.error ? <p className="text-sm text-danger">{info.error}</p>
        : info && (info.set
          ? <p className="text-sm text-success font-semibold">Heslo je nastavené{when ? ` (${when}${info.updatedBy ? `, ${info.updatedBy}` : ""})` : ""}.{info.activeSessions ? ` Prihlásení lekári: ${info.activeSessions}.` : ""}</p>
          : <p className="text-sm text-warn font-semibold">Heslo ešte nie je nastavené — lekári sa nemôžu prihlásiť.</p>)}
      {isSuper ? (
        <div className="flex flex-wrap gap-2 items-center">
          <input type={show ? "text" : "password"} autoComplete="new-password" className={inp + " max-w-xs"} placeholder="nové heslo (min. 8 znakov)" value={pw} onChange={(e) => setPw(e.target.value)} data-testid="ct-doctor-pw" />
          <label className="text-xs text-muted flex items-center gap-1"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> zobraziť</label>
          <button type="button" onClick={save} className="bg-brand hover:bg-brand-dark text-white text-sm font-semibold px-4 py-2 rounded-lg" data-testid="ct-doctor-pw-save">{info?.set ? "Zmeniť heslo" : "Nastaviť heslo"}</button>
        </div>
      ) : <p className="text-xs text-muted">Heslo nastavuje a mení superadmin.</p>}
      <p className="text-xs text-muted">Heslo meňte, keď lekár odíde z ústavu alebo keď sa heslo dostane k nepovolanej osobe. Zmena hneď odhlási všetkých lekárov. Odovzdávajte ho osobne alebo telefonicky, nie e-mailom.</p>
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-success" : "text-danger"}`}>{msg}</p>}
    </div>
  );
}

function CtSettings({ data, isSuper }) {
  const [exams, setExams] = useState(() => data.pricelist.map((p) => ({ ...p })));
  const [docs, setDocs] = useState(() => normalizeDoctors(data.doctors));
  const [msg, setMsg] = useMsg();
  const slug = () => "ct_" + Math.random().toString(36).slice(2, 10);
  // presun typu v zozname (poradie = sort_order = poradie pre pacienta)
  const move = (i, d) => setExams((p) => { const j = i + d; if (j < 0 || j >= p.length) return p; const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const saveExams = () => { setMsg(""); data.savePricelist(exams.filter((e) => e.label.trim())).then(() => setMsg("✓ Typy CT vyšetrení uložené.")).catch((e) => setMsg(e.message)); };
  const saveDocs = () => { setMsg(""); data.saveDoctors(docs.filter((d) => d.name.trim())).then(() => setMsg("✓ CT lekári uložení.")).catch((e) => setMsg(e.message)); };

  return (
    <div className="space-y-5">
      <DoctorAccessCard isSuper={isSuper} />
      {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-success" : "text-danger"}`}>{msg}</p>}

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">Typy CT vyšetrení</h3>
        <p className="text-xs text-muted">Poradie v zozname je poradie, v akom typy uvidia lekári pri žiadosti — šípkami ▲▼ ho zmeníte a uložte.</p>
        {exams.map((e, i) => (
          <div key={e.id} className="border border-line rounded-lg p-3 space-y-2">
            <div className="flex gap-2">
              <input className={inp} placeholder="Názov vyšetrenia" value={e.label} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, label: ev.target.value } : x))} />
              <label className="text-sm shrink-0">Trvanie<br />
                <select className={inp} value={e.durationSlots} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, durationSlots: Number(ev.target.value) } : x))}>
                  {[2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n * 5} min</option>)}
                </select>
              </label>
              <div className="flex flex-col shrink-0 self-start pt-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Posunúť vyššie" aria-label="Posunúť vyššie" className="text-muted hover:text-brand text-xs leading-none px-1 py-0.5 disabled:opacity-50">▲</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === exams.length - 1} title="Posunúť nižšie" aria-label="Posunúť nižšie" className="text-muted hover:text-brand text-xs leading-none px-1 py-0.5 disabled:opacity-50">▼</button>
              </div>
              <button onClick={() => setExams((p) => p.filter((_, j) => j !== i))} className="text-danger text-sm shrink-0 self-start pt-2">✕</button>
            </div>
            <textarea className={inp} rows={2} placeholder="Pokyny / príprava" value={e.instructions} onChange={(ev) => setExams((p) => p.map((x, j) => j === i ? { ...x, instructions: ev.target.value } : x))} />
          </div>
        ))}
        <button onClick={() => setExams((p) => [...p, { id: slug(), label: "", instructions: "", durationSlots: 3 }])} className="bg-soft text-ink text-sm font-semibold px-4 py-2 rounded-lg">+ Pridať vyšetrenie</button>
        <div><button onClick={saveExams} className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť typy vyšetrení</button></div>
      </div>

      <div className="bg-white rounded-xl border border-line p-5 space-y-3">
        <h3 className="text-lg font-semibold text-brand">CT lekári</h3>
        {!isSuper && <p className="text-xs text-warn">Zoznam lekárov môže meniť len superadmin.</p>}
        {docs.map((d, i) => (
          <div key={i} className="border border-line rounded-lg p-3 space-y-2">
            <div className="flex gap-2">
              <input className={inp} placeholder="MUDr. Meno Priezvisko" value={d.name} onChange={(e) => setDocs((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} disabled={!isSuper} />
              <button onClick={() => setDocs((p) => p.filter((_, j) => j !== i))} className="text-danger text-sm shrink-0 self-start pt-2" disabled={!isSuper}>✕</button>
            </div>
            <input className={inp} placeholder="Ambulancia / miesto" value={d.location} onChange={(e) => setDocs((p) => p.map((x, j) => j === i ? { ...x, location: e.target.value } : x))} disabled={!isSuper} />
            <div className="flex flex-wrap gap-2">
              {data.pricelist.map((ex) => {
                const on = (d.examTypeIds || []).includes(ex.id);
                return (
                  <button key={ex.id} disabled={!isSuper}
                    onClick={() => setDocs((p) => p.map((x, j) => j === i ? { ...x, examTypeIds: on ? x.examTypeIds.filter((t) => t !== ex.id) : [...(x.examTypeIds || []), ex.id] } : x))}
                    className={`text-xs px-2 py-1 rounded-lg border ${on ? "bg-brand text-white border-brand" : "bg-white text-muted border-line"}`}>{ex.label}</button>
                );
              })}
            </div>
            <p className="text-xs text-muted">Ak nevyberiete žiadne, lekár robí všetky.</p>
          </div>
        ))}
        {isSuper && <button onClick={() => setDocs((p) => [...p, { name: "", email: "", location: "", examTypeIds: [] }])} className="bg-soft text-ink text-sm font-semibold px-4 py-2 rounded-lg">+ Pridať lekára</button>}
        {isSuper && <div><button onClick={saveDocs} className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-lg">Uložiť lekárov</button></div>}
      </div>
    </div>
  );
}

export default function CtApp({ isStaff, role = "superadmin", doctorName = "" }) {
  const data = useCtData(isStaff);
  return (
    <div className="space-y-4">
      <div className="bg-brand-soft border border-line text-brand rounded-lg px-4 py-3 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
        <span>CT pracovisko — správa objednávok{data.pendingCount > 0 ? ` · žiadosti na potvrdenie: ${data.pendingCount}` : ""}</span>
        <span className="flex flex-wrap gap-3">
          <a href={ctDoctorUrl()} target="_blank" rel="noreferrer" className="hover:underline" data-testid="ct-doctor-page">Stránka pre lekárov ›</a>
          <a href="#/sprava" className="hover:underline">← Späť do správy</a>
        </span>
      </div>
      <AngioAdmin data={data} role={role} clinic="ct" SettingsView={CtSettings} doctorName={doctorName} />
    </div>
  );
}
