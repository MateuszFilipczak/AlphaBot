import { useMemo, useRef, useState } from "react";
import { commitXtbImport, importXtbPreview } from "../api.js";
import { fmtDate, fmtMoney, fmtShares } from "../format.js";

const KIND_LABELS = {
  BUY: "Kupno",
  SELL: "Sprzedaż",
  DEPOSIT: "Wpłata",
  TRANSFER: "Przewalutowanie",
};

// "Importuj ▾" button for the portfolio header: a source menu (XTB for now),
// a hidden file input, and the preview modal. Nothing is persisted until the
// user confirms the selection in the preview.
export function ImportButton({ portfolio, onImported }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState(null); // parse result from the server
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const pickFile = () => {
    setMenuOpen(false);
    fileRef.current?.click();
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // same file can be re-picked later
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      setPreview(await importXtbPreview(portfolio.id, file));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <span className="import-wrap">
      <button className="btn" onClick={() => setMenuOpen((o) => !o)} disabled={uploading}>
        {uploading ? "Wczytywanie…" : "Importuj ▾"}
      </button>
      {menuOpen && (
        <>
          {/* click-away layer under the menu */}
          <div className="import-clickaway" onMouseDown={() => setMenuOpen(false)} />
          <div className="menu-pop import-menu">
            <button onClick={pickFile}>XTB (xlsx)</button>
          </div>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        style={{ display: "none" }}
        onChange={onFile}
      />
      {error && (
        <ErrorModal message={error} onClose={() => setError(null)} />
      )}
      {preview && (
        <ImportPreviewModal
          portfolio={portfolio}
          preview={preview}
          onClose={() => setPreview(null)}
          onImported={() => {
            setPreview(null);
            onImported();
          }}
        />
      )}
    </span>
  );
}

function ErrorModal({ message, onClose }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>Import nie powiódł się</h3>
        <div className="form-error">{message}</div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Zamknij</button>
        </div>
      </div>
    </div>
  );
}

// Preview table: every parsed operation with a checkbox (duplicates come
// unchecked and badged "już istnieje"), editable ticker when Yahoo doesn't
// know the mapped symbol, and row warnings from the amount validation.
function ImportPreviewModal({ portfolio, preview, onClose, onImported }) {
  const [rows, setRows] = useState(() =>
    preview.operations.map((op) => ({
      ...op,
      selected: !op.already_exists,
      ticker: op.ticker ?? "",
    }))
  );
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const selected = useMemo(() => rows.filter((r) => r.selected), [rows]);
  const allSelected = selected.length === rows.length && rows.length > 0;

  const setRow = (i, patch) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const toggleAll = () =>
    setRows((rs) => rs.map((r) => ({ ...r, selected: !allSelected })));

  const submit = async () => {
    const missingTicker = selected.find(
      (r) => (r.kind === "BUY" || r.kind === "SELL") && !r.ticker.trim()
    );
    if (missingTicker) {
      setError(`Uzupełnij ticker dla operacji ${KIND_LABELS[missingTicker.kind]} z ${fmtDate(missingTicker.date)}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await commitXtbImport(
        portfolio.id,
        selected.map((r) => ({
          kind: r.kind,
          ticker: r.ticker.trim() ? r.ticker.trim().toUpperCase() : null,
          date: r.date,
          shares: r.shares,
          price: r.price,
          amount: r.amount,
          external_id: r.external_id,
          note: r.note,
        }))
      );
      if (result.skipped_duplicates > 0) {
        // rare: rows turned duplicate between preview and commit
        console.info(`Import: pominięto ${result.skipped_duplicates} duplikatów`);
      }
      onImported();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <h3>Import z XTB — portfel {portfolio.name} ({portfolio.currency})</h3>

        {preview.warnings.map((w) => (
          <p key={w} className="note warn">⚠ {w}</p>
        ))}

        {rows.length === 0 ? (
          <p className="empty">Nie znaleziono operacji w pliku.</p>
        ) : (
          <div className="table-wrap import-scroll">
            <table className="import-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Zaznacz wszystkie"
                    />
                  </th>
                  <th>Typ</th>
                  <th>Ticker</th>
                  <th>Data</th>
                  <th>Ilość</th>
                  <th>Cena</th>
                  <th>Kwota</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.external_id ?? i} className={r.already_exists ? "row-muted" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.selected}
                        onChange={(e) => setRow(i, { selected: e.target.checked })}
                      />
                    </td>
                    <td className={`import-kind ${r.kind === "SELL" ? "pnl-down" : ""}`}>
                      {KIND_LABELS[r.kind] ?? r.kind}
                    </td>
                    <td>
                      {r.kind === "BUY" || r.kind === "SELL" ? (
                        r.ticker_verified ? (
                          <span className="ticker-cell">
                            {r.ticker}
                            {r.xtb_ticker && r.xtb_ticker !== r.ticker && (
                              <span className="instr-name">z {r.xtb_ticker}</span>
                            )}
                          </span>
                        ) : (
                          <input
                            className="ticker-fix"
                            value={r.ticker}
                            onChange={(e) => setRow(i, { ticker: e.target.value })}
                            placeholder={r.xtb_ticker}
                            title={`Nie znaleziono „${r.ticker}” w Yahoo — popraw ticker`}
                          />
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{fmtDate(r.date)}</td>
                    <td>{r.shares !== null ? fmtShares(r.shares) : "—"}</td>
                    <td>{r.price !== null ? fmtMoney(r.price, portfolio.currency) : "—"}</td>
                    <td>{fmtMoney(r.amount, portfolio.currency)}</td>
                    <td className="import-status">
                      {r.already_exists && <span className="badge">już istnieje</span>}
                      {!r.already_exists && r.ticker && !r.ticker_verified && (
                        <span className="badge warn" title="Ticker niezweryfikowany w Yahoo — możesz go poprawić">
                          nieznany ticker
                        </span>
                      )}
                      {r.warning && (
                        <span className="badge warn" title={r.warning}>⚠ kwota</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={saving}>Anuluj</button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={saving || selected.length === 0}
          >
            {saving ? "Importowanie…" : `Importuj zaznaczone (${selected.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
