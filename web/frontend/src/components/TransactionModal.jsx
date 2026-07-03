import { useEffect, useState } from "react";
import { addTransaction, getInstrument, getPosition, updateTransaction } from "../api.js";
import { fmtShares } from "../format.js";
import TickerSearch from "./TickerSearch.jsx";

const today = () => new Date().toISOString().slice(0, 10);

export default function TransactionModal({ portfolio, defaults, onClose, onSaved }) {
  const editing = defaults.edit ?? null; // existing transaction → edit mode (PUT)
  const [type, setType] = useState(editing?.type ?? defaults.type ?? "BUY");
  const [ticker, setTicker] = useState(editing?.ticker ?? defaults.ticker ?? "");
  const [shares, setShares] = useState(editing ? String(editing.shares) : "");
  const [price, setPrice] = useState(editing ? String(editing.price) : "");
  const [fee, setFee] = useState(editing ? String(editing.fee ?? 0) : "0");
  const [date, setDate] = useState(editing?.date?.slice(0, 10) ?? today());
  const [note, setNote] = useState(editing?.note ?? "");
  const [owned, setOwned] = useState(null); // shares held, for SELL validation
  const [instrument, setInstrument] = useState(null); // for the currency-mismatch warning
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // when selling, show how many shares are held of the chosen ticker
  // (skipped in edit mode — the server replays the whole history anyway)
  useEffect(() => {
    setOwned(null);
    if (editing || type !== "SELL" || !ticker.trim()) return;
    let cancelled = false;
    getPosition(portfolio.id, ticker.trim())
      .then((d) => !cancelled && setOwned(d.summary.shares))
      .catch(() => !cancelled && setOwned(0));
    return () => {
      cancelled = true;
    };
  }, [editing, type, ticker, portfolio.id]);

  // instrument metadata (debounced) → warn when its trading currency differs
  // from the portfolio's; adding is still allowed (broker-style FX conversion)
  useEffect(() => {
    setInstrument(null);
    const q = ticker.trim();
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getInstrument(q)
        .then((i) => !cancelled && setInstrument(i))
        .catch(() => !cancelled && setInstrument(null));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ticker]);

  const currencyMismatch =
    instrument?.currency && instrument.currency !== portfolio.currency ? instrument.currency : null;

  const sharesNum = parseFloat(shares);
  const oversell = !editing && type === "SELL" && owned !== null && sharesNum > owned + 1e-9;

  const submit = async (e) => {
    e.preventDefault();
    if (!ticker.trim()) return setError("Podaj ticker.");
    if (!(sharesNum > 0)) return setError("Liczba akcji musi być większa od zera.");
    const priceNum = parseFloat(price);
    if (!(priceNum >= 0) || price === "") return setError("Podaj cenę za akcję.");
    if (oversell) return setError(`Nie możesz sprzedać więcej niż ${fmtShares(owned)} akcji.`);

    setSaving(true);
    setError(null);
    const body = {
      ticker: ticker.trim().toUpperCase(),
      type,
      shares: sharesNum,
      price: priceNum,
      fee: parseFloat(fee) || 0,
      date,
      note: note.trim() || null,
    };
    try {
      if (editing) await updateTransaction(editing.id, body);
      else await addTransaction(portfolio.id, body);
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>
          {editing ? `Edytuj transakcję — ${editing.ticker}` : `Nowa transakcja — portfel ${portfolio.name}`}
        </h3>

        <div className="type-toggle" role="group" aria-label="Typ transakcji">
          <button
            type="button"
            className={`buy ${type === "BUY" ? "active" : ""}`}
            onClick={() => setType("BUY")}
          >
            Kupno
          </button>
          <button
            type="button"
            className={`sell ${type === "SELL" ? "active" : ""}`}
            onClick={() => setType("SELL")}
          >
            Sprzedaż
          </button>
        </div>

        <div className="field">
          <label>Ticker</label>
          <TickerSearch
            value={ticker}
            onChange={setTicker}
            onSelect={(item) => setTicker(item.symbol)}
            disabled={!!editing}
          />
          {!editing && type === "SELL" && ticker && owned !== null && (
            <div className={`hint ${oversell ? "error" : ""}`}>
              Posiadasz: {fmtShares(owned)} szt.
            </div>
          )}
          {currencyMismatch && (
            <div className="hint" style={{ color: "#c98500" }}>
              ⚠ {ticker.trim().toUpperCase()} notowane w {currencyMismatch}, portfel jest w{" "}
              {portfolio.currency} — sumy będą przeliczane po bieżącym kursie (przybliżenie).
            </div>
          )}
        </div>

        <div className="field-row">
          <div className="field">
            <label>Liczba akcji</label>
            <input
              type="number"
              step="any"
              min="0"
              max={type === "SELL" && owned !== null ? owned : undefined}
              value={shares}
              onChange={(e) => setShares(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Cena za akcję</label>
            <input type="number" step="any" min="0" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Prowizja</label>
            <input type="number" step="any" min="0" value={fee} onChange={(e) => setFee(e.target.value)} />
          </div>
          <div className="field">
            <label>Data</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Notatka (opcjonalna)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="btn primary" disabled={saving || oversell}>
            {saving ? "Zapisywanie…" : type === "BUY" ? "Kup" : "Sprzedaj"}
          </button>
        </div>
      </form>
    </div>
  );
}
