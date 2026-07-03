import { useState } from "react";
import { addDeposit, addWithdrawal } from "../api.js";

const today = () => new Date().toISOString().slice(0, 10);

// One modal for both cash-flow directions: mode = "deposit" | "withdraw".
// Withdrawals additionally take an optional note; the server rejects a
// withdrawal larger than the available cash (its message lands in `error`).
export default function DepositModal({ portfolio, mode = "deposit", onClose, onSaved }) {
  const withdraw = mode === "withdraw";
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const value = parseFloat(amount);
    if (!(value > 0)) {
      setError("Kwota musi być większa od zera.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (withdraw) {
        await addWithdrawal(portfolio.id, { amount: value, date, note: note.trim() || null });
      } else {
        await addDeposit(portfolio.id, { amount: value, date });
      }
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>
          {withdraw ? "Wypłata" : "Wpłata"} — portfel {portfolio.name} ({portfolio.currency})
        </h3>
        <div className="field-row">
          <div className="field">
            <label>Kwota ({portfolio.currency})</label>
            <input
              type="number"
              step="any"
              min="0"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Data</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        {withdraw && (
          <div className="field">
            <label>Notatka (opcjonalna)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className={`btn ${withdraw ? "danger" : "primary"}`} disabled={saving}>
            {saving ? "Zapisywanie…" : withdraw ? "Zapisz wypłatę" : "Zapisz wpłatę"}
          </button>
        </div>
      </form>
    </div>
  );
}
