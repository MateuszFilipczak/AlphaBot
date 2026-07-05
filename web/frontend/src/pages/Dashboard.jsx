import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../App.jsx";
import { deleteDeposit, getDeposits, getSummary } from "../api.js";
import { fmtDate, fmtMoney, fmtPct, fmtShares, pnlClass, typeBadgeClass, typeLabel } from "../format.js";
import PortfolioChart from "../components/PortfolioChart.jsx";
import DepositModal from "../components/DepositModal.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import RowMenu from "../components/RowMenu.jsx";

// filters for the operations history table
const FLOW_FILTERS = [
  ["all", "Wszystkie"],
  ["in", "Wpłaty"],
  ["out", "Wypłaty"],
  ["income", "Dochody"],
];
const FLOWS_PER_PAGE = 10;

// row label: contributions are plain in/out, income/return rows say what they are
function flowLabel(d) {
  const category = d.category ?? "CONTRIBUTION";
  if (category === "INCOME") return d.type === "WITHDRAWAL" ? "Podatek" : "Dochód";
  if (category === "RETURN") return "Zwrot kapitału";
  return d.type === "WITHDRAWAL" ? "Wypłata" : "Wpłata";
}

export default function Dashboard() {
  const { portfolio, portfolioId, refreshTick, refresh } = useApp();
  const [summary, setSummary] = useState(null);
  const [deposits, setDeposits] = useState([]);
  const [error, setError] = useState(null);
  const [editFlow, setEditFlow] = useState(null); // deposits row being edited
  const [deleteFlow, setDeleteFlow] = useState(null); // deposits row pending delete
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [flowFilter, setFlowFilter] = useState("all");
  const [flowPage, setFlowPage] = useState(1);
  const [closedOpen, setClosedOpen] = useState(false);
  const [closedPage, setClosedPage] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const navigate = useNavigate();

  const confirmDeleteFlow = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDeposit(deleteFlow.id);
      setDeleteFlow(null);
      refresh();
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!portfolioId) return;
    setSummary(null);
    setError(null);
    setFlowPage(1);
    setClosedPage(1);
    getSummary(portfolioId).then(setSummary).catch((e) => setError(e.message));
    getDeposits(portfolioId).then(setDeposits).catch(console.error);
  }, [portfolioId, refreshTick]);

  if (error) return <div className="empty">Błąd: {error}</div>;
  if (!summary) return <div className="loading">Ładowanie portfela…</div>;

  const cur = portfolio.currency;
  const pnl = summary.total_pnl;

  // operations history: newest first, filterable, 10 per page
  const flowsAll = [...deposits].reverse();
  const flows = flowsAll.filter((d) => {
    const income = (d.category ?? "CONTRIBUTION") === "INCOME";
    if (flowFilter === "in") return d.type === "DEPOSIT" && !income;
    if (flowFilter === "out") return d.type === "WITHDRAWAL" && !income;
    if (flowFilter === "income") return income;
    return true;
  });
  const pages = Math.max(1, Math.ceil(flows.length / FLOWS_PER_PAGE));
  const page = Math.min(flowPage, pages);
  const pageFlows = flows.slice((page - 1) * FLOWS_PER_PAGE, page * FLOWS_PER_PAGE);

  // closed positions: same 10-per-page treatment
  const closedAll = summary.closed_positions;
  const closedPages = Math.max(1, Math.ceil(closedAll.length / FLOWS_PER_PAGE));
  const cPage = Math.min(closedPage, closedPages);
  const pageClosed = closedAll.slice((cPage - 1) * FLOWS_PER_PAGE, cPage * FLOWS_PER_PAGE);

  return (
    <>
      <section className="tiles">
        <div className="tile" title="Wpłaty bankowe + transfery przychodzące (z innych portfeli/subkont)">
          <div className="label">Suma wpłat<span className="info">ⓘ</span></div>
          <div className="value">{fmtMoney(summary.contributed_in, cur)}</div>
        </div>
        <div className="tile" title="Wypłaty bankowe + transfery wychodzące (przewalutowania, inne subkonta)">
          <div className="label">Suma wypłat<span className="info">ⓘ</span></div>
          <div className="value">{fmtMoney(summary.contributed_out, cur)}</div>
        </div>
        <div className="tile">
          <div className="label">Gotówka dostępna</div>
          <div className={`value ${summary.cash < 0 ? "pnl-down" : ""}`}>
            {fmtMoney(summary.cash, cur)}
          </div>
        </div>
        <div className="tile">
          <div className="label">Wartość otwartych pozycji</div>
          <div className="value">{fmtMoney(summary.positions_value, cur)}</div>
          {summary.unpriced_tickers.length > 0 && (
            <div className="sub">po koszcie (cena niedostępna): {summary.unpriced_tickers.join(", ")}</div>
          )}
        </div>
        <div
          className="tile"
          title="Zrealizowany wynik + niezrealizowany na otwartych pozycjach + dywidendy/odsetki − podatki. Procent względem sumy wpłat."
        >
          <div className="label">Zysk łączny<span className="info">ⓘ</span></div>
          <div className={`value ${pnlClass(pnl)}`}>
            {fmtMoney(pnl, cur, { sign: true })}
          </div>
          <div className={`sub ${pnlClass(pnl)}`}>{fmtPct(summary.total_pnl_pct)}</div>
        </div>
      </section>

      {Object.keys(summary.fx_rates ?? {}).length > 0 && (
        <div className="note">
          ≈ Pozycje w innych walutach przeliczone po bieżącym kursie (przybliżenie):{" "}
          {Object.entries(summary.fx_rates)
            .map(([c, r]) => `${c}→${cur} ${r.toFixed(4)}`)
            .join(", ")}
        </div>
      )}
      {(summary.fx_unavailable ?? []).length > 0 && (
        <div className="note warn">
          ⚠ Brak kursu dla: {summary.fx_unavailable.join(", ")} — kwoty policzone 1:1.
        </div>
      )}

      <PortfolioChart
        portfolioId={portfolioId}
        currency={cur}
        refreshTick={refreshTick}
      />

      <h2>Otwarte pozycje</h2>
      {summary.positions.length === 0 ? (
        <div className="table-wrap">
          <div className="empty">Brak otwartych pozycji — dodaj pierwszą transakcję.</div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Akcje</th>
                <th>Śr. cena zakupu</th>
                <th>Aktualna cena</th>
                <th>Wartość rynkowa</th>
                <th>Zysk netto</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {summary.positions.map((pos) => (
                <tr
                  key={pos.ticker}
                  className="clickable"
                  onClick={() => navigate(`/position/${pos.ticker}?p=${portfolioId}`)}
                >
                  <td className="ticker-cell">
                    {pos.ticker}
                    <span className={`badge ${typeBadgeClass(pos.type)}`}>{typeLabel(pos.type)}</span>
                    <span className="instr-name">{pos.name}</span>
                  </td>
                  <td>{fmtShares(pos.shares)}</td>
                  <td>{fmtMoney(pos.avg_cost, pos.currency)}</td>
                  <td>
                    {pos.priced ? (
                      fmtMoney(pos.current_price, pos.currency)
                    ) : (
                      <span className="cell-note">cena niedostępna</span>
                    )}
                  </td>
                  <td>
                    {pos.priced ? (
                      fmtMoney(pos.value_pc, cur)
                    ) : (
                      <span className="cell-note">po koszcie: {fmtMoney(pos.value_pc, cur)}</span>
                    )}
                  </td>
                  <td className={pnlClass(pos.unrealized_pnl_pc)}>
                    {pos.priced ? fmtMoney(pos.unrealized_pnl_pc, cur, { sign: true }) : "—"}
                  </td>
                  <td className={pnlClass(pos.unrealized_pnl_pc)}>
                    {pos.priced ? fmtPct(pos.unrealized_pnl_pct) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.closed_positions.length > 0 && (
        <>
          <h2
            className="collapsible"
            onClick={() => setClosedOpen((o) => !o)}
            role="button"
            aria-expanded={closedOpen}
          >
            <span className={`chevron ${closedOpen ? "open" : ""}`}>▶</span>
            Zamknięte pozycje
            <span className="count-hint">({summary.closed_positions.length})</span>
          </h2>
          {closedOpen && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Sprzedane akcje</th>
                  <th>Zainwestowano</th>
                  <th>Ze sprzedaży</th>
                  <th>Zrealizowany zysk</th>
                  <th>%</th>
                  <th>Zamknięta</th>
                </tr>
              </thead>
              <tbody>
                {pageClosed.map((pos) => (
                  <tr
                    key={pos.ticker}
                    className="clickable"
                    onClick={() => navigate(`/position/${pos.ticker}?p=${portfolioId}`)}
                  >
                    <td className="ticker-cell">
                      {pos.ticker}
                      <span className={`badge ${typeBadgeClass(pos.type)}`}>{typeLabel(pos.type)}</span>
                      <span className="instr-name">{pos.name}</span>
                    </td>
                    <td>{fmtShares(pos.shares_sold)}</td>
                    {/* portfolio currency — FX-exact for imported trades (broker
                        rates); approximated at the current rate otherwise */}
                    <td>{fmtMoney(pos.invested_pc, cur)}</td>
                    <td>{fmtMoney(pos.proceeds_pc, cur)}</td>
                    <td className={pnlClass(pos.realized_pnl_pc)}>
                      {fmtMoney(pos.realized_pnl_pc, cur, { sign: true })}
                      {pos.currency !== cur && (
                        <span className="instr-name">
                          {fmtMoney(pos.realized_pnl, pos.currency, { sign: true })}
                          {pos.fx_exact ? "" : " ≈"}
                        </span>
                      )}
                    </td>
                    <td className={pnlClass(pos.realized_pnl_pc)}>{fmtPct(pos.realized_pnl_pct)}</td>
                    <td>{fmtDate(pos.last_sell_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
          {closedOpen && closedPages > 1 && (
            <div className="pager">
              <button className="btn" disabled={cPage <= 1} onClick={() => setClosedPage(cPage - 1)}>
                ← Poprzednia
              </button>
              <span className="pager-info">
                strona {cPage} z {closedPages} · {closedAll.length} pozycji
              </span>
              <button
                className="btn"
                disabled={cPage >= closedPages}
                onClick={() => setClosedPage(cPage + 1)}
              >
                Następna →
              </button>
            </div>
          )}
        </>
      )}

      <div className="section-head">
        <h2
          className="collapsible"
          onClick={() => setHistoryOpen((o) => !o)}
          role="button"
          aria-expanded={historyOpen}
        >
          <span className={`chevron ${historyOpen ? "open" : ""}`}>▶</span>
          Historia operacji
          <span className="count-hint">({flowsAll.length})</span>
        </h2>
        {historyOpen && (
          <div className="seg" role="group" aria-label="Filtr operacji">
            {FLOW_FILTERS.map(([value, label]) => (
              <button
                key={value}
                className={flowFilter === value ? "active" : ""}
                onClick={() => {
                  setFlowFilter(value);
                  setFlowPage(1);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {historyOpen && (
      <div className="table-wrap">
        {flows.length === 0 ? (
          <div className="empty">Brak operacji.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Typ</th>
                <th>Kwota</th>
                <th>Notatka</th>
                <th aria-label="Akcje wiersza"></th>
              </tr>
            </thead>
            <tbody>
              {pageFlows.map((d) => {
                const out = d.type === "WITHDRAWAL";
                return (
                  <tr key={d.id}>
                    <td>{fmtDate(d.date)}</td>
                    <td>{flowLabel(d)}</td>
                    <td className={out ? "pnl-down" : ""}>
                      {fmtMoney(out ? -d.amount : d.amount, d.currency ?? cur, { sign: out })}
                    </td>
                    <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {d.note ?? ""}
                    </td>
                    <td>
                      <RowMenu
                        label="Menu wpisu"
                        items={[
                          { label: "Edytuj", onClick: () => setEditFlow(d) },
                          {
                            label: "Usuń",
                            danger: true,
                            onClick: () => {
                              setDeleteError(null);
                              setDeleteFlow(d);
                            },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      )}
      {historyOpen && pages > 1 && (
        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => setFlowPage(page - 1)}>
            ← Poprzednia
          </button>
          <span className="pager-info">
            strona {page} z {pages} · {flows.length} operacji
          </span>
          <button className="btn" disabled={page >= pages} onClick={() => setFlowPage(page + 1)}>
            Następna →
          </button>
        </div>
      )}

      {editFlow && (
        <DepositModal
          portfolio={portfolio}
          edit={editFlow}
          onClose={() => setEditFlow(null)}
          onSaved={() => {
            setEditFlow(null);
            refresh();
          }}
        />
      )}
      {deleteFlow && (
        <ConfirmModal
          title={`Usunąć ${deleteFlow.type === "WITHDRAWAL" ? "wypłatę" : "wpłatę"}?`}
          body={`${deleteFlow.type === "WITHDRAWAL" ? "Wypłata" : "Wpłata"} ${fmtMoney(deleteFlow.amount, deleteFlow.currency ?? cur)} z dnia ${fmtDate(deleteFlow.date)} zniknie z historii, a saldo zostanie przeliczone.`}
          error={deleteError}
          busy={deleting}
          onConfirm={confirmDeleteFlow}
          onClose={() => setDeleteFlow(null)}
        />
      )}
    </>
  );
}
