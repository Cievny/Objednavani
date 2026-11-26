import { useEffect, useMemo, useRef, useState } from "react";
import { guardFor, ensureHumanPass, prewarmHumanPass, honeypotProps } from "./botguard.js";
import { inputCls, labelCls, Btn, Card, Callout } from "./ui.jsx";
import { RED_FLAGS, TOPICS, REGIONS, classify, topicById } from "./triaz.js";
import { consultApi } from "./konzultacieData.js";
import { BigHero, IconChat } from "./hero.jsx";

// Konzultácia — verejný triážny formulár (odkaz z Instagramu, #/konzultacia).
// NEDÁVA termín: človek uvedie iniciály, rok narodenia, ťažkosti a kontakt;
// lekár žiadosť posúdi a odpovie, kam sa obrátiť (ústav, rajónny angiológ,
// obvodný lekár). Pri akútnych príznakoch dostane pokyn hneď na obrazovke.

const CONTACTS = [
  { id: "sms", label: "SMS", field: "Číslo mobilu", placeholder: "0949 123 456", inputMode: "tel", type: "tel", done: "SMS správou" },
  { id: "email", label: "E-mail", field: "E-mailová adresa", placeholder: "meno@priklad.sk", inputMode: "email", type: "email", done: "e-mailom" },
  { id: "instagram", label: "Instagram", field: "Vaše meno na Instagrame", placeholder: "@meno", inputMode: "text", type: "text", done: "správou na Instagrame" },
];
const choiceCls = (on, err) => `w-full text-left text-sm font-semibold px-3 py-2.5 rounded-lg border transition-colors ${on ? "bg-brand text-white border-brand" : `bg-white text-ink hover:border-brand ${err ? "border-danger" : "border-line"}`}`;

const Err = ({ msg }) => (msg ? <p className="text-xs text-danger mt-1" role="alert" data-konz-err>{msg}</p> : null);
const H = ({ n, children }) => <h2 className="text-base font-semibold text-brand mb-3"><span className="inline-flex items-center justify-center w-6 h-6 mr-2 rounded-full bg-brand text-white text-xs">{n}</span>{children}</h2>;

function Urgent({ call155, className = "" }) {
  return (
    <Callout tone="danger" role="alert" className={`text-base ${className}`} data-testid="konz-urgent">
      <b>Toto môže byť akútny stav — nečakajte na odpoveď z tohto formulára.</b>{" "}
      {call155 ? <>Volajte hneď <a href="tel:155" className="font-bold underline">155</a>.</> : <>Vyhľadajte lekára ešte dnes (pohotovosť alebo urgentný príjem). Pri zhoršení volajte <a href="tel:155" className="font-bold underline">155</a>.</>}
    </Callout>
  );
}

