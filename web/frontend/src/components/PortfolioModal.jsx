import { useState } from "react";
import { createPortfolio } from "../api.js";

const CURRENCIES = ["USD", "EUR", "PLN", "GBP"];

export default function PortfolioModal({ onClose, onSaved }) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("PLN");
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
        <h3>Nowy portfel</h3>
        <div className="field">
          <label>Nazwa (np. PLN (IKE))</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Waluta</label>
          <div className="type-toggle">
            {CURRENCIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`buy ${currency === c ? "active" : ""}`}
                onClick={() => setCurrency(c)}
              >
                {c}
              </button>
            ))}
          </div>
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
