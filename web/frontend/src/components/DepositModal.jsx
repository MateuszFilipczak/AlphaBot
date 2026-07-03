import { useState } from "react";
import { addDeposit, addWithdrawal, updateDeposit } from "../api.js";
import { fmtDate } from "../format.js";

const today = () => new Date().toISOString().slice(0, 10);

// One modal for both cash-flow directions: mode = "deposit" | "withdraw".
// Pass `edit` (an existing deposits row) to edit amount/date/note via PUT —
// the row's type stays fixed. Server-side validation errors (withdrawal over
// balance, edit breaking cash coverage) land in `error`.
export default function DepositModal({ portfolio, mode = "deposit", edit = null, onClose, onSaved }) {
  const withdraw = edit ? edit.type === "WITHDRAWAL" : mode === "withdraw";
  const [amount, setAmount] = useState(edit ? String(edit.amount) : "");
  const [date, setDate] = useState(edit ? fmtDate(edit.date) : today());
  const [note, setNote] = useState(edit?.note ?? "");
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
      if (edit) {
        await updateDeposit(edit.id, { amount: value, date, note: note.trim() || null });
      } else if (withdraw) {
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
          {edit
            ? `Edytuj ${withdraw ? "wypłatę" : "wpłatę"}`
            : withdraw ? "Wypłata" : "Wpłata"}
          {" — portfel "}{portfolio.name} ({portfolio.currency})
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
        {(withdraw || edit) && (
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
          <button type="submit" className={`btn ${withdraw && !edit ? "danger" : "primary"}`} disabled={saving}>
            {saving ? "Zapisywanie…" : edit ? "Zapisz zmiany" : withdraw ? "Zapisz wypłatę" : "Zapisz wpłatę"}
          </button>
        </div>
      </form>
    </div>
  );
}