export default function ConsultForm() {
  const year = new Date().getFullYear();
  const [ready, setReady] = useState(undefined); // undefined = zisťujem; null = nie je v databáze; false = pozastavené
  const [flags, setFlags] = useState([]);
  const [noFlags, setNoFlags] = useState(false);
  const [topic, setTopic] = useState("");
  const [answers, setAnswers] = useState({});
  const [note, setNote] = useState("");
  const [initials, setInitials] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [region, setRegion] = useState("");
  const [contactType, setContactType] = useState("");
  const [contact, setContact] = useState("");
  const [consent, setConsent] = useState(false);
  const [hp, setHp] = useState("");
  const [errs, setErrs] = useState({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const startedAt = useRef(Date.now());
  const topRef = useRef(null);

  useEffect(() => { let on = true; consultApi.ready().then((v) => { if (on) setReady(v); }).catch(() => { if (on) setReady(true); }); return () => { on = false; }; }, []);
  const clear = (k) => setErrs((x) => { if (!x[k]) return x; const n = { ...x }; delete n[k]; return n; });
  const t = topicById(topic);
  const triage = useMemo(() => classify({ topic, answers, flags }), [topic, answers, flags]);
  const urgent = triage.category === "akutne";
  const ct = CONTACTS.find((c) => c.id === contactType);

  const toggleFlag = (id) => { setNoFlags(false); clear("flags"); setFlags((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id])); };
  const pickTopic = (id) => { setTopic(id); setAnswers({}); clear("topic"); setErrs((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith("q_")))); };

  const submit = async (e) => {
    e?.preventDefault();
    const er = {};
    if (!noFlags && flags.length === 0) er.flags = "Označte, čo sa vás týka, alebo zvoľte „Nič z toho“.";
    if (!t) er.topic = "Vyberte, čo vás trápi.";
    else for (const qq of t.questions) if (!answers[qq.id]) er[`q_${qq.id}`] = "Vyberte odpoveď.";
    if (t?.id === "ine" && note.trim().length < 10) er.note = "Opíšte, prosím, svoje ťažkosti aspoň niekoľkými slovami.";
    const letters = initials.replace(/[^\p{L}]/gu, "");
    if (letters.length < 1 || letters.length > 4) er.initials = "Zadajte len iniciály (napr. J. K.), nie celé meno.";
    const y = Number(birthYear);
    if (!/^\d{4}$/.test(birthYear) || y < 1900 || y > year) er.birthYear = "Zadajte rok narodenia (napr. 1958).";
    if (!ct) er.contactType = "Vyberte, kam vám máme odpovedať.";
    else if (!contact.trim()) er.contact = `Zadajte ${ct.field.toLowerCase()}.`;
    if (!consent) er.consent = "Bez súhlasu žiadosť nemôžeme prijať.";
    setErrs(er);
    if (Object.keys(er).length) {
      setMsg("Skontrolujte, prosím, zvýraznené polia.");
      requestAnimationFrame(() => document.querySelector("[data-konz-err]")?.scrollIntoView({ behavior: "smooth", block: "center" }));
      return;
    }
    setBusy(true); setMsg("");
    try {
      guardFor({ hp, startedAt: startedAt.current });
      await ensureHumanPass();
      const id = await consultApi.submit({ initials, birthYear: y, region, topic, answers, flags, note: note.trim(), contactType, contact: contact.trim(), consent });
      setDone({ id, via: ct.done, urgent, call155: triage.call155 });
      requestAnimationFrame(() => topRef.current?.scrollIntoView({ block: "start" }));
    } catch (err) { setMsg(err?.message || String(err)); } finally { setBusy(false); }
  };


  if (ready === undefined) return <p className="text-center text-muted py-10">Načítavam…</p>;
  if (ready === null || ready === false) {
    return (
      <Card className="text-center space-y-3" data-testid="konz-closed">
        <h1 className="text-xl font-semibold text-brand">Konzultácie sú momentálne pozastavené</h1>
        <p className="text-ink">Žiadosti teraz neprijímame. Skúste to, prosím, neskôr.</p>
        <p className="text-sm text-muted">Pri náhlych ťažkostiach volajte <a href="tel:155" className="font-semibold text-brand">155</a>. S bežnými ťažkosťami sa obráťte na svojho všeobecného lekára.</p>
      </Card>
    );
  }

  if (done) {
    return (
      <div ref={topRef} className="space-y-4">
        {done.urgent && <Urgent call155={done.call155} />}
        <Card className="text-center space-y-2" data-testid="konz-done">
          <h1 className="text-xl font-semibold text-success">Ďakujeme, žiadosť sme prijali</h1>
          <p className="text-ink">Prečíta si ju lekár a odpovieme vám <b>{done.via}</b> — spravidla do niekoľkých pracovných dní.</p>
          <p className="text-sm text-muted">Odpoveď vám povie, či je vhodné vyšetrenie u nás, u angiológa vo vašom okolí alebo u všeobecného lekára. Nie je to objednanie na termín.</p>
          {done.id && <p className="text-sm text-muted">Číslo žiadosti: <span className="font-mono">{done.id}</span></p>}
          <p className="text-sm text-muted">Hneď po odpovedi vaše údaje z dotazníka zo systému vymažeme; ak vás pozveme na vyšetrenie, lekár si žiadosť ponechá na účely objednania.</p>
          <p className="text-sm text-muted">Ak sa váš stav zhorší, nečakajte na odpoveď a vyhľadajte lekára.</p>
        </Card>
      </div>
    );
  }

  return (
    <form ref={topRef} onSubmit={submit} onFocus={prewarmHumanPass} className="space-y-4 relative" noValidate data-testid="konz-form">
      <input {...honeypotProps} value={hp} onChange={(e) => setHp(e.target.value)} />
      <BigHero
        testId="konz-hero"
        eyebrow="Národný ústav srdcových a cievnych chorôb"
        word="Poraďte sa"
        title="s cievnym lekárom"
        chips={[["clock", "zaberie asi 2 minúty"], ["lock", "bez mena a rodného čísla"], ["doctor", "odpíše vám lekár"]]}
        text="Vyplňte krátky dotazník. Lekár si ho prečíta a odpíše vám, či je vhodné vyšetrenie u nás v ústave, u angiológa vo vašom okolí alebo u všeobecného lekára."
        cta={{ label: "Vyplniť dotazník", target: "konz-start", testId: "konz-hero-cta" }}
        note="Formulár nie je objednanie na termín a nenahrádza lekárske vyšetrenie. Pri náhlych ťažkostiach volajte 155."
        decor={<IconChat className="w-full h-full" />}
      />

      <Card id="konz-start" tabIndex={-1} className={`scroll-mt-4 outline-none ${errs.flags ? "border-danger" : ""}`}>
        <H n={1}>Najprv to najdôležitejšie</H>
        <p className="text-sm text-ink mb-3">Týka sa vás <b>práve teraz</b> niečo z tohto?</p>
        <div className="space-y-2" role="group" aria-label="Akútne príznaky">
          {RED_FLAGS.map((f) => (
            <label key={f.id} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer ${flags.includes(f.id) ? "border-danger bg-danger-soft" : "border-line bg-white"}`}>
              <input type="checkbox" className="mt-1 accent-danger shrink-0" checked={flags.includes(f.id)} onChange={() => toggleFlag(f.id)} data-testid={`konz-flag-${f.id}`} />
              <span className="text-sm text-ink">{f.label}</span>
            </label>
          ))}
          <label className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer ${noFlags ? "border-brand bg-brand-soft" : "border-line bg-white"}`}>
            <input type="checkbox" className="mt-1 accent-brand shrink-0" checked={noFlags} onChange={(e) => { setNoFlags(e.target.checked); if (e.target.checked) setFlags([]); clear("flags"); }} data-testid="konz-noflags" />
            <span className="text-sm font-semibold text-ink">Nič z toho sa ma netýka</span>
          </label>
        </div>
        <Err msg={errs.flags} />
        {flags.length > 0 && <Urgent call155={triage.call155} className="mt-3" />}
        {flags.length > 0 && <p className="text-xs text-muted mt-2">Dotazník môžete aj tak dokončiť — lekár žiadosť uvidí prednostne.</p>}
      </Card>

      <Card className={errs.topic ? "border-danger" : ""}>
        <H n={2}>Čo vás trápi?</H>
        <div className="grid sm:grid-cols-2 gap-2" role="group" aria-label="Čo vás trápi">
          {TOPICS.map((x) => (
            <button key={x.id} type="button" aria-pressed={topic === x.id} onClick={() => pickTopic(x.id)} className={choiceCls(topic === x.id, errs.topic)} data-testid={`konz-topic-${x.id}`}>{x.label}</button>
          ))}
        </div>
        <Err msg={errs.topic} />
      </Card>

      {t && t.questions.length > 0 && (
        <Card>
          <H n={3}>Pár doplňujúcich otázok</H>
          <div className="space-y-4">
            {t.questions.map((qq) => (
              <fieldset key={qq.id}>
                <legend className={labelCls}>{qq.label}</legend>
                <div className={`grid gap-2 ${qq.options.length === 2 ? "grid-cols-2" : "sm:grid-cols-2"}`}>
                  {qq.options.map((o) => (
                    <button key={o.value} type="button" aria-pressed={answers[qq.id] === o.value} data-testid={`konz-q-${qq.id}-${o.value}`}
                      onClick={() => { setAnswers((a) => ({ ...a, [qq.id]: o.value })); clear(`q_${qq.id}`); }}
                      className={choiceCls(answers[qq.id] === o.value, errs[`q_${qq.id}`])}>{o.label}</button>
                  ))}
                </div>
                <Err msg={errs[`q_${qq.id}`]} />
              </fieldset>
            ))}
          </div>
          {urgent && flags.length === 0 && <Urgent call155={false} className="mt-4" />}
        </Card>
      )}

      {t && (
        <Card>
          <H n={t.questions.length > 0 ? 4 : 3}>Opíšte to vlastnými slovami</H>
          <label className="sr-only" htmlFor="konz-note">Popis ťažkostí</label>
          <textarea id="konz-note" rows={4} maxLength={1500} className={inputCls + (errs.note ? " border-danger" : "")} value={note} data-testid="konz-note"
            placeholder="Čo vás trápi, ako dlho, čo ste už skúšali, aké vyšetrenia máte za sebou…" onChange={(e) => { setNote(e.target.value); clear("note"); }} />
          <Err msg={errs.note} />
          <p className="text-xs text-muted mt-1">{t.id === "ine" ? "Povinné. " : "Nepovinné. "}Nepíšte, prosím, meno, rodné číslo ani adresu.</p>
        </Card>
      )}

      <Card>
        <H n={t ? (t.questions.length > 0 ? 5 : 4) : 3}>O vás a kam odpovedať</H>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="konz-initials">Iniciály <span className="text-danger">*</span></label>
            <input id="konz-initials" maxLength={8} autoComplete="off" autoCapitalize="characters" placeholder="J. K." className={inputCls + (errs.initials ? " border-danger" : "")}
              value={initials} onChange={(e) => { setInitials(e.target.value); clear("initials"); }} data-testid="konz-initials" />
            <Err msg={errs.initials} />
          </div>
          <div>
            <label className={labelCls} htmlFor="konz-year">Rok narodenia <span className="text-danger">*</span></label>
            <input id="konz-year" inputMode="numeric" maxLength={4} autoComplete="off" placeholder="1958" className={inputCls + (errs.birthYear ? " border-danger" : "")}
              value={birthYear} onChange={(e) => { setBirthYear(e.target.value.replace(/\D/g, "").slice(0, 4)); clear("birthYear"); }} data-testid="konz-year" />
            <Err msg={errs.birthYear} />
          </div>
          <div className="col-span-2">
            <label className={labelCls} htmlFor="konz-region">Kraj, kde bývate <span className="font-normal text-muted">(nepovinné)</span></label>
            <select id="konz-region" className={inputCls} value={region} onChange={(e) => setRegion(e.target.value)} data-testid="konz-region">
              <option value="">— nevybrané —</option>
              {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <fieldset className="mt-4">
          <legend className={labelCls}>Kam vám máme odpovedať? <span className="text-danger">*</span></legend>
          <div className="grid grid-cols-3 gap-2">
            {CONTACTS.map((c) => (
              <button key={c.id} type="button" aria-pressed={contactType === c.id} data-testid={`konz-contact-${c.id}`}
                onClick={() => { setContactType(c.id); setContact(""); clear("contactType"); clear("contact"); }}
                className={choiceCls(contactType === c.id, errs.contactType) + " text-center"}>{c.label}</button>
            ))}
          </div>
          <Err msg={errs.contactType} />
        </fieldset>
        {ct && (
          <div className="mt-3">
            <label className={labelCls} htmlFor="konz-contact">{ct.field} <span className="text-danger">*</span></label>
            <input id="konz-contact" type={ct.type} inputMode={ct.inputMode} autoComplete="off" placeholder={ct.placeholder} className={inputCls + (errs.contact ? " border-danger" : "")}
              value={contact} onChange={(e) => { setContact(e.target.value); clear("contact"); }} data-testid="konz-contact" />
            <Err msg={errs.contact} />
            {ct.id === "instagram" && <p className="text-xs text-muted mt-1">Odpíšeme vám správou na Instagrame — skontrolujte si potom aj žiadosti o správy.</p>}
          </div>
        )}

        <label className={`flex items-start gap-3 mt-5 text-sm text-ink cursor-pointer rounded-lg border px-3 py-2.5 ${errs.consent ? "border-danger" : "border-line"}`}>
          <input type="checkbox" className="mt-1 accent-brand shrink-0" checked={consent} onChange={(e) => { setConsent(e.target.checked); clear("consent"); }} data-testid="konz-consent" />
          <span>Súhlasím, aby NÚSCH, a.s. spracoval údaje z tohto formulára vrátane údajov o mojom zdraví na posúdenie žiadosti a odpoveď. Hneď po odpovedi lekára údaje zo systému vymažeme (nevybavené žiadosti najneskôr do 90 dní); ak vám odporučí vyšetrenie u nás, ponechá si žiadosť na účely objednania. <a href="#/osobne-udaje" target="_blank" rel="noreferrer" className="text-brand font-semibold hover:underline">Viac o ochrane údajov</a></span>
        </label>
        <Err msg={errs.consent} />

        {msg && <Callout tone="danger" role="alert" className="mt-4" data-testid="konz-error">{msg}</Callout>}
        <Btn type="submit" size="lg" block disabled={busy} className="mt-4" data-testid="konz-submit">{busy ? "Odosielam…" : "Odoslať lekárovi"}</Btn>
        <p className="text-xs text-muted mt-3 text-center">Odpoveď vychádza len z toho, čo napíšete, a nenahrádza vyšetrenie. Pri náhlom zhoršení volajte 155.</p>
      </Card>
    </form>
  );
}
