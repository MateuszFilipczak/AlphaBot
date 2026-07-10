import { useState } from "react";
import { addWatch } from "../api.js";
import TickerSearch from "./TickerSearch.jsx";

// Add a ticker to the active portfolio's watchlist (Yahoo autocomplete).
export default function WatchModal({ portfolio, onClose, onSaved }) {
  const [ticker, setTicker] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!ticker.trim()) return setError("Podaj ticker.");
    setSaving(true);
    setError(null);
    try {
      await addWatch(portfolio.id, ticker.trim().toUpperCase());
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>Obserwuj instrument — portfel {portfolio.name}</h3>
        <div className="field">
          <label>Ticker</label>
          <TickerSearch value={ticker} onChange={setTicker} onSelect={(item) => setTicker(item.symbol)} />
          <div className="hint">Pozycja trafi na listę obserwowanych — bez transakcji.</div>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Anuluj</button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Dodawanie…" : "Obserwuj"}
          </button>
        </div>
      </form>
    </div>
  );
}
