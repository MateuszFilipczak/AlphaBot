import { Link } from "react-router-dom";
import { MODULES, ModuleIcon } from "../components/ModuleNav.jsx";

// Entry page (/): the AlphaBot wordmark centred over three module tiles.
// Fixed module order Budżet · Giełda · Krypto (same as the nav bar).
export default function Landing() {
  return (
    <div className="landing">
      <div className="landing-inner">
        <h1 className="landing-brand">Alpha<span>Bot</span></h1>
        <p className="landing-sub">Wybierz moduł</p>
        <div className="landing-tiles">
          {MODULES.map((m) => (
            <Link key={m.key} to={m.to} className="landing-tile" style={{ "--mod": m.accent }}>
              <span className="landing-ic"><ModuleIcon kind={m.icon} /></span>
              <b>{m.label}</b>
              <span className="landing-hint">{m.hint}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
