// Čítanie žiadanky na CT z PDF (DOCTUS / AdaSoft) priamo v prehliadači lekára —
// súbor nikam neodchádza, pdf.js sa načíta až pri nahratí. readZiadankaPdf()
// vráti textové položky s pozíciou, parseZiadanka() z nich podľa popisov polí
// na žiadanke vytiahne údaje na predvyplnenie formulára CT pre lekárov.

export async function readZiadankaPdf(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.min.mjs");
  const { default: workerUrl } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
  try {
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    return tc.items.filter((it) => it.str && it.str.trim())
      .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() }));
  } finally {
    doc.destroy();
  }
}

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const isoFromSk = (s) => { const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s || ""); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : ""; };
const num = (s) => { const n = Number(String(s || "").replace(",", ".").replace(/[^\d.]/g, "")); return n > 0 ? n : null; };

// riadky textu: položky s rovnakou výškou (±3 body) zoradené zľava doprava, riadky zhora nadol
function toRows(items) {
  const rows = [];
  [...items].sort((a, b) => b.y - a.y || a.x - b.x).forEach((it) => {
    const r = rows.find((row) => Math.abs(row.y - it.y) <= 3);
    if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] });
  });
  rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  return rows;
}

export function parseZiadanka(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const label = (re) => items.find((it) => re.test(norm(it.s)));
  // hodnota vpravo od popisu v tom istom riadku (po ďalší popis, ak je zadaný)
  const rightOf = (lab, untilLab, dy = 6) => !lab ? [] : items
    .filter((it) => it !== lab && Math.abs(it.y - lab.y) <= dy && it.x > lab.x + 5 && (!untilLab || it.x < untilLab.x - 2))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  // hodnota pod popisom (najbližší riadok nižšie), v stĺpci od popisu po ďalší popis
  const below = (lab, untilLab, maxDy = 25) => {
    if (!lab) return [];
    const cand = items.filter((it) => it.y < lab.y - 3 && it.y >= lab.y - maxDy && it.x >= lab.x - 80 && (!untilLab || it.x < untilLab.x - 2));
    if (!cand.length) return [];
    const top = Math.max(...cand.map((it) => it.y));
    return cand.filter((it) => Math.abs(it.y - top) <= 3).sort((a, b) => a.x - b.x);
  };
  // text medzi dvoma popismi (sekcia na celú šírku)
  const between = (fromLab, toLab) => {
    if (!fromLab) return "";
    const lo = toLab ? toLab.y + 2 : -Infinity;
    return toRows(items.filter((it) => it.y < fromLab.y - 2 && it.y > lo))
      .map((r) => r.items.map((it) => it.s).join(" ")).join("\n").trim();
  };
  const join = (arr) => arr.map((it) => it.s).join(" ").replace(/\s+/g, " ").trim();

  const lName = label(/^priezvisko a meno/), lBirth = label(/^datum narodenia/), lRc = label(/^rodne cislo/);
  const lPoist = label(/^cislo poistenca/), lPayType = label(/^druh uhrady/);
  const lIns = label(/^cis\.? poistovne/), lPhone = label(/^telefon/), lEmail = label(/^email/), lResched = label(/^preplanovane/);
  const lSender = label(/^odosielatel/), lOrdered = label(/^objednal:?$/), lPlanned = label(/^objednane na/);
  const lDg = label(/^kod diagnozy/), lExams = label(/^pozadovane vysetrenia/), lQuestion = label(/^otazka, ktora/);
  const lAllergy = label(/^alergicka anamneza/), lObj = label(/^objektivny nalez/), lLab = label(/^posledny vysledok lab/);
  const lPrevCt = label(/^bol uz pacient vysetreny na ct/), lPrep = label(/^- za spravnu pripravu/), lHw = label(/^vyska\/vaha/);
  if (!lName && !lQuestion) return null; // nie je to žiadanka v známom tvare

  const out = {};
  out.patientName = join(below(lName, lBirth));
  out.birthDate = isoFromSk(join(below(lBirth, lRc)));
  // rodné číslo: pod „Rodné číslo", inak „Číslo poistenca" (u poistencov v SR je to r.č.)
  const rcOf = (s) => { const m = /(?:^|\D)(\d{6})\s*\/?\s*(\d{3,4})(?!\d)/.exec(s || ""); return m ? `${m[1]}/${m[2]}` : ""; };
  out.birthNumber = rcOf(join(lRc ? items.filter((it) => it.y < lRc.y - 3 && it.y >= lRc.y - 25 && it.x >= lRc.x - 10) : []))
    || rcOf(join(below(lPoist, lPayType)));
  const ins = join(rightOf(lIns));
  const insCode = /^(\d{2})\b/.exec(ins)?.[1] || "";
  out.insurance = ["24", "25", "27"].includes(insCode) ? insCode : ins ? "other" : "";
  out.phone = join(rightOf(lPhone, lEmail)).replace(/[^\d+ ]/g, "").trim();
  out.email = (/[^\s@]+@[^\s@]+\.[^\s@]+/.exec(join(rightOf(lEmail, lResched))) || [""])[0];
  out.plannedDate = isoFromSk(join(rightOf(lPlanned)));

  // odosielateľ: oddelenie a lekár bez kódov (P…/A… čísla PZS a lekára); objednal: meno bez dátumu
  if (lSender) {
    const senderRows = toRows(items.filter((it) => it.y <= lSender.y + 3 && it.y >= lSender.y - 20 && it.x > lSender.x + 5 && (!lOrdered || it.x < lOrdered.x - 2)));
    const strip = (s) => s.replace(/^[A-Z]?\d{5,}\s+/, "").trim();
    out.senderDept = strip(senderRows[0]?.items.map((it) => it.s).join(" ").replace(/\s*-\s*\d+\s*$/, "") || "");
    out.senderDoctor = strip(senderRows[1]?.items.map((it) => it.s).join(" ") || "");
  }
  if (lOrdered) {
    out.orderedBy = items.filter((it) => it.y <= lOrdered.y + 3 && it.y >= lOrdered.y - 20 && it.x > lOrdered.x + 5 && !/\d{1,2}\.\d{1,2}\.\d{4}/.test(it.s))
      .map((it) => it.s).join(" ").trim();
  }
  out.heightWeight = join(rightOf(lHw)).replace(/[^\d/]/g, "");

  const dg = rightOf(lDg);
  out.diagnosisCode = dg.find((it) => /^[A-Z]\d{2}(\.\d+)?$/.test(it.s))?.s || "";
  out.diagnosisText = dg.filter((it) => it.s !== out.diagnosisCode).map((it) => it.s).join(" ").trim();
  out.requestedExams = lExams ? toRows(items.filter((it) => it.y < lExams.y - 2 && (!lQuestion || it.y > lQuestion.y + 2) && it.x >= lExams.x - 5))
    .map((r) => r.items.map((it) => it.s).join(" ").trim()).filter(Boolean) : [];
  out.question = between(lQuestion, lAllergy || lObj || lLab).replace(/\n/g, " ");
  out.allergy = between(lAllergy, lObj || lLab).replace(/\n/g, " ");
  out.objective = between(lObj, lLab).replace(/\n/g, " ");
  out.previousCt = between(lPrevCt, lPrep).replace(/\n/g, " ");

  // laboratórne výsledky: riadky pod hlavičkou tabuľky (dátum odberu, parameter, hodnota)
  out.labs = [];
  if (lLab) {
    const end = lPrevCt || lPrep;
    toRows(items.filter((it) => it.y < lLab.y - 2 && (!end || it.y > end.y + 2))).forEach((r) => {
      const txt = r.items.map((it) => it.s).join(" ");
      const date = isoFromSk(txt);
      const param = r.items.find((it) => /^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(it.s) && !/^(umol|mmol|ml|l)\b/i.test(it.s))?.s || "";
      const value = r.items.find((it) => /^\d+([.,]\d+)?$/.test(it.s))?.s || "";
      if (param && value) out.labs.push({ date, param, value: num(value) });
    });
  }
  const crea = out.labs.find((l) => /^(kreat|kreatinin|crea|creat|s-kreat)/i.test(l.param));
  const egfr = out.labs.find((l) => /gfr/i.test(l.param));
  out.creatinine = crea?.value ?? null;
  out.egfr = egfr?.value ?? null;
  out.labDate = (crea || egfr)?.date || "";

  // kontrast: CTA / angiografia / kontrast v otázke alebo požadovaných vyšetreniach
  const wantsText = norm(`${out.question} ${out.requestedExams.join(" ")}`);
  out.contrast = /\bcta\b|angio|kontrast|i\.v\./.test(wantsText) ? true : null;
  const al = norm(out.allergy);
  out.allergyAnswer = !al ? "" : /jod|kontrast/.test(al) ? "ano" : /^(ziadn|nie|neguje|bez|0\b|-$|nema)/.test(al) ? "nie" : "";
  return out;
}

