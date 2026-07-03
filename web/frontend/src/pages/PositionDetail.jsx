import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApp } from "../App.jsx";
import { deleteTransaction, getChart, getPosition, setInstrumentType } from "../api.js";
import { fmtDate, fmtMoney, fmtPct, fmtShares, pnlClass, typeBadgeClass, typeLabel } from "../format.js";
import PriceChart from "../components/PriceChart.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import RowMenu from "../components/RowMenu.jsx";

const RANGES = [
  ["1mo", "1M"],
  ["3mo", "3M"],
  ["1y", "1R"],
  ["max", "MAX"],
];

const INSTRUMENT_TYPES = [
  ["EQUITY", "Akcja"],
  ["ETF", "ETF"],
  ["ETC", "ETC (surowce)"],
];

// Yahoo often mislabels ETCs as ETF/EQUITY — manual override, saved in the
// instruments table.
function InstrumentTypeModal({ ticker, current, onClose, onSaved }) {
  const [type, setType] = useState(current ?? "EQUITY");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setInstrumentType(ticker, type);
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>Typ instrumentu — {ticker}</h3>
        <div className="type-toggle">
          {INSTRUMENT_TYPES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`buy ${type === value ? "active" : ""}`}
              onClick={() => setType(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Zapisywanie…" : "Zapisz"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function PositionDetail() {
  const { ticker } = useParams();
  const { portfolio, portfolioId, refreshTick, openTransaction, refresh } = useApp();
  const [detail, setDetail] = useState(null);
  const [chart, setChart] = useState(null);
  const [chartError, setChartError] = useState(null);
  const [range, setRange] = useState("3mo");
  const [mode, setMode] = useState("line");
  const [showBuys, setShowBuys] = useState(true);
  const [showSells, setShowSells] = useState(true);
  const [error, setError] = useState(null);
  const [toDelete, setToDelete] = useState(null); // transaction pending confirmation
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [typeModal, setTypeModal] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!portfolioId) return;
    setError(null);
    getPosition(portfolioId, ticker).then(setDetail).catch((e) => setError(e.message));
  }, [portfolioId, ticker, refreshTick]);

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTransaction(toDelete.id);
      setToDelete(null);
      // deleting the last transaction of a ticker leaves nothing to show here
      if (detail.transactions.length <= 1) navigate(`/?p=${portfolioId}`);
      else refresh();
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!portfolioId) return;
    setChart(null);
    setChartError(null);
    getChart(ticker, range, portfolioId).then(setChart).catch((e) => setChartError(e.message));
  }, [portfolioId, ticker, range, refreshTick]);

  // realized P&L per SELL transaction id, for the history table
  const realizedByTxn = useMemo(() => {
    const map = new Map();
    for (const s of detail?.sales ?? []) map.set(s.txn_id, s.realized_pnl);
    return map;
  }, [detail]);

  if (error) return <div className="empty">Błąd: {error}</div>;
  if (!detail || !portfolio) return <div className="loading">Ładowanie pozycji…</div>;

  // prices/lots here are NATIVE — the instrument's trading currency
  const cur = detail.currency ?? portfolio.currency;
  const inst = detail.instrument;
  const s = detail.summary;

  return (
    <>
      <Link className="back" to={`/?p=${portfolioId}`}>
        ← Wróć do portfela {portfolio.name}
      </Link>

      <div className="pos-head">
        <h1>
          {detail.ticker}
          <span className={`badge ${typeBadgeClass(inst?.type)}`}>{typeLabel(inst?.type)}</span>
          {inst && (
            <span className="instr-name">
              {inst.name}
              {inst.exchange ? ` · ${inst.exchange}` : ""}
            </span>
          )}
        </h1>
        <span className="price">
          {s.current_price != null ? fmtMoney(s.current_price, cur) : "cena niedostępna"}
        </span>
        {s.unrealized_pnl != null && (
          <span className={pnlClass(s.unrealized_pnl)}>
            {fmtMoney(s.unrealized_pnl, cur, { sign: true })} ({fmtPct(s.unrealized_pnl_pct)})
          </span>
        )}
        <div className="actions" style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => openTransaction({ ticker: detail.ticker, type: "BUY" })}>
            Kup
          </button>
          <button
            className="btn danger"
            disabled={s.shares <= 0}
            onClick={() => openTransaction({ ticker: detail.ticker, type: "SELL" })}
          >
            Sprzedaj
          </button>
          <RowMenu
            label="Menu pozycji"
            items={[{ label: "Zmień typ instrumentu", onClick: () => setTypeModal(true) }]}
          />
        </div>
      </div>

      {cur !== portfolio.currency && (
        <div className="note">
          Notowane w {cur}, portfel w {portfolio.currency} — sumy portfela przeliczane po
          bieżącym kursie (przybliżenie).
        </div>
      )}

      <div className="chart-card">
        <div className="chart-controls">
          <div className="seg" role="group" aria-label="Typ wykresu">
            <button className={mode === "line" ? "active" : ""} onClick={() => setMode("line")}>
              Linia
            </button>
            <button className={mode === "candles" ? "active" : ""} onClick={() => setMode("candles")}>
              Świece
            </button>
          </div>
          <div className="seg" role="group" aria-label="Zakres">
            {RANGES.map(([value, label]) => (
              <button
                key={value}
                className={range === value ? "active" : ""}
                onClick={() => setRange(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Widoczność markerów">
            <button
              className={showBuys ? "active" : ""}
              aria-pressed={showBuys}
              onClick={() => setShowBuys((v) => !v)}
            >
              ● Kupno
            </button>
            <button
              className={showSells ? "active" : ""}
              aria-pressed={showSells}
              onClick={() => setShowSells((v) => !v)}
            >
              ● Sprzedaż
            </button>
          </div>
        </div>
        {chartError ? (
          <div className="chart-msg">Brak danych wykresu: {chartError}</div>
        ) : !chart ? (
          <div className="chart-msg">Ładowanie wykresu…</div>
        ) : (
          <>
            <PriceChart
              candles={chart.candles}
              markers={chart.markers.filter((m) =>
                m.type === "BUY" ? showBuys : showSells
              )}
              currentPrice={chart.current_price}
              mode={mode}
              currency={cur}
            />
            <div className="legend">
              <span>
                <span className="dot" style={{ background: "#0ca30c" }} />
                kupno (otwarta pozycja)
              </span>
              <span>
                <span className="dot" style={{ background: "#898781" }} />
                zamknięte kupno
              </span>
              <span>
                <span className="dot diamond" style={{ background: "#898781" }} />
                sprzedaż
              </span>
              <span>
                <span className="dot" style={{ background: "#c3c2b7" }} />
                ― aktualna cena
              </span>
            </div>
          </>
        )}
      </div>

      <h2>Otwarte pozycje</h2>
      <div className="table-wrap">
        {detail.lots.length === 0 ? (
          <div className="empty">Pozycja zamknięta — brak otwartych pozycji.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Data zakupu</th>
                <th>Akcje</th>
                <th>Cena zakupu</th>
                <th>Wartość dziś</th>
                <th>Zysk</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {detail.lots.map((lot) => (
                <tr key={lot.txn_id}>
                  <td>{fmtDate(lot.date)}</td>
                  <td>{fmtShares(lot.shares_remaining)}</td>
                  <td>{fmtMoney(lot.price, cur)}</td>
                  <td>{fmtMoney(lot.value_today, cur)}</td>
                  <td className={pnlClass(lot.pnl)}>{fmtMoney(lot.pnl, cur, { sign: true })}</td>
                  <td className={pnlClass(lot.pnl)}>{fmtPct(lot.pnl_pct)}</td>
                </tr>
              ))}
              <tr className="row-total">
                <td>Razem</td>
                <td>{fmtShares(s.shares)}</td>
                <td>{fmtMoney(s.avg_cost, cur)}</td>
                <td>{fmtMoney(s.market_value, cur)}</td>
                <td className={pnlClass(s.unrealized_pnl)}>
                  {fmtMoney(s.unrealized_pnl, cur, { sign: true })}
                </td>
                <td className={pnlClass(s.unrealized_pnl)}>{fmtPct(s.unrealized_pnl_pct)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <h2>
        Historia transakcji{" "}
        {s.realized_pnl !== 0 && (
          <span className={pnlClass(s.realized_pnl)}>
            (zrealizowany zysk: {fmtMoney(s.realized_pnl, cur, { sign: true })})
          </span>
        )}
      </h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Typ</th>
              <th>Akcje</th>
              <th>Cena</th>
              <th>Prowizja</th>
              <th>Zrealizowany zysk</th>
              <th>Notatka</th>
              <th aria-label="Akcje wiersza"></th>
            </tr>
          </thead>
          <tbody>
            {[...detail.transactions].reverse().map((t) => {
              const realized = t.type === "SELL" ? realizedByTxn.get(t.id) : null;
              return (
                <tr key={t.id} className={t.type === "SELL" ? "row-muted" : ""}>
                  <td>{fmtDate(t.date)}</td>
                  <td>{t.type === "BUY" ? "Kupno" : "Sprzedaż"}</td>
                  <td>{fmtShares(t.shares)}</td>
                  <td>{fmtMoney(t.price, cur)}</td>
                  <td>{t.fee ? fmtMoney(t.fee, cur) : "—"}</td>
                  <td className={realized != null ? pnlClass(realized) : ""}>
                    {realized != null ? fmtMoney(realized, cur, { sign: true }) : "—"}
                  </td>
                  <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {t.note ?? ""}
                  </td>
                  <td>
                    <RowMenu
                      label="Menu transakcji"
                      items={[
                        { label: "Edytuj", onClick: () => openTransaction({ edit: t }) },
                        {
                          label: "Usuń",
                          danger: true,
                          onClick: () => {
                            setDeleteError(null);
                            setToDelete(t);
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
      </div>

      {typeModal && (
        <InstrumentTypeModal
          ticker={detail.ticker}
          current={inst?.type}
          onClose={() => setTypeModal(false)}
          onSaved={() => {
            setTypeModal(false);
            refresh();
          }}
        />
      )}

      {toDelete && (
        <ConfirmModal
          title="Usunąć transakcję?"
          body={`${toDelete.type === "BUY" ? "Kupno" : "Sprzedaż"} ${fmtShares(toDelete.shares)} × ${detail.ticker} @ ${fmtMoney(toDelete.price, cur)} z dnia ${fmtDate(toDelete.date)} zniknie z historii, a portfel zostanie przeliczony. To nie jest sprzedaż — wpis po prostu przestanie istnieć.`}
          error={deleteError}
          busy={deleting}
          onConfirm={confirmDelete}
          onClose={() => setToDelete(null)}
        />
      )}
    </>
  );
}
