import { useState } from "react";
import { createPortfolio } from "../api.js";

// New-portfolio modal. The currency comes from the active currency tab and
// is NOT editable here — you create portfolios in the currency you're in.
export default function PortfolioModal({ currency, onClose, onSaved }) {
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Podaj nazwę portfela.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { id } = await createPortfolio({ name: name.trim(), currency });
      onSaved(id);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>Nowy portfel — {currency}</h3>
        <div className="field">
          <label>Nazwa (np. IKE, IKZE, Broker XYZ)</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Waluta</label>
          <input value={currency} disabled />
          <div className="hint">Waluta pochodzi z aktywnej zakładki.</div>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Tworzenie…" : "Utwórz portfel"}
          </button>
        </div>
      </form>
    </div>
  );
}
