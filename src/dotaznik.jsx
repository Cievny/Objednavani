import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { inputCls, labelCls, Btn, Callout } from "./ui.jsx";
import {
  Q, QM, isVisible, rowVisible, applyGates, toggleMany, progress, cleanForSubmit,
  evaluate, reportText, missingNumbers, questionnaireApi, questionnaireLink,
} from "./dotaznikData.js";

// Dotazník pred vyšetrením (v139, dotaznik-001)
//  • PatientQuestionnaire — verejná stránka #/angio1/dotaznik/<kľúč>: pacientka
//    vyplní doma, bez prihlásenia a bez mena; odošle raz.
//  • QuestionnairePanel — v karte objednávky (správa angio): poslať odkaz
//    (SMS + e-mail), QR kód / odkaz, stav; vyšetrujúci lekár otvorí vyhodnotenie
//    a anamnézu do správy. Obsah odpovedí vracia databáza len jemu.

const fmtD = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().map((x, i) => (i < 2 ? String(+x) : x)).join(". ") : "");
const fmtDT = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleString("sk-SK", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return String(iso).slice(0, 16); } };
const chipCls = (on) => `inline-flex items-center text-left text-sm px-3 py-2 min-h-[44px] rounded-lg border transition-colors cursor-pointer ${on ? "bg-brand text-white border-brand" : "bg-white text-ink border-line hover:border-brand"}`;
const draftKey = (token) => `angioQDraft_${token}`;

// ---------- jedna otázka ----------
function Options({ q, state, onOne, onMany }) {
  const idx = q.only || q.o.map((_, i) => i);
  const many = q.k === "many";
  return (
    <div className="flex flex-wrap gap-2" role={many ? "group" : "radiogroup"} aria-label={q.t}>
      {idx.map((i) => {
        const on = many ? Array.isArray(state[q.id]) && state[q.id].includes(i) : state[q.id] === i;
        return (
          <label key={i} className={chipCls(on)}>
            <input type={many ? "checkbox" : "radio"} name={q.id} className="sr-only" checked={on}
              onChange={(e) => (many ? onMany(q.id, i, e.target.checked) : onOne(q.id, i))} />
            {many && <span aria-hidden="true" className={`mr-2 inline-block w-4 h-4 shrink-0 rounded border ${on ? "bg-white border-white" : "border-muted"}`}>{on ? <span className="block text-brand text-xs leading-4 text-center font-bold">✓</span> : null}</span>}
            <span>{q.o[i]}</span>
          </label>
        );
      })}
    </div>
  );
}

