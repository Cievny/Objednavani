// ============================================================
// Supabase Edge Function: order-emails
// Posiela e-mailové notifikácie k objednávkam cez Resend.
//
// Volá ju Database Webhook na tabuľke orders (INSERT + UPDATE).
// Potrebné secrets (Edge Functions -> Secrets):
//   RESEND_API_KEY  – kľúč z resend.com
//   WEBHOOK_SECRET  – ľubovoľný dlhý reťazec; ten istý sa nastaví
//                     ako hlavička x-webhook-secret vo webhooku
//   MAIL_FROM       – voliteľné, napr. "NÚSCH Objednávanie <info@objednavky.nusch.sk>"
//                     (kým nie je overená doména, nechajte nevyplnené —
//                     použije sa testovacia adresa onboarding@resend.dev)
// E-maily:
//   INSERT                  -> pacientovi potvrdenie rezervácie + platobné údaje
//                              + pracovisku upozornenie (settings.notify_email)
//   UPDATE -> confirmed     -> pacientovi potvrdenie termínu
//   UPDATE -> rejected      -> pacientovi zrušenie
//   UPDATE zmena dňa/času   -> pacientovi presun termínu
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "NÚSCH Objednávanie <onboarding@resend.dev>";
const APP_URL = Deno.env.get("APP_URL") ?? "https://cievny.github.io/Objednavani/";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const fmtDate = (iso: string) => {
  try {
    return new Date(`${iso}T12:00:00`).toLocaleDateString("sk-SK", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  } catch {
    return iso;
  }
};
const fmtTime = (t: string) => (t || "").slice(0, 5);
const fmtPrice = (p: unknown) => `${Number(p).toFixed(2).replace(".", ",")} €`;

async function getSettings(): Promise<Record<string, string>> {
  const { data } = await supabase.from("settings").select("key, value");
  return Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!to || !to.includes("@")) return;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
  });
  if (!res.ok) {
    console.error("Resend error", res.status, await res.text());
  }
}

