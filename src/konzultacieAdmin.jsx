import { useEffect, useMemo, useState } from "react";
import { inputCls, inputSmCls, labelCls, Btn, Card, Callout } from "./ui.jsx";
import { showToast } from "./toast.jsx";
import { CATEGORIES, CATEGORY_ORDER, PRIORITY_LABEL, RED_FLAGS, OUTCOMES, REPLY_TEMPLATES, RULES_OVERVIEW, TOPICS, topicById, summarize, triageSort } from "./triaz.js";
import { useConsultRequests, smsPlain, SMS_MAX } from "./konzultacieData.js";

// Konzultácie — prehľad žiadostí z verejného formulára (#/konzultacie, len personál).
// Žiadosti sú zoradené podľa NÁVRHU zaradenia (src/triaz.js); rozhodnutie a odpoveď
// sú vždy na lekárovi. Odpovedať môže superadmin a lekár, sestra len číta.
// GDPR: vybavením sa žiadosť IHNEĎ a natrvalo maže — ostáva len anonymný počet.

const CHIP = {
  akutne: "bg-danger text-white", ustav: "bg-brand text-white", posudit: "bg-warn-soft text-warn border border-warn/30",
  angiolog: "bg-soft text-ink border border-line", obvodny: "bg-white text-muted border border-line",
};
const ACCENT = { akutne: "border-l-danger", ustav: "border-l-brand", posudit: "border-l-warn", angiolog: "border-l-line", obvodny: "border-l-line" };
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES);
const CONTACT_LABEL = { sms: "SMS", email: "E-mail", instagram: "Instagram" };
const publicLink = () => `${window.location.origin}${window.location.pathname.replace(/sprava\/?$/, "")}konzultacia/`;
const fmt = (d) => (d ? new Date(d).toLocaleString("sk-SK", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const daysAgo = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
const ago = (d) => { const n = daysAgo(d); return n === 0 ? "dnes" : n === 1 ? "včera" : `pred ${n} dňami`; };
const copyText = async (text, okMsg) => {
  try { await navigator.clipboard.writeText(text); showToast(okMsg); return true; }
  catch { showToast("Nepodarilo sa skopírovať — označte text a skopírujte ho ručne.", "err"); return false; }
};

function Contact({ r }) {
  const cls = "font-semibold text-brand hover:underline break-all";
  if (r.contactType === "sms") return <a className={cls} href={`tel:${r.contact}`}>{r.contact}</a>;
  if (r.contactType === "email") return <a className={cls} href={`mailto:${r.contact}`}>{r.contact}</a>;
  return <a className={cls} href={`https://www.instagram.com/${encodeURIComponent(r.contact)}/`} target="_blank" rel="noreferrer">@{r.contact} ↗</a>;
}

function Details({ r }) {
  const rows = summarize(r);
  const flags = r.flags.map((f) => RED_FLAGS.find((x) => x.id === f)).filter(Boolean);
  return (
    <div className="space-y-3">
      {flags.length > 0 && (
        <Callout tone="danger"><b>Pacient označil akútne príznaky:</b>
          <ul className="list-disc ml-5 mt-1">{flags.map((f) => <li key={f.id}>{f.label}</li>)}</ul>
          <p className="mt-1 text-xs">Pokyn (155 / lekár ešte dnes) dostal hneď na obrazovke.</p>
        </Callout>
      )}
      {rows.length > 0 && (
        <dl className="text-sm divide-y divide-line border border-line rounded-lg bg-white">
          {rows.map(([k, v]) => (
            <div key={k} className="px-3 py-1.5 sm:flex sm:gap-3">
              <dt className="text-muted sm:w-1/2">{k}</dt><dd className="font-semibold text-ink sm:w-1/2">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">Vlastnými slovami</p>
        {r.note ? <p className="text-sm text-ink whitespace-pre-wrap break-words bg-page border border-line rounded-lg px-3 py-2" data-testid="konz-a-note">{r.note}</p>
          : <p className="text-sm text-muted">— bez popisu —</p>}
      </div>
    </div>
  );
}

// čitateľný výpis dotazníka do e-mailu lekárovi (pri rozhodnutí „pozvať k nám")
const forwardSummary = (r) => {
  const flags = r.flags.map((f) => RED_FLAGS.find((x) => x.id === f)).filter(Boolean);
  return [
    `Téma: ${topicById(r.topic)?.label || r.topic}`,
    ...summarize(r).map(([q, a]) => `${q} — ${a}`),
    ...(flags.length ? [`Akútne príznaky označené pacientom: ${flags.map((f) => f.short).join("; ")}`] : []),
    `Návrh zaradenia: ${CATEGORIES[r.triage.category].label} · ${PRIORITY_LABEL[r.triage.priority]} — ${r.triage.reasons.join(" · ")}`,
  ].join("\n");
};

// Rozhodnutie a odpoveď. Každé vybavenie sa potvrdzuje — žiadosť sa tým natrvalo zmaže.
function ReplyPanel({ r, onResolve, forwardEmail = "" }) {
  const failed = r.status === "failed";
  const suggested = !failed && OUTCOME_LABEL[r.triage.category] ? r.triage.category : "";
  const tpl = (o) => REPLY_TEMPLATES[o] || REPLY_TEMPLATES.posudit;
  const [outcome, setOutcome] = useState(r.outcome || suggested);
  const [reply, setReply] = useState(r.replyText || tpl(r.outcome || suggested));
  const [touched, setTouched] = useState(Boolean(r.replyText));
  const [confirm, setConfirm] = useState(""); // "" | "send" | "close"
  const [fwd, setFwd] = useState(true); // pri „pozvať k nám" poslať celú žiadosť na pracovný e-mail lekára
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isSms = r.contactType === "sms", isIg = r.contactType === "instagram";
  const smsLen = isSms ? smsPlain(reply).length : 0;
  const tooLong = isSms ? smsLen > SMS_MAX : reply.length > 2000;
  const pick = (o) => { setOutcome(o); setErr(""); setConfirm(""); if (!touched) setReply(tpl(o)); };
  const check = (needReply) => {
    if (!outcome) return "Vyberte rozhodnutie.";
    if (needReply && reply.trim().length < 10) return "Napíšte odpoveď pacientovi.";
    if (needReply && tooLong) return isSms ? "SMS je príliš dlhá — skráťte ju." : "Text je príliš dlhý.";
    return "";
  };
  const canForward = !failed && outcome === "ustav";
  const forward = canForward && fwd && Boolean(forwardEmail);
  const ask = (kind) => { const e = check(kind === "send"); if (e) { setErr(e); setConfirm(""); } else { setErr(""); setConfirm(kind); } };
  const run = async () => {
    const send = confirm === "send";
    setBusy(true); setErr("");
    try {
      const res = await onResolve(r.id, { outcome, reply: reply.trim(), send, forward, summary: forward ? forwardSummary(r) : "" });
      showToast((res?.sent === "sms" ? "SMS odoslaná — žiadosť sa maže" : res?.sent === "email" ? "E-mail odoslaný — žiadosť sa maže" : "Žiadosť vybavená a zmazaná")
        + (res?.forwarded ? " · kópia ide na váš pracovný e-mail" : ""));
    } catch (x) { setErr(x?.message || String(x)); setBusy(false); setConfirm(""); }
  };

  return (
    <div className="border-t border-line pt-4 space-y-3" data-testid="konz-reply-panel">
      <fieldset>
        <legend className={labelCls}>Rozhodnutie</legend>
        <div className="flex flex-wrap gap-2">
          {OUTCOMES.map(([o, label]) => (
            <button key={o} type="button" aria-pressed={outcome === o} onClick={() => pick(o)} data-testid={`konz-outcome-${o}`}
              className={`text-sm font-semibold px-3 py-2 rounded-lg border transition-colors ${outcome === o ? "bg-brand text-white border-brand" : "bg-white text-ink border-line hover:border-brand"}`}>
              {label}{o === suggested ? " · návrh" : ""}
            </button>
          ))}
        </div>
      </fieldset>
      <div>
        <div className="flex items-end justify-between gap-2">
          <label className={labelCls} htmlFor={`rp-${r.id}`}>Odpoveď pacientovi <span className="font-normal text-muted">({isIg ? "na Instagram ju pošlete sami" : `odíde ako ${isSms ? "SMS" : "e-mail"}`})</span></label>
          {touched && outcome && <button type="button" className="text-xs text-brand font-semibold hover:underline mb-1" onClick={() => { setReply(tpl(outcome)); setTouched(false); setConfirm(""); }}>Vrátiť šablónu</button>}
        </div>
        <textarea id={`rp-${r.id}`} rows={4} className={inputCls + (tooLong ? " border-danger" : "")} value={reply} data-testid="konz-reply"
          onChange={(e) => { setReply(e.target.value); setTouched(true); setErr(""); setConfirm(""); }} />
        {isSms && <p className={`text-xs mt-1 ${tooLong ? "text-danger font-semibold" : "text-muted"}`} data-testid="konz-sms-len">{smsLen} / {SMS_MAX} znakov · SMS odíde bez diakritiky a začína slovom „NUSCH:“{smsLen > 153 ? ` · ${Math.ceil((smsLen + 7) / 153)} SMS` : ""}</p>}
      </div>
      {canForward && (
        <label className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${forwardEmail ? "cursor-pointer border-brand/40 bg-brand-soft" : "border-line bg-soft text-muted"}`} data-testid="konz-forward-box">
          <input type="checkbox" className="mt-1 accent-brand shrink-0" checked={forward} disabled={!forwardEmail} onChange={(e) => { setFwd(e.target.checked); setConfirm(""); }} data-testid="konz-forward" />
          {forwardEmail
            ? <span>Poslať celú žiadosť na môj pracovný e-mail <b className="break-all">{forwardEmail}</b> <span className="text-muted">— aby ste mali podľa čoho pacienta objednať</span></span>
            : <span>Žiadosť sa dá poslať na váš pracovný e-mail — adresu najprv nastavte nižšie v časti „Upozornenia e-mailom“.</span>}
        </label>
      )}
      {err && <Callout tone="danger" role="alert" data-testid="konz-reply-error">{err}</Callout>}
      {confirm ? (
        <Callout tone="warn" className="flex flex-wrap items-center gap-2" data-testid="konz-confirm">
          <span className="grow">
            {confirm === "send" ? <>Odoslať {isSms ? "SMS" : "e-mail"} na <b>{r.contact}</b>? </> : null}
            Žiadosť sa tým zo systému <b>natrvalo zmaže</b> — nedá sa vrátiť.
            {forward ? <> Kópia celej žiadosti pôjde na <b>{forwardEmail}</b>.</> : null}
          </span>
          <Btn disabled={busy} onClick={run} data-testid="konz-confirm-yes">{busy ? "Pracujem…" : confirm === "send" ? "Áno, odoslať a zmazať" : "Áno, vybaviť a zmazať"}</Btn>
          <Btn variant="secondary" disabled={busy} onClick={() => setConfirm("")}>Späť</Btn>
        </Callout>
      ) : isIg ? (
        <div className="flex flex-wrap gap-2 items-center">
          <Btn variant="outline" onClick={() => copyText(reply.trim(), "Odpoveď skopírovaná")} data-testid="konz-copy">📋 Kopírovať odpoveď</Btn>
          <Btn variant="outline" href={`https://www.instagram.com/${encodeURIComponent(r.contact)}/`} target="_blank" rel="noreferrer">Otvoriť Instagram ↗</Btn>
          <Btn onClick={() => ask("close")} data-testid="konz-resolve">Odpísané — vybaviť</Btn>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 items-center">
          <Btn onClick={() => ask("send")} data-testid="konz-send">{failed ? "Odoslať znova" : `Odoslať ${isSms ? "SMS" : "e-mail"} a vybaviť`}</Btn>
          <Btn variant="secondary" onClick={() => ask("close")} data-testid="konz-resolve">Vybaviť bez odoslania</Btn>
        </div>
      )}
      <p className="text-xs text-muted">Po vybavení sa žiadosť zo systému ihneď a natrvalo vymaže. Ostane len anonymný počet (téma, rozhodnutie) bez údajov pacienta.{forward ? " Kópia vo vašej pracovnej pošte obsahuje zdravotné údaje a sama sa nemaže." : ""}</p>
    </div>
  );
}

function RequestCard({ r, canReply, locked, expanded, onToggle, onResolve, forwardEmail }) {
  const t = r.triage, cat = CATEGORIES[t.category], failed = r.status === "failed";
  const age = new Date().getFullYear() - r.birthYear;
  const wait = daysAgo(r.createdAt);
  const reply = locked ? <Callout tone="warn">Vybavovanie je dočasne zablokované — najprv treba v databáze spustiť skript konzultacie-002.sql.</Callout>
    : canReply ? <ReplyPanel r={r} onResolve={onResolve} forwardEmail={forwardEmail} /> : <Callout tone="soft">Odpovedať na konzultácie môže len lekár.</Callout>;
  // odpoveď, ktorú brána neprijala: zdravotné údaje sú už zmazané, ostal len kontakt a text odpovede
  if (failed) {
    return (
      <li className="bg-white rounded-xl border border-danger/40 border-l-4 border-l-danger p-4 space-y-3" data-testid="konz-card" data-id={r.id} data-category="failed">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-danger text-white">Neodoslané</span>
          <span className="font-semibold text-ink">Odpoveď sa nepodarilo odoslať{r.sendError ? ` — ${r.sendError}` : ""}</span>
        </p>
        <p className="text-sm text-ink">Zdravotné údaje žiadosti sú už zmazané; ostal len kontakt a text odpovede. Skontrolujte kontakt a pošlite odpoveď znova, alebo žiadosť zavrite.</p>
        <p className="text-sm"><span className="text-muted">{CONTACT_LABEL[r.contactType]}: </span><Contact r={r} /><span className="text-xs text-muted"> · {r.id}</span></p>
        {reply}
      </li>
    );
  }
  return (
    <li className={`bg-white rounded-xl border border-line border-l-4 ${ACCENT[t.category]}`} data-testid="konz-card" data-id={r.id} data-category={t.category}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="w-full text-left p-4 rounded-xl hover:bg-page transition-colors" data-testid="konz-card-toggle">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${CHIP[t.category]}`} title={cat.long}>{cat.label} · {PRIORITY_LABEL[t.priority]}</span>
          <span className="font-semibold text-ink">{r.initials}</span>
          <span className="text-sm text-muted">{age} r. (*{r.birthYear}){r.region ? ` · ${r.region}` : ""}</span>
          <span className={`text-xs ml-auto whitespace-nowrap ${wait >= 3 ? "text-warn font-semibold" : "text-muted"}`} title={fmt(r.createdAt)}>{wait >= 3 ? `čaká ${wait} dní` : ago(r.createdAt)}</span>
        </span>
        <span className="block text-sm font-semibold text-brand mt-1.5">{topicById(r.topic)?.label || r.topic}</span>
        <span className="block text-sm text-ink mt-0.5"><span className="text-muted">Prečo: </span>{t.reasons.join(" · ")}</span>
        {!expanded && r.note && <span className="block text-sm text-muted mt-1 line-clamp-2 break-words">„{r.note}“</span>}
        <span className="block text-xs text-brand font-semibold mt-2">{expanded ? "▾ Zbaliť" : canReply ? "▸ Otvoriť a vybaviť" : "▸ Zobraziť podrobnosti"}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          <Details r={r} />
          <p className="text-sm"><span className="text-muted">Odpovedať cez {CONTACT_LABEL[r.contactType]}: </span><Contact r={r} /><span className="text-xs text-muted"> · {r.id} · prijaté {fmt(r.createdAt)}</span></p>
          {reply}
        </div>
      )}
    </li>
  );
}

// Anonymné počty vybavených žiadostí (žiadosti samotné sa po vybavení mažú)
function Stats({ stats }) {
  const since = (days) => { const d = new Date(Date.now() - days * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const recent = stats.filter((s) => String(s.doneOn) >= since(30));
  const count = (rows, f) => rows.filter(f).length;
  const avg = recent.length ? Math.round((recent.reduce((a, s) => a + s.waitDays, 0) / recent.length) * 10) / 10 : null;
  const topics = TOPICS.map((t) => ({ t, all: count(stats, (s) => s.topic === t.id) })).filter((x) => x.all > 0);
  const th = "text-left text-xs font-semibold uppercase tracking-wide text-muted px-3 py-2";
  const td = "px-3 py-2 text-sm";
  const num = td + " text-right tabular-nums font-semibold";
  return (
    <div className="space-y-4" data-testid="konz-stats">
      <Callout tone="info">Vybavené žiadosti sa <b>ihneď a natrvalo mažú</b> — tu ostávajú len anonymné počty (deň, téma, rozhodnutie, spôsob odpovede), bez iniciál, roku narodenia, kontaktu aj textu.</Callout>
      {stats.length === 0 ? <Card className="text-center text-muted" data-testid="konz-empty">Zatiaľ nič vybavené.</Card> : (
        <>
          <Card pad="sm" className="overflow-x-auto">
            <table className="w-full" data-testid="konz-stats-outcomes">
              <thead><tr className="border-b border-line"><th className={th}>Rozhodnutie</th><th className={th + " text-right"}>Posledných 30 dní</th><th className={th + " text-right"}>Spolu</th></tr></thead>
              <tbody className="divide-y divide-line">
                {OUTCOMES.map(([o, label]) => (
                  <tr key={o} data-outcome={o}><td className={td}>{label}</td><td className={num}>{count(recent, (s) => s.outcome === o)}</td><td className={num}>{count(stats, (s) => s.outcome === o)}</td></tr>
                ))}
                <tr className="bg-page"><td className={td + " font-semibold"}>Spolu</td><td className={num}>{recent.length}</td><td className={num} data-testid="konz-stats-total">{stats.length}</td></tr>
              </tbody>
            </table>
          </Card>
          <Card pad="sm" className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-line"><th className={th}>Téma</th><th className={th + " text-right"}>Spolu</th><th className={th + " text-right"}>Z toho pozvaní k nám</th></tr></thead>
              <tbody className="divide-y divide-line">
                {topics.map(({ t, all }) => (
                  <tr key={t.id}><td className={td}>{t.label}</td><td className={num}>{all}</td><td className={num}>{count(stats, (s) => s.topic === t.id && s.outcome === "ustav")}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
          {avg !== null && <p className="text-xs text-muted">Za posledných 30 dní: priemerné čakanie na vybavenie {String(avg).replace(".", ",")} {!Number.isInteger(avg) ? "dňa" : avg === 1 ? "deň" : avg >= 2 && avg <= 4 ? "dni" : "dní"} · odpoveď odoslaná zo systému pri {count(recent, (s) => s.replySent)} z {recent.length} žiadostí.</p>}
        </>
      )}
    </div>
  );
}

export default function ConsultAdminApp({ role = "superadmin", backHref = "#/sprava" }) {
  const canReply = role === "superadmin" || role === "lekar";
  const c = useConsultRequests(true);
  const { reload } = c;
  const [tab, setTab] = useState("new");
  const [cat, setCat] = useState("all");
  const [openId, setOpenId] = useState("");
  const [mail, setMail] = useState("");
  const [fmail, setFmail] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMail(c.notifyEmail); }, [c.notifyEmail]);
  useEffect(() => { setFmail(c.forwardEmail); }, [c.forwardEmail]);
  useEffect(() => { const f = () => reload(); window.addEventListener("focus", f); return () => window.removeEventListener("focus", f); }, [reload]);

  const failed = useMemo(() => c.list.filter((r) => r.status === "failed"), [c.list]);
  const sending = useMemo(() => c.list.filter((r) => r.status === "sending").length, [c.list]);
  const open = useMemo(() => c.list.filter((r) => r.status === "new").sort(triageSort), [c.list]);
  const counts = useMemo(() => Object.fromEntries(CATEGORY_ORDER.map((k) => [k, open.filter((r) => r.triage.category === k).length])), [open]);
  const shown = cat === "all" ? open : open.filter((r) => r.triage.category === cat);
  const link = publicLink();
  // kým sa odpoveď odosiela, zoznam sa sám obnovuje (brána potvrdí prijatie → riadok sa zmaže; odmietne → vráti sa ako neodoslaná)
  useEffect(() => { if (!sending) return undefined; const id = setTimeout(() => reload(), 5000); return () => clearTimeout(id); }, [sending, c.list, reload]);

  const resolve = async (id, v) => { const res = await c.resolve(id, v); setOpenId(""); return res; };
  const toggleIntake = async () => {
    setBusy(true);
    try { await c.setFormOpen(!c.open); showToast(c.open ? "Príjem žiadostí pozastavený" : "Príjem žiadostí zapnutý"); }
    catch (x) { showToast(x?.message || String(x), "err"); } finally { setBusy(false); }
  };
  const saveFmail = async (e) => {
    e.preventDefault();
    try { await c.saveForwardEmail(fmail); showToast(fmail.trim() ? "Pracovný e-mail uložený" : "Pracovný e-mail zrušený"); } catch (x) { showToast(x?.message || String(x), "err"); }
  };
  const saveMail = async (e) => {
    e.preventDefault();
    try { await c.saveNotifyEmail(mail); showToast("Uložené"); } catch (x) { showToast(x?.message || String(x), "err"); }
  };
  const tabCls = (on) => `px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${on ? "bg-brand text-white" : "bg-white text-ink border border-line hover:border-brand"}`;
  const chipCls = (on) => `text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${on ? "bg-ink text-white border-ink" : "bg-white text-ink border-line hover:border-brand"}`;

  return (
    <div className="space-y-4" data-testid="konz-admin">
      <p className="text-sm text-muted"><a href={backHref} className="hover:underline">← Späť do správy</a></p>
      <Card>
        <div className="flex flex-wrap items-start gap-3">
          <div className="grow min-w-0">
            <h1 className="text-xl font-semibold text-brand">Konzultácie z Instagramu</h1>
            <p className="text-sm text-muted mt-1">Žiadosti z verejného formulára. Nikto nedostáva termín — systém žiadosti len zoradí a navrhne, kam patria. Rozhodnutie a odpoveď sú na vás; po vybavení sa žiadosť ihneď maže.</p>
          </div>
          <Btn variant="secondary" size="sm" onClick={() => reload()} data-testid="konz-reload">↻ Obnoviť</Btn>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className={`inline-flex items-center gap-1.5 font-semibold ${c.open ? "text-success" : "text-warn"}`} data-testid="konz-intake-state"><span aria-hidden="true">●</span>Príjem žiadostí: {c.open ? "zapnutý" : "pozastavený"}</span>
          {canReply && <Btn variant="outline" size="sm" disabled={busy} onClick={toggleIntake} data-testid="konz-intake-toggle">{c.open ? "Pozastaviť" : "Zapnúť"}</Btn>}
          <span className="text-muted hidden sm:inline">·</span>
          <span className="text-muted break-all">Odkaz do Instagramu: <b className="text-ink">{link.replace(/^https?:\/\//, "")}</b></span>
          <Btn variant="secondary" size="sm" onClick={() => copyText(link, "Odkaz skopírovaný")} data-testid="konz-copy-link">📋 Kopírovať</Btn>
        </div>
      </Card>

      {c.error && <Callout tone="danger" role="alert" data-testid="konz-admin-error">{c.error}</Callout>}

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Konzultácie">
        <button type="button" role="tab" aria-selected={tab === "new"} className={tabCls(tab === "new")} onClick={() => { setTab("new"); setOpenId(""); }} data-testid="konz-tab-new">Na vybavenie ({open.length + failed.length})</button>
        <button type="button" role="tab" aria-selected={tab === "stats"} className={tabCls(tab === "stats")} onClick={() => { setTab("stats"); setOpenId(""); }} data-testid="konz-tab-stats">Vybavené — počty ({c.stats.length})</button>
      </div>

      {tab === "stats" ? <Stats stats={c.stats} /> : c.loading ? <p className="text-center text-muted py-10">Načítavam…</p> : (
        <>
          {sending > 0 && <Callout tone="info" data-testid="konz-sending">Odosiela sa {sending === 1 ? "1 odpoveď" : `${sending} odpovedí`} — po potvrdení brány sa žiadosť zmaže. Zdravotné údaje sú už zmazané.</Callout>}
          {failed.length > 0 && (
            <ul className="space-y-3" data-testid="konz-failed">
              {failed.map((r) => <RequestCard key={r.id} r={r} canReply={canReply} locked={c.needsUpgrade} expanded onToggle={() => {}} onResolve={resolve} forwardEmail={c.forwardEmail} />)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter podľa návrhu zaradenia">
            <button type="button" aria-pressed={cat === "all"} className={chipCls(cat === "all")} onClick={() => setCat("all")} data-testid="konz-cat-all">Všetky ({open.length})</button>
            {CATEGORY_ORDER.map((k) => (
              <button key={k} type="button" aria-pressed={cat === k} className={chipCls(cat === k)} onClick={() => setCat(k)} title={CATEGORIES[k].long} data-testid={`konz-cat-${k}`}>{CATEGORIES[k].label} ({counts[k]})</button>
            ))}
          </div>
          {shown.length === 0 ? <Card className="text-center text-muted" data-testid="konz-empty">{cat === "all" ? "Žiadne žiadosti na vybavenie." : "V tejto skupine nie je žiadna žiadosť."}</Card> : (
            <ul className="space-y-3">
              {shown.map((r) => (
                <RequestCard key={r.id} r={r} canReply={canReply} locked={c.needsUpgrade} expanded={openId === r.id} onToggle={() => setOpenId(openId === r.id ? "" : r.id)} onResolve={resolve} forwardEmail={c.forwardEmail} />
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">Nevybavené žiadosti sa automaticky mažú najneskôr po 90 dňoch.</p>
        </>
      )}

      <details className="group rounded-xl border border-line bg-white" data-testid="konz-rules">
        <summary className="cursor-pointer select-none list-none px-4 py-3 text-sm font-semibold text-brand flex items-center gap-2">
          <span className="inline-block transition-transform group-open:rotate-90">▸</span> Ako systém žiadosti zaraďuje
        </summary>
        <div className="px-4 pb-4 space-y-3 text-sm border-t border-line pt-3">
          <p className="text-muted">Zaradenie je len návrh podľa odpovedí pacienta — nie diagnóza. Pacient ho nevidí; na obrazovke dostane iba upozornenie pri akútnych príznakoch. Ak chcete niektoré pravidlo zmeniť, povedzte — upraví sa na jednom mieste.</p>
          {RULES_OVERVIEW.map((g) => (
            <div key={g.title}>
              <p className="font-semibold text-ink"><span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full mr-2 ${CHIP[g.category]}`}>{CATEGORIES[g.category].label}</span>{g.title}</p>
              <ul className="list-disc ml-6 mt-1 text-ink space-y-0.5">{g.items.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          ))}
        </div>
      </details>

      {role === "superadmin" && (
        <details className="group rounded-xl border border-line bg-white" data-testid="konz-mail-settings">
          <summary className="cursor-pointer select-none list-none px-4 py-3 text-sm font-semibold text-brand flex items-center gap-2">
            <span className="inline-block transition-transform group-open:rotate-90">▸</span> Upozornenia e-mailom
          </summary>
          <form onSubmit={saveMail} className="px-4 pb-4 border-t border-line pt-3 space-y-2">
            <label className={labelCls} htmlFor="konz-mail">Kam posielať upozornenia o konzultáciách</label>
            <div className="flex flex-wrap gap-2">
              <input id="konz-mail" type="email" className={inputSmCls + " max-w-sm"} value={mail} onChange={(e) => setMail(e.target.value)} placeholder="ako ostatné upozornenia pracoviska" data-testid="konz-notify-email" />
              <Btn type="submit" size="sm">Uložiť</Btn>
            </div>
            <p className="text-xs text-muted">E-mail príde pri každej novej žiadosti (ak ich príde viac naraz, jeden spoločný — najviac raz za 15 minút), hneď pri žiadosti s akútnymi príznakmi a keď sa odpoveď nepodarí odoslať; ráno navyše súhrn čakajúcich. E-maily neobsahujú zdravotné údaje. Prázdne pole = adresy pracoviska ako pri ostatných upozorneniach.</p>
          </form>
          <form onSubmit={saveFmail} className="px-4 pb-4 border-t border-line pt-3 space-y-2">
            <label className={labelCls} htmlFor="konz-fmail">Pracovný e-mail lekára — sem príde celá žiadosť, keď zvolíte „Pozvať k nám“</label>
            <div className="flex flex-wrap gap-2">
              <input id="konz-fmail" type="email" className={inputSmCls + " max-w-sm"} value={fmail} onChange={(e) => setFmail(e.target.value)} placeholder="meno@nusch.sk" data-testid="konz-forward-email" />
              <Btn type="submit" size="sm" data-testid="konz-forward-save">Uložiť</Btn>
            </div>
            <p className="text-xs text-muted">Táto správa obsahuje zdravotné údaje pacienta (odpovede, popis, kontakt), preto ide len na adresu, ktorú tu výslovne uvediete — zadajte pracovnú, nie súkromnú. Pri každej žiadosti sa dá posielanie odškrtnúť. Prázdne pole = nič sa neposiela.</p>
          </form>
        </details>
      )}
    </div>
  );
}
