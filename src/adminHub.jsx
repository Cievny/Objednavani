import { showToast } from "./toast.jsx";

// Rozcestník na úvode správy: všetky správy pre personál a všetky stránky,
// ktoré používajú pacienti a lekári (s kopírovaním odkazu na zdieľanie).
// Verejné stránky žijú v pacientskej verzii — zo správy (/sprava/) o úroveň vyššie.
const publicBase = () => `${window.location.origin}${window.location.pathname.replace(/sprava\/?$/, "")}`;

export default function AdminHub({ usgHref, angioAdminHref }) {
  const base = publicBase();
  const admin = [
    { href: usgHref, title: "USG — objednávky", desc: "platené USG vyšetrenia, platby, faktúry", current: true },
    { href: angioAdminHref, title: "Angiologická ambulancia č. 1", desc: "objednávky, kalendár, spätné volania" },
    { href: "#/ct", title: "CT pracovisko", desc: "žiadosti lekárov, kalendár, heslo pre lekárov" },
    { href: "#/platba", title: "Ad-hoc platby", desc: "platba za výkon cez QR kód" },
  ];
  const pub = [
    { url: `${base}#/`, title: "USG objednávanie", desc: "pacienti — platené USG vyšetrenia" },
    { url: `${base}#/angio1`, title: "Angiologická ambulancia — objednanie", desc: "pacienti — bez poplatku" },
    { url: `${base}zachrannohu/`, title: "Zachráň nohu", desc: "informačná stránka, samotest, Zavolajte mi späť" },
    { url: `${base}#/ct-lekar`, title: "CT pre lekárov NÚSCH", desc: "žiadosti o CT termín, spoločné heslo" },
    { url: `${base}#/som-tu`, title: "Som tu — príchod do čakárne", desc: "QR kód na stojane v čakárni" },
    { url: `${base}#/podmienky`, title: "Podmienky online objednávania", desc: "právne texty" },
    { url: `${base}#/osobne-udaje`, title: "Ochrana osobných údajov", desc: "právne texty" },
  ];
  const copy = async (url) => {
    try { await navigator.clipboard.writeText(url); showToast("Odkaz skopírovaný"); }
    catch { showToast("Odkaz sa nepodarilo skopírovať", "err"); }
  };
  return (
    <nav aria-label="Rozcestník správy" className="mb-5 space-y-4" data-testid="admin-hub">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Správa</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {admin.map((a) => (
            <a key={a.title} href={a.href} aria-current={a.current ? "page" : undefined} data-testid="hub-admin"
              className={`block rounded-lg border px-3 py-2.5 transition-colors ${a.current ? "border-brand bg-brand-soft" : "border-line bg-white hover:border-brand hover:bg-page"}`}>
              <span className="block text-sm font-semibold text-brand">{a.title}{a.current ? " · tu ste" : " ›"}</span>
              <span className="block text-xs text-muted mt-0.5">{a.desc}</span>
            </a>
          ))}
        </div>
      </div>
      <details className="group rounded-lg border border-line bg-white">
        <summary className="cursor-pointer select-none list-none px-3 py-2.5 text-sm font-semibold text-brand flex items-center gap-2" data-testid="hub-public-toggle">
          <span className="inline-block transition-transform group-open:rotate-90">▸</span> Stránky pre pacientov a lekárov ({pub.length})
        </summary>
        <ul className="divide-y divide-line border-t border-line">
          {pub.map((p) => (
            <li key={p.title} className="flex items-center gap-3 px-3 py-2" data-testid="hub-public">
              <div className="min-w-0 flex-1">
                <a href={p.url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-brand hover:underline">{p.title} ↗</a>
                <span className="block text-xs text-muted truncate">{p.desc} · {p.url.replace(/^https?:\/\//, "")}</span>
              </div>
              <button type="button" onClick={() => copy(p.url)} title="Kopírovať odkaz" aria-label={`Kopírovať odkaz: ${p.title}`}
                className="shrink-0 text-xs bg-soft hover:bg-line text-ink font-semibold px-2.5 py-1.5 rounded-lg">📋 Kopírovať</button>
            </li>
          ))}
        </ul>
      </details>
    </nav>
  );
}
