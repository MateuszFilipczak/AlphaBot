import { useEffect, useMemo, useState } from "react";
import ModuleBar from "../components/ModuleNav.jsx";
import RowMenu from "../components/RowMenu.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import { BudgetItemModal, CategoryManagerModal, LoanModal } from "../components/BudgetModals.jsx";
import {
  deleteBudgetItem, deleteBudgetLoan, getBudgetCategories, getBudgetItems, getBudgetLoans,
} from "../api.js";
import { LOANS_COLOR, NO_CAT_COLOR, addMonths, loanState, monthKey, monthLabel } from "../budget.js";

const zl = (v) => (v ?? 0).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });
const pnl = (v) => (v >= 0 ? "pnl-up" : "pnl-down");

export default function Budget() {
  const [month, setMonth] = useState(monthKey());
  const [items, setItems] = useState(null);
  const [loans, setLoans] = useState(null);
  const [cats, setCats] = useState(null);
  const [itemModal, setItemModal] = useState(null); // {type, edit?}
  const [loanModal, setLoanModal] = useState(null); // {edit?} | true
  const [catModal, setCatModal] = useState(false);
  const [del, setDel] = useState(null); // {kind, row}
  const [delBusy, setDelBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    getBudgetItems().then(setItems).catch(() => setItems([]));
    getBudgetLoans().then(setLoans).catch(() => setLoans([]));
    getBudgetCategories().then(setCats).catch(() => setCats([]));
  }, [tick]);
  const refresh = () => setTick((t) => t + 1);

  const catMap = useMemo(() => {
    const m = new Map();
    (cats ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [cats]);
  const catInfo = (id) => (id != null && catMap.get(id)) || { name: "Bez kategorii", color: NO_CAT_COLOR };
  const expenseCats = (cats ?? []).filter((c) => c.kind === "EXPENSE");
  const incomeCats = (cats ?? []).filter((c) => c.kind === "INCOME");

  const view = useMemo(() => {
    if (!items || !loans || !cats) return null;
    // recurring (month == null) always count; one-off only in their month
    const inMonth = (i) => i.month == null || i.month === month;
    const active = items.filter(inMonth);
    const incomeRec = active.filter((i) => i.type === "INCOME" && i.month == null);
    const expenseRec = active.filter((i) => i.type === "EXPENSE" && i.month == null);
    const oneOff = active.filter((i) => i.month === month);

    const loanViews = loans
      .map((l) => ({ ...l, s: loanState(l, month) }))
      .sort((a, b) => a.s.finished - b.s.finished || a.name.localeCompare(b.name));
    const activeLoans = loanViews.filter((l) => l.s.active);
    const installmentsTotal = activeLoans.reduce((a, l) => a + l.installment, 0);

    const totalIncome = active.filter((i) => i.type === "INCOME").reduce((a, i) => a + i.amount, 0);
    const totalExpenses = active.filter((i) => i.type === "EXPENSE").reduce((a, i) => a + i.amount, 0) + installmentsTotal;
    const leftover = totalIncome - totalExpenses;

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
    return {
      incomeRec, expenseRec, oneOff, loanViews, activeLoans, installmentsTotal,
      totalIncome, totalExpenses, leftover, catSegs, totalDebt,
      savingsRate: totalIncome > 0 ? Math.round((leftover / totalIncome) * 100) : 0,
    };
  }, [items, loans, cats, month]);

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
        <input className="bmonth-input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
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
            <div className="bud-num"><span className="lbl">Stopa oszczędności</span><span className="val">{view.savingsRate}%</span></div>
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

          <div className="bud-cols">
            <div className="bud-panel">
              <div className="panel-head">
                <h4>Przychody stałe</h4>
                <button className="btn small" onClick={() => setItemModal({ type: "INCOME" })}>+ Wpływ</button>
              </div>
              {view.incomeRec.length === 0 ? <div className="empty small">Brak stałych wpływów.</div> :
                view.incomeRec.map((i) => (
                  <div className="bud-row" key={i.id}>
                    <span>{i.name}{i.note && <small>{i.note}</small>}</span>
                    <span className="row-end"><b className="pnl-up">{zl(i.amount)}</b>{itemMenu(i)}</span>
                  </div>
                ))}
            </div>

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
                    <span><i className="cat-dot" style={{ background: c.color }} />{e.name}<small>{c.name}</small></span>
                    <span className="row-end"><b>{zl(e.amount)}</b>{itemMenu(e)}</span>
                  </div>
                );
              })}
              {view.activeLoans.map((l) => (
                <div className="bud-row muted-row" key={`loan-${l.id}`}>
                  <span><i className="cat-dot" style={{ background: LOANS_COLOR }} />{l.name}<small>rata kredytu</small></span>
                  <b>{zl(l.installment)}</b>
                </div>
              ))}
              <div className="bud-row total"><span>Razem</span><b className="pnl-down">{zl(view.totalExpenses)}</b></div>
            </div>
          </div>

          {/* one-off entries for the viewed month */}
          <div className="bud-panel">
            <div className="panel-head">
              <h4>Dodatkowe w tym miesiącu</h4>
              <button className="btn small" onClick={() => setItemModal({ type: "EXPENSE", oneOff: true })}>+ Wydatek jednorazowy</button>
            </div>
            {view.oneOff.length === 0 ? (
              <div className="empty small">Brak jednorazowych pozycji w {monthLabel(month)} (np. ubezpieczenie auta, nadpłata kredytu).</div>
            ) : view.oneOff.map((o) => {
              const c = o.type === "EXPENSE" ? catInfo(o.category_id) : null;
              return (
                <div className="bud-row" key={o.id}>
                  <span>
                    {c && <i className="cat-dot" style={{ background: c.color }} />}
                    {o.name}<small>{o.type === "INCOME" ? "wpływ" : c.name}</small>
                  </span>
                  <span className="row-end">
                    <b className={o.type === "INCOME" ? "pnl-up" : ""}>{o.type === "INCOME" ? "+" : ""}{zl(o.amount)}</b>
                    {itemMenu(o)}
                  </span>
                </div>
              );
            })}
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
