import { Link } from "react-router-dom";
import { addMonths, loanState } from "../budget.js";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 11: loans view proposals for the Budżet module. 4 alternative layouts
// on the user's real loans. Current view = topline summary + detail cards.

const NOW = "2026-07";
const zl = (v) => (v ?? 0).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });

const LOANS = [
  { name: "Kredyt Hipoteczny (Pekao)", principal: 299317.91, installment: 3275.39, installments_count: 122, start_month: "2026-07" },
  { name: "Kredyt Samochodowy (Revolut)", principal: 5587.84, installment: 2793.92, installments_count: 2, start_month: "2026-07" },
  { name: "Kredyt Gotówkowy (Revolut)", principal: 3000, installment: 311.14, installments_count: 10, start_month: "2026-06" },
  { name: "KKOP (Teściowa)", principal: 20000, installment: 2000, installments_count: 10, start_month: "2026-05" },
];
const VIEWS = LOANS.map((l) => ({ ...l, s: loanState(l, NOW), end: addMonths(l.start_month, l.installments_count - 1) }));
const C = "#5b6cff";

function Ring({ pct, size = 54 }) {
  return (
    <div className="kl-ring" style={{ width: size, height: size, background: `conic-gradient(${C} ${pct * 3.6}deg, var(--surface-2) 0)` }}>
      <div className="kl-ring-hole">{Math.round(pct)}%</div>
    </div>
  );
}
const Bar = ({ pct }) => <div className="kl-bar"><span style={{ width: `${pct}%`, background: C }} /></div>;

function Topline() {
  const debt = VIEWS.reduce((a, l) => a + l.s.remaining, 0);
  const monthly = VIEWS.reduce((a, l) => a + l.installment, 0);
  return (
    <div className="kl-topline">
      <div><span className="muted">Zadłużenie łącznie</span><b className="pnl-down">{zl(debt)}</b></div>
      <div><span className="muted">Raty miesięcznie</span><b>{zl(monthly)}</b></div>
    </div>
  );
}

// K1 · Zwarte wiersze (table-like)
function K1() {
  return (
    <div className="kl-rows">
      {VIEWS.map((l) => (
        <div className="kl-row" key={l.name}>
          <div className="kl-row-name"><b>{l.name}</b><span className="muted">do {l.end}</span></div>
          <div className="kl-row-bar"><Bar pct={l.s.pct} /><span className="muted">{l.s.paidCount}/{l.installments_count} rat</span></div>
          <div className="kl-row-vals"><b>{zl(l.installment)}</b><span className="muted">zostało {zl(l.s.remaining)}</span></div>
        </div>
      ))}
    </div>
  );
}

// K2 · Karty z pierścieniem postępu
function K2() {
  return (
    <div className="kl-cards">
      {VIEWS.map((l) => (
        <div className="kl-card" key={l.name}>
          <Ring pct={l.s.pct} />
          <div className="kl-card-info">
            <b>{l.name}</b>
            <span className="muted">rata {zl(l.installment)} · zostało {l.s.left} rat</span>
            <span>{zl(l.s.remaining)} <small className="muted">do spłaty · do {l.end}</small></span>
          </div>
        </div>
      ))}
    </div>
  );
}

// K3 · Oś czasu spłaty
function K3() {
  return (
    <div className="kl-tl">
      {VIEWS.map((l) => (
        <div className="kl-tl-row" key={l.name}>
          <div className="kl-tl-head"><b>{l.name}</b><span className="muted">{l.start_month} → {l.end}</span></div>
          <div className="kl-tl-track">
            <span className="kl-tl-done" style={{ width: `${l.s.pct}%` }} />
            <span className="kl-tl-now" style={{ left: `${l.s.pct}%` }} />
          </div>
          <div className="kl-tl-foot muted">spłacono {l.s.paidCount} z {l.installments_count} rat · zostało {zl(l.s.remaining)}</div>
        </div>
      ))}
    </div>
  );
}

// K4 · Duże karty z naciskiem na „zostało"
function K4() {
  return (
    <div className="kl-big">
      {VIEWS.map((l) => (
        <div className="kl-big-card" key={l.name}>
          <div className="kl-big-top">
            <b>{l.name}</b>
            <span className="muted">{l.s.paidCount}/{l.installments_count} rat · koniec {l.end}</span>
          </div>
          <div className="kl-big-remaining"><span className="muted">Zostało do spłaty</span><b>{zl(l.s.remaining)}</b></div>
          <Bar pct={l.s.pct} />
          <div className="kl-big-grid">
            <span><small className="muted">Rata</small>{zl(l.installment)}</span>
            <span><small className="muted">Spłacono</small>{zl(l.s.paid)}</span>
            <span><small className="muted">Zostało rat</small>{l.s.left}</span>
          </div>
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
        Laboratorium — runda 11{" "}
        <span className="instr-name">widok kredytów · 4 propozycje · Twoje realne kredyty</span>
      </h1>
      <p className="note">
        Podsumowanie (zadłużenie / raty) zostaje u góry każdej propozycji. Poniżej różne sposoby
        pokazania samych kredytów.
      </p>
      <LabCard title="K1 · Zwarte wiersze" desc="Każdy kredyt jako jeden wiersz: nazwa, pasek postępu z liczbą rat, rata i ile zostało. Najbardziej zwarte — dużo kredytów mieści się na raz.">
        <K1 />
      </LabCard>
      <LabCard title="K2 · Karty z pierścieniem" desc="Kafelki z kołowym wskaźnikiem postępu (% spłaty) i skrótem informacji. Wizualne, dobre gdy kredytów jest kilka.">
        <K2 />
      </LabCard>
      <LabCard title="K3 · Oś czasu spłaty" desc="Poziomy pasek od startu do końca ze znacznikiem teraz. Kładzie nacisk na to, kiedy kredyt się skończy.">
        <K3 />
      </LabCard>
      <LabCard title="K4 · Duże karty (zostało)" desc="Bliskie obecnemu, ale z wyeksponowaną kwotą zostało do spłaty i paskiem. Najbardziej szczegółowe.">
        <K4 />
      </LabCard>
    </div>
  );
}
