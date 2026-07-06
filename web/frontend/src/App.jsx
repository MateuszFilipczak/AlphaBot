import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { deletePortfolio, getPortfolios, getSummary, renamePortfolio } from "./api.js";
import { fmtMoney, pnlClass } from "./format.js";
import TransactionModal from "./components/TransactionModal.jsx";
import DepositModal from "./components/DepositModal.jsx";
import PortfolioModal from "./components/PortfolioModal.jsx";
import ConfirmModal from "./components/ConfirmModal.jsx";
import RowMenu from "./components/RowMenu.jsx";
import ModuleBar from "./components/ModuleNav.jsx";
import { useXtbImport } from "./components/ImportModal.jsx";

// closes a dropdown on outside click or Escape while it's open
function useDismissable(open, close) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);
}

// Portfolio switcher: one dropdown listing the current currency's portfolios
// (+ "Nowy portfel"). Replaces side-by-side tabs so up to 10 stay tidy; the
// active portfolio's rename/delete menu lives next to it (in App).
function PortfolioSwitcher({ portfolios, activeId, onSelect, onNew }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismissable(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = portfolios.find((p) => p.id === activeId) ?? portfolios[0];
  return (
    <div className="sw-drop" ref={ref}>
      <button className="sw-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{active?.name}</span>
        <span className="sw-caret">▾</span>
      </button>
      {open && (
        <div className="menu-pop sw-menu">
          {portfolios.map((p) => (
            <button
              key={p.id}
              className={p.id === activeId ? "on" : ""}
              onClick={() => { onSelect(p.id); setOpen(false); }}
            >
              {p.id === activeId ? "✓ " : ""}{p.name}
            </button>
          ))}
          <div className="sw-sep" />
          <button className="sw-new" onClick={() => { onNew(); setOpen(false); }}>
            + Nowy portfel
          </button>
        </div>
      )}
    </div>
  );
}

// Split action button: primary "+ Transakcja" one click, caret opens the rest
// (Wpłata / Wypłata / Import). Menu closes on outside click or Escape.
function AddActions({ onTransaction, onDeposit, onWithdraw, onImport, importing }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismissable(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (fn) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="split-wrap" ref={ref}>
      <button className="btn primary split-main" onClick={onTransaction}>
        + Transakcja
      </button>
      <button
        className="btn primary split-caret"
        aria-label="Więcej akcji"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ▾
      </button>
      {open && (
        <div className="menu-pop act-menu">
          <button onClick={pick(onDeposit)}>+ Wpłata</button>
          <button onClick={pick(onWithdraw)}>− Wypłata</button>
          <button onClick={pick(onImport)} disabled={importing}>
            {importing ? "Wczytywanie…" : "Import z XTB (xlsx)"}
          </button>
        </div>
      )}
    </div>
  );
}

// Fixed top-level currency tabs — always visible. GBP appears only when a
// GBP portfolio actually exists.
const FIXED_CURRENCIES = ["USD", "EUR", "PLN"];

// Shared app context: active portfolio (kept in the URL via ?p=), modal
// openers, and a refresh tick that bumps after every successful write so
// views refetch without a page reload.
const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// Rename-portfolio modal (name only — the currency is fixed).
function RenameModal({ portfolio, onClose, onSaved }) {
  const [name, setName] = useState(portfolio.name);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Podaj nazwę.");
    setSaving(true);
    setError(null);
    try {
      await renamePortfolio(portfolio.id, name.trim());
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>Zmień nazwę portfela</h3>
        <div className="field">
          <label>Nazwa</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Anuluj</button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Zapisywanie…" : "Zapisz"}
          </button>
        </div>
      </form>
    </div>
  );
}

// "Łącznie: wartość X · zysk Y" over the portfolio tabs — aggregated across
// every portfolio of the active currency.
function CurrencyTotals({ portfolios, currency, refreshTick }) {
  const [totals, setTotals] = useState(null);

  useEffect(() => {
    if (portfolios.length === 0) {
      setTotals(null);
      return;
    }
    let cancelled = false;
    Promise.all(portfolios.map((p) => getSummary(p.id)))
      .then((summaries) => {
        if (cancelled) return;
        setTotals({
          value: summaries.reduce((acc, s) => acc + s.cash + s.positions_value, 0),
          pnl: summaries.reduce((acc, s) => acc + s.total_pnl, 0),
        });
      })
      .catch(() => !cancelled && setTotals(null));
    return () => {
      cancelled = true;
    };
  }, [portfolios.map((p) => p.id).join(","), refreshTick]);

  if (!totals) return null;
  return (
    <span className="agg-line">
      Łącznie: wartość <b>{fmtMoney(totals.value, currency)}</b> ·{" "}
      <span className={pnlClass(totals.pnl)}>
        zysk {fmtMoney(totals.pnl, currency, { sign: true })}
      </span>
    </span>
  );
}

export default function App() {
  const [portfolios, setPortfolios] = useState(null); // null = loading
  const [searchParams] = useSearchParams();
  const [txModal, setTxModal] = useState(null); // null | {ticker?, type?, edit?}
  const [cashModal, setCashModal] = useState(null); // null | "deposit" | "withdraw"
  const [portfolioModal, setPortfolioModal] = useState(false);
  const [renameModal, setRenameModal] = useState(null); // portfolio being renamed
  const [deleteModal, setDeleteModal] = useState(null); // portfolio pending delete
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const navigate = useNavigate();

  const bumpRefresh = () => setRefreshTick((t) => t + 1);
  const loadPortfolios = () => getPortfolios().then(setPortfolios).catch(console.error);
  // refreshTick in deps: every write (deposit, transaction…) refreshes the
  // txn/deposit counts too — the delete flow depends on them being current
  useEffect(() => {
    loadPortfolios();
  }, [refreshTick]);

  const all = portfolios ?? [];
  const byId = (id) => all.find((p) => p.id === id) ?? null;
  const urlPortfolio = byId(Number(searchParams.get("p")));

  // active currency: from the selected portfolio, else ?c=, else USD
  const activeCurrency =
    urlPortfolio?.currency ?? searchParams.get("c") ?? "USD";
  const currencyPortfolios = all.filter((p) => p.currency === activeCurrency);
  // no valid ?p → fall back to the currency's first portfolio (if any)
  const portfolio = urlPortfolio ?? currencyPortfolios[0] ?? null;
  const portfolioId = portfolio?.id ?? null;

  // XTB import wired into the header's split-button menu (see AddActions)
  const xtb = useXtbImport({ portfolio, onImported: bumpRefresh });

  const currencies = [
    ...FIXED_CURRENCIES,
    ...(all.some((p) => p.currency === "GBP") ? ["GBP"] : []),
  ];

  const selectCurrency = (cur) => {
    const list = all.filter((p) => p.currency === cur);
    // a single-portfolio currency opens that portfolio right away; several →
    // its first one; none → the currency's empty state
    navigate(list.length > 0 ? `/?p=${list[0].id}` : `/?c=${cur}`);
  };

  const confirmDeletePortfolio = async () => {
    // read counts from the CURRENT list, not the (possibly stale) modal object
    const target = byId(deleteModal.id) ?? deleteModal;
    const hasData = target.txn_count + target.deposit_count > 0;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePortfolio(target.id, hasData);
      setDeleteModal(null);
      const fresh = await getPortfolios();
      setPortfolios(fresh);
      // switch to another portfolio of this currency, else its empty state
      const sibling = fresh.find(
        (p) => p.currency === target.currency && p.id !== target.id
      );
      navigate(sibling ? `/?p=${sibling.id}` : `/?c=${target.currency}`);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const ctx = useMemo(
    () => ({
      portfolios: all,
      portfolio,
      portfolioId,
      refreshTick,
      openTransaction: (defaults = {}) => setTxModal(defaults),
      openDeposit: () => setCashModal("deposit"),
      openWithdraw: () => setCashModal("withdraw"),
      refresh: () => setRefreshTick((t) => t + 1),
    }),
    [all, portfolio, portfolioId, refreshTick]
  );

  if (portfolios === null) {
    return <div className="app"><div className="loading">Ładowanie…</div></div>;
  }

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <ModuleBar />
        <header className="topbar">
          <nav className="switcher" aria-label="Waluta">
            {currencies.map((cur) => (
              <button
                key={cur}
                className={cur === activeCurrency ? "active" : ""}
                onClick={() => selectCurrency(cur)}
              >
                {cur}
              </button>
            ))}
          </nav>
          {portfolio && (
            <div className="actions">
              <AddActions
                onTransaction={() => setTxModal({})}
                onDeposit={() => setCashModal("deposit")}
                onWithdraw={() => setCashModal("withdraw")}
                onImport={xtb.pickFile}
                importing={xtb.uploading}
              />
            </div>
          )}
        </header>

        <div className="portfolio-row">
          <CurrencyTotals
            portfolios={currencyPortfolios}
            currency={activeCurrency}
            refreshTick={refreshTick}
          />
          {currencyPortfolios.length > 0 && (
            <nav className="pswitch" aria-label="Portfele">
              <PortfolioSwitcher
                portfolios={currencyPortfolios}
                activeId={portfolioId}
                onSelect={(id) => navigate(`/?p=${id}`)}
                onNew={() => setPortfolioModal(true)}
              />
              {portfolio && currencyPortfolios.some((p) => p.id === portfolioId) && (
                <RowMenu
                  label="Menu portfela"
                  items={[
                    { label: "Zmień nazwę", onClick: () => setRenameModal(portfolio) },
                    {
                      label: "Usuń portfel",
                      danger: true,
                      onClick: () => {
                        setDeleteError(null);
                        setDeleteModal(portfolio);
                      },
                    },
                  ]}
                />
              )}
            </nav>
          )}
        </div>

        {portfolio ? (
          <Outlet />
        ) : (
          <div className="empty-currency">
            <p>Brak portfeli w {activeCurrency}</p>
            <button className="btn primary" onClick={() => setPortfolioModal(true)}>
              Utwórz pierwszy portfel
            </button>
          </div>
        )}

        {txModal !== null && portfolio && (
          <TransactionModal
            portfolio={portfolio}
            defaults={txModal}
            onClose={() => setTxModal(null)}
            onSaved={() => {
              setTxModal(null);
              ctx.refresh();
            }}
          />
        )}
        {portfolioModal && (
          <PortfolioModal
            currency={activeCurrency}
            onClose={() => setPortfolioModal(false)}
            onSaved={async (id) => {
              setPortfolioModal(false);
              await loadPortfolios();
              navigate(`/?p=${id}`);
            }}
          />
        )}
        {renameModal && (
          <RenameModal
            portfolio={renameModal}
            onClose={() => setRenameModal(null)}
            onSaved={async () => {
              setRenameModal(null);
              await loadPortfolios();
            }}
          />
        )}
        {deleteModal && (() => {
          const target = byId(deleteModal.id) ?? deleteModal;
          return (
          <ConfirmModal
            title={`Usunąć portfel „${target.name}”?`}
            body={
              target.txn_count + target.deposit_count > 0
                ? `Portfel zawiera ${target.txn_count} transakcji i ${target.deposit_count} wpłat/wypłat. Usunięcie skasuje je bezpowrotnie. Kontynuować?`
                : `Portfel „${target.name}” jest pusty i zostanie usunięty.`
            }
            confirmLabel="Usuń portfel"
            error={deleteError}
            busy={deleting}
            onConfirm={confirmDeletePortfolio}
            onClose={() => setDeleteModal(null)}
          />
          );
        })()}
        {cashModal && portfolio && (
          <DepositModal
            portfolio={portfolio}
            mode={cashModal}
            onClose={() => setCashModal(null)}
            onSaved={() => {
              setCashModal(null);
              ctx.refresh();
            }}
          />
        )}
        {portfolio && xtb.overlay}
      </div>
    </AppCtx.Provider>
  );
}
