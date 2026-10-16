import { useState } from "react";

// „Zachráň nohu" — dlhá informačná stránka (#/angio1/zachrannohu) v dizajne
// objednávania: lišta s kotvami → hero → čísla → čo je to → samotest →
// priebeh vyšetrenia → čo ak niečo nájdu → kedy volať 155 → mýty → výzva →
// objednanie (deti: AngioBookingView + AngioOrderLookup) → pätička so zdrojmi.
// Texty vychádzajú z odporúčaní ESC 2024, ACC/AHA 2024, IWGDF/ESVS/SVS 2023
// a AHA 2024 (podklady OpenEvidence), zostručnené pre pacienta.

const NAV = [
  ["cisla", "Čísla"], ["co-je-to", "Čo je to"], ["samotest", "Samotest"], ["vysetrenie", "Vyšetrenie"],
  ["nalez", "Čo bude ďalej"], ["urgent", "Kedy volať 155"], ["myty", "Mýty"], ["zavolame", "Zavoláme vám"],
];

const STATS = [
  { n: "85 %", t: "amputácií pri cukrovke predchádza vred na nohe, ktorý sa nehojí", src: "AHA 2024" },
  { n: "2 týždne", t: "rana, ktorá sa nehojí dlhšie, patrí k cievnemu lekárovi", src: "ESC 2024" },
  { n: "15–20 min", t: "trvá vyšetrenie — bez bolesti, bez ihiel, bez prípravy", src: "" },
  { n: "do 7 dní", t: "dostanete termín v Angiologickej ambulancii č. 1", src: "" },
];

const QUESTIONS = [
  { t: "Máte na nohe ranu, vred alebo odreninu, ktorá sa nehojí dlhšie ako 2 týždne?", strong: true },
  { t: "Máte cukrovku, fajčíte, chodíte na dialýzu alebo ste už mali zákrok na cievach nôh?", strong: false },
  { t: "Bolí vás noha v pokoji, najmä v noci, a uľaví sa vám, keď ju spustíte z postele?", strong: true },
  { t: "Zmenil prst alebo chodidlo farbu (modrá, fialová, čierna) alebo je noha nápadne chladná?", strong: true },
];

const STEPS = [
  { n: "1", title: "Registrácia", text: "Prídete na objednaný termín s kartičkou poistenca. Žiadanku nepotrebujete. Ak máte, prineste fotku rany a zoznam liekov." },
  { n: "2", title: "Rozhovor a pohľad na nohu", text: "Lekár sa spýta, ako dlho sa rana nehojí, čo vás bolí a aké lieky užívate. Pozrie si ranu, farbu a teplotu nohy." },
  { n: "3", title: "Pulzy a tlaky", text: "Nahmatá pulzy a manžetou zmeria tlak na členku, pri cukrovke aj na prste. Je to ako meranie tlaku na ruke." },
  { n: "4", title: "Ultrazvuk ciev", text: "Sondou s gélom prejde po nohe a na obrazovke vidí, kde a ako veľmi je tepna zúžená. Nič nebolí." },
  { n: "5", title: "Výsledok a smer hneď", text: "Ešte v ambulancii sa dozviete, či má rana cievnu príčinu, a dostanete správu s odporúčaním: ošetrovanie u vášho chirurga, zákrok na cievach u nás alebo ďalšia starostlivosť u angiológa vo vašom regióne." },
];

const FINDINGS = [
  ["Prekrvenie je dostatočné", "Rana nemá cievnu príčinu. Ošetrovanie pokračuje u vášho chirurga alebo v ambulancii, ktorá sa o ranu stará — dostanete pre nich správu z vyšetrenia."],
  ["Zlé prekrvenie, ktoré treba riešiť", "Navrhneme vám obnovenie prietoku (revaskularizáciu): zákrok cez cievu balónikom alebo stentom, prípadne bypass. Naplánujeme ho u nás v NÚSCH."],
  ["Zlé prekrvenie, ktoré zatiaľ zákrok nevyžaduje", "Lieky, chôdza, kontrola cukrovky a odvykanie od fajčenia. Odovzdáme vás so správou angiológovi vo vašom regióne, ktorý sa o vás bude ďalej starať."],
];

