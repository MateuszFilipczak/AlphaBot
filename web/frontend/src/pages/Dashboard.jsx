import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../App.jsx";
import { deleteDeposit, getDeposits, getSummary } from "../api.js";
import { fmtDate, fmtMoney, fmtPct, fmtShares, pnlClass, typeBadgeClass, typeLabel } from "../format.js";
import PortfolioChart from "../components/PortfolioChart.jsx";
import DepositModal from "../components/DepositModal.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import RowMenu from "../components/RowMenu.jsx";

export default function Dashboard() {
  const { portfolio, portfolioId, refreshTick, refresh } = useApp();
  const [summary, setSummary] = useState(null);
  const [deposits, setDeposits] = useState([]);
  const [error, setError] = useState(null);
  const [editFlow, setEditFlow] = useState(null); // deposits row being edited
  const [deleteFlow, setDeleteFlow] = useState(null); // deposits row pending delete
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);
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
    getSummary(portfolioId).then(setSummary).catch((e) => setError(e.message));
    getDeposits(portfolioId).then(setDeposits).catch(console.error);
  }, [portfolioId, refreshTick]);

  if (error) return <div className="empty">Błąd: {error}</div>;
  if (!summary) return <div className="loading">Ładowanie portfela…</div>;

  const cur = portfolio.currency;
  const pnl = summary.total_pnl;

  return (
    <>
      <section className="tiles">
        <div className="tile">
          <div className="label">Wpłacono łącznie</div>
          <div className="value">{fmtMoney(summary.deposited, cur)}</div>
        </div>
        <div className="tile">
          <div className="label">Gotówka dostępna</div>
          <div className={`value ${summary.cash < 0 ? "pnl-down" : ""}`}>
            {fmtMoney(summary.cash, cur)}
          </div>
        </div>
        <div className="tile">
          <div className="label">Wartość pozycji</div>
          <div className="value">{fmtMoney(summary.positions_value, cur)}</div>
          {summary.unpriced_tickers.length > 0 && (
            <div className="sub">po koszcie (cena niedostępna): {summary.unpriced_tickers.join(", ")}</div>
          )}
        </div>
        <div className="tile">
          <div className="label">Zysk łączny</div>
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

      <h2>Pozycje</h2>
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

      <h2>Historia wpłat i wypłat</h2>
      <div className="table-wrap">
        {deposits.length === 0 ? (
          <div className="empty">Brak wpłat.</div>
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
              {[...deposits].reverse().map((d) => {
                const out = d.type === "WITHDRAWAL";
                return (
                  <tr key={d.id}>
                    <td>{fmtDate(d.date)}</td>
                    <td>{out ? "Wypłata" : "Wpłata"}</td>
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
