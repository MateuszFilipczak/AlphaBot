import { useEffect, useMemo, useState } from "react";
import ModuleBar from "../components/ModuleNav.jsx";
import RowMenu from "../components/RowMenu.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import { BudgetItemModal, LoanModal } from "../components/BudgetModals.jsx";
import {
  deleteBudgetItem, deleteBudgetLoan, getBudgetItems, getBudgetLoans,
} from "../api.js";
import {
  EXPENSE_CATEGORIES, LOANS_COLOR, addMonths, catColor, catLabel,
  loanState, monthKey, monthLabel,
} from "../budget.js";

const zl = (v) => (v ?? 0).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });
const pnl = (v) => (v >= 0 ? "pnl-up" : "pnl-down");

export default function Budget() {
  const [month, setMonth] = useState(monthKey());
  const [items, setItems] = useState(null);
  const [loans, setLoans] = useState(null);
  const [itemModal, setItemModal] = useState(null); // {type, edit?}
  const [loanModal, setLoanModal] = useState(null); // {edit?} | true
  const [del, setDel] = useState(null); // {kind, row}
  const [delBusy, setDelBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = () => {
    getBudgetItems().then(setItems).catch(() => setItems([]));
    getBudgetLoans().then(setLoans).catch(() => setLoans([]));
  };
  useEffect(reload, [tick]);
  const refresh = () => setTick((t) => t + 1);

  const view = useMemo(() => {
    if (!items || !loans) return null;
    const income = items.filter((i) => i.type === "INCOME");
    const expenses = items.filter((i) => i.type === "EXPENSE");
    const loanViews = loans
      .map((l) => ({ ...l, s: loanState(l, month) }))
      .sort((a, b) => a.s.finished - b.s.finished || a.name.localeCompare(b.name));
    const activeLoans = loanViews.filter((l) => l.s.active);
    const installmentsTotal = activeLoans.reduce((a, l) => a + l.installment, 0);
    const totalIncome = income.reduce((a, i) => a + i.amount, 0);
    const totalFixed = expenses.reduce((a, e) => a + e.amount, 0);
    const totalExpenses = totalFixed + installmentsTotal;
    const leftover = totalIncome - totalExpenses;

    // struktura wydatków: per-category totals + loans as one synthetic slice
    const byCat = {};
    for (const e of expenses) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    const catSegs = EXPENSE_CATEGORIES
      .filter((c) => byCat[c.key])
      .map((c) => ({ label: c.label, amount: byCat[c.key], color: c.color }));
    if (installmentsTotal > 0) catSegs.unshift({ label: "Raty kredytów", amount: installmentsTotal, color: LOANS_COLOR });

    const totalDebt = loanViews.reduce((a, l) => a + (l.s.finished ? 0 : l.s.remaining), 0);
    return {
      income, expenses, loanViews, activeLoans, installmentsTotal,
      totalIncome, totalExpenses, leftover, catSegs, totalDebt,
      savingsRate: totalIncome > 0 ? Math.round((leftover / totalIncome) * 100) : 0,
    };
  }, [items, loans, month]);

  const confirmDelete = async () => {
    setDelBusy(true);
    try {
      if (del.kind === "item") await deleteBudgetItem(del.row.id);
      else await deleteBudgetLoan(del.row.id);
      setDel(null);
      refresh();
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <div className="app">
      <ModuleBar />

      {/* month picker */}
      <div className="bmonth">
        <button className="btn" aria-label="Poprzedni miesiąc" onClick={() => setMonth((m) => addMonths(m, -1))}>‹</button>
        <div className="bmonth-label">
          <span className="muted">Budżet za</span>
          <b>{monthLabel(month)}</b>
        </div>
        <button className="btn" aria-label="Następny miesiąc" onClick={() => setMonth((m) => addMonths(m, 1))}>›</button>
        <input className="bmonth-input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        {month !== monthKey() && (
          <button className="btn" onClick={() => setMonth(monthKey())}>Dziś</button>
        )}
      </div>

      {!view ? (
        <div className="loading">Ładowanie budżetu…</div>
      ) : (
        <>
          {/* summary */}
          <section className="bud-summary big">
            <div className="bud-num"><span className="lbl">Przychody</span><span className="val pnl-up">{zl(view.totalIncome)}</span></div>
            <div className="bud-num"><span className="lbl">Wydatki</span><span className="val pnl-down">{zl(view.totalExpenses)}</span></div>
            <div className="bud-num"><span className="lbl">Zostaje</span><span className={`val ${pnl(view.leftover)}`}>{zl(view.leftover)}</span></div>
            <div className="bud-num"><span className="lbl">Stopa oszczędności</span><span className="val">{view.savingsRate}%</span></div>
          </section>

          {/* struktura wydatków */}
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

          {/* income + expenses columns */}
          <div className="bud-cols">
            <div className="bud-panel">
              <div className="panel-head">
                <h4>Przychody</h4>
                <button className="btn small" onClick={() => setItemModal({ type: "INCOME" })}>+ Wpływ</button>
              </div>
              {view.income.length === 0 ? <div className="empty small">Brak wpływów.</div> :
                view.income.map((i) => (
                  <div className="bud-row" key={i.id}>
                    <span>{i.name}{i.note && <small>{i.note}</small>}</span>
                    <span className="row-end"><b className="pnl-up">{zl(i.amount)}</b>
                      <RowMenu label="Menu" items={[
                        { label: "Edytuj", onClick: () => setItemModal({ type: "INCOME", edit: i }) },
                        { label: "Usuń", danger: true, onClick: () => setDel({ kind: "item", row: i }) },
                      ]} />
                    </span>
                  </div>
                ))}
              <div className="bud-row total"><span>Razem</span><b className="pnl-up">{zl(view.totalIncome)}</b></div>
            </div>

            <div className="bud-panel">
              <div className="panel-head">
                <h4>Wydatki stałe</h4>
                <button className="btn small" onClick={() => setItemModal({ type: "EXPENSE" })}>+ Wydatek</button>
              </div>
              {view.expenses.length === 0 && view.activeLoans.length === 0 ?
                <div className="empty small">Brak wydatków.</div> : null}
              {view.expenses.map((e) => (
                <div className="bud-row" key={e.id}>
                  <span><i className="cat-dot" style={{ background: catColor(e.category) }} />{e.name}
                    <small>{catLabel(e.category)}</small></span>
                  <span className="row-end"><b>{zl(e.amount)}</b>
                    <RowMenu label="Menu" items={[
                      { label: "Edytuj", onClick: () => setItemModal({ type: "EXPENSE", edit: e }) },
                      { label: "Usuń", danger: true, onClick: () => setDel({ kind: "item", row: e }) },
                    ]} />
                  </span>
                </div>
              ))}
              {view.activeLoans.map((l) => (
                <div className="bud-row muted-row" key={`loan-${l.id}`}>
                  <span><i className="cat-dot" style={{ background: LOANS_COLOR }} />{l.name}<small>rata kredytu</small></span>
                  <b>{zl(l.installment)}</b>
                </div>
              ))}
              <div className="bud-row total"><span>Razem</span><b className="pnl-down">{zl(view.totalExpenses)}</b></div>
            </div>
          </div>

          {/* loans dashboard */}
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
                <div className="loan-detail-list">
                  {view.loanViews.map((l) => (
                    <div className={`loan-detail ${l.s.finished ? "done" : ""} ${l.s.upcoming ? "soon" : ""}`} key={l.id}>
                      <div className="ld-top">
                        <b>{l.name}
                          {l.s.finished && <span className="badge ok">spłacony</span>}
                          {l.s.upcoming && <span className="badge">jeszcze nieaktywny</span>}
                        </b>
                        <span className="row-end">
                          <span className="muted">{l.s.paidCount}/{l.installments_count} rat · koniec {addMonths(l.start_month, l.installments_count - 1)}</span>
                          <RowMenu label="Menu kredytu" items={[
                            { label: "Edytuj", onClick: () => setLoanModal({ edit: l }) },
                            { label: "Usuń", danger: true, onClick: () => setDel({ kind: "loan", row: l }) },
                          ]} />
                        </span>
                      </div>
                      <div className="bud-bar"><span style={{ width: `${l.s.pct}%`, background: LOANS_COLOR }} /></div>
                      <div className="ld-grid">
                        <span><small className="muted">Rata</small>{zl(l.installment)}</span>
                        <span><small className="muted">Spłacono</small>{zl(l.s.paid)}</span>
                        <span><small className="muted">Zostało</small>{zl(l.s.remaining)}</span>
                        <span><small className="muted">Zostało rat</small>{l.s.left}</span>
                      </div>
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
          onClose={() => setItemModal(null)}
          onSaved={() => { setItemModal(null); refresh(); }}
        />
      )}
      {loanModal && (
        <LoanModal
          edit={loanModal.edit}
          onClose={() => setLoanModal(null)}
          onSaved={() => { setLoanModal(null); refresh(); }}
        />
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
