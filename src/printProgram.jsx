// Tlač programu dňa (aj „Uložiť ako PDF" v dialógu tlače) — USG, angio, CT.
// Program sa vloží do #print-root mimo aplikácie; pri tlači je viditeľný len on
// (src/index.css, body.printing). Titulok okna = názov súboru pri uložení do PDF.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// +421905222333 → +421 905 222 333 (ostatné tvary ostávajú, ako ich pacient zadal)
export const fmtPhone = (p) => {
  const s = String(p || "").replace(/\s+/g, "");
  return /^\+4\d{11}$/.test(s) ? `${s.slice(0, 4)} ${s.slice(4, 7)} ${s.slice(7, 10)} ${s.slice(10)}` : String(p || "");
};

// rows: [{ time, end, name, birth, phone, exam, doctor, status, notes: [] }]
export function printDayProgram({ heading, dateLabel, rows }) {
  const now = new Date().toLocaleString("sk-SK", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const body = rows.length === 0
    ? `<tr><td colspan="7" class="pp-empty">V tento deň nie sú objednaní žiadni pacienti.</td></tr>`
    : rows.map((r) => `<tr>
        <td class="pp-time"><b>${esc(r.time)}</b>${r.end ? `<br><span>–${esc(r.end)}</span>` : ""}</td>
        <td><b>${esc(r.name)}</b>${r.birth ? `<br><span>nar. ${esc(r.birth)}</span>` : ""}</td>
        <td class="pp-phone">${esc(fmtPhone(r.phone)) || "—"}</td>
        <td>${esc(r.exam)}${r.doctor ? `<br><span>${esc(r.doctor)}</span>` : ""}</td>
        <td>${esc(r.status)}</td>
        <td class="pp-notes">${(r.notes || []).filter(Boolean).map(esc).join("<br>")}</td>
        <td class="pp-chk"><span class="pp-box"></span></td>
      </tr>`).join("");
  const html = `
    <div class="pp-head">
      <div>
        <div class="pp-org">Národný ústav srdcových a cievnych chorôb, a.s.</div>
        <h1>${esc(heading)} — program dňa</h1>
        <div class="pp-date">${esc(dateLabel)}</div>
      </div>
      <div class="pp-meta">${rows.length} ${rows.length === 1 ? "pacient" : rows.length > 1 && rows.length < 5 ? "pacienti" : "pacientov"}<br>vytlačené ${esc(now)}</div>
    </div>
    <table class="pp-table">
      <thead><tr><th>Čas</th><th>Pacient</th><th>Telefón</th><th>Vyšetrenie / lekár</th><th>Stav</th><th>Poznámka</th><th class="pp-chk">Prišiel</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="pp-foot">Dôverné — obsahuje osobné údaje pacientov. Po použití skartujte.</p>`;
  let root = document.getElementById("print-root");
  if (!root) { root = document.createElement("div"); root.id = "print-root"; document.body.appendChild(root); }
  root.innerHTML = html;
  const prevTitle = document.title;
  document.title = `${heading} — program ${dateLabel}`;
  document.body.classList.add("printing");
  const cleanup = () => {
    document.body.classList.remove("printing");
    root.innerHTML = "";
    document.title = prevTitle;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

export function PrintButton({ onClick, label = "Tlačiť / PDF", className = "" }) {
  return (
    <button type="button" onClick={onClick} data-testid="print-program" title="Vytlačiť program dňa alebo ho uložiť ako PDF"
      className={`shrink-0 text-xs font-semibold text-brand bg-white border border-line hover:border-brand px-3 py-1.5 rounded-lg ${className}`}>
      🖨 {label}
    </button>
  );
}
