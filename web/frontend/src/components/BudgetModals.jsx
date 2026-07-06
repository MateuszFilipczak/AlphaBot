import { useState } from "react";
import {
  addBudgetItem, addBudgetLoan, updateBudgetItem, updateBudgetLoan,
} from "../api.js";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, monthKey } from "../budget.js";

// Add/edit an income or expense entry. `type` fixes income vs expense (INCOME|
// EXPENSE); `edit` (an existing row) switches to PUT. Amount, name, category
// and note are all editable.
export function BudgetItemModal({ type, edit = null, onClose, onSaved }) {
  const isIncome = type === "INCOME";
  const cats = isIncome ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const [name, setName] = useState(edit?.name ?? "");
  const [amount, setAmount] = useState(edit ? String(edit.amount) : "");
  const [category, setCategory] = useState(edit?.category ?? cats[0].key);
  const [note, setNote] = useState(edit?.note ?? "");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Podaj nazwę.");
    const value = parseFloat(amount);
    if (!(value >= 0) || amount === "") return setError("Podaj kwotę.");
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), amount: value, category, note: note.trim() || null };
    try {
      if (edit) await updateBudgetItem(edit.id, body);
      else await addBudgetItem({ type, ...body });
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const noun = isIncome ? "wpływ" : "wydatek";
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>{edit ? `Edytuj ${noun}` : isIncome ? "Nowy wpływ" : "Nowy wydatek stały"}</h3>
        <div className="field">
          <label>Nazwa</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder={isIncome ? "np. Wypłata" : "np. Prąd"} />
        </div>
        <div className="field-row">
          <div className="field">
            <label>Kwota (zł / mies.)</label>
            <input type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="field">
            <label>Kategoria</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Notatka (opcjonalna)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Anuluj</button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Zapisywanie…" : "Zapisz"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Add/edit a loan: borrowed sum, installment, count, start month.
export function LoanModal({ edit = null, onClose, onSaved }) {
  const [name, setName] = useState(edit?.name ?? "");
  const [principal, setPrincipal] = useState(edit ? String(edit.principal) : "");
  const [installment, setInstallment] = useState(edit ? String(edit.installment) : "");
  const [count, setCount] = useState(edit ? String(edit.installments_count) : "");
  const [start, setStart] = useState(edit?.start_month ?? monthKey());
  const [note, setNote] = useState(edit?.note ?? "");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const cnt = parseInt(count, 10);
  const inst = parseFloat(installment);
  const total = cnt > 0 && inst > 0 ? cnt * inst : null;

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Podaj nazwę kredytu.");
    if (!(inst > 0)) return setError("Rata musi być większa od zera.");
    if (!(cnt > 0)) return setError("Podaj liczbę rat.");
    if (!/^\d{4}-\d{2}$/.test(start)) return setError("Wybierz miesiąc pierwszej raty.");
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      principal: parseFloat(principal) || 0,
      installment: inst,
      installments_count: cnt,
      start_month: start,
      note: note.trim() || null,
    };
    try {
      if (edit) await updateBudgetLoan(edit.id, body);
      else await addBudgetLoan(body);
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>{edit ? "Edytuj kredyt" : "Nowy kredyt"}</h3>
        <div className="field">
          <label>Nazwa</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="np. Kredyt hipoteczny" />
        </div>
        <div className="field-row">
          <div className="field">
            <label>Kwota kredytu (zł)</label>
            <input type="number" step="any" min="0" value={principal} onChange={(e) => setPrincipal(e.target.value)}
              placeholder="pożyczona kwota" />
          </div>
          <div className="field">
            <label>Rata (zł / mies.)</label>
            <input type="number" step="any" min="0" value={installment} onChange={(e) => setInstallment(e.target.value)} />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>Liczba rat</label>
            <input type="number" step="1" min="1" value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          <div className="field">
            <label>Pierwsza rata (miesiąc)</label>
            <input type="month" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
        </div>
        {total != null && (
          <div className="field hint">Suma do spłaty: {total.toLocaleString("pl-PL")} zł ({cnt} rat)</div>
        )}
        <div className="field">
          <label>Notatka (opcjonalna)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Anuluj</button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Zapisywanie…" : "Zapisz"}
          </button>
        </div>
      </form>
    </div>
  );
}