// typ CT z cenníka: pri CTA / angiografii typ s „angio" v názve; inak podľa prvého
// požadovaného vyšetrenia — typ s najväčším podielom zhodných slov názvu (pri zhode nič)
export function matchCtExam(parsed, pricelist) {
  if (!parsed || !Array.isArray(pricelist) || pricelist.length === 0) return null;
  const all = norm(`${parsed.requestedExams.join(" ")} ${parsed.question}`);
  if (/\bcta\b|angiograf/.test(all)) {
    const angio = pricelist.filter((p) => /angio/.test(norm(p.label)));
    if (angio.length === 1) return angio[0];
  }
  const first = norm(parsed.requestedExams[0] || parsed.question);
  const stem = (w) => w.slice(0, Math.max(4, Math.min(6, w.length - 2)));
  let best = null, bestScore = 0, tie = false;
  pricelist.forEach((p) => {
    const words = norm(p.label).split(/[^a-z]+/).filter((w) => w.length >= 4 && w !== "oblasti");
    if (!words.length) return;
    const score = words.filter((w) => first.includes(stem(w))).length / words.length;
    if (score > bestScore) { best = p; bestScore = score; tie = false; } else if (score > 0 && score === bestScore) tie = true;
  });
  return bestScore >= 0.5 && !tie ? best : null;
}
