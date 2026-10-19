// Zdieľané UI primitíva (audit UX 1 / v111). Jediné miesto, kde sa definujú
// triedy vstupov, tlačidiel a farby stavov — moduly ich importujú namiesto
// vlastných kópií. Farby sú výlučne z tokenov v src/index.css.

// --- vstupy -----------------------------------------------------------------
export const inputCls = "w-full p-3 bg-white border border-line rounded-lg text-ink focus:border-brand focus:ring-2 focus:ring-brand/30 outline-none";
export const inputSmCls = "w-full p-2 bg-white border border-line rounded-lg text-ink text-sm focus:border-brand focus:ring-2 focus:ring-brand/30 outline-none";
export const labelCls = "block text-sm font-semibold text-ink mb-1";

// Pole formulára: label ↔ input prepojené cez id, hviezdička pre povinné,
// chyba s role=alert a aria-describedby.
let fieldSeq = 0;
export function Field({ label, required = false, hint = "", error = "", className = "", children, id }) {
  const [uid] = useStateOnce(() => id || `f-${++fieldSeq}`);
  const hintId = hint ? `${uid}-hint` : undefined;
  const errId = error ? `${uid}-err` : undefined;
  const child = children && typeof children === "object" && "props" in children
    ? cloneWith(children, { id: uid, "aria-invalid": error ? "true" : undefined, "aria-describedby": [hintId, errId].filter(Boolean).join(" ") || undefined, "aria-required": required || undefined })
    : children;
  return (
    <div className={className}>
      <label htmlFor={uid} className={labelCls}>{label}{required && <span className="text-danger" aria-hidden="true"> *</span>}</label>
      {child}
      {hint && !error && <p id={hintId} className="text-xs text-muted mt-1">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}

// --- tlačidlá -----------------------------------------------------------------
const BTN_VARIANT = {
  primary: "bg-brand hover:bg-brand-dark text-white",
  secondary: "bg-soft hover:bg-line text-ink",
  outline: "bg-white border border-brand text-brand hover:bg-brand-soft",
  danger: "bg-danger hover:bg-danger/90 text-white",
  "danger-outline": "bg-white border border-danger/40 text-danger hover:bg-danger-soft",
  ghost: "text-brand hover:bg-brand-soft",
};
const BTN_SIZE = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-6 py-3 text-base" };
export function Btn({ variant = "primary", size = "md", block = false, className = "", type = "button", href, children, ...rest }) {
  const cls = `inline-flex items-center justify-center gap-2 font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${BTN_VARIANT[variant] || BTN_VARIANT.primary} ${BTN_SIZE[size] || BTN_SIZE.md} ${block ? "w-full" : ""} ${className}`;
  if (href) return <a href={href} className={cls} {...rest}>{children}</a>;
  return <button type={type} className={cls} {...rest}>{children}</button>;
}

// --- karty a upozornenia -----------------------------------------------------
const CARD_PAD = { sm: "p-4", md: "p-5 md:p-6", lg: "p-6 md:p-8" };
export function Card({ pad = "md", className = "", children, ...rest }) {
  return <div className={`bg-white rounded-xl border border-line ${CARD_PAD[pad] || CARD_PAD.md} ${className}`} {...rest}>{children}</div>;
}
const CALLOUT = {
  info: "bg-brand-soft border-brand/30 text-brand-dark",
  warn: "bg-warn-soft border-warn/30 text-warn",
  danger: "bg-danger-soft border-danger/40 text-danger",
  success: "bg-success-soft border-success/40 text-success",
  soft: "bg-soft border-line text-ink",
};
export function Callout({ tone = "info", className = "", children, ...rest }) {
  return <div className={`border rounded-lg px-3 py-2 text-sm ${CALLOUT[tone] || CALLOUT.info} ${className}`} {...rest}>{children}</div>;
}

// --- stavy objednávok ---------------------------------------------------------
// Jedna mapa pre USG, angio aj CT: čip (zoznamy), accent (ľavý okraj karty), card (pozadie karty).
export const STATUS_TONES = {
  new: { chip: "bg-warn-soft text-warn", accent: "border-l-warn", card: "border-l-warn bg-warn-soft" },
  confirmed: { chip: "bg-brand-soft text-brand", accent: "border-l-brand", card: "border-l-brand bg-brand-soft" },
  done: { chip: "bg-success-soft text-success", accent: "border-l-success", card: "border-l-success bg-success-soft" },
  rejected: { chip: "bg-danger-soft text-danger", accent: "border-l-danger", card: "border-l-danger bg-danger-soft" },
  noshow: { chip: "bg-soft text-muted", accent: "border-l-line", card: "border-l-line bg-soft" },
};
export const statusTone = (status) => STATUS_TONES[status] || STATUS_TONES.noshow;
export function StatusChip({ status, label, className = "" }) {
  return <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${statusTone(status).chip} ${className}`}>{label || status}</span>;
}

// --- pomôcky ------------------------------------------------------------------
import { useState, cloneElement } from "react";
function useStateOnce(init) { return useState(init); }
function cloneWith(el, props) { return cloneElement(el, props); }
