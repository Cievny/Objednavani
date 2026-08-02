import { useState } from "react";
import { PaymentQr } from "./booking.jsx";
import { useAdhocData } from "./podappkyData.js";

// Testovacia pod-appka: ad-hoc platba za ľubovoľný výkon.
// Personál zadá názov výkonu + sumu (+ meno/e-mail pacienta), systém
// vygeneruje QR (PAY by square). Po zaplatení (Fio alebo ručne
// „Platba prijatá") sa vystaví faktúra a pošle potvrdenie e-mailom.
export default function AdhocPaymentApp() {
  const { isSupabase, settings, payments, createPayment, markPaid, resendEmail } = useAdhocData();
  const [item, setItem] = useState("");
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState(null); // { id, variableSymbol, itemName, amount, patientName }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg("");
    try {
      const a = Number(String(amount).replace(",", "."));
      if (!item.trim()) throw new Error("Zadajte názov výkonu.");
      if (!a || a <= 0) throw new Error("Zadajte platnú sumu.");
      const { id, variableSymbol } = await createPayment(item.trim(), a, name.trim(), email.trim());
      setCreated({ id, variableSymbol, itemName: item.trim(), amount: a, patientName: name.trim() });
    } catch (err) {
      setMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { setCreated(null); setItem(""); setAmount(""); setName(""); setEmail(""); setMsg(""); };

  const doMarkPaid = async (id) => {
    setMsg("");
    try { await markPaid(id); } catch (err) { setMsg(err?.message || String(err)); }
  };

  const doResend = async (id) => {
    setMsg("");
    try { await resendEmail(id); setMsg("✓ Výzva na úhradu bola poslaná e-mailom."); }
    catch (err) { setMsg(err?.message || String(err)); }
  };

  const input = "w-full p-3 bg-white border border-slate-300 rounded-[10px] text-slate-800 text-sm focus:ring-2 focus:ring-[#2B46A2] outline-none";

  return (
    <div className="space-y-5">
      <div className="bg-[#FFF6E0] border border-[#E0C878] text-[#856404] rounded-[10px] px-4 py-3 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
        <span>Testovacia sekcia — ad-hoc platba za iný výkon. Nie je verejná.</span>
        <a href="#/sprava" className="text-[#2B46A2] hover:underline">← Späť do správy</a>
      </div>

      {!created ? (
        <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6">
          <h2 className="text-xl font-bold text-[#2B46A2] mb-4">Nová platba za výkon</h2>
          <form onSubmit={submit} className="space-y-3 max-w-md">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Názov výkonu</label>
              <input className={input} value={item} onChange={(e) => setItem(e.target.value)} placeholder="napr. Konzultácia" autoFocus />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Suma (€)</label>
              <input className={input} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="napr. 30" inputMode="decimal" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Meno pacienta <span className="text-slate-400 font-normal">(nepovinné)</span></label>
              <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ján Novák" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">E-mail pacienta <span className="text-slate-400 font-normal">(na doručenie faktúry)</span></label>
              <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jan.novak@…" />
            </div>
            {msg && <p className="text-sm text-red-600 font-semibold">{msg}</p>}
            <button type="submit" disabled={busy} className="bg-[#2B46A2] hover:bg-[#1E3580] disabled:opacity-60 text-white font-bold py-3 px-5 rounded-[10px] transition-colors">
              {busy ? "Vytváram…" : "Vytvoriť QR platbu"}
            </button>
          </form>
        </div>
      ) : (
        <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6">
          <h2 className="text-xl font-bold text-[#2B46A2] mb-1">Platba za: {created.itemName}</h2>
          <p className="text-slate-600 mb-4">Suma <b>{created.amount.toFixed(2).replace(".", ",")} €</b></p>
          <div className="flex flex-col md:flex-row gap-5 items-start">
            <PaymentQr
              order={{ price: created.amount, variableSymbol: created.variableSymbol, patient: { name: created.patientName }, date: "", time: "" }}
              settings={settings}
              note={`${created.itemName}${created.patientName ? " " + created.patientName : ""}`}
            />
            <div className="text-sm text-slate-700 space-y-1">
              <p><span className="text-slate-500">IBAN:</span> <b className="font-mono">{settings.iban}</b></p>
              <p><span className="text-slate-500">Suma:</span> <b>{created.amount.toFixed(2).replace(".", ",")} €</b></p>
              <p><span className="text-slate-500">Variabilný symbol:</span> <b className="font-mono">{created.variableSymbol}</b></p>
              <p><span className="text-slate-500">Doklad:</span> {created.id}</p>
              <p className="text-xs text-slate-500 pt-2 max-w-xs">
                {email.trim()
                  ? "Výzva na úhradu odišla pacientovi e-mailom. Po pripísaní platby sa faktúra vystaví a pošle automaticky."
                  : "Po pripísaní platby sa faktúra vystaví automaticky (e-mail sa pošle, ak ho zadáte)."}
              </p>
              {msg && <p className={`text-sm font-semibold ${msg.startsWith("✓") ? "text-[#16A34A]" : "text-red-600"}`}>{msg}</p>}
              <div className="flex flex-wrap gap-2 mt-3">
                {isSupabase && email.trim() && (
                  <button onClick={() => doResend(created.id)} className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] font-semibold px-4 py-2 rounded-[10px] transition-colors">
                    Poslať údaje e-mailom
                  </button>
                )}
                <button onClick={reset} className="bg-[#F0F2F5] hover:bg-[#E0E4EF] text-[#444444] font-semibold px-4 py-2 rounded-[10px] transition-colors">
                  + Nová platba
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* kniha ad-hoc platieb */}
      <div className="bg-white rounded-[15px] shadow-[0_2px_12px_rgba(0,0,0,0.08)] p-5 md:p-6">
        <h3 className="text-lg font-bold text-[#2B46A2] mb-3">Ad-hoc platby</h3>
        {msg && !created && <p className="text-sm text-red-600 font-semibold mb-2">{msg}</p>}
        {payments.length === 0 ? (
          <p className="text-sm text-slate-400">Zatiaľ žiadne platby.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse min-w-[520px]">
              <thead>
                <tr className="text-left text-xs text-[#767676] border-b border-[#E0E4EF]">
                  <th className="py-2 pr-3">Výkon</th><th className="py-2 pr-3 text-right">Suma</th>
                  <th className="py-2 pr-3">VS</th><th className="py-2 pr-3">Pacient</th>
                  <th className="py-2 pr-3">Stav</th><th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-[#F0F2F5]">
                    <td className="py-2 pr-3">{p.itemName}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{p.amount.toFixed(2).replace(".", ",")} €</td>
                    <td className="py-2 pr-3 font-mono">{p.variableSymbol}</td>
                    <td className="py-2 pr-3">{p.patientName || "—"}</td>
                    <td className="py-2 pr-3">
                      {p.paid
                        ? <span className="text-xs font-bold text-white bg-[#2B46A2] rounded px-2 py-1">ZAPLATENÉ</span>
                        : <span className="text-xs font-bold text-[#856404] bg-[#FFF6E0] border border-[#E0C878] rounded px-2 py-1">ČAKÁ</span>}
                    </td>
                    <td className="py-2 text-right space-x-2 whitespace-nowrap">
                      {!p.paid && isSupabase && p.email && (
                        <button onClick={() => doResend(p.id)} className="bg-[#F0F4FF] hover:bg-[#E0E4EF] text-[#2B46A2] text-xs font-semibold px-3 py-1.5 rounded transition-colors">
                          Poslať e-mail
                        </button>
                      )}
                      {!p.paid && (
                        <button onClick={() => doMarkPaid(p.id)} className="bg-[#16A34A] hover:bg-[#128A3E] text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors">
                          Platba prijatá
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