function layout(title: string, intro: string, rows: [string, string][], outro = "") {
  const tr = rows
    .filter(([, v]) => v)
    .map(([k, v]) =>
      `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top">${k}</td>` +
      `<td style="padding:6px 0;color:#0f172a;font-weight:600">${v}</td></tr>`)
    .join("");
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <div style="border-bottom:3px solid #e2001a;padding:16px 0;margin-bottom:16px">
      <strong style="color:#003d7c;font-size:15px">Národný ústav srdcových a cievnych chorôb, a.s.</strong><br>
      <span style="color:#64748b;font-size:12px">Objednávanie na USG vyšetrenia</span>
    </div>
    <h2 style="color:#003d7c;font-size:20px;margin:0 0 8px">${title}</h2>
    <p style="font-size:14px;line-height:1.5">${intro}</p>
    <table style="font-size:14px;border-collapse:collapse;margin:12px 0">${tr}</table>
    ${outro ? `<p style="font-size:13px;line-height:1.5;background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:10px">${outro}</p>` : ""}
    <p style="font-size:12px;color:#94a3b8;margin-top:20px">
      Stav objednávky si môžete kedykoľvek overiť (číslom objednávky a telefónom) na
      <a href="${APP_URL}" style="color:#005ca9">${APP_URL}</a>.<br>
      Tento e-mail bol vygenerovaný automaticky, neodpovedajte naň.
    </p>
  </div>`;
}

// deno-lint-ignore no-explicit-any
function orderRows(r: any): [string, string][] {
  return [
    ["Vyšetrenie", r.exam_label],
    ["Termín", `${fmtDate(r.slot_date)} o ${fmtTime(r.slot_time)}`],
    ["Lekár", r.doctor || ""],
    ["Pacient", r.patient_name],
    ["Číslo objednávky", r.id],
  ];
}

Deno.serve(async (req) => {
  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const { type, record, old_record: old } = payload ?? {};
  if (!record) return Response.json({ ok: true, skipped: true });

  const settings = await getSettings();
  const termin = `${fmtDate(record.slot_date)} o ${fmtTime(record.slot_time)}`;

  if (type === "INSERT") {
    const paymentRows: [string, string][] = [
      ...orderRows(record),
      [record.has_referral ? "Doplatok so žiadankou" : "Cena (samoplatca)", fmtPrice(record.price)],
      ["IBAN", settings.iban ?? ""],
      ["Variabilný symbol", record.variable_symbol],
    ];
    await sendEmail(
      record.email,
      `Rezervácia USG vyšetrenia — ${termin}`,
      layout(
        "Rezervácia prijatá — čaká na platbu",
        "Ďakujeme za objednávku. Termín je rezervovaný a bude potvrdený po prijatí platby (údaje nižšie, prípadne QR kód zo stránky).",
        paymentRows,
        record.has_referral
          ? "Nezabudnite si na vyšetrenie priniesť žiadanku (výmenný lístok) od odporúčajúceho lekára — bez nej platí plná samoplatcovská cena."
          : "Ak platba nepríde do 24 hodín, rezervácia môže byť zrušená.",
      ),
    );
    if (settings.notify_email) {
      await sendEmail(
        settings.notify_email,
        `Nová objednávka: ${record.patient_name} — ${termin}`,
        layout(
          "Nová objednávka na USG",
          "V systéme pribudla nová objednávka.",
          [
            ...orderRows(record),
            ["Telefón", record.phone],
            ["E-mail", record.email || "—"],
            ["Typ", record.has_referral ? "so žiadankou (doplatok)" : "samoplatca"],
            ["Suma", fmtPrice(record.price)],
          ],
        ),
      );
    }
    return Response.json({ ok: true, sent: "insert" });
  }

  if (type === "UPDATE" && old) {
    const slotChanged = old.slot_date !== record.slot_date || fmtTime(old.slot_time) !== fmtTime(record.slot_time);

    if (old.status !== "confirmed" && record.status === "confirmed") {
      await sendEmail(
        record.email,
        `Termín USG potvrdený — ${termin}`,
        layout(
          "Váš termín je potvrdený",
          "Platbu sme prijali a termín vyšetrenia je záväzne potvrdený. Tešíme sa na vás.",
          orderRows(record),
          record.has_referral ? "Prineste si so sebou žiadanku (výmenný lístok)." : "",
        ),
      );
      return Response.json({ ok: true, sent: "confirmed" });
    }

    if (old.status !== "rejected" && record.status === "rejected") {
      await sendEmail(
        record.email,
        `Objednávka USG zrušená — ${termin}`,
        layout(
          "Objednávka bola zrušená",
          record.status_note === "Zrušené pacientom"
            ? "Vaša objednávka bola na vašu žiadosť zrušená."
            : `Vaša objednávka bola zrušená pracoviskom.${record.status_note ? ` Dôvod: ${record.status_note}` : ""} V prípade otázok nás kontaktujte.`,
          orderRows(record),
          record.paid ? "Objednávka bola uhradená — ohľadom vrátenia platby vás budeme kontaktovať." : "",
        ),
      );
      return Response.json({ ok: true, sent: "rejected" });
    }

    if (slotChanged && record.status !== "rejected") {
      await sendEmail(
        record.email,
        `Zmena termínu USG — ${termin}`,
        layout(
          "Váš termín bol presunutý",
          `Pôvodný termín ${fmtDate(old.slot_date)} o ${fmtTime(old.slot_time)} bol presunutý na nový termín nižšie. Ak vám nevyhovuje, kontaktujte nás alebo objednávku zrušte na stránke.`,
          orderRows(record),
        ),
      );
      return Response.json({ ok: true, sent: "rescheduled" });
    }
  }

  return Response.json({ ok: true, skipped: true });
});
