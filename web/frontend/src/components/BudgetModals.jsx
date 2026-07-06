import { useEffect, useRef, useState } from "react";
import {
  addBudgetCategory, addBudgetItem, addBudgetLoan, deleteBudgetCategory,
  reorderBudgetCategories, updateBudgetCategory, updateBudgetItem, updateBudgetLoan,
} from "../api.js";
import { monthKey } from "../budget.js";

// Add/edit an income or expense entry. `type` fixes income vs expense; `edit`
// switches to PUT. `categories` are the user's categories of this kind. A
// one-off toggle attaches the entry to a specific month (default = the month
// being viewed); recurring entries have month = null.
export function BudgetItemModal({ type, edit = null, defaultOneOff = false, categories, viewMonth, onClose, onSaved }) {
  const isIncome = type === "INCOME";
  // recurring income is a template (name + category); its amount is entered
  // per month inline, so the modal hides amount/one-off/shared for it
  const isIncomeSource = isIncome && (!edit || edit.month == null) && !defaultOneOff;
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
    const value = isIncomeSource ? 0 : parseFloat(amount);
    if (!isIncomeSource && (!(value >= 0) || amount === "")) return setError("Podaj kwotę.");
    const sh = shared ? parseFloat(sharedAmount) || 0 : 0;
    if (sh > value) return setError("Udział partnera nie może przekraczać kwoty.");
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      amount: value,
      category_id: categoryId ? Number(categoryId) : null,
      month: isIncomeSource ? null : (oneOff ? month : null),
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
        <h3>{edit ? `Edytuj ${noun}` : isIncome ? "Nowy przychód" : "Nowy wydatek"}</h3>
        <div className="field">
          <label>Nazwa</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder={isIncome ? "np. Wypłata" : "np. Prąd"} />
        </div>
        <div className="field-row">
          {!isIncomeSource && (
            <div className="field">
              <label>Kwota (zł)</label>
              <input type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Kategoria</label>
            <select value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value || null)}>
              {categories.length === 0 && <option value="">Bez kategorii</option>}
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        {isIncomeSource && (
          <div className="hint" style={{ marginBottom: 12 }}>
            Kwotę wpisujesz osobno dla każdego miesiąca w liście przychodów.
          </div>
        )}
        {!isIncome && (
          <label className="checkline">
            <input type="checkbox" checked={oneOff} onChange={(e) => setOneOff(e.target.checked)} />
            Jednorazowo w konkretnym miesiącu (nie co miesiąc)
          </label>
        )}
        {!isIncome && oneOff && (
          <div className="field">
            <label>Miesiąc</label>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </div>
        )}
        {!isIncome && (
          <>
            <label className="checkline">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              Koszt dzielony z partnerem
            </label>
            {shared && (
              <div className="field">
                <label>Udział partnera (zł) — ile ma oddać</label>
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

// Add/edit a loan (snapshot model): original amount, current outstanding
// balance, current installment, and the last-payment month.
export function LoanModal({ edit = null, onClose, onSaved }) {
  const [name, setName] = useState(edit?.name ?? "");
  const [principal, setPrincipal] = useState(edit ? String(edit.principal) : "");
  const [remaining, setRemaining] = useState(edit ? String(edit.remaining) : "");
  const [installment, setInstallment] = useState(edit ? String(edit.installment) : "");
  const [endMonth, setEndMonth] = useState(edit?.end_month ?? monthKey());
  const [note, setNote] = useState(edit?.note ?? "");
  const [shared, setShared] = useState(edit && edit.shared_installment > 0);
  const [sharedInst, setSharedInst] = useState(edit?.shared_installment ? String(edit.shared_installment) : "");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const inst = parseFloat(installment);
  const rem = parseFloat(remaining) || 0;
  const prin = parseFloat(principal) || 0;
  const leftRat = inst > 0 ? Math.ceil(rem / inst) : null;
  const pct = prin > 0 ? Math.min(100, Math.max(0, ((prin - rem) / prin) * 100)) : null;

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Podaj nazwę kredytu.");
    if (!(inst > 0)) return setError("Rata musi być większa od zera.");
    if (!/^\d{4}-\d{2}$/.test(endMonth)) return setError("Wybierz miesiąc ostatniej raty.");
    if (rem > prin && prin > 0) return setError("Pozostało nie może przekraczać kwoty pierwotnej.");
    const sh = shared ? parseFloat(sharedInst) || 0 : 0;
    if (sh > inst) return setError("Udział partnera nie może przekraczać raty.");
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      principal: prin,
      remaining: rem,
      installment: inst,
      end_month: endMonth,
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
            <label>Kwota pierwotna (zł)</label>
            <input type="number" step="any" min="0" value={principal} onChange={(e) => setPrincipal(e.target.value)}
              placeholder="ile wynosił kredyt" />
          </div>
          <div className="field">
            <label>Pozostało do spłaty (zł)</label>
            <input type="number" step="any" min="0" value={remaining} onChange={(e) => setRemaining(e.target.value)}
              placeholder="stan wg banku" />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>Aktualna rata (zł / mies.)</label>
            <input type="number" step="any" min="0" value={installment} onChange={(e) => setInstallment(e.target.value)} />
          </div>
          <div className="field">
            <label>Ostatnia rata (miesiąc)</label>
            <input type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} />
          </div>
        </div>
        {(leftRat != null || pct != null) && (
          <div className="field hint">
            {leftRat != null && <>≈ {leftRat} rat do spłaty</>}
            {pct != null && <> · spłacono {pct.toFixed(0)}%</>}
          </div>
        )}
        <label className="checkline">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Rata dzielona z partnerem
        </label>
        {shared && (
          <div className="field">
            <label>Udział partnera w racie (zł) — ile ma oddać</label>
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

// Manage categories (C1 design): clean draggable rows — colour swatch (click →
// picker, saves immediately), click-to-rename name, delete. Drag the handle to
// reorder; the new order is persisted (drives the category dropdown + the
// expense-structure chart). Per kind (income vs expense).
export function CategoryManagerModal({ categories, onClose, onChanged }) {
  const [tab, setTab] = useState("EXPENSE");
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState("#3b82f6");
  const [rows, setRows] = useState([]);           // local order for the active tab
  const [over, setOver] = useState(null);
  const [error, setError] = useState(null);
  const drag = useRef(null);

  // re-sync local rows from props whenever the tab or the data changes
  useEffect(() => {
    setRows(categories.filter((c) => c.kind === tab));
  }, [categories, tab]);

  const guard = async (fn) => {
    setError(null);
    try { await fn(); } catch (err) { setError(err.message); }
  };

  const add = () => guard(async () => {
    if (!draftName.trim()) throw new Error("Podaj nazwę kategorii.");
    await addBudgetCategory({ kind: tab, name: draftName.trim(), color: draftColor });
    setDraftName("");
    onChanged();
  });

  const onDrop = (to) => {
    const from = drag.current;
    drag.current = null;
    setOver(null);
    if (from == null || from === to) return;
    const next = [...rows];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    setRows(next);                                  // optimistic
    guard(async () => {
      await reorderBudgetCategories(next.map((c) => c.id));
      onChanged();
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <h3>Kategorie</h3>
        <div className="type-toggle">
          <button type="button" className={`buy ${tab === "EXPENSE" ? "active" : ""}`} onClick={() => setTab("EXPENSE")}>Wydatki</button>
          <button type="button" className={`buy ${tab === "INCOME" ? "active" : ""}`} onClick={() => setTab("INCOME")}>Wpływy</button>
        </div>

        <div className="cm-list">
          {rows.map((c, i) => (
            <CategoryRow
              key={c.id} cat={c} index={i} over={over === i}
              onChanged={onChanged} setError={setError}
              onDragStart={() => (drag.current = i)}
              onDragOver={(e) => { e.preventDefault(); setOver(i); }}
              onDragLeave={() => setOver((o) => (o === i ? null : o))}
              onDrop={() => onDrop(i)}
            />
          ))}
          {rows.length === 0 && <div className="empty small">Brak kategorii — dodaj pierwszą.</div>}
        </div>

        <div className="cm-add">
          <input type="color" value={draftColor} onChange={(e) => setDraftColor(e.target.value)} aria-label="Kolor" />
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Nowa kategoria" />
          <button type="button" className="btn primary" onClick={add}>Dodaj</button>
        </div>

        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Gotowe</button>
        </div>
      </div>
    </div>
  );
}

function CategoryRow({ cat, over, onChanged, setError, onDragStart, onDragOver, onDragLeave, onDrop }) {
  const [name, setName] = useState(cat.name);
  const [editing, setEditing] = useState(false);

  const saveName = async () => {
    setEditing(false);
    if (name.trim() === cat.name || !name.trim()) { setName(cat.name); return; }
    setError(null);
    try { await updateBudgetCategory(cat.id, { name: name.trim(), color: cat.color }); onChanged(); }
    catch (err) { setError(err.message); setName(cat.name); }
  };
  const saveColor = async (color) => {
    setError(null);
    try { await updateBudgetCategory(cat.id, { name: cat.name, color }); onChanged(); }
    catch (err) { setError(err.message); }
  };
  const remove = async () => {
    setError(null);
    try { await deleteBudgetCategory(cat.id); onChanged(); }
    catch (err) { setError(err.message); }
  };

  return (
    <div
      className={`cm-row ${over ? "cm-over" : ""}`}
      draggable onDragStart={onDragStart} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      <span className="cm-handle" title="Przeciągnij, aby zmienić kolejność">⠿</span>
      <label className="cm-swatch-wrap" title="Zmień kolor">
        <span className="cm-swatch" style={{ background: cat.color }} />
        <input type="color" value={cat.color} onChange={(e) => saveColor(e.target.value)} />
      </label>
      {editing ? (
        <input
          className="cm-name-input" autoFocus value={name}
          onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setName(cat.name); setEditing(false); } }}
        />
      ) : (
        <button className="cm-name" onClick={() => setEditing(true)} title="Kliknij, aby zmienić nazwę">{cat.name}</button>
      )}
      <div className="cm-actions">
        <button type="button" className="danger" title="Usuń" onClick={remove}>✕</button>
      </div>
    </div>
  );
}
