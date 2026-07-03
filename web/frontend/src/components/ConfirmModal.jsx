export default function ConfirmModal({ title, body, confirmLabel = "Usuń", onConfirm, onClose, error, busy }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{title}</h3>
        <p style={{ margin: "0 0 4px", color: "var(--ink-2)" }}>{body}</p>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Anuluj
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Usuwanie…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
