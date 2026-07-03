import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { getPortfolios } from "./api.js";
import TransactionModal from "./components/TransactionModal.jsx";
import DepositModal from "./components/DepositModal.jsx";

// Shared app context: active portfolio (kept in the URL via ?p=), modal
// openers, and a refresh tick that bumps after every successful write so
// views refetch without a page reload.
const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export default function App() {
  const [portfolios, setPortfolios] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [txModal, setTxModal] = useState(null); // null | {ticker?, type?, edit?}
  const [cashModal, setCashModal] = useState(null); // null | "deposit" | "withdraw"
  const [refreshTick, setRefreshTick] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    getPortfolios().then(setPortfolios).catch(console.error);
  }, []);

  const portfolioId = Number(searchParams.get("p")) || portfolios[0]?.id || null;
  const portfolio = portfolios.find((p) => p.id === portfolioId) ?? null;

  const ctx = useMemo(
    () => ({
      portfolios,
      portfolio,
      portfolioId,
      refreshTick,
      openTransaction: (defaults = {}) => setTxModal(defaults),
      openDeposit: () => setCashModal("deposit"),
      openWithdraw: () => setCashModal("withdraw"),
      refresh: () => setRefreshTick((t) => t + 1),
    }),
    [portfolios, portfolio, portfolioId, refreshTick]
  );

  const switchPortfolio = (id) => {
    // portfolio choice lives in the URL; changing it goes back to the dashboard
    navigate(`/?p=${id}`);
  };

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <a className="brand" href="/">
            Alpha<span>Bot</span>
          </a>
          <nav className="switcher" aria-label="Portfel">
            {portfolios.map((p) => (
              <button
                key={p.id}
                className={p.id === portfolioId ? "active" : ""}
                onClick={() => switchPortfolio(p.id)}
              >
                {p.name}
              </button>
            ))}
          </nav>
          <div className="actions">
            <button className="btn" onClick={() => setCashModal("deposit")}>
              + Wpłata
            </button>
            <button className="btn" onClick={() => setCashModal("withdraw")}>
              − Wypłata
            </button>
            <button className="btn primary" onClick={() => setTxModal({})}>
              + Transakcja
            </button>
          </div>
        </header>

        {portfolio ? <Outlet /> : <div className="loading">Ładowanie…</div>}

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
      </div>
    </AppCtx.Provider>
  );
}
