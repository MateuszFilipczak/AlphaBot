import { useLocation, useNavigate } from "react-router-dom";

// Top-level modules. Giełda is the working app (root routes); the others are
// placeholders for now. `match` decides which one is active for a given path;
// `hint`/`accent` drive the module-identity strip under the bar.
export const MODULES = [
  { key: "budget", label: "Budżet", to: "/budzet", icon: "wallet",
    hint: "Budżet domowy", accent: "#0ca30c",
    match: (p) => p.startsWith("/budzet") },
  { key: "stocks", label: "Giełda", to: "/", icon: "chart",
    hint: "Akcje i ETF-y", accent: "#3987e5",
    match: (p) => p === "/" || p.startsWith("/position") },
  { key: "crypto", label: "Krypto", to: "/krypto", icon: "coin",
    hint: "Kryptowaluty", accent: "#c98500",
    match: (p) => p.startsWith("/krypto") },
];

function Icon({ kind }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (kind) {
    case "wallet":
      return <svg width="15" height="15" viewBox="0 0 20 20"><g {...p}><rect x="2.5" y="4.5" width="15" height="11" rx="2" /><path d="M2.5 8h15" /><circle cx="14" cy="11.5" r="1.1" fill="currentColor" stroke="none" /></g></svg>;
    case "chart":
      return <svg width="15" height="15" viewBox="0 0 20 20"><g {...p}><path d="M3 16V4M3 16h14" /><path d="M6 13l3-3 2.5 2.5L16 6" /></g></svg>;
    case "coin":
      return <svg width="15" height="15" viewBox="0 0 20 20"><g {...p}><circle cx="10" cy="10" r="7" /><path d="M8 6.5h3a1.8 1.8 0 0 1 0 3.5H8m0 0h3.3a1.8 1.8 0 0 1 0 3.6H8M8 5v10" /></g></svg>;
    default:
      return null;
  }
}

// Shared app bar: brand + module switcher (V1 — top segmented) with a module-
// identity strip under it (accent icon · name · hint). Rendered atop every
// module so the navigation is consistent everywhere.
export default function ModuleBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = MODULES.find((m) => m.match(pathname)) ?? MODULES[1];
  return (
    <>
      <div className="appbar">
        <a className="brand" href="/">Alpha<span>Bot</span></a>
        <nav className="mod-seg" aria-label="Moduły">
          {MODULES.map((m) => (
            <button
              key={m.key}
              className={m.match(pathname) ? "on" : ""}
              onClick={() => navigate(m.to)}
            >
              <Icon kind={m.icon} /> {m.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="mod-ident">
        <span className="mod-ident-ic" style={{ color: active.accent }}>
          <Icon kind={active.icon} />
        </span>
        <b>{active.label}</b>
        <span className="mod-ident-sub">{active.hint}</span>
      </div>
    </>
  );
}
