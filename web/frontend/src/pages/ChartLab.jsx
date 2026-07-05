import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 7: portfolio switcher UX with many portfolios (limit 10/currency).
// Four interactive mockups on sample data. Not linked from the UI.

const SAMPLE = [
  { id: 1, name: "Główny - XTB", value: "12 340 zł", pnl: "+854 zł", up: true },
  { id: 2, name: "IKE", value: "8 210 zł", pnl: "+1 120 zł", up: true },
  { id: 3, name: "IKZE", value: "5 430 zł", pnl: "−230 zł", up: false },
  { id: 4, name: "Emerytura", value: "22 900 zł", pnl: "+3 410 zł", up: true },
  { id: 5, name: "Dywidendowy", value: "9 750 zł", pnl: "+540 zł", up: true },
  { id: 6, name: "Spekulacyjny", value: "3 120 zł", pnl: "−870 zł", up: false },
  { id: 7, name: "ETF świat", value: "14 060 zł", pnl: "+2 030 zł", up: true },
  { id: 8, name: "Obligacje", value: "6 500 zł", pnl: "+90 zł", up: true },
];

function useClickAway(onAway) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && onAway();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onAway]);
  return ref;
}

function LabCard({ title, desc, children }) {
  return (
    <div className="lab-card">
      <h3>{title}</h3>
      <p className="lab-desc">{desc}</p>
      <div className="sw-stage">{children}</div>
    </div>
  );
}

// V1 · Plain dropdown — one control lists every portfolio + "new"
function VariantDropdown({ items, active, setActive, onNew }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const cur = items.find((p) => p.id === active);
  return (
    <div className="sw-drop" ref={ref}>
      <button className="sw-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{cur?.name}</span>
        <span className="sw-caret">▾</span>
      </button>
      {open && (
        <div className="menu-pop sw-menu">
          {items.map((p) => (
            <button key={p.id} className={p.id === active ? "on" : ""} onClick={() => { setActive(p.id); setOpen(false); }}>
              {p.id === active ? "✓ " : ""}{p.name}
            </button>
          ))}
          <div className="sw-sep" />
          <button className="sw-new" onClick={() => { onNew(); setOpen(false); }}>+ Nowy portfel</button>
        </div>
      )}
    </div>
  );
}

