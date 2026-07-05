import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 6: consolidating the header actions (Wpłata / Wypłata / Transakcja /
// Import) into fewer controls — 4 interactive mockups. Not linked from the UI.

// action set shared by every proposal
const ACTIONS = [
  { key: "txn", label: "Transakcja", hint: "Kupno / sprzedaż", icon: "swap", primary: true },
  { key: "deposit", label: "Wpłata", hint: "Zasil portfel", icon: "plus" },
  { key: "withdraw", label: "Wypłata", hint: "Wypłać gotówkę", icon: "minus" },
  { key: "import", label: "Import z XTB", hint: "Wczytaj xlsx", icon: "upload" },
];

function Icon({ kind }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (kind) {
    case "swap":
      return <svg width="16" height="16" viewBox="0 0 16 16"><g {...p}><path d="M2 5h9M9 2.5 11.5 5 9 7.5" /><path d="M14 11H5M7 8.5 4.5 11 7 13.5" /></g></svg>;
    case "plus":
      return <svg width="16" height="16" viewBox="0 0 16 16"><g {...p}><path d="M8 3v10M3 8h10" /></g></svg>;
    case "minus":
      return <svg width="16" height="16" viewBox="0 0 16 16"><g {...p}><path d="M3 8h10" /></g></svg>;
    case "upload":
      return <svg width="16" height="16" viewBox="0 0 16 16"><g {...p}><path d="M8 10V3M5.5 5.5 8 3l2.5 2.5M3 12h10" /></g></svg>;
    default:
      return null;
  }
}

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
      <div className="action-stage">{children}</div>
    </div>
  );
}

// V1 · Split button — one-click primary action + caret for the rest
function VariantSplit({ onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const [primary, ...rest] = ACTIONS;
  return (
    <div className="split-wrap" ref={ref}>
      <button className="btn primary split-main" onClick={() => onPick(primary)}>
        <Icon kind={primary.icon} /> {primary.label}
      </button>
      <button className="btn primary split-caret" aria-label="Więcej" onClick={() => setOpen((o) => !o)}>
        ▾
      </button>
      {open && (
        <div className="menu-pop act-menu">
          {rest.map((a) => (
            <button key={a.key} onClick={() => { setOpen(false); onPick(a); }}>
              <Icon kind={a.icon} /> {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// V2 · Single dropdown — everything behind one "+ Dodaj ▾"
function VariantDropdown({ onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  return (
    <div className="split-wrap" ref={ref}>
      <button className="btn primary" onClick={() => setOpen((o) => !o)}>
        + Dodaj ▾
      </button>
      {open && (
        <div className="menu-pop act-menu wide">
          {ACTIONS.map((a) => (
            <button key={a.key} onClick={() => { setOpen(false); onPick(a); }}>
              <Icon kind={a.icon} />
              <span className="am-text">
                <b>{a.label}</b>
                <small>{a.hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// V3 · Speed-dial FAB — a round + that fans actions out (labels on hover)
function VariantFab({ onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  return (
    <div className="fab-wrap" ref={ref}>
      {open && (
        <div className="fab-items">
          {ACTIONS.map((a) => (
            <button key={a.key} className="fab-item" onClick={() => { setOpen(false); onPick(a); }}>
              <span className="fab-label">{a.label}</span>
              <span className="fab-mini"><Icon kind={a.icon} /></span>
            </button>
          ))}
        </div>
      )}
      <button className={`fab-main ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} aria-label="Dodaj">
        +
      </button>
    </div>
  );
}

// V4 · Icon popover — one + opening a grid of labelled action tiles
function VariantTiles({ onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  return (
    <div className="split-wrap" ref={ref}>
      <button className="btn primary" onClick={() => setOpen((o) => !o)}>
        + Nowa operacja
      </button>
      {open && (
        <div className="tile-pop">
          {ACTIONS.map((a) => (
            <button key={a.key} className="op-tile" onClick={() => { setOpen(false); onPick(a); }}>
              <span className={`op-ic op-${a.key}`}><Icon kind={a.icon} /></span>
              <b>{a.label}</b>
              <small>{a.hint}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChartLab() {
  const [picked, setPicked] = useState(null);
  const onPick = (a) => setPicked(a.label);

  return (
    <div className="app lab">
      <Link className="back" to="/">← Wróć do aplikacji</Link>
      <h1>
        Laboratorium — runda 6{" "}
        <span className="instr-name">spięcie przycisków akcji · 4 propozycje (klikalne)</span>
      </h1>
      <p className="note">
        Obecnie w nagłówku są 4 osobne przyciski: Importuj ▾ · + Wpłata · − Wypłata · + Transakcja.
        Poniżej propozycje, jak zwinąć je w jeden. Kliknij — na dole pokaże się wybrana akcja.
      </p>

      <div className="lab-grid">
        <LabCard
          title="V1 · Split — akcja + rozwijane"
          desc="Najczęstsza akcja (Transakcja) jednym kliknięciem; strzałka odsłania resztę. Kompromis: częste szybko, rzadkie o klik dalej."
        >
          <VariantSplit onPick={onPick} />
        </LabCard>
        <LabCard
          title="V2 · Jeden przycisk + Dodaj ▾"
          desc="Wszystko za jednym przyciskiem z rozwijaną listą (z podpowiedziami). Najbardziej zwięzłe; każda akcja to dwa kliknięcia."
        >
          <VariantDropdown onPick={onPick} />
        </LabCard>
        <LabCard
          title="V3 · FAB (pływający +)"
          desc="Okrągły + w rogu ekranu, rozwijający wachlarz akcji. Mobilny sznyt, nie zajmuje miejsca w nagłówku."
        >
          <VariantFab onPick={onPick} />
        </LabCard>
        <LabCard
          title="V4 · Kafelki akcji w popoverze"
          desc="Jeden przycisk otwiera panel z dużymi, opisanymi kafelkami. Najczytelniejsze, dobre gdy akcji może przybyć."
        >
          <VariantTiles onPick={onPick} />
        </LabCard>
      </div>

      <div className={`act-picked ${picked ? "show" : ""}`}>
        {picked ? <>Wybrano akcję: <b>{picked}</b></> : "Kliknij którąś propozycję…"}
      </div>
    </div>
  );
}
