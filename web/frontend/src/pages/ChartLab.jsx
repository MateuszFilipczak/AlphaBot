import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 8: top-level module navigation (Budżet / Giełda / Krypto) — 4 nav-bar
// mockups, each shown wrapping a stub app shell. Not linked from the UI.

const MODULES = [
  { key: "budget", label: "Budżet", hint: "Budżet domowy", icon: "wallet", accent: "#0ca30c" },
  { key: "stocks", label: "Giełda", hint: "Akcje i ETF-y", icon: "chart", accent: "#3987e5" },
  { key: "crypto", label: "Krypto", hint: "Kryptowaluty", icon: "coin", accent: "#c98500" },
];

function Icon({ kind, size = 18 }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (kind) {
    case "wallet":
      return <svg width={size} height={size} viewBox="0 0 20 20"><g {...p}><rect x="2.5" y="4.5" width="15" height="11" rx="2" /><path d="M2.5 8h15" /><circle cx="14" cy="11.5" r="1.1" fill="currentColor" stroke="none" /></g></svg>;
    case "chart":
      return <svg width={size} height={size} viewBox="0 0 20 20"><g {...p}><path d="M3 16V4M3 16h14" /><path d="M6 13l3-3 2.5 2.5L16 6" /></g></svg>;
    case "coin":
      return <svg width={size} height={size} viewBox="0 0 20 20"><g {...p}><circle cx="10" cy="10" r="7" /><path d="M8 6.5h3a1.8 1.8 0 0 1 0 3.5H8m0 0h3.3a1.8 1.8 0 0 1 0 3.6H8M8 5v10" /></g></svg>;
    default:
      return null;
  }
}

// stub content so each nav variant is shown in context, not in a vacuum
function Shell({ active }) {
  const m = MODULES.find((x) => x.key === active);
  return (
    <div className="shell-body">
      <div className="shell-h">
        <span className="shell-ic" style={{ color: m.accent }}><Icon kind={m.icon} /></span>
        <b>{m.label}</b>
        <span className="shell-sub">{m.hint}</span>
      </div>
      <div className="shell-tiles">
        <div className="shell-tile" /><div className="shell-tile" /><div className="shell-tile" />
      </div>
      <div className="shell-line" />
    </div>
  );
}

function LabCard({ title, desc, wide, children }) {
  return (
    <div className={`lab-card ${wide ? "lab-card-wide" : ""}`}>
      <h3>{title}</h3>
      <p className="lab-desc">{desc}</p>
      <div className="nav-stage">{children}</div>
    </div>
  );
}

// V1 · Top segmented bar next to the brand
function VariantTopSeg({ active, setActive }) {
  return (
    <div className="nv1">
      <div className="nv1-top">
        <span className="brand">Alpha<span>Bot</span></span>
        <div className="nv1-seg">
          {MODULES.map((m) => (
            <button key={m.key} className={active === m.key ? "on" : ""} onClick={() => setActive(m.key)}>
              <Icon kind={m.icon} size={15} /> {m.label}
            </button>
          ))}
        </div>
      </div>
      <Shell active={active} />
    </div>
  );
}

// V2 · Left icon sidebar (app-shell)
function VariantSidebar({ active, setActive }) {
  return (
    <div className="nv2">
      <nav className="nv2-rail">
        <span className="nv2-logo">A</span>
        {MODULES.map((m) => (
          <button
            key={m.key}
            className={active === m.key ? "on" : ""}
            style={active === m.key ? { color: m.accent } : undefined}
            onClick={() => setActive(m.key)}
            title={m.label}
          >
            <Icon kind={m.icon} size={20} />
            <span className="nv2-lbl">{m.label}</span>
          </button>
        ))}
      </nav>
      <div className="nv2-main"><Shell active={active} /></div>
    </div>
  );
}

// V3 · Underlined tabs, module accent follows the active one
function VariantUnderline({ active, setActive }) {
  const m = MODULES.find((x) => x.key === active);
  return (
    <div className="nv3" style={{ "--mod": m.accent }}>
      <div className="nv3-bar">
        <span className="brand">Alpha<span>Bot</span></span>
        <div className="nv3-tabs">
          {MODULES.map((x) => (
            <button key={x.key} className={active === x.key ? "on" : ""} onClick={() => setActive(x.key)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <Shell active={active} />
    </div>
  );
}

// V4 · Bottom nav (mobile-first)
function VariantBottom({ active, setActive }) {
  return (
    <div className="nv4">
      <div className="nv4-main"><Shell active={active} /></div>
      <nav className="nv4-bar">
        {MODULES.map((m) => (
          <button
            key={m.key}
            className={active === m.key ? "on" : ""}
            style={active === m.key ? { color: m.accent } : undefined}
            onClick={() => setActive(m.key)}
          >
            <Icon kind={m.icon} size={20} />
            <small>{m.label}</small>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function ChartLab() {
  const [active, setActive] = useState("stocks");
  return (
    <div className="app lab">
      <Link className="back" to="/">← Wróć do aplikacji</Link>
      <h1>
        Laboratorium — runda 8{" "}
        <span className="instr-name">nawigacja modułów: Budżet · Giełda · Krypto · 4 propozycje</span>
      </h1>
      <p className="note">
        Docelowo AlphaBot to kilka modułów. Poniżej propozycje paska nawigacji najwyższego poziomu —
        kliknij, aby przełączyć moduł; pod paskiem szkic zawartości reaguje na wybór.
      </p>

      <div className="lab-grid">
        <LabCard title="V1 · Górny pasek segmentowy" desc="Przełącznik obok logo, jak obecne waluty. Znajomy, kompaktowy; ikona + etykieta. Dobre dla 3–5 modułów.">
          <VariantTopSeg active={active} setActive={setActive} />
        </LabCard>
        <LabCard title="V2 · Boczny pasek ikon" desc="Stała szpula po lewej (app-shell). Skaluje się na wiele modułów, robi wrażenie „platformy”; zabiera trochę szerokości.">
          <VariantSidebar active={active} setActive={setActive} />
        </LabCard>
        <LabCard title="V3 · Zakładki z podkreśleniem" desc="Zakładki pod logo; akcent (kolor podkreślenia) zmienia się wraz z modułem — subtelny sygnał, gdzie jesteś.">
          <VariantUnderline active={active} setActive={setActive} />
        </LabCard>
        <LabCard title="V4 · Dolny pasek (mobile)" desc="Nawigacja na dole ekranu, jak w apkach mobilnych. Kciukowo wygodne na telefonie; na desktopie mniej typowe.">
          <VariantBottom active={active} setActive={setActive} />
        </LabCard>
      </div>

      <div className="act-picked show">
        Aktywny moduł: <b>{MODULES.find((m) => m.key === active)?.label}</b>
      </div>
    </div>
  );
}
