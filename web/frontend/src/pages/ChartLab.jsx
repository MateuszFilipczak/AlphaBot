import { Link } from "react-router-dom";
import { addMonths } from "../budget.js";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 13: simpler loan model — monthly obligation (installment) + how many
// installments remain (counts down from end_month). No bank balance tracking.
// 4 proposals; some optionally show a progress bar if a total count is given.

const NOW = "2026-07";
const zl = (v) => (v ?? 0).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });
const fmtMY = (m) => { const [y, mo] = m.split("-"); return `${mo}.${y}`; };

// ratLeft = installments remaining as of NOW; totalRat = original count (opt.)
const LOANS = [
  { name: "Kredyt Hipoteczny (Pekao)", installment: 3275.39, ratLeft: 122, totalRat: 132 },
  { name: "Kredyt Samochodowy (Revolut)", installment: 2793.92, ratLeft: 2, totalRat: 6 },
  { name: "Kredyt Gotówkowy (Revolut)", installment: 311.14, ratLeft: 10, totalRat: 12 },
  { name: "KKOP (Teściowa)", installment: 2000, ratLeft: 10, totalRat: 20 },
];
const VIEWS = LOANS.map((l) => ({
  ...l,
  end: addMonths(NOW, l.ratLeft - 1),
  toPay: l.installment * l.ratLeft,
  pct: l.totalRat ? Math.round(((l.totalRat - l.ratLeft) / l.totalRat) * 100) : null,
}));
const C = "#5b6cff";
const monthly = VIEWS.reduce((a, l) => a + l.installment, 0);
const Bar = ({ pct }) => <div className="kl-bar"><span style={{ width: `${pct}%`, background: C }} /></div>;

function Topline() {
  return (
    <div className="kl-topline">
      <div><span className="muted">Miesięczne zobowiązania z kredytów</span><b>{zl(monthly)}</b></div>
    </div>
  );
}

// L1 · Minimalny — tylko rata + ile rat do końca
function L1() {
  return (
    <div className="kl-rows">
      {VIEWS.map((l) => (
        <div className="kl-row l1" key={l.name}>
          <div className="kl-row-name"><b>{l.name}</b></div>
          <div className="kl-l1-mid muted">{l.ratLeft} rat do końca · do {fmtMY(l.end)}</div>
          <div className="kl-row-vals"><b>{zl(l.installment)}</b><span className="muted">/mies.</span></div>
        </div>
      ))}
    </div>
  );
}

// L2 · Z paskiem odliczania (gdy podano łączną liczbę rat)
function L2() {
  return (
    <div className="kl-rows">
      {VIEWS.map((l) => (
        <div className="kl-row" key={l.name}>
          <div className="kl-row-name"><b>{l.name}</b><span className="muted">do {fmtMY(l.end)}</span></div>
          <div className="kl-row-bar">
            <Bar pct={l.pct ?? 0} />
            <span className="muted">{l.totalRat ? `${l.totalRat - l.ratLeft}/${l.totalRat} rat · ${l.pct}%` : `${l.ratLeft} rat do końca`}</span>
          </div>
          <div className="kl-row-vals"><b>{zl(l.installment)}</b><span className="muted">/mies.</span></div>
        </div>
      ))}
    </div>
  );
}

// L3 · Kafelek zobowiązania (rata na pierwszym planie)
function L3() {
  return (
    <div className="kl-cards">
      {VIEWS.map((l) => (
        <div className="kl-card l3" key={l.name}>
          <div className="kl-l3-info">
            <b>{l.name}</b>
            <span className="muted">zostało {l.ratLeft} rat · do {fmtMY(l.end)}</span>
            <span className="muted">łącznie do końca ≈ {zl(l.toPay)}</span>
          </div>
          <div className="kl-l3-rata">
            <b>{zl(l.installment)}</b>
            <span className="muted">/ mies.</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// L4 · Widok budżetowy — nacisk na sumę zobowiązań, cienkie wiersze
function L4() {
  return (
    <div className="kl-l4">
      <div className="kl-l4-sum">
        <span className="muted">Suma rat w tym miesiącu</span>
        <b>{zl(monthly)}</b>
      </div>
      {VIEWS.map((l) => (
        <div className="kl-l4-row" key={l.name}>
          <span className="kl-l4-name">{l.name}</span>
          <span className="muted">{l.ratLeft} rat → {fmtMY(l.end)}</span>
          <b>{zl(l.installment)}</b>
        </div>
      ))}
    </div>
  );
}

function LabCard({ title, desc, children }) {
  return (
    <div className="lab-card lab-card-wide">
      <h3>{title}</h3>
      <p className="lab-desc">{desc}</p>
      <div className="kl-stage"><Topline />{children}</div>
    </div>
  );
}

export default function ChartLab() {
  return (
    <div className="app lab">
      <Link className="back" to="/">← Wróć do aplikacji</Link>
      <h1>
        Laboratorium — runda 13{" "}
        <span className="instr-name">kredyty: zobowiązanie + liczba rat do końca · 4 propozycje</span>
      </h1>
      <p className="note">
        Prostszy model: podajesz ratę i ile rat zostało (liczba odlicza się co miesiąc, bez łączenia
        z bankiem). Bez śledzenia salda. Pasek postępu tylko tam, gdzie podasz łączną liczbę rat.
      </p>
      <LabCard title="L1 · Minimalny" desc="Tylko rata i „X rat do końca (do MM.RRRR)”. Bez paska, bez salda. Najczystsze — czyste zobowiązanie miesięczne.">
        <L1 />
      </LabCard>
      <LabCard title="L2 · Z paskiem odliczania" desc="Rata + pasek postępu z liczby rat (jeśli podasz łączną liczbę). Widać jak daleko jesteś, ale wciąż bez salda z odsetkami.">
        <L2 />
      </LabCard>
      <LabCard title="L3 · Kafelek zobowiązania" desc="Rata na pierwszym planie, obok „zostało X rat” i „łącznie do końca ≈ rata × rat”. Nacisk na miesięczny koszt.">
        <L3 />
      </LabCard>
      <LabCard title="L4 · Widok budżetowy" desc="Na górze suma rat (to, co realnie obciąża budżet), pod spodem cienkie wiersze: rata + rat do końca. Najbardziej „budżetowe”.">
        <L4 />
      </LabCard>
    </div>
  );
}
