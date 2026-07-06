import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApp } from "../App.jsx";
import { deleteTransaction, getChart, getPosition, setInstrumentType } from "../api.js";
import { fmtDate, fmtMoney, fmtPct, fmtShares, pnlClass, typeBadgeClass, typeLabel } from "../format.js";
import PriceChart from "../components/PriceChart.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import RowMenu from "../components/RowMenu.jsx";

const RANGES = [
  ["1d", "1D"],
  ["5d", "1T"],
  ["1mo", "1M"],
  ["6mo", "6M"],
  ["1y", "1R"],
  ["5y", "5L"],
  ["max", "MAX"],
];

// graphic line/candles toggle icons
const LineIcon = () => (
  <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
    <polyline points="1,10 5,5.5 8,7.5 12,2.5 15,4.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
  </svg>
);
const CandlesIcon = () => (
  <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1" fill="currentColor">
      <line x1="3" y1="0.5" x2="3" y2="11.5" />
      <rect x="1.4" y="3" width="3.2" height="5" rx="0.5" />
      <line x1="8" y1="1.5" x2="8" y2="10" />
      <rect x="6.4" y="4.5" width="3.2" height="3.5" rx="0.5" />
      <line x1="13" y1="2" x2="13" y2="11.5" />
      <rect x="11.4" y="4" width="3.2" height="5.5" rx="0.5" />
    </g>
  </svg>
);

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
  const [range, setRange] = useState("6mo");
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
      if (detail.transactions.length <= 1) navigate(`/gielda?p=${portfolioId}`);
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

  // full sale record per SELL transaction id (native + settled-cash figures)
  const saleByTxn = useMemo(() => {
    const map = new Map();
    for (const s of detail?.sales ?? []) map.set(s.txn_id, s);
    return map;
  }, [detail]);

  if (error) return <div className="empty">Błąd: {error}</div>;
  if (!detail || !portfolio) return <div className="loading">Ładowanie pozycji…</div>;

  // prices/lots here are NATIVE — the instrument's trading currency
  const cur = detail.currency ?? portfolio.currency;
  const pcur = portfolio.currency;
  const foreign = cur !== pcur;
  const fxRate = detail.fx_rate; // current rate for ≈-fallbacks (may be null)
  const inst = detail.instrument;
  const s = detail.summary;

  // portfolio-currency value of one transaction: broker-settled amount when
  // imported (exact), otherwise ≈ at the current rate
  const txnValuePc = (t) => {
    if (t.cash_amount != null) return { value: t.cash_amount, exact: true };
    if (fxRate != null) return { value: t.shares * t.price * fxRate, exact: false };
    return null;
  };
  // FX-exact realized total (matches the broker) — only when every sale has it
  const realizedPcTotal =
    foreign && detail.sales.length > 0 && detail.sales.every((x) => x.realized_cash != null)
      ? detail.sales.reduce((acc, x) => acc + x.realized_cash, 0)
      : null;

  return (
    <>
      <Link className="back" to={`/gielda?p=${portfolioId}`}>
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
            <button
              className={`icon-btn ${mode === "line" ? "active" : ""}`}
              title="Linia"
              aria-label="Wykres liniowy"
              onClick={() => setMode("line")}
            >
              <LineIcon />
            </button>
            <button
              className={`icon-btn ${mode === "candles" ? "active" : ""}`}
              title="Świece"
              aria-label="Wykres świecowy"
              onClick={() => setMode("candles")}
            >
              <CandlesIcon />
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
          <div className="seg right" role="group" aria-label="Widoczność markerów">
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
                kupno (pinezka pod wykresem)
              </span>
              <span>
                <span className="dot" style={{ background: "#0ca30c", opacity: 0.5 }} />
                kupno zamknięte sprzedażą
              </span>
              <span>
                <span className="dot" style={{ background: "#d03b3b" }} />
                sprzedaż (pinezka nad wykresem)
              </span>
              <span>
                <span className="dot" style={{ background: "#3987e5" }} />
                ostatnia cena (puls)
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
            (zrealizowany zysk:{" "}
            {realizedPcTotal != null
              ? `${fmtMoney(realizedPcTotal, pcur, { sign: true })} · ${fmtMoney(s.realized_pnl, cur, { sign: true })}`
              : fmtMoney(s.realized_pnl, cur, { sign: true })}
            )
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
              {foreign && <th>Kwota ({pcur})</th>}
              <th>Prowizja</th>
              <th>Zrealizowany zysk</th>
              <th>Notatka</th>
              <th aria-label="Akcje wiersza"></th>
            </tr>
          </thead>
          <tbody>
            {[...detail.transactions].reverse().map((t) => {
              const sale = t.type === "SELL" ? saleByTxn.get(t.id) : null;
              const realized = sale?.realized_pnl ?? null;
              // portfolio-currency realized: broker-exact when available,
              // otherwise ≈ at the current rate
              const realizedPc =
                sale == null ? null
                : sale.realized_cash != null ? { value: sale.realized_cash, exact: true }
                : fxRate != null ? { value: sale.realized_pnl * fxRate, exact: false }
                : null;
              const valuePc = foreign ? txnValuePc(t) : null;
              return (
                <tr key={t.id} className={t.type === "SELL" ? "row-muted" : ""}>
                  <td>{fmtDate(t.date)}</td>
                  <td>{t.type === "BUY" ? "Kupno" : "Sprzedaż"}</td>
                  <td>{fmtShares(t.shares)}</td>
                  <td>{fmtMoney(t.price, cur)}</td>
                  {foreign && (
                    <td>
                      {valuePc ? `${valuePc.exact ? "" : "≈ "}${fmtMoney(valuePc.value, pcur)}` : "—"}
                    </td>
                  )}
                  <td>{t.fee ? fmtMoney(t.fee, cur) : "—"}</td>
                  <td className={realized != null ? pnlClass(realized) : ""}>
                    {realized == null ? "—" : foreign && realizedPc ? (
                      <>
                        {realizedPc.exact ? "" : "≈ "}
                        {fmtMoney(realizedPc.value, pcur, { sign: true })}
                        <span className="instr-name">{fmtMoney(realized, cur, { sign: true })}</span>
                      </>
                    ) : (
                      fmtMoney(realized, cur, { sign: true })
                    )}
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