const URGENT = [
  "Náhla, silná bolesť nohy, ktorá neustupuje",
  "Noha je zrazu bledá, mramorová alebo studená",
  "Necítite nohu alebo ňou nevládzete hýbať",
  "Prst alebo časť chodidla sčernela",
  "Rana s horúčkou, zimnicou alebo rýchlo sa šíriacim začervenaním",
];

const MYTHS = [
  { q: "„Rana sa zahojí sama, len to chce čas.“", a: "Rana, ktorá sa nehojí 2 týždne, sa sama zahojí len zriedka. Ak do nej netečie dosť krvi, čas pracuje proti nohe." },
  { q: "„Mám cukrovku, to je od nervov, nie od ciev.“", a: "Pri cukrovke sú často postihnuté nervy aj cievy naraz. Preto odporúčania hovoria: pri každom vrede u diabetika treba cievy vyšetriť." },
  { q: "„Bez žiadanky ma nevyšetria.“", a: "Na toto vyšetrenie žiadanku nepotrebujete a je bez poplatku. Objednáte sa sami online." },
  { q: "„Vyšetrenie bolí a sú pri ňom ihly.“", a: "Nie. Meria sa tlak manžetou a robí ultrazvuk s gélom. Žiadne ihly, žiadne žiarenie." },
  { q: "„Ak nebolí, nie je to vážne.“", a: "Pri cukrovke môže byť citlivosť znížená a rana nebolí, aj keď je vážna. Rozhoduje to, či sa hojí, nie to, či bolí." },
  { q: "„Som starý, aj tak sa s tým nedá nič robiť.“", a: "Dá. Zákrok cez cievu zvládajú aj ľudia vo vysokom veku a zachraňuje nohu i nezávislosť. Čím skôr, tým jednoduchší zákrok." },
];

const SOURCES = [
  "ESC Guidelines for the Management of Peripheral Arterial and Aortic Diseases (2024)",
  "ACC/AHA Guideline for the Management of Lower Extremity Peripheral Artery Disease (2024)",
  "IWGDF/ESVS/SVS Guidelines on Peripheral Artery Disease in People with Diabetes and a Foot Ulcer (2023)",
  "AHA Scientific Statement: Diabetic Foot Ulcers in the Cardiovascular Patient Population (2024)",
];

// plynulý posun na sekciu + presun fokusu (klávesnica/čítačka); rešpektuje prefers-reduced-motion.
// href odkazov = aktuálna adresa stránky, aby otvorenie v novej karte neskončilo na úvodnej stránke USG.
const goTo = (id) => (e) => {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
};
const hereHref = () => window.location.hash || "#/angio1/zachrannohu";
// známe (slovenské) hlášky zo servera; čokoľvek iné (výpadok siete, nespustený skript) → všeobecná veta
const friendlyError = (msg) => (/^(Zadajte|Príliš veľa|Vašu žiadosť)/.test(msg || "") ? msg : "Nepodarilo sa odoslať. Skúste to prosím znova o chvíľu.");

// fotografie v public/zachrannohu/*.webp (base podľa buildu: / alebo /beta/)
const IMG = (name) => `${import.meta.env.BASE_URL}zachrannohu/${name}.webp`;
function Photo({ name, alt, className = "", fallback = null, eager = false, testId = null, rounded = true }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img src={IMG(name)} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setFailed(true)}
      data-testid={testId || `img-${name}`} className={`block w-full h-auto object-cover ${rounded ? "rounded-lg" : ""} ${className}`} />
  );
}

