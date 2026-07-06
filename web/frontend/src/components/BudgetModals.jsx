import { useState } from "react";
import {
  addBudgetCategory, addBudgetItem, addBudgetLoan, deleteBudgetCategory,
  updateBudgetCategory, updateBudgetItem, updateBudgetLoan,
} from "../api.js";
import { monthKey } from "../budget.js";

// Add/edit an income or expense entry. `type` fixes income vs expense; `edit`
// switches to PUT. `categories` are the user's categories of this kind. A
// one-off toggle attaches the entry to a specific month (default = the month
// being viewed); recurring entries have month = null.
export function BudgetItemModal({ type, edit = null, defaultOneOff = false, categories, viewMonth, onClose, onSaved }) {
  const isIncome = type === "INCOME";
  const [name, setName] = useState(edit?.name ?? "");
  const [amount, setAmount] = useState(edit ? String(edit.amount) : "");
  const [categoryId, setCategoryId] = useState(edit?.category_id ?? categories[0]?.id ?? null);
  const [oneOff, setOneOff] = useState(edit ? edit.month != null : defaultOneOff);
  const [month, setMonth] = useState(edit?.month ?? viewMonth ?? monthKey());
  const [note, setNote] = useState(edit?.note ?? "");
  const [shared, setShared] = useState(edit && edit.shared_amount > 0);
  const [sharedAmount, setSharedAmount] = useState(edit?.shared_amount ? String(edit.shared_amount) : "");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Podaj nazwę.");
    const value = parseFloat(amount);
    if (!(value >= 0) || amount === "") return setError("Podaj kwotę.");
    const sh = shared ? parseFloat(sharedAmount) || 0 : 0;
    if (sh > value) return setError("Udział żony nie może przekraczać kwoty.");
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      amount: value,
      category_id: categoryId ? Number(categoryId) : null,
      month: oneOff ? month : null,
      note: note.trim() || null,
      shared_amount: sh,
    };
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
        <h3>{edit ? `Edytuj ${noun}` : isIncome ? "Nowy wpływ" : "Nowy wydatek"}</h3>
        <div className="field">
          <label>Nazwa</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder={isIncome ? "np. Wypłata" : "np. Prąd"} />
        </div>
        <div className="field-row">
          <div className="field">
            <label>Kwota (zł)</label>
            <input type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="field">
            <label>Kategoria</label>
            <select value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value || null)}>
              {categories.length === 0 && <option value="">Bez kategorii</option>}
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <label className="checkline">
          <input type="checkbox" checked={oneOff} onChange={(e) => setOneOff(e.target.checked)} />
          Jednorazowo w konkretnym miesiącu (nie co miesiąc)
        </label>
        {oneOff && (
          <div className="field">
            <label>Miesiąc</label>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </div>
        )}
        {!isIncome && (
          <>
            <label className="checkline">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              Koszt dzielony z żoną
            </label>
            {shared && (
              <div className="field">
                <label>Udział żony (zł) — ile ma oddać</label>
                <input type="number" step="any" min="0" value={sharedAmount}
                  onChange={(e) => setSharedAmount(e.target.value)} placeholder="np. 1500" />
                {parseFloat(amount) > 0 && parseFloat(sharedAmount) >= 0 && (
                  <div className="hint">Twój udział: {(parseFloat(amount) - (parseFloat(sharedAmount) || 0)).toLocaleString("pl-PL")} zł</div>
                )}
              </div>
            )}
          </>
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

// Add/edit a loan: borrowed sum, installment, count, start month.
export function LoanModal({ edit = null, onClose, onSaved }) {
  const [name, setName] = useState(edit?.name ?? "");
  const [principal, setPrincipal] = useState(edit ? String(edit.principal) : "");
  const [installment, setInstallment] = useState(edit ? String(edit.installment) : "");
  const [count, setCount] = useState(edit ? String(edit.installments_count) : "");
  const [start, setStart] = useState(edit?.start_month ?? monthKey());
  const [note, setNote] = useState(edit?.note ?? "");
  const [shared, setShared] = useState(edit && edit.shared_installment > 0);
  const [sharedInst, setSharedInst] = useState(edit?.shared_installment ? String(edit.shared_installment) : "");
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
    const sh = shared ? parseFloat(sharedInst) || 0 : 0;
    if (sh > inst) return setError("Udział żony nie może przekraczać raty.");
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      principal: parseFloat(principal) || 0,
      installment: inst,
      installments_count: cnt,
      start_month: start,
      note: note.trim() || null,
      shared_installment: sh,
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
        <label className="checkline">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Rata dzielona z żoną
        </label>
        {shared && (
          <div className="field">
            <label>Udział żony w racie (zł) — ile ma oddać</label>
            <input type="number" step="any" min="0" value={sharedInst}
              onChange={(e) => setSharedInst(e.target.value)} placeholder="np. 1500" />
            {inst > 0 && (
              <div className="hint">Twój udział w racie: {(inst - (parseFloat(sharedInst) || 0)).toLocaleString("pl-PL")} zł</div>
            )}
          </div>
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

// Manage categories: add / rename / recolor / delete, per kind (income vs
// expense). Colours drive the expense-structure chart, so distinct hues help.
export function CategoryManagerModal({ categories, onClose, onChanged }) {
  const [tab, setTab] = useState("EXPENSE");
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState("#3b82f6");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const list = categories.filter((c) => c.kind === tab);

  const wrap = (fn) => async () => {
    setBusy(true);
    setError(null);
    try { await fn(); onChanged(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const add = wrap(async () => {
    if (!draftName.trim()) throw new Error("Podaj nazwę kategorii.");
    await addBudgetCategory({ kind: tab, name: draftName.trim(), color: draftColor });
    setDraftName("");
  });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <h3>Kategorie</h3>
        <div className="type-toggle">
          <button type="button" className={`buy ${tab === "EXPENSE" ? "active" : ""}`} onClick={() => setTab("EXPENSE")}>Wydatki</button>
          <button type="button" className={`buy ${tab === "INCOME" ? "active" : ""}`} onClick={() => setTab("INCOME")}>Wpływy</button>
        </div>

        <div className="cat-list">
          {list.map((c) => (
            <CategoryRow key={c.id} cat={c} busy={busy} onChanged={onChanged} setError={setError} />
          ))}
          {list.length === 0 && <div className="empty small">Brak kategorii — dodaj pierwszą.</div>}
        </div>

        <div className="cat-add">
          <input type="color" value={draftColor} onChange={(e) => setDraftColor(e.target.value)} aria-label="Kolor" />
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Nowa kategoria" />
          <button type="button" className="btn primary" disabled={busy} onClick={add}>Dodaj</button>
        </div>

        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Gotowe</button>
        </div>
      </div>
    </div>
  );
}

function CategoryRow({ cat, busy, onChanged, setError }) {
  const [name, setName] = useState(cat.name);
  const [color, setColor] = useState(cat.color);
  const dirty = name.trim() !== cat.name || color !== cat.color;

  const save = async () => {
    setError(null);
    try { await updateBudgetCategory(cat.id, { name: name.trim(), color }); onChanged(); }
    catch (err) { setError(err.message); }
  };
  const remove = async () => {
    setError(null);
    try { await deleteBudgetCategory(cat.id); onChanged(); }
    catch (err) { setError(err.message); }
  };

  return (
    <div className="cat-row">
      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Kolor" />
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <button type="button" className="btn small" disabled={busy || !dirty} onClick={save}>Zapisz</button>
      <button type="button" className="btn small danger" disabled={busy} onClick={remove}>Usuń</button>
    </div>
  );
}
