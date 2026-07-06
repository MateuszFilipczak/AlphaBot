import { useEffect, useMemo, useRef, useState } from "react";
import ModuleBar from "../components/ModuleNav.jsx";
import RowMenu from "../components/RowMenu.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import { BudgetItemModal, CategoryManagerModal, LoanModal } from "../components/BudgetModals.jsx";
import {
  deleteBudgetItem, deleteBudgetLoan, getBudgetCategories, getBudgetItems,
  getBudgetLoans, getIncomeAmounts, setIncomeAmount, updateBudgetItem,
} from "../api.js";
import { LOANS_COLOR, NO_CAT_COLOR, addMonths, loanState, monthKey, monthLabel } from "../budget.js";

const zl = (v) => (v ?? 0).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });
const pnl = (v) => (v >= 0 ? "pnl-up" : "pnl-down");

export default function Budget() {
  const [month, setMonth] = useState(monthKey());
  const [items, setItems] = useState(null);
  const [loans, setLoans] = useState(null);
  const [cats, setCats] = useState(null);
  const [incomeAmounts, setIncomeAmounts] = useState(null); // {item_id: amount} for month
  const [incomeDraft, setIncomeDraft] = useState({}); // per-row inline input text
  const [editingInc, setEditingInc] = useState(null); // income row id being edited
  const [editingExp, setEditingExp] = useState(null); // expense row id being edited
  const [expenseDraft, setExpenseDraft] = useState(""); // current expense edit text
  const [itemModal, setItemModal] = useState(null); // {type, edit?}
  const [loanModal, setLoanModal] = useState(null); // {edit?} | true
  const [catModal, setCatModal] = useState(false);
  const [del, setDel] = useState(null); // {kind, row}
  const [delBusy, setDelBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const monthInputRef = useRef(null);

  const openMonthPicker = () => {
    const el = monthInputRef.current;
    if (!el) return;
    if (el.showPicker) { try { el.showPicker(); return; } catch { /* fall through */ } }
    el.focus();
  };

  useEffect(() => {
    getBudgetItems().then(setItems).catch(() => setItems([]));
    getBudgetLoans().then(setLoans).catch(() => setLoans([]));
    getBudgetCategories().then(setCats).catch(() => setCats([]));
  }, [tick]);
  // per-month income amounts reload on month change too
  useEffect(() => {
    getIncomeAmounts(month).then(setIncomeAmounts).catch(() => setIncomeAmounts({}));
  }, [month, tick]);
  const refresh = () => setTick((t) => t + 1);

  // seed the inline income inputs whenever the amounts (month/data) change
  useEffect(() => {
    if (!incomeAmounts) return;
    const d = {};
    for (const [k, v] of Object.entries(incomeAmounts)) d[k] = String(v);
    setIncomeDraft(d);
  }, [incomeAmounts]);

  const saveIncome = async (itemId) => {
    const raw = incomeDraft[itemId];
    const value = parseFloat(raw) || 0;
    if ((incomeAmounts?.[itemId] ?? 0) === value) return; // unchanged
    await setIncomeAmount({ item_id: Number(itemId), month, amount: value });
    setIncomeAmounts((prev) => ({ ...(prev ?? {}), [itemId]: value }));
  };

  // inline-edit a recurring expense amount (item.amount — same every month)
  const saveExpense = async (item) => {
    setEditingExp(null);
    const value = parseFloat(expenseDraft);
    if (!(value >= 0) || value === item.amount) return; // invalid or unchanged
    await updateBudgetItem(item.id, {
      name: item.name, amount: value, category_id: item.category_id,
      month: item.month, note: item.note, shared_amount: item.shared_amount,
    });
    refresh();
  };

  const catMap = useMemo(() => {
    const m = new Map();
    (cats ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [cats]);
  const catInfo = (id) => (id != null && catMap.get(id)) || { name: "Bez kategorii", color: NO_CAT_COLOR };
  const expenseCats = (cats ?? []).filter((c) => c.kind === "EXPENSE");
  const incomeCats = (cats ?? []).filter((c) => c.kind === "INCOME");

  const view = useMemo(() => {
    if (!items || !loans || !cats || !incomeAmounts) return null;
    // recurring (month == null) always count; one-off only in their month
    const inMonth = (i) => i.month == null || i.month === month;
    const active = items.filter(inMonth);
    // recurring income amount comes from the per-month override (0 if unset)
    const incAmt = (i) => incomeAmounts[i.id] ?? 0;
    const incomeRec = active.filter((i) => i.type === "INCOME" && i.month == null);
    const expenseRec = active.filter((i) => i.type === "EXPENSE" && i.month == null);
    const oneOff = active.filter((i) => i.month === month);

    const loanViews = loans
      .map((l) => ({ ...l, s: loanState(l, month) }))
      .sort((a, b) => a.s.finished - b.s.finished || a.name.localeCompare(b.name));
    const activeLoans = loanViews.filter((l) => l.s.active);
    const installmentsTotal = activeLoans.reduce((a, l) => a + l.installment, 0);

    const oneOffIncome = oneOff.filter((i) => i.type === "INCOME").reduce((a, i) => a + i.amount, 0);
    const totalIncome = incomeRec.reduce((a, i) => a + incAmt(i), 0) + oneOffIncome;
    const totalExpenses = active.filter((i) => i.type === "EXPENSE").reduce((a, i) => a + i.amount, 0) + installmentsTotal;
    const leftover = totalIncome - totalExpenses;

    // koszty dzielone z żoną: her share across expenses (recurring + one-off)
    // and active loans, this month
    const sharedItems = active
      .filter((i) => i.type === "EXPENSE" && i.shared_amount > 0)
      .map((i) => ({ id: `i${i.id}`, name: i.name, total: i.amount, share: i.shared_amount, loan: false }));
    const sharedLoans = activeLoans
      .filter((l) => l.shared_installment > 0)
      .map((l) => ({ id: `l${l.id}`, name: l.name, total: l.installment, share: l.shared_installment, loan: true }));
    const shared = [...sharedItems, ...sharedLoans];
    const wifeOwes = shared.reduce((a, s) => a + s.share, 0);
    const myExpenses = totalExpenses - wifeOwes;

    // struktura wydatków: every expense this month (recurring + one-off) by
    // category, plus loans as one synthetic slice
    const byCat = new Map();
    for (const e of active.filter((i) => i.type === "EXPENSE")) {
      const c = catInfo(e.category_id);
      const prev = byCat.get(c.name) ?? { label: c.name, amount: 0, color: c.color };
      prev.amount += e.amount;
      byCat.set(c.name, prev);
    }
    const catSegs = [...byCat.values()].sort((a, b) => b.amount - a.amount);
    if (installmentsTotal > 0) catSegs.unshift({ label: "Raty kredytów", amount: installmentsTotal, color: LOANS_COLOR });

    const totalDebt = loanViews.reduce((a, l) => a + (l.s.finished ? 0 : l.s.remaining), 0);
    const oneOffTotal = oneOff.reduce((a, o) => a + (o.type === "INCOME" ? o.amount : -o.amount), 0);
    return {
      incomeRec, expenseRec, oneOff, oneOffTotal, loanViews, activeLoans, installmentsTotal,
      totalIncome, totalExpenses, leftover, catSegs, totalDebt,
      shared, wifeOwes, myExpenses,
    };
  }, [items, loans, cats, month, incomeAmounts]);

  const confirmDelete = async () => {
    setDelBusy(true);
    try {
      if (del.kind === "loan") await deleteBudgetLoan(del.row.id);
      else await deleteBudgetItem(del.row.id);
      setDel(null);
      refresh();
    } finally {
      setDelBusy(false);
    }
  };

  const itemMenu = (row) => (
    <RowMenu label="Menu" items={[
      { label: "Edytuj", onClick: () => setItemModal({ type: row.type, edit: row }) },
      { label: "Usuń", danger: true, onClick: () => setDel({ kind: "item", row }) },
    ]} />
  );

  return (
    <div className="app">
      <ModuleBar />

      <div className="bmonth">
        <button className="btn" aria-label="Poprzedni miesiąc" onClick={() => setMonth((m) => addMonths(m, -1))}>‹</button>
        <div className="bmonth-label"><span className="muted">Budżet za</span><b>{monthLabel(month)}</b></div>
        <button className="btn" aria-label="Następny miesiąc" onClick={() => setMonth((m) => addMonths(m, 1))}>›</button>
        <span className="cal-wrap">
          <button className="btn cal-btn" aria-label="Wybierz miesiąc" onClick={openMonthPicker}>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4.5" width="14" height="13" rx="2" /><path d="M3 8h14M7 3v3M13 3v3" />
            </svg>
          </button>
          <input
            ref={monthInputRef} className="cal-native" type="month" tabIndex={-1}
            value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
          />
        </span>
        {month !== monthKey() && <button className="btn" onClick={() => setMonth(monthKey())}>Dziś</button>}
        <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setCatModal(true)}>Kategorie</button>
      </div>

      {!view ? (
        <div className="loading">Ładowanie budżetu…</div>
      ) : (
        <>
          <section className="bud-summary big">
            <div className="bud-num"><span className="lbl">Przychody</span><span className="val pnl-up">{zl(view.totalIncome)}</span></div>
            <div className="bud-num"><span className="lbl">Wydatki</span><span className="val pnl-down">{zl(view.totalExpenses)}</span></div>
            <div className="bud-num"><span className="lbl">Zostaje</span><span className={`val ${pnl(view.leftover)}`}>{zl(view.leftover)}</span></div>
            {view.wifeOwes > 0 && (
              <div className="bud-num"><span className="lbl">Żona ma oddać</span><span className="val accent">{zl(view.wifeOwes)}</span></div>
            )}
          </section>

          {view.catSegs.length > 0 && (
            <div className="bud-panel">
              <h4>Struktura wydatków</h4>
              <div className="stack-bar">
                {view.catSegs.map((s) => (
                  <span key={s.label} style={{ width: `${(s.amount / view.totalExpenses) * 100}%`, background: s.color }} title={`${s.label} ${zl(s.amount)}`} />
                ))}
              </div>
              <div className="stack-legend">
                {view.catSegs.map((s) => (
                  <span key={s.label}><i style={{ background: s.color }} />{s.label} {zl(s.amount)}
                    <small className="muted"> · {Math.round((s.amount / view.totalExpenses) * 100)}%</small></span>
                ))}
              </div>
            </div>
          )}

          <div className="bud-arrange">
            {/* left column: the short panels stack; the last one fills down so
                its bottom lines up with the tall Wydatki panel on the right */}
            <div className="arr-col">
              <div className="bud-panel">
                <div className="panel-head">
                  <h4>Przychody stałe</h4>
                  <button className="btn small" onClick={() => setItemModal({ type: "INCOME" })}>+ Źródło</button>
                </div>
                {view.incomeRec.length === 0 ? <div className="empty small">Brak źródeł wpływu. Dodaj np. Wypłatę — kwotę wpiszesz co miesiąc.</div> :
                  view.incomeRec.map((i) => {
                    const amt = incomeAmounts[i.id] ?? 0;
                    const editing = editingInc === i.id;
                    return (
                      <div className="bud-row" key={i.id}>
                        <span>{i.name}{i.note && <small>{i.note}</small>}</span>
                        <span className="row-end">
                          {editing ? (
                            <input
                              className="inc-amount"
                              type="number" step="any" min="0" inputMode="decimal" autoFocus
                              placeholder="0"
                              value={incomeDraft[i.id] ?? ""}
                              onChange={(e) => setIncomeDraft((d) => ({ ...d, [i.id]: e.target.value }))}
                              onBlur={async () => { await saveIncome(i.id); setEditingInc(null); }}
                              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingInc(null); }}
                            />
                          ) : (
                            <button
                              className={`inc-text ${amt > 0 ? "" : "empty-amt"}`}
                              onClick={() => setEditingInc(i.id)}
                              title="Kliknij, aby wpisać kwotę w tym miesiącu"
                            >
                              {amt > 0 ? zl(amt) : "wpisz kwotę"}
                            </button>
                          )}
                          {itemMenu(i)}
                        </span>
                      </div>
                    );
                  })}
                <div className="bud-row total"><span>Razem</span><b className="pnl-up">{zl(view.totalIncome)}</b></div>
              </div>

              {view.shared.length > 0 && (
                <div className="bud-panel">
                  <h4>Rozliczenie z żoną</h4>
                  {view.shared.map((s) => (
                    <div className={`bud-row ${s.loan ? "muted-row" : ""}`} key={s.id}>
                      <span>{s.name}<small>{s.loan ? "rata kredytu · " : ""}z {zl(s.total)}</small></span>
                      <b>{zl(s.share)}</b>
                    </div>
                  ))}
                  <div className="bud-row total"><span>Razem</span><b className="accent">{zl(view.wifeOwes)}</b></div>
                </div>
              )}

              {/* one-off entries for the viewed month */}
              <div className="bud-panel">
                <div className="panel-head">
                  <h4>Wydatki dodatkowe</h4>
                  <button className="btn small" onClick={() => setItemModal({ type: "EXPENSE", oneOff: true })}>+ Wydatek jednorazowy</button>
                </div>
                {view.oneOff.length === 0 ? (
                  <div className="empty small">Brak jednorazowych pozycji w tym miesiącu (np. ubezpieczenie auta, nadpłata kredytu).</div>
                ) : (
                  <>
                    {view.oneOff.map((o) => {
                      const c = o.type === "EXPENSE" ? catInfo(o.category_id) : null;
                      return (
                        <div className="bud-row" key={o.id}>
                          <span>
                            {c && <i className="cat-dot" style={{ background: c.color }} />}
                            {o.name}<small>{o.type === "INCOME" ? "wpływ" : c.name}</small>
                            {o.type === "EXPENSE" && o.shared_amount > 0 && <span className="split-tag">½ {zl(o.shared_amount)} od żony</span>}
                          </span>
                          <span className="row-end">
                            <b className={o.type === "INCOME" ? "pnl-up" : ""}>{o.type === "INCOME" ? "+" : ""}{zl(o.amount)}</b>
                            {itemMenu(o)}
                          </span>
                        </div>
                      );
                    })}
                    <div className="bud-row total"><span>Razem</span>
                      <b className={pnl(view.oneOffTotal)}>{view.oneOffTotal >= 0 ? "+" : ""}{zl(view.oneOffTotal)}</b></div>
                  </>
                )}
              </div>
            </div>

            <div className="arr-col">
              <div className="bud-panel">
                <div className="panel-head">
                  <h4>Wydatki stałe</h4>
                  <button className="btn small" onClick={() => setItemModal({ type: "EXPENSE" })}>+ Wydatek</button>
                </div>
                {view.expenseRec.length === 0 && view.activeLoans.length === 0 ?
                  <div className="empty small">Brak stałych wydatków.</div> : null}
                {view.expenseRec.map((e) => {
                  const c = catInfo(e.category_id);
                  return (
                    <div className="bud-row" key={e.id}>
                      <span><i className="cat-dot" style={{ background: c.color }} />{e.name}<small>{c.name}</small>
                        {e.shared_amount > 0 && <span className="split-tag">½ {zl(e.shared_amount)} od żony</span>}</span>
                      <span className="row-end">
                        {editingExp === e.id ? (
                          <input
                            className="inc-amount" type="number" step="any" min="0" inputMode="decimal" autoFocus
                            value={expenseDraft}
                            onChange={(ev) => setExpenseDraft(ev.target.value)}
                            onBlur={() => saveExpense(e)}
                            onKeyDown={(ev) => { if (ev.key === "Enter") ev.currentTarget.blur(); if (ev.key === "Escape") setEditingExp(null); }}
                          />
                        ) : (
                          <button
                            className="inc-text"
                            onClick={() => { setExpenseDraft(String(e.amount)); setEditingExp(e.id); }}
                            title="Kliknij, aby zmienić kwotę"
                          >
                            {zl(e.amount)}
                          </button>
                        )}
                        {itemMenu(e)}
                      </span>
                    </div>
                  );
                })}
                {view.activeLoans.map((l) => (
                  <div className="bud-row muted-row" key={`loan-${l.id}`}>
                    <span><i className="cat-dot" style={{ background: LOANS_COLOR }} />{l.name}<small>rata kredytu</small>
                      {l.shared_installment > 0 && <span className="split-tag">½ {zl(l.shared_installment)} od żony</span>}</span>
                    <b>{zl(l.installment)}</b>
                  </div>
                ))}
                <div className="bud-row total"><span>Razem</span><b className="pnl-down">{zl(view.totalExpenses)}</b></div>
              </div>
            </div>
          </div>

          <div className="bud-panel">
            <div className="panel-head">
              <h4>Kredyty</h4>
              <button className="btn small" onClick={() => setLoanModal({})}>+ Kredyt</button>
            </div>
            {view.loanViews.length === 0 ? (
              <div className="empty small">Brak kredytów. Dodaj, aby śledzić spłatę.</div>
            ) : (
              <>
                <div className="loan-topline">
                  <div><span className="muted">Zadłużenie łącznie</span><b className="pnl-down">{zl(view.totalDebt)}</b></div>
                  <div><span className="muted">Raty miesięcznie</span><b>{zl(view.installmentsTotal)}</b></div>
                </div>
                <div className="kl-rows">
                  {view.loanViews.map((l) => (
                    <div className={`kl-row ${l.s.finished ? "done" : ""}`} key={l.id}>
                      <div className="kl-row-name">
                        <b>{l.name}{l.s.finished && <span className="badge ok">spłacony</span>}</b>
                        <span className="muted">do {l.s.endMonth}</span>
                      </div>
                      <div className="kl-row-bar">
                        <div className="bud-bar"><span style={{ width: `${l.s.pct}%`, background: LOANS_COLOR }} /></div>
                        <span className="muted">≈ {l.s.left} rat · spłacono {Math.round(l.s.pct)}%</span>
                      </div>
                      <div className="kl-row-vals">
                        <b>{zl(l.installment)}</b>
                        <span className="muted">zostało {zl(l.s.remaining)}</span>
                      </div>
                      <RowMenu label="Menu kredytu" items={[
                        { label: "Edytuj", onClick: () => setLoanModal({ edit: l }) },
                        { label: "Usuń", danger: true, onClick: () => setDel({ kind: "loan", row: l }) },
                      ]} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {itemModal && (
        <BudgetItemModal
          type={itemModal.type}
          edit={itemModal.edit}
          defaultOneOff={itemModal.oneOff ?? false}
          categories={itemModal.type === "INCOME" ? incomeCats : expenseCats}
          viewMonth={month}
          onClose={() => setItemModal(null)}
          onSaved={() => { setItemModal(null); refresh(); }}
        />
      )}
      {loanModal && (
        <LoanModal edit={loanModal.edit} onClose={() => setLoanModal(null)} onSaved={() => { setLoanModal(null); refresh(); }} />
      )}
      {catModal && (
        <CategoryManagerModal categories={cats ?? []} onClose={() => setCatModal(false)} onChanged={refresh} />
      )}
      {del && (
        <ConfirmModal
          title={del.kind === "loan" ? "Usunąć kredyt?" : "Usunąć pozycję?"}
          body={`„${del.row.name}” zniknie z budżetu.`}
          busy={delBusy}
          onConfirm={confirmDelete}
          onClose={() => setDel(null)}
        />
      )}
    </div>
  );
}