// obrázok s popiskom; pri chybe načítania sa celý blok skryje (žiadne prázdne miesto)
function PhotoFigure({ name, alt, caption, className = "", figureClass = "" }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className={figureClass}>
      <img src={IMG(name)} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)}
        data-testid={`img-${name}`} className={`block w-full h-auto object-cover rounded-lg ${className}`} />
      <figcaption className="text-xs text-slate-500 mt-2">{caption}</figcaption>
    </figure>
  );
}

const H2 = ({ children }) => <h2 className="text-2xl md:text-3xl font-semibold text-brand-dark leading-tight">{children}</h2>;
const Card = ({ children, className = "" }) => (
  <div className={`bg-white rounded-xl border border-line p-5 md:p-7 ${className}`}>{children}</div>
);
const Cta = ({ children, id = "objednat", className = "" }) => (
  <a href={hereHref()} onClick={goTo(id)} className={`inline-block bg-brand hover:bg-brand-dark text-white font-semibold text-base px-6 py-3 rounded-lg transition-colors ${className}`}>
    {children}
  </a>
);

function SelfTest() {
  const [ans, setAns] = useState(Array(QUESTIONS.length).fill(null));
  const done = ans.every((a) => a !== null);
  const strong = done && QUESTIONS.some((q, i) => q.strong && ans[i]);
  const maybe = done && !strong && ans.some(Boolean);
  const result = !done ? null
    : strong ? { cls: "bg-danger-soft border border-danger/40 text-danger", title: "Objednajte sa čo najskôr.", text: "Vaše odpovede ukazujú na ranu alebo bolesť, pri ktorej treba cievy vyšetriť bez odkladu. Termín máte do týždňa." }
    : maybe ? { cls: "bg-white text-brand-dark border-2 border-brand", title: "Vyšetrenie sa oplatí.", text: "Máte rizikový faktor, pri ktorom sa cievy nôh oplatí skontrolovať. Objednajte sa, alebo to preberte so svojím lekárom." }
    : { cls: "bg-brand-soft text-brand-dark", title: "Zatiaľ nie je dôvod na obavy.", text: "Sledujte nohy. Ak sa objaví rana, ktorá sa nehojí, bolesť v pokoji alebo zmena farby, objednajte sa." };
  return (
    <Card>
      <H2>Môžem sa objednať?</H2>
      <p className="text-slate-600 mt-1 mb-4">Odpovedzte na 4 otázky. Nič sa nikam neukladá.</p>
      <div className="space-y-3">
        {QUESTIONS.map((q, i) => (
          <div key={i} className="border border-line rounded-lg p-3 flex flex-col sm:flex-row sm:items-center gap-2" data-testid={`q${i + 1}`}>
            <p className="flex-1 text-base text-slate-800">{q.t}</p>
            <div className="flex gap-2 shrink-0">
              {[["Áno", true], ["Nie", false]].map(([lbl, v]) => (
                <button key={lbl} type="button" onClick={() => setAns((a) => a.map((x, j) => (j === i ? v : x)))} aria-pressed={ans[i] === v}
                  className={`min-h-[44px] px-5 py-2 rounded-lg text-base font-bold border-2 transition-colors ${ans[i] === v ? (v ? "bg-danger border-danger text-white" : "bg-brand border-brand text-white") : "bg-white border-slate-300 text-slate-700 hover:border-brand"}`}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {result ? (
        <div data-testid="selftest-result" className={`mt-4 rounded-lg p-5 text-center ${result.cls}`}>
          <p className="text-xl font-semibold">{result.title}</p>
          <p className="mt-1 text-sm opacity-95">{result.text}</p>
          <Cta className={`mt-4 ${strong ? "!bg-danger !text-white hover:!bg-danger/90" : ""}`}>Chcem sa objednať ›</Cta>
        </div>
      ) : (
        <p className="mt-4 text-xs text-slate-500">Výsledok sa zobrazí po zodpovedaní všetkých otázok.</p>
      )}
      <p className="mt-3 text-xs text-slate-500">Test nenahrádza vyšetrenie. Pri náhlej silnej bolesti a bledej či studenej nohe volajte 155.</p>
    </Card>
  );
}

function Myths() {
  const [open, setOpen] = useState(null);
  return (
    <div className="space-y-2">
      {MYTHS.map((m, i) => (
        <div key={i} className="bg-white rounded-lg border border-line overflow-hidden">
          <button type="button" onClick={() => setOpen((o) => (o === i ? null : i))} aria-expanded={open === i} data-testid={`myth${i + 1}`}
            className="w-full flex items-center justify-between gap-3 text-left px-4 py-3 font-bold text-brand-dark">
            <span>{m.q}</span><span className="text-xl text-brand" aria-hidden="true">{open === i ? "−" : "+"}</span>
          </button>
          {open === i && <p className="px-4 pb-4 text-sm text-slate-700"><b className="text-danger">Realita:</b> {m.a}</p>}
        </div>
      ))}
    </div>
  );
}

// jednoduchá ilustrácia: tepna s plakom a slabým prietokom k rane
const ArteryIllustration = () => (
  <svg viewBox="0 0 320 200" className="w-full max-w-sm mx-auto" role="img" aria-label="Zúžená tepna v nohe: do rany tečie málo krvi">
    <rect x="0" y="0" width="320" height="200" rx="16" fill="#F0F4FF" />
    <path d="M30 60 C 90 60, 110 60, 150 60 C 170 60, 175 72, 190 72 C 230 72, 260 72, 290 72" stroke="#B42318" strokeWidth="26" fill="none" strokeLinecap="round" />
    <path d="M30 60 C 90 60, 110 60, 150 60 C 170 60, 175 72, 190 72 C 230 72, 260 72, 290 72" stroke="#FFB4B4" strokeWidth="12" fill="none" strokeLinecap="round" />
    <ellipse cx="172" cy="64" rx="22" ry="11" fill="#F2C94C" />
    <ellipse cx="172" cy="64" rx="12" ry="5" fill="#E0A800" />
    <text x="30" y="40" fontSize="12" fill="#003C7E" fontFamily="Arial" fontWeight="bold">dobrý prietok</text>
    <text x="150" y="40" fontSize="12" fill="#B45309" fontFamily="Arial" fontWeight="bold">zúženie (plak)</text>
    <text x="222" y="104" fontSize="12" fill="#B91C1C" fontFamily="Arial" fontWeight="bold">slabý prietok</text>
    <circle cx="275" cy="150" r="22" fill="#FFE4E6" stroke="#B42318" strokeWidth="3" />
    <circle cx="275" cy="150" r="9" fill="#B42318" />
    <text x="190" y="155" fontSize="12" fill="#003C7E" fontFamily="Arial" fontWeight="bold">rana sa nehojí</text>
  </svg>
);

// „Zavolajte mi späť" — pre pacientov, ktorí nezvládnu online objednanie.
// Dve polia, žiadny kód z SMS; žiadosť ide personálu (SMS na mobil pracoviska + e-mail),
// personál zavolá a pacienta objedná. Používa sa na stránke Zachráň nohu aj na bežnom /angio1.
export function CallbackCard({ onRequest, source = "angio1" }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try { const r = await onRequest({ name, phone, pref: "", source }); setDone(r || { ok: true }); }
    catch (ex) { setErr(friendlyError(ex?.message || String(ex))); }
    finally { setBusy(false); }
  };
  const field = "w-full px-4 py-3.5 bg-white border-2 border-slate-200 rounded-lg text-slate-800 text-lg placeholder:text-slate-400 focus:border-brand focus:ring-4 focus:ring-brand/15 outline-none transition-colors";
  return (
    <div className="bg-white rounded-xl border border-line p-5 md:p-7 border-2 border-brand/20" data-testid="callback-card">
      <h2 className="text-2xl md:text-3xl font-semibold text-brand-dark leading-tight">Nejde vám objednanie online? Zavoláme vám.</h2>
      <p className="text-slate-700 mt-2 text-base md:text-lg">Napíšte nám meno a telefónne číslo. <b>Zavoláme vám najneskôr nasledujúci pracovný deň</b> a termín dohodneme spolu. Nič iné vypĺňať nemusíte.</p>
      {done ? (
        <div className="mt-5 rounded-lg bg-brand-soft border border-line p-5 text-brand-dark" data-testid="callback-done" role="status" aria-live="polite">
          <p className="text-xl font-semibold">Ďakujeme, {name.trim()}.</p>
          <p className="mt-1 text-base">Žiadosť sme prijali. Zavoláme vám na číslo <b>{phone.trim()}</b> najneskôr nasledujúci pracovný deň. Telefón majte prosím pri sebe.</p>
          <p className="mt-3 text-sm text-slate-600">Ak sa stav nohy medzitým náhle zhorší (silná bolesť, bledá alebo studená noha), nečakajte na náš hovor a volajte 155.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-5" noValidate>
          <label className="block">
            <span className="block text-sm font-bold text-slate-700 mb-1">Meno a priezvisko</span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="napr. Mária Nováková" data-testid="cb-name" required />
          </label>
          <label className="block">
            <span className="block text-sm font-bold text-slate-700 mb-1">Telefónne číslo</span>
            <input className={field} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="napr. 0949 123 456" data-testid="cb-phone" required />
          </label>
          {err && <p className="text-red-600 font-semibold" data-testid="cb-error" role="alert">{err}</p>}
          <button type="submit" disabled={busy} data-testid="cb-submit"
            className="w-full md:w-auto md:min-w-[18rem] bg-brand hover:bg-brand-dark disabled:opacity-60 text-white text-lg font-bold px-8 py-4 rounded-lg shadow-md transition-colors">
            {busy ? "Odosielam…" : "Zavolajte mi späť ›"}
          </button>
          <p className="text-sm text-slate-500 leading-relaxed" data-testid="cb-privacy">
            Odoslaním potvrdzujete, že ste sa oboznámili s{" "}
            <a href="#/osobne-udaje" target="_blank" rel="noopener" className="text-brand font-semibold underline underline-offset-2">informáciami o spracúvaní osobných údajov</a>.
            Meno a číslo použijeme len na dohodnutie termínu; žiadosť po vybavení vymažeme. Objednať vás môže aj syn, dcéra či sused — s vaším vedomím napíše vaše meno a telefón, na ktorom vás zastihneme.
          </p>
        </form>
      )}
    </div>
  );
}

export default function ZachranNohuLanding({ landing, exam, children, requestCallback = null }) {
  return (
    <div className="space-y-6" data-testid="zn-landing">
      {/* lišta s kotvami */}
      <nav className="sticky top-0 z-20 -mx-2 sm:-mx-4 md:-mx-6 px-2 sm:px-4 md:px-6 py-2 bg-white/95 backdrop-blur border-b border-line" aria-label="Obsah stránky">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="font-semibold text-brand-dark whitespace-nowrap mr-1">Zachráň nohu</span>
          {NAV.map(([id, lbl]) => (
            <a key={id} href={hereHref()} onClick={goTo(id)} className={`whitespace-nowrap text-sm font-semibold px-3 py-2.5 min-h-[40px] inline-flex items-center rounded-full ${id === "urgent" ? "bg-danger-soft text-danger" : "bg-soft text-brand hover:bg-line"}`} data-testid={`nav-${id}`}>{lbl}</a>
          ))}
          <a href={hereHref()} onClick={goTo("objednat")} className="whitespace-nowrap text-sm font-bold px-4 py-2.5 min-h-[40px] inline-flex items-center rounded-full bg-brand text-white hover:bg-brand-dark ml-auto" data-testid="nav-objednat">Objednať sa</a>
        </div>
      </nav>

      {/* hero: vľavo modrý panel s textom, vpravo svetlý panel s 3D nohou od okraja po okraj */}
      <header id="hero" tabIndex={-1} className="relative overflow-hidden rounded-xl border border-line grid md:grid-cols-[11fr_9fr]">
        <div className="bg-brand-soft text-ink p-6 md:p-10 flex flex-col justify-center md:min-h-[440px]">
          <p className="text-[11px] md:text-xs font-semibold tracking-wide text-muted uppercase">Angiologická ambulancia č. 1 · NÚSCH, a.s.</p>
          <h1 data-testid="landing-title" className="text-3xl md:text-[2.75rem] font-semibold leading-tight mt-3 text-brand-dark">Rana na nohe, ktorá sa nehojí? Čas rozhoduje.</h1>
          <p className="text-base md:text-lg text-ink mt-4">Zistíme, či je príčinou <b>zlé prekrvenie</b>, a nasmerujeme vás tam, kde vám pomôžu.</p>
          <ul className="flex flex-wrap gap-2 mt-4" aria-label="Základné informácie">
            {["bez poplatku", "bez žiadanky", "termín do 7 dní", "15 – 20 minút"].map((c) => (
              <li key={c} className="text-xs md:text-sm font-medium bg-white border border-line text-brand-dark rounded-full px-3 py-1">{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3 mt-6">
            <a href={hereHref()} onClick={goTo("objednat")} data-testid="landing-cta" className="inline-block bg-brand text-white font-semibold text-base px-6 py-3 rounded-lg hover:bg-brand-dark transition-colors">
              {landing?.cta || "Objednať sa — termín do týždňa"} ›
            </a>
            <a href={hereHref()} onClick={goTo("samotest")} className="inline-block border border-brand text-brand font-semibold text-base px-5 py-3 rounded-lg hover:bg-white transition-colors">Zistiť, či sa mám objednať ↓</a>
          </div>
          {requestCallback && (
            <p className="mt-4 text-sm md:text-base text-muted">Nejde vám objednanie online? <a href={hereHref()} onClick={goTo("zavolame")} data-testid="hero-callback-link" className="font-semibold text-brand underline underline-offset-2 hover:text-brand-dark">Nechajte nám číslo, zavoláme vám ›</a></p>
          )}
        </div>
        <div className="bg-soft h-[300px] md:h-auto">
          <Photo name="tepna" eager rounded={false} testId="img-tepna-hero" alt="Zúžená tepna v nohe: za zúžením tečie do chodidla málo krvi a rana na palci sa nehojí" className="h-full w-full object-cover object-[50%_20%]"
            fallback={<div className="h-full w-full flex items-center justify-center p-6"><ArteryIllustration /></div>} />
        </div>
      </header>

      {/* čísla */}
      <section id="cisla" tabIndex={-1} className="scroll-mt-16 outline-none grid grid-cols-2 md:grid-cols-4 gap-3">
        {STATS.map((s) => (
          <div key={s.n} className="bg-white rounded-xl border border-line p-4 text-center">
            <p className="text-3xl md:text-4xl font-semibold text-brand">{s.n}</p>
            <p className="text-sm text-slate-700 mt-1">{s.t}</p>
            {s.src && <p className="text-[11px] text-slate-500 mt-1">{s.src}</p>}
          </div>
        ))}
      </section>

      {/* čo je to */}
      <section id="co-je-to" tabIndex={-1} className="scroll-mt-16 outline-none">
        <Card>
          <div className="grid md:grid-cols-2 gap-6 items-center">
            <div className="space-y-3 text-slate-700">
              <H2>Prečo sa rana nehojí?</H2>
              <p>Tepny v nohách sú ako <b>záhradná hadica</b>. Keď sa na jednom mieste zúžia usadeninami, do chodidla tečie málo krvi. Rana potrebuje na hojenie kyslík a živiny z krvi — bez nich sa <b>nezahojí, nech ju ošetrujete akokoľvek</b>.</p>
              <p>Zúženie rastie <b>roky, potichu a často bez bolesti</b>. Pri cukrovke je citlivosť znížená, takže prvým znamením býva práve rana, ktorá sa nehojí, alebo zmena farby prsta.</p>
              <p className="bg-brand-soft rounded-lg p-3"><b className="text-brand-dark">Naša úloha:</b> rozlíšiť, či sa rana nehojí pre zlé prekrvenie. Ultrazvuk a meranie tlakov to spoľahlivo odhalia. Ak prekrvenie chýba, zúženú tepnu dnes vieme vo väčšine prípadov spriechodniť cez malý vpich, bez veľkej operácie.</p>
            </div>
            <figure>
              <div className="aspect-square overflow-hidden rounded-lg bg-soft">
                <Photo name="tepna" rounded={false} alt="Detail: usadenina (plak) zužuje tepnu v stehne, pod ňou je prietok slabý" className="h-full w-full object-cover object-[50%_10%] scale-[1.7] origin-[50%_10%]" fallback={<ArteryIllustration />} />
              </div>
              <figcaption className="text-xs text-slate-500 mt-2">Usadenina (plak) zužuje tepnu v stehne; pod zúžením je prietok slabý a rana na prste sa nehojí.</figcaption>
            </figure>
          </div>
        </Card>
      </section>

      {/* samotest */}
      <section id="samotest" tabIndex={-1} className="scroll-mt-16 outline-none"><SelfTest /></section>

      {/* vyšetrenie */}
      <section id="vysetrenie" tabIndex={-1} className="scroll-mt-16 outline-none">
        <Card>
          <H2>Ako prebieha vyšetrenie</H2>
          <p className="text-slate-600 mt-1 mb-4">Päť jednoduchých krokov. Žiadna bolesť, žiadne ihly, žiadna príprava vopred.</p>
          <div className="grid md:grid-cols-2 gap-6 items-start">
          <ol className="space-y-3">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-3">
                <span className="shrink-0 w-9 h-9 rounded-full bg-brand text-white font-semibold flex items-center justify-center">{s.n}</span>
                <div><p className="font-bold text-brand-dark">{s.title}</p><p className="text-sm text-slate-700">{s.text}</p></div>
              </li>
            ))}
          </ol>
          <PhotoFigure name="vysetrenie" figureClass="md:sticky md:top-20" className="aspect-[3/2]" alt="Lekár vyšetruje ultrazvukom tepny na nohe pacienta ležiaceho na lehátku" caption="Ultrazvuk ciev dolnej končatiny: sonda s gélom, bez ihiel a bez žiarenia." />
          </div>
        </Card>
      </section>

      {/* čo ak niečo nájdu */}
      <section id="nalez" tabIndex={-1} className="scroll-mt-16 outline-none">
        <Card>
          <H2>Čo bude po vyšetrení?</H2>
          <p className="text-slate-700 mt-2">Vyšetrenie odpovie na jednu otázku: <b>tečie do rany dosť krvi?</b> Podľa odpovede vás nasmerujeme tam, kde vám najviac pomôžu — nikto neodchádza bez odporúčania. Nález zúženej tepny <b>nie je rozsudok</b>; rozhoduje, aby sa to stihlo, kým je rana malá.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead><tr className="text-left text-xs text-muted border-b border-line"><th className="py-2 pr-3">Výsledok</th><th className="py-2">Kam ďalej</th></tr></thead>
              <tbody>
                {FINDINGS.map(([a, b]) => (
                  <tr key={a} className="border-b border-soft align-top"><td className="py-2 pr-3 font-bold text-brand-dark min-w-[9rem]">{a}</td><td className="py-2 text-slate-700">{b}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <PhotoFigure name="zakrok" figureClass="mt-5" className="aspect-[16/9]" alt="Tri fázy zákroku cez cievu: tepna zúžená plakom, balónik roztláča zúženie, stent drží tepnu otvorenú" caption="Ako vyzerá zákrok cez cievu: zúžená tepna → balónik roztlačí usadeninu → stent (jemná sieťka) drží tepnu otvorenú. Vstup je malým vpichom, zvyčajne v slabine." />
          <p className="text-xs text-slate-500 mt-3">O presnom postupe vždy rozhoduje lekár podľa vášho celkového zdravotného stavu.</p>
        </Card>
      </section>

      {/* urgent */}
      <section id="urgent" tabIndex={-1} className="scroll-mt-16 outline-none">
        <div className="bg-danger-soft border border-danger/40 rounded-xl p-5 md:p-7" data-testid="landing-urgent">
          <h2 className="text-2xl md:text-3xl font-semibold text-danger leading-tight">Kedy okamžite volať 155 / 112</h2>
          <p className="text-slate-700 mt-2">Ak sa objaví čokoľvek z tohto, <b>nečakajte na termín</b>. Pri náhlom uzávere tepny rozhodujú hodiny.</p>
          <ul className="mt-3 space-y-1 text-slate-800">
            {URGENT.map((u) => <li key={u} className="flex gap-2"><span className="text-danger font-bold">▸</span><span>{u}</span></li>)}
          </ul>
          <p className="mt-4 text-sm text-slate-700">Povedzte záchranárom túto vetu: <b>„Mám náhlu bolesť nohy a noha je studená a bledá.“</b></p>
        </div>
      </section>

      {/* mýty */}
      <section id="myty" tabIndex={-1} className="scroll-mt-16 outline-none">
        <H2>Mýty vs. realita</H2>
        <div className="mt-3"><Myths /></div>
      </section>

      {/* záverečná výzva: fotka páru ako pozadie, modrý prekryv */}
      <section className="relative overflow-hidden rounded-xl text-white border border-line min-h-[360px] flex items-center">
        <Photo name="par" alt="Starší pár na prechádzke v jesennom parku" rounded={false} className="absolute inset-0 h-full w-full object-cover object-[75%_50%]" />
        <div className="absolute inset-0 bg-gradient-to-r from-brand-dark/90 via-brand-dark/70 to-brand/30" aria-hidden="true" />
        <div className="relative p-6 md:p-10 max-w-xl">
          <h2 className="text-2xl md:text-4xl font-semibold leading-tight">15 minút vyšetrenia. Roky chôdze po vlastných.</h2>
          <p className="mt-3 text-white/95">Nehojaca sa rana nie je kozmetický problém. Čím skôr zistíme, či do nohy tečie dosť krvi, tým jednoduchšie ju vieme zachrániť.</p>
          <a href={hereHref()} onClick={goTo("objednat")} className="inline-block mt-5 bg-white text-brand font-bold text-base px-6 py-3 rounded-lg shadow hover:bg-brand-soft">Objednať sa — termín do týždňa ›</a>
        </div>
      </section>

      {/* objednanie */}
      <section id="objednat" tabIndex={-1} className="scroll-mt-16 outline-none space-y-4">
        {children}
      </section>

      {requestCallback && (
        <section id="zavolame" tabIndex={-1} className="scroll-mt-16 outline-none">
          <CallbackCard onRequest={requestCallback} source="zachrannohu" />
        </section>
      )}

      {/* pätička */}
      <footer className="text-xs text-slate-500 border-t border-line pt-4 space-y-2">
        <p>Obsah tejto stránky má informačný charakter a nenahrádza vyšetrenie ani rozhovor s lekárom. Pri zdravotných ťažkostiach sa vždy obráťte na svojho lekára; pri náhlych ťažkostiach volajte 155.</p>
        <p className="font-semibold text-slate-600">Zdroje</p>
        <ul className="list-disc pl-5 space-y-0.5">{SOURCES.map((s) => <li key={s}>{s}</li>)}</ul>
        <p>
          <a href="#/podmienky" className="text-brand font-semibold hover:underline">Podmienky online objednávania</a>{" · "}
          <a href="#/osobne-udaje" className="text-brand font-semibold hover:underline">Ochrana osobných údajov</a>
        </p>
        <p>© {new Date().getFullYear()} Národný ústav srdcových a cievnych chorôb, a.s. · Angiologická ambulancia č. 1</p>
      </footer>
    </div>
  );
}