// V2 · Tabs + overflow — first few as tabs, the rest behind "+N ▾"
function VariantOverflow({ items, active, setActive, onNew }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const SHOWN = 3;
  // keep the active portfolio visible even if it's in the overflow bucket
  let head = items.slice(0, SHOWN);
  let rest = items.slice(SHOWN);
  if (!head.some((p) => p.id === active)) {
    const a = items.find((p) => p.id === active);
    if (a) { head = [...items.slice(0, SHOWN - 1), a]; rest = items.filter((p) => !head.includes(p)); }
  }
  return (
    <div className="sw-tabs" ref={ref}>
      {head.map((p) => (
        <button key={p.id} className={`sw-tab ${p.id === active ? "on" : ""}`} onClick={() => setActive(p.id)}>
          {p.name}
        </button>
      ))}
      {rest.length > 0 && (
        <div className="sw-more">
          <button className="sw-tab more" onClick={() => setOpen((o) => !o)}>+{rest.length} ▾</button>
          {open && (
            <div className="menu-pop sw-menu">
              {rest.map((p) => (
                <button key={p.id} onClick={() => { setActive(p.id); setOpen(false); }}>{p.name}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <button className="sw-tab new" onClick={onNew}>+ Nowy</button>
    </div>
  );
}

// V3 · Rich dropdown — each row shows value + P&L
function VariantRich({ items, active, setActive, onNew }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const cur = items.find((p) => p.id === active);
  return (
    <div className="sw-drop wide" ref={ref}>
      <button className="sw-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{cur?.name}</span>
        <span className={`sw-mini ${cur?.up ? "up" : "down"}`}>{cur?.pnl}</span>
        <span className="sw-caret">▾</span>
      </button>
      {open && (
        <div className="menu-pop sw-menu rich">
          {items.map((p) => (
            <button key={p.id} className={p.id === active ? "on" : ""} onClick={() => { setActive(p.id); setOpen(false); }}>
              <span className="sw-rname">{p.name}</span>
              <span className="sw-rval">{p.value}</span>
              <span className={`sw-mini ${p.up ? "up" : "down"}`}>{p.pnl}</span>
            </button>
          ))}
          <div className="sw-sep" />
          <button className="sw-new" onClick={() => { onNew(); setOpen(false); }}>+ Nowy portfel</button>
        </div>
      )}
    </div>
  );
}

// V4 · Scrollable pills — one row, horizontal scroll with fade edges
function VariantPills({ items, active, setActive, onNew }) {
  return (
    <div className="sw-pillbar">
      <div className="sw-pills">
        {items.map((p) => (
          <button key={p.id} className={`sw-pill ${p.id === active ? "on" : ""}`} onClick={() => setActive(p.id)}>
            {p.name}
          </button>
        ))}
        <button className="sw-pill new" onClick={onNew}>+ Nowy</button>
      </div>
    </div>
  );
}

export default function ChartLab() {
  const [count, setCount] = useState(8); // how many sample portfolios to show
  const [active, setActive] = useState(1);
  const [note, setNote] = useState(null);
  const items = SAMPLE.slice(0, count);
  const onNew = () => setNote("Kliknięto: + Nowy portfel");
  const pass = { items, active, setActive: (id) => { setActive(id); setNote(null); }, onNew };

  return (
    <div className="app lab">
      <Link className="back" to="/">← Wróć do aplikacji</Link>
      <h1>
        Laboratorium — runda 7{" "}
        <span className="instr-name">przełącznik portfeli · limit 10/walutę · 4 propozycje</span>
      </h1>
      <p className="note">
        Obecnie portfele danej waluty to taby obok siebie — przy 10 zaczną się rozjeżdżać.
        Ustaw liczbę portfeli i sprawdź, jak każdy wariant to znosi. Kliknij, aby przełączyć.
      </p>
      <div className="section-head" style={{ marginBottom: 8 }}>
        <span className="chart-title">Liczba portfeli do podglądu:</span>
        <div className="seg">
          {[3, 6, 8, 10].map((n) => (
            <button key={n} className={count === n ? "active" : ""} onClick={() => setActive((a) => Math.min(a, n)) || setCount(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="lab-grid">
        <LabCard title="V1 · Rozwijane menu" desc="Jeden przycisk z nazwą aktywnego portfela; lista wszystkich + „Nowy portfel”. Kompaktowe, skaluje się do 10 bez rozjeżdżania.">
          <VariantDropdown {...pass} />
        </LabCard>
        <LabCard title="V2 · Taby + nadmiar" desc="Pierwsze 3 jako taby (szybki dostęp), reszta pod „+N ▾”. Aktywny zawsze widoczny. Kompromis: znane taby, ale bez rozlewania.">
          <VariantOverflow {...pass} />
        </LabCard>
        <LabCard title="V3 · Menu z wartościami" desc="Rozwijane, ale każdy wiersz pokazuje wartość i wynik portfela — od razu widać, który jak stoi, bez wchodzenia.">
          <VariantRich {...pass} />
        </LabCard>
        <LabCard title="V4 · Przewijane piguły" desc="Najmniejsza zmiana: taby zostają, ale w jednym rzędzie z poziomym przewijaniem i wygaszaniem krawędzi.">
          <VariantPills {...pass} />
        </LabCard>
      </div>

      <div className={`act-picked ${note ? "show" : ""}`}>
        {note ?? <>Aktywny portfel: <b>{items.find((p) => p.id === active)?.name}</b></>}
      </div>
    </div>
  );
}