function Scale({ q, state, onRow }) {
  const v = state[q.id] || {};
  return (
    <div className="space-y-4">
      {q.r.map((r, ri) => rowVisible(q, ri, state) && (
        <div key={ri} role="radiogroup" aria-label={r}>
          <p className="text-sm text-ink mb-1">{r}</p>
          <div className="grid grid-cols-11 gap-1">
            {Array.from({ length: 11 }, (_, n) => (
              <label key={n} className={`flex items-center justify-center h-10 rounded-md border text-sm tabular-nums cursor-pointer ${v[ri] === n ? "bg-brand text-white border-brand" : "bg-white border-line hover:border-brand"}`}>
                <input type="radio" name={`${q.id}_${ri}`} className="sr-only" checked={v[ri] === n} onChange={() => onRow(q.id, ri, n)} />{n}
              </label>
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted mt-1"><span>{q.e[0]}</span><span>{q.e[1]}</span></div>
        </div>
      ))}
    </div>
  );
}

function Phq({ q, state, onRow }) {
  const v = state[q.id] || {};
  return (
    <div className="space-y-4">
      {q.r.map((r, ri) => (
        <div key={ri} role="radiogroup" aria-label={r}>
          <p className="text-sm text-ink mb-1">{"abcd"[ri]}) {r}</p>
          <div className="flex flex-wrap gap-2">
            {q.o.map((o, n) => (
              <label key={n} className={chipCls(v[ri] === n)}>
                <input type="radio" name={`${q.id}_${ri}`} className="sr-only" checked={v[ri] === n} onChange={() => onRow(q.id, ri, n)} />{o}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Treatments({ q, state, onTx }) {
  const v = state[q.id] || {};
  return (
    <div className="space-y-2">
      {q.r.map((r, ri) => {
        const c = v[ri] || {};
        return (
          <div key={ri} className="border border-line rounded-lg p-3 space-y-2 bg-white">
            <label className={chipCls(Boolean(c.t))}>
              <input type="checkbox" className="sr-only" checked={Boolean(c.t)} onChange={(e) => onTx(q.id, ri, { t: e.target.checked })} />
              <span aria-hidden="true" className={`mr-2 inline-block w-4 h-4 rounded border ${c.t ? "bg-white border-white" : "border-muted"}`}>{c.t ? <span className="block text-brand text-xs leading-4 text-center font-bold">✓</span> : null}</span>
              {r}
            </label>
            {c.t && (
              <>
                <input className={inputCls} maxLength={200} placeholder="Doplňte, ak chcete" value={c.d || ""} onChange={(e) => onTx(q.id, ri, { d: e.target.value })} />
                <p className="text-sm text-ink">Pomohlo?</p>
                <div className="flex flex-wrap gap-2">
                  {q.o.map((o, n) => (
                    <label key={n} className={chipCls(c.e === n)}>
                      <input type="radio" name={`${q.id}_${ri}e`} className="sr-only" checked={c.e === n} onChange={() => onTx(q.id, ri, { e: n })} />{o}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Question({ q, state, set }) {
  const k = q.k;
  let body = null;
  if (k === "one" || k === "many") body = <Options q={q} state={state} onOne={set.one} onMany={set.many} />;
  else if (k === "scale") body = <Scale q={q} state={state} onRow={set.row} />;
  else if (k === "phq") body = <Phq q={q} state={state} onRow={set.row} />;
  else if (k === "tx") body = <Treatments q={q} state={state} onTx={set.tx} />;
  else if (k === "long") body = <textarea className={`${inputCls} min-h-[84px]`} maxLength={1500} value={state[q.id] || ""} onChange={(e) => set.val(q.id, e.target.value)} />;
  else if (k === "fields") body = (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {q.f.map(([fid, l]) => (
        <label key={fid} className="text-sm text-muted">{l}
          <input type="number" inputMode="numeric" min="0" className={`${inputCls} mt-1`} value={state[fid] ?? ""} onChange={(e) => set.val(fid, e.target.value)} />
        </label>
      ))}
    </div>
  );
  else body = (
    <input type={k === "num" ? "number" : k === "date" ? "date" : "text"} inputMode={k === "num" ? "numeric" : undefined} maxLength={k === "text" ? 300 : undefined}
      className={`${inputCls} ${k === "text" ? "" : "max-w-[14rem]"}`} value={state[q.id] ?? ""} onChange={(e) => set.val(q.id, e.target.value)} />
  );
  const main = Boolean(q.n || q.g);
  return (
    <div className={`py-4 ${main ? "border-t border-line first:border-t-0" : "pt-1"}`} data-q={q.id}>
      <p className={`mb-2 ${main ? "font-semibold text-ink" : "text-sm text-ink"}`}>
        {q.t}{q.m ? <span className="font-normal text-muted text-sm"> (môžete označiť viac)</span> : null}{q.h ? <span className="font-normal text-muted text-sm"> ({q.h})</span> : null}
      </p>
      {body}
    </div>
  );
}

// ---------- pacientka ----------
export function PatientQuestionnaire({ token }) {
  const [phase, setPhase] = useState("loading"); // loading | open | invalid | expired | submitted | done | error
  const [slotDate, setSlotDate] = useState(null);
  const [state, setState] = useState(() => { try { return JSON.parse(localStorage.getItem(draftKey(token)) || "{}"); } catch { return {}; } });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const topRef = useRef(null);

  useEffect(() => {
    let on = true;
    questionnaireApi.open(token).then((r) => { if (!on) return; setSlotDate(r.slotDate); setPhase(r.state); })
      .catch((e) => { if (on) { setMsg(e?.message || String(e)); setPhase("error"); } });
    return () => { on = false; };
  }, [token]);
  // rozpracované odpovede v tomto prehliadači (zmažú sa po odoslaní)
  useEffect(() => { if (phase === "open") { try { localStorage.setItem(draftKey(token), JSON.stringify(state)); } catch { /* bez úložiska */ } } }, [state, phase, token]);

  const upd = (fn) => setState((s) => applyGates(fn(s)));
  const set = {
    one: (id, v) => upd((s) => ({ ...s, [id]: v })),
    many: (id, v, ch) => upd((s) => toggleMany(s, id, v, ch)),
    row: (id, ri, v) => upd((s) => ({ ...s, [id]: { ...(s[id] || {}), [ri]: v } })),
    tx: (id, ri, patch) => upd((s) => ({ ...s, [id]: { ...(s[id] || {}), [ri]: { ...((s[id] || {})[ri] || {}), ...patch } } })),
    val: (id, v) => setState((s) => ({ ...s, [id]: v })),
  };
  const sections = useMemo(() => {
    const out = []; let cur = null;
    Q.forEach((q) => { if (q.s) { cur = { s: q.s, d: q.d, items: [] }; out.push(cur); } else cur.items.push(q); });
    return out;
  }, []);
  const p = progress(state);

  const submit = async () => {
    setMsg(""); setBusy(true);
    try {
      await questionnaireApi.submit(token, cleanForSubmit(state));
      try { localStorage.removeItem(draftKey(token)); } catch { /* nič */ }
      setPhase("done"); topRef.current?.scrollIntoView({ block: "start" });
    } catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); }
  };

  const Head = ({ children }) => (
    <div ref={topRef} className="rounded-xl bg-brand-dark text-white p-6 md:p-8 border border-line">
      <p className="text-xs font-semibold text-white/70">Národný ústav srdcových a cievnych chorôb, a.s. · Angiologická ambulancia č. 1</p>
      <h1 className="text-2xl md:text-3xl font-semibold leading-tight mt-1">Dotazník pred vyšetrením</h1>
      {children}
    </div>
  );

  if (phase === "loading") return <div className="bg-white rounded-xl border border-line p-6 text-center text-muted">Načítavam dotazník…</div>;
  if (phase !== "open") {
    const text = {
      done: ["Ďakujeme, dotazník sme prijali.", "Odpovede uvidí lekár, ktorý vás vyšetrí. Nič ďalšie netreba robiť. Pri náhlom zhoršení stavu volajte 155."],
      submitted: ["Dotazník už bol odoslaný.", "Ďakujeme. Vyplniť sa dá len raz — ak chcete niečo doplniť, povedzte to lekárovi pri vyšetrení."],
      expired: ["Dotazník sa už nedá vyplniť.", "Termín vyšetrenia prebehol alebo bol zrušený. Ak ste objednaná, prejdeme otázky spolu pri vyšetrení."],
      invalid: ["Odkaz na dotazník je neplatný.", "Skontrolujte, prosím, či ste otvorili celý odkaz zo SMS alebo e-mailu. Ak problém pretrváva, nič sa nedeje — otázky prejdeme pri vyšetrení."],
      error: ["Dotazník sa nepodarilo načítať.", msg || "Skúste to, prosím, o chvíľu znova."],
    }[phase] || ["", ""];
    return (
      <div className="space-y-4" data-testid={`q-${phase}`}>
        <Head><p className="text-lg mt-4 font-semibold">{text[0]}</p><p className="text-sm text-white/90 mt-1 max-w-xl">{text[1]}</p></Head>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="q-form">
      <Head>
        {slotDate && <p className="text-sm text-white/90 mt-2">Vyšetrenie dňa <b>{fmtD(slotDate)}</b></p>}
        <p className="text-sm text-white/90 mt-2 max-w-xl">
          Dotazník lekárovi pomôže pripraviť sa na vyšetrenie. Trvá asi 10 minút. Nepýta sa na meno ani rodné číslo a odpovede uvidí len lekár, ktorý vás vyšetrí.
          Na otázku, na ktorú nechcete odpovedať, neodpovedajte.
        </p>
      </Head>

      <div className="sticky top-[47px] z-10 bg-page/95 backdrop-blur border-b border-line py-2 flex items-center gap-3">
        <div className="flex-1 h-1.5 bg-soft rounded-full overflow-hidden" aria-hidden="true"><div className="h-full bg-brand transition-all" style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} /></div>
        <span className="text-xs text-muted tabular-nums whitespace-nowrap">{p.done} / {p.total}</span>
      </div>

      {sections.map((sec, si) => (
        <section key={sec.s} className="bg-white rounded-xl border border-line p-5 md:p-6">
          <h2 className="text-lg font-semibold text-brand-dark">{sec.s}</h2>
          {sec.d && <p className="text-sm text-muted mt-1">{sec.d}</p>}
          {si === 0 && (
            <div className="grid grid-cols-2 gap-3 mt-3 max-w-sm">
              <label className={labelCls}>Výška (cm)<input type="number" inputMode="numeric" min="100" max="220" className={`${inputCls} mt-1 font-normal`} value={state.ht ?? ""} onChange={(e) => set.val("ht", e.target.value)} /></label>
              <label className={labelCls}>Hmotnosť (kg)<input type="number" inputMode="decimal" min="25" max="250" className={`${inputCls} mt-1 font-normal`} value={state.wt ?? ""} onChange={(e) => set.val("wt", e.target.value)} /></label>
            </div>
          )}
          <div>{sec.items.filter((q) => isVisible(q, state)).map((q) => <Question key={q.id} q={q} state={state} set={set} />)}</div>
        </section>
      ))}

      <div className="bg-white rounded-xl border border-line p-5 md:p-6 space-y-3">
        <p className="text-sm text-ink">Skontrolujte, prosím, či ste nevynechali otázku, na ktorú chcete odpovedať. Po odoslaní sa odpovede už nedajú zmeniť.</p>
        {msg && <Callout tone="danger" role="alert">{msg}</Callout>}
        <Btn size="lg" onClick={submit} disabled={busy} data-testid="q-submit">{busy ? "Odosielam…" : "Odoslať dotazník"}</Btn>
        <p className="text-xs text-muted">Pri náhlom zhoršení stavu nečakajte na vyšetrenie a volajte 155.</p>
      </div>
    </div>
  );
}

// ---------- lekár: vyhodnotenie a text do správy ----------
function Items({ items, empty }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((x, i) => (
        <li key={i} className={`rounded-lg px-3 py-2 text-sm ${x.lvl === "red" ? "bg-danger-soft border border-danger/30" : x.lvl === "flag" ? "bg-warn-soft border border-warn/30" : "bg-white border border-line"}`}>
          <b className={x.lvl === "red" ? "text-danger" : "text-ink"}>{x.t}</b>
          {x.d && <span className="block text-ink">{x.d}</span>}
          {x.s && <span className="block text-xs text-muted">{x.s}</span>}
        </li>
      ))}
    </ul>
  );
}

function ScaleTable({ id, answers, title }) {
  const q = QM[id]; const v = answers[id] || {};
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead><tr className="text-xs text-muted text-left"><th className="py-1 pr-2 font-semibold">{title}</th><th className="py-1 text-right font-semibold">0–10</th></tr></thead>
        <tbody>{q.r.map((r, i) => <tr key={i} className="border-t border-line"><td className="py-1 pr-2">{r}</td><td className="py-1 text-right font-semibold">{v[i] ?? "—"}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function QuestionnaireReport({ data }) {
  const meta = { birthYear: data.birthYear, submittedAt: data.submittedAt, orderId: data.orderId };
  const E = useMemo(() => evaluate(data.answers, meta), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = useMemo(() => reportText(data.answers, meta), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const miss = useMemo(() => missingNumbers(applyGates(data.answers || {})), [data]);
  const [copied, setCopied] = useState("");
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied("Skopírované."); } catch { setCopied("Kopírovanie zlyhalo — označte text ručne."); } };
  return (
    <div className="bg-white border border-line rounded-lg p-3 md:p-4 space-y-4" data-testid="q-report">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className={`text-3xl font-semibold tabular-nums ${E.red.length ? "text-danger" : "text-success"}`}>{E.red.length}</span>
        <span className="font-semibold text-ink">{E.red.length ? "varovné príznaky" : "bez varovných príznakov"}</span>
        <span className="text-sm text-muted">vek {E.age ?? "—"} · BMI {E.bmi ? E.bmi.toFixed(1).replace(".", ",") : "—"} · venózne znaky {E.ven.length} · vyplnené {fmtDT(data.submittedAt)}</span>
      </div>
      <p className="text-xs text-muted">Kľúč pre lekára. Dotazník nie je validovaný diagnostický test a nemá skóre ani prah. Hmatnú rezistenciu overiť vyšetrením.</p>
      <div><h4 className="text-sm font-semibold text-brand-dark mb-1">Varovné príznaky — riešiť pred úvahou o embolizácii</h4><Items items={E.red} empty="Pacientka žiadny neuviedla." />{E.ctx.length > 0 && <div className="mt-2"><Items items={E.ctx} empty="" /></div>}</div>
      <div><h4 className="text-sm font-semibold text-brand-dark mb-1">Anamnestické znaky venózneho pôvodu</h4><Items items={E.ven} empty="Žiadne z položiek kľúča." /></div>
      <div><h4 className="text-sm font-semibold text-brand-dark mb-1">Skríning nevenóznych príčin</h4><p className="text-xs text-muted mb-1">Prahy z validačných štúdií jednotlivých nástrojov; pozitívny skríning venóznu príčinu nevylučuje.</p><Items items={E.scr} empty="" /></div>
      <div><h4 className="text-sm font-semibold text-brand-dark mb-1">Plánovanie výkonu</h4><Items items={E.proc} empty="Bez záznamu." /></div>
      <div className="grid sm:grid-cols-2 gap-4"><ScaleTable id="q3" answers={data.answers} title="Bolesť" /><ScaleTable id="q34" answers={data.answers} title="Obmedzenie za mesiac" /></div>
      <div>
        <h4 className="text-sm font-semibold text-brand-dark mb-1">Anamnéza do správy</h4>
        <p className="text-xs text-muted mb-1">Text skladá šablóna len z vyplnených odpovedí; nič nedopĺňa. Odpoveď na otázku o násilí sa do textu nevkladá.</p>
        <textarea readOnly className="w-full p-3 bg-soft border border-line rounded-lg text-sm text-ink min-h-[360px]" value={text} data-testid="q-text" />
        <div className="flex flex-wrap items-center gap-2 mt-2"><Btn size="sm" onClick={copy}>📋 Kopírovať do správy</Btn>{copied && <span className="text-xs text-muted" aria-live="polite">{copied}</span>}</div>
        {miss.length > 0 && <p className="text-xs text-muted mt-1">Nezodpovedané otázky: {miss.join(", ")}</p>}
      </div>
    </div>
  );
}

// ---------- karta objednávky: poslať / stav / otvoriť ----------
function Qr({ link }) {
  const [src, setSrc] = useState("");
  useEffect(() => { let on = true; QRCode.toDataURL(link, { width: 220, margin: 1 }).then((u) => on && setSrc(u)).catch(() => {}); return () => { on = false; }; }, [link]);
  const [copied, setCopied] = useState("");
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied("Odkaz skopírovaný."); } catch { setCopied("Kopírovanie zlyhalo."); } };
  return (
    <div className="flex flex-wrap items-start gap-3 bg-white border border-line rounded-lg p-3">
      {src ? <img src={src} alt="QR kód dotazníka" width="140" height="140" className="rounded" /> : <div className="w-[140px] h-[140px] bg-soft rounded" />}
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs text-muted">Pacientka naskenuje QR kód mobilom (napr. pri telefonickom objednaní ho pošlite alebo vytlačte). Odkaz neobsahuje meno ani iné údaje.</p>
        <p className="text-xs font-mono break-all text-ink">{link}</p>
        <div className="flex items-center gap-2"><Btn size="sm" variant="secondary" onClick={copy}>Kopírovať odkaz</Btn>{copied && <span className="text-xs text-muted">{copied}</span>}</div>
      </div>
    </div>
  );
}

export function QuestionnairePanel({ order }) {
  const [st, setSt] = useState(undefined); // undefined = načítavam, null = bez oprávnenia / bez databázy
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [info, setInfo] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [report, setReport] = useState(null);
  const active = order.status === "new" || order.status === "confirmed";

  const load = () => questionnaireApi.status(order.id).then(setSt).catch(() => setSt(null));
  useEffect(() => { load(); }, [order.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (st === undefined || st === null) return null;
  if (!st.exists && !(active && st.canSend)) return null;

  const run = async (fn) => { setMsg(""); setInfo(""); setBusy(true); try { await fn(); } catch (e) { setMsg(e?.message || String(e)); } finally { setBusy(false); } };
  const send = (really) => run(async () => {
    const r = await questionnaireApi.send(order.id, really);
    if (really) setInfo(r.warning || (r.sentVia ? `Odoslané: ${r.sentVia}.` : ""));
    if (!really || r.warning) setShowQr(true);
    await load();
  });
  const open = () => run(async () => { if (report) { setReport(null); return; } setReport(await questionnaireApi.get(order.id)); });
  const link = st.token ? questionnaireLink(st.token) : "";

  return (
    <div className="bg-white/70 border border-line rounded-lg p-3 space-y-2" data-testid="q-panel" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">Dotazník pred vyšetrením (panvová bolesť)</span>
        {st.submittedAt ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-success-soft text-success">vyplnený {fmtDT(st.submittedAt)}</span>
          : st.sentAt ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-warn-soft text-warn">odoslaný {fmtDT(st.sentAt)}{st.sentVia ? ` (${st.sentVia})` : ""} · čaká</span>
          : st.exists ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-soft text-muted">odkaz pripravený, neodoslaný</span> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {!st.submittedAt && active && st.canSend && (
          <>
            <Btn size="sm" disabled={busy} onClick={() => send(true)} data-testid="q-send">{st.sentAt ? "Poslať znova (SMS + e-mail)" : "Poslať dotazník (SMS + e-mail)"}</Btn>
            <Btn size="sm" variant="secondary" disabled={busy} onClick={() => (st.token ? setShowQr((x) => !x) : send(false))}>{showQr ? "Skryť QR kód" : "QR kód / odkaz"}</Btn>
          </>
        )}
        {st.submittedAt && st.canRead && <Btn size="sm" disabled={busy} onClick={open} data-testid="q-open">{report ? "Zavrieť dotazník" : "Otvoriť vyhodnotenie a anamnézu"}</Btn>}
      </div>
      {st.submittedAt && !st.canRead && <p className="text-xs text-muted">Odpovede vidí len lekár, ku ktorému je pacientka objednaná.</p>}
      {info && <p className="text-xs text-ink">{info}</p>}
      {msg && <p className="text-xs text-danger font-semibold" role="alert">{msg}</p>}
      {showQr && link && !st.submittedAt && <Qr link={link} />}
      {report && <QuestionnaireReport data={report} />}
    </div>
  );
}

