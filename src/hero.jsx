// Výrazný úvod stránky a farebné dlaždice služieb (v138, návrh na porovnanie na beta).
// Štýl: tmavomodrý blok s veľkým nadpisom, okrúhle tlačidlo so šípkou, fotografia
// v oblúku; pod ním pastelové dlaždice s jednoduchými kreslenými ikonami.
// Farby len z tokenov v src/index.css (brand-dark + tile-*).
//
// ODLOŽENÉ (26. 11. 2026, rozhodnutie lekára): nový vzhľad sa zobrazuje LEN na beta
// (build s VITE_BETA=1) alebo lokálne s VITE_NEW_LOOK=1. Ostrá stránka má pôvodný
// úvod v105. Zapnutie na ostrej = zmeniť NEW_LOOK nižšie na true.
export const NEW_LOOK = import.meta.env.VITE_BETA === "1" || import.meta.env.VITE_NEW_LOOK === "1";

const scrollToId = (id) => (e) => {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  el.focus?.({ preventScroll: true });
};

// --- ikony (dekoratívne, aria-hidden) ---------------------------------------
const Svg = ({ className = "", children, size = 64 }) => (
  <svg viewBox={`0 0 ${size} ${size}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>{children}</svg>
);
// ultrazvuková sonda (držadlo, hlavica s vypuklou plôškou, kábel) a vlny pod ňou
export const IconProbe = (p) => (
  <Svg {...p}>
    <g transform="rotate(-28 32 30)">
      <path d="M32 6c2-5 12-5 14 2" />
      <rect x="27" y="6" width="10" height="20" rx="4" />
      <path d="M24 26h16v8c0 2-1 3-3 3H27c-2 0-3-1-3-3z" />
      <path d="M22 37h20c0 4-4 7-10 7s-10-3-10-7z" />
    </g>
    <path d="M20 52c7 4 17 4 24 0" /><path d="M14 58c11 6 25 6 36 0" />
  </Svg>
);
export const IconStethoscope = (p) => (
  <Svg {...p}>
    <path d="M14 6h7M33 6h7" /><path d="M17 6v14a10 10 0 0 0 20 0V6" />
    <path d="M27 30v10a11 11 0 0 0 22 0v-6" /><circle cx="49" cy="28" r="6" /><circle cx="49" cy="28" r="1.5" />
  </Svg>
);
export const IconChat = (p) => (
  <Svg {...p}>
    <path d="M12 10h40a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H30l-11 10V44h-7a6 6 0 0 1-6-6V16a6 6 0 0 1 6-6z" />
    <path d="M32 19v16M24 27h16" />
  </Svg>
);
export const IconFoot = (p) => (
  <Svg {...p}>
    <path d="M23 26c-6 8-7 21-3 29 3 7 14 8 17 0 3-8-1-13 1-20 2-8-1-14-7-14-3 0-6 2-8 5z" />
    <circle cx="25" cy="13" r="3.5" /><circle cx="33" cy="10" r="3" /><circle cx="40" cy="12" r="2.6" /><circle cx="45" cy="16" r="2.2" /><circle cx="48" cy="21" r="1.8" />
  </Svg>
);
const IconArrow = ({ className = "" }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
const CHIP_ICONS = {
  calendar: <><rect x="4" y="5.5" width="16" height="14" rx="2.5" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  qr: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2v2M20 14v6h-6M17 17v3" /></>,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  doctor: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5" /></>,
};
const ChipIcon = ({ name }) => (
  <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/15 shrink-0" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">{CHIP_ICONS[name] || CHIP_ICONS.heart}</svg>
  </span>
);

// --- úvod -----------------------------------------------------------------
// word = veľký nadpis (h1); title = menší podnadpis; note = drobný text dole (verzálkami);
// cta = { label, target (id prvku na stránke) | href, testId }; photo = { src, alt, position }
export function BigHero({ eyebrow, word, title, text, chips = [], note, cta, photo, decor, testId = "big-hero" }) {
  const ctaProps = cta?.target ? { href: `#${cta.target}`, onClick: scrollToId(cta.target) } : { href: cta?.href };
  const Cta = cta ? (
    <a {...ctaProps} data-testid={cta.testId} className="group inline-flex items-center gap-1.5 self-start">
      <span className="bg-tile-rose text-brand-dark font-semibold text-base md:text-lg pl-6 pr-5 py-3 rounded-full transition-colors group-hover:bg-white">{cta.label}</span>
      <span className="inline-flex items-center justify-center w-12 h-12 rounded-full border-2 border-tile-rose text-tile-rose transition-transform group-hover:translate-x-0.5 group-hover:border-white group-hover:text-white">
        <IconArrow className="w-5 h-5" />
      </span>
    </a>
  ) : null;
  return (
    <section className="relative overflow-hidden rounded-[28px] bg-brand-dark text-white" aria-label="Úvod" data-testid={testId}>
      <div className={`relative px-5 pt-6 pb-6 md:px-10 md:pt-9 md:pb-10 ${photo ? "md:pr-[40%]" : ""}`}>
        {eyebrow && <p className="text-[11px] md:text-xs font-semibold uppercase tracking-[0.16em] text-white/70">{eyebrow}</p>}
        <h1 className="font-sans font-bold text-white leading-[0.92] tracking-[-0.035em] text-[clamp(3rem,15vw,7.25rem)] mt-2 md:mt-3 relative z-0">{word}</h1>
        {title && <p className="text-xl md:text-2xl font-semibold text-white/95 leading-snug mt-3 md:mt-4 max-w-xl">{title}</p>}

        {photo && (
          // mobil: oblúk s fotkou pod nadpisom; počítač: oblúk vpravo, prekrýva koniec nadpisu
          <div className="relative z-10 mx-auto mt-5 w-[78%] max-w-[320px] h-[clamp(160px,25vh,210px)] rounded-t-full overflow-hidden border-4 border-white/10
                          md:absolute md:mt-0 md:right-10 md:bottom-0 md:top-[22%] md:w-[33%] md:max-w-[360px] md:h-auto md:border-b-0">
            <img src={photo.src} alt={photo.alt} className="absolute inset-0 w-full h-full object-cover" style={{ objectPosition: photo.position || "50% 50%" }} />
          </div>
        )}
        {!photo && decor && (
          <div className="pointer-events-none absolute hidden md:block -right-6 -bottom-8 text-white/10 w-64" aria-hidden="true">{decor}</div>
        )}

        {chips.length > 0 && (
          <ul className="flex flex-wrap gap-x-5 gap-y-2.5 mt-5 md:mt-6 relative z-10" aria-label="Základné informácie">
            {chips.map(([icon, label]) => (
              <li key={label} className="flex items-center gap-2 text-sm md:text-base text-white/95"><ChipIcon name={icon} />{label}</li>
            ))}
          </ul>
        )}
        {/* s fotkou na mobile text vynechať, aby bolo tlačidlo vidieť bez posúvania */}
        {text && <p className={`text-base md:text-lg text-white/85 mt-5 max-w-xl relative z-10 ${photo ? "hidden md:block" : ""}`}>{text}</p>}
        <div className="mt-6 md:mt-7 flex flex-col gap-4 relative z-10">
          {Cta}
          {note && <p className="text-[11px] md:text-xs uppercase tracking-[0.08em] leading-relaxed text-white/65 max-w-md">{note}</p>}
        </div>
      </div>
    </section>
  );
}

// --- dlaždice služieb -----------------------------------------------------
const TILE_TONES = {
  rose: { bg: "bg-tile-rose", ink: "text-tile-rose-ink" },
  sun: { bg: "bg-tile-sun", ink: "text-tile-sun-ink" },
  mint: { bg: "bg-tile-mint", ink: "text-tile-mint-ink" },
  sky: { bg: "bg-tile-sky", ink: "text-tile-sky-ink" },
};
// items: [{ title, sub, tone, Icon, href | target, testId }]
export function ServiceTiles({ items, label = "Čo pre vás môžeme urobiť" }) {
  return (
    <nav aria-label={label} data-testid="service-tiles">
      <ul className="grid grid-cols-2 md:grid-cols-4 gap-2.5 md:gap-3">
        {items.map(({ title, sub, tone, Icon, href, target, testId }) => {
          const t = TILE_TONES[tone] || TILE_TONES.sky;
          const linkProps = target ? { href: `#${target}`, onClick: scrollToId(target) } : { href };
          return (
            <li key={title} className="min-w-0">
              <a {...linkProps} data-testid={testId}
                className={`group relative flex h-full min-h-[158px] md:min-h-[200px] flex-col overflow-hidden rounded-[22px] p-4 md:p-5 ${t.bg} transition-transform hover:-translate-y-0.5`}>
                <span className="relative z-10 block text-[17px] md:text-xl font-bold leading-tight text-brand-dark pr-1">{title}</span>
                <span className="relative z-10 block text-xs md:text-sm leading-snug text-brand-dark/80 mt-1.5 pr-2 md:pr-8">{sub}</span>
                <span className="relative z-10 mt-auto inline-flex items-center justify-center w-9 h-9 rounded-full bg-brand-dark text-white transition-transform group-hover:translate-x-0.5" aria-hidden="true">
                  <IconArrow className="w-4 h-4" />
                </span>
                <Icon className={`absolute right-1 bottom-1 w-16 h-16 md:-right-1 md:-bottom-2 md:w-24 md:h-24 ${t.ink}`} />
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
