import { Link } from "react-router-dom";
import { fmtMoney } from "../format.js";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 9: Budżet module tracker — 4 full-width layout proposals on sample
// data (income, fixed expenses, loans with installments + payoff dates).

const zl = (v) => fmtMoney(v, "PLN");
const NOW = { y: 2026, m: 7 }; // "dziś" dla wyliczeń kredytów

const INCOME = [
  { name: "Wypłata", amount: 8000, note: "co miesiąc" },
  { name: "Inne wpływy", amount: 600, note: "freelance" },
];

// fixed monthly expenses that are NOT loan installments
const EXPENSES = [
  { name: "Prąd", amount: 250, cat: "media" },
  { name: "Gaz", amount: 120, cat: "media" },
  { name: "Internet + TV", amount: 90, cat: "media" },
  { name: "Telefon", amount: 60, cat: "media" },
  { name: "Ubezpieczenia", amount: 180, cat: "inne" },
  { name: "Subskrypcje", amount: 110, cat: "inne" },
];

const LOANS = [
  { name: "Kredyt hipoteczny", principal: 350000, installment: 2100, count: 360, start: { y: 2021, m: 6 }, color: "#3987e5" },
  { name: "Kredyt samochodowy", principal: 60000, installment: 1200, count: 48, start: { y: 2024, m: 1 }, color: "#c98500" },
  { name: "RTV/AGD (raty 0%)", principal: 6000, installment: 500, count: 12, start: { y: 2026, m: 1 }, color: "#0ca30c" },
];

const monthsBetween = (a, b) => (b.y - a.y) * 12 + (b.m - a.m);
const addMonths = ({ y, m }, n) => {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
};
const fmtMY = ({ y, m }) => `${String(m).padStart(2, "0")}.${y}`;

function loanState(loan) {
  const elapsed = Math.max(0, Math.min(loan.count, monthsBetween(loan.start, NOW)));
  const left = loan.count - elapsed;
  const total = loan.count * loan.installment;   // łączna kwota do spłaty
  const paid = elapsed * loan.installment;
  const remaining = total - paid;
  const pct = (elapsed / loan.count) * 100;
  return { elapsed, left, total, paid, remaining, pct, end: addMonths(loan.start, loan.count) };
}

const sum = (arr, k) => arr.reduce((a, x) => a + (k ? x[k] : x), 0);
const totalIncome = sum(INCOME, "amount");
const totalInstallments = sum(LOANS, "installment");
const totalFixed = sum(EXPENSES, "amount");
const totalExpenses = totalFixed + totalInstallments;
const leftover = totalIncome - totalExpenses;
const savingsRate = Math.round((leftover / totalIncome) * 100);

function Bar({ pct, color = "var(--accent)" }) {
  return <div className="bud-bar"><span style={{ width: `${pct}%`, background: color }} /></div>;
}

function Ring({ pct, color }) {
  return (
    <div className="bud-ring" style={{ background: `conic-gradient(${color} ${pct * 3.6}deg, var(--surface-2) 0)` }}>
      <div className="bud-ring-hole">{Math.round(pct)}%</div>
    </div>
  );
}

function Card({ title, desc, children }) {
  return (
    <div className="lab-card lab-card-wide">
      <h3>{title}</h3>
      <p className="lab-desc">{desc}</p>
      <div className="bud-stage">{children}</div>
    </div>
  );
}

// V1 · Klasyczny bilans miesięczny
function V1() {
  return (
    <>
      <div className="bud-summary">
        <div className="bud-num"><span className="lbl">Przychody</span><span className="val up">{zl(totalIncome)}</span></div>
        <div className="bud-num"><span className="lbl">Wydatki</span><span className="val down">{zl(totalExpenses)}</span></div>
        <div className="bud-num"><span className="lbl">Zostaje</span><span className="val accent">{zl(leftover)}</span></div>
      </div>
      <div className="bud-cols">
        <div className="bud-panel">
          <h4>Przychody</h4>
          {INCOME.map((i) => (
            <div className="bud-row" key={i.name}><span>{i.name} <small>{i.note}</small></span><b className="up">{zl(i.amount)}</b></div>
          ))}
        </div>
        <div className="bud-panel">
          <h4>Wydatki stałe</h4>
          {EXPENSES.map((e) => (
            <div className="bud-row" key={e.name}><span>{e.name}</span><b>{zl(e.amount)}</b></div>
          ))}
          {LOANS.map((l) => (
            <div className="bud-row" key={l.name}><span>{l.name} <small>rata</small></span><b>{zl(l.installment)}</b></div>
          ))}
        </div>
      </div>
      <div className="bud-panel">
        <h4>Kredyty</h4>
        {LOANS.map((l) => {
          const s = loanState(l);
          return (
            <div className="loan-row" key={l.name}>
              <div className="loan-head"><b>{l.name}</b><span className="muted">{zl(l.installment)}/mc · do {fmtMY(s.end)} · zostało {s.left} rat</span></div>
              <Bar pct={s.pct} color={l.color} />
              <div className="loan-foot muted">spłacono {zl(s.paid)} z {zl(s.total)} · zostało {zl(s.remaining)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// V2 · Dashboard kafelkowy
function V2() {
  const catTotals = { media: 0, inne: 0, raty: totalInstallments };
  EXPENSES.forEach((e) => { catTotals[e.cat] += e.amount; });
  const catColors = { raty: "#3987e5", media: "#c98500", inne: "#9b59b6" };
  return (
    <>
      <div className="bud-tiles">
        <div className="bud-tile"><span className="lbl">Przychody</span><b className="up">{zl(totalIncome)}</b></div>
        <div className="bud-tile"><span className="lbl">Wydatki</span><b className="down">{zl(totalExpenses)}</b></div>
        <div className="bud-tile"><span className="lbl">Zostaje</span><b className="accent">{zl(leftover)}</b></div>
        <div className="bud-tile"><span className="lbl">Stopa oszczędności</span><b>{savingsRate}%</b></div>
      </div>
      <div className="bud-panel">
        <h4>Struktura wydatków</h4>
        <div className="stack-bar">
          {Object.entries(catTotals).map(([k, v]) => (
            <span key={k} style={{ width: `${(v / totalExpenses) * 100}%`, background: catColors[k] }} title={`${k} ${zl(v)}`} />
          ))}
        </div>
        <div className="stack-legend">
          {Object.entries(catTotals).map(([k, v]) => (
            <span key={k}><i style={{ background: catColors[k] }} />{k === "raty" ? "Raty kredytów" : k} {zl(v)}</span>
          ))}
        </div>
      </div>
      <div className="loan-cards">
        {LOANS.map((l) => {
          const s = loanState(l);
          return (
            <div className="loan-card" key={l.name}>
              <Ring pct={s.pct} color={l.color} />
              <div className="loan-card-info">
                <b>{l.name}</b>
                <span className="muted">rata {zl(l.installment)}</span>
                <span className="muted">zostało {s.left} rat · do {fmtMY(s.end)}</span>
                <span>{zl(s.remaining)} <small className="muted">do spłaty</small></span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// V3 · Przepływ (cashflow) — pasek dochodu zjadany przez wydatki
function V3() {
  const segs = [
    { name: "Raty kredytów", amount: totalInstallments, color: "#3987e5" },
    { name: "Media", amount: sum(EXPENSES.filter((e) => e.cat === "media"), "amount"), color: "#c98500" },
    { name: "Inne", amount: sum(EXPENSES.filter((e) => e.cat === "inne"), "amount"), color: "#9b59b6" },
  ];
  return (
    <>
      <div className="flow-head">
        <span className="muted">Z każdych {zl(totalIncome)} przychodu zostaje</span>
        <b className="accent">{zl(leftover)}</b>
      </div>
      <div className="flow-bar">
        {segs.map((s) => (
          <span key={s.name} className="flow-seg" style={{ width: `${(s.amount / totalIncome) * 100}%`, background: s.color }} title={`${s.name} ${zl(s.amount)}`} />
        ))}
        <span className="flow-seg rest" style={{ width: `${(leftover / totalIncome) * 100}%` }}>Zostaje</span>
      </div>
      <div className="flow-legend">
        {segs.map((s) => (<span key={s.name}><i style={{ background: s.color }} />{s.name} {zl(s.amount)}</span>))}
      </div>
      <div className="bud-panel">
        <h4>Kredyty — postęp spłaty</h4>
        {LOANS.map((l) => {
          const s = loanState(l);
          return (
            <div className="tl-row" key={l.name}>
              <span className="tl-name">{l.name}</span>
              <div className="tl-track"><span style={{ width: `${s.pct}%`, background: l.color }} /></div>
              <span className="tl-end muted">{fmtMY(NOW)} → {fmtMY(s.end)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// V4 · Kredyty w centrum
function V4() {
  const totalDebt = sum(LOANS.map(loanState).map((s) => s.remaining));
  return (
    <>
      <div className="bud-summary">
        <div className="bud-num"><span className="lbl">Zadłużenie łącznie</span><span className="val down">{zl(totalDebt)}</span></div>
        <div className="bud-num"><span className="lbl">Raty miesięcznie</span><span className="val">{zl(totalInstallments)}</span></div>
        <div className="bud-num"><span className="lbl">Wolne po ratach</span><span className="val accent">{zl(leftover)}</span></div>
      </div>
      <div className="loan-detail-list">
        {LOANS.map((l) => {
          const s = loanState(l);
          return (
            <div className="loan-detail" key={l.name}>
              <div className="ld-top">
                <b>{l.name}</b>
                <span className="muted">{s.elapsed}/{l.count} rat · koniec {fmtMY(s.end)}</span>
              </div>
              <Bar pct={s.pct} color={l.color} />
              <div className="ld-grid">
                <span><small className="muted">Rata</small>{zl(l.installment)}</span>
                <span><small className="muted">Spłacono</small>{zl(s.paid)}</span>
                <span><small className="muted">Zostało</small>{zl(s.remaining)}</span>
                <span><small className="muted">Zostało rat</small>{s.left}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function ChartLab() {
  return (
    <div className="app lab">
      <Link className="back" to="/">← Wróć do aplikacji</Link>
      <h1>
        Laboratorium — runda 9{" "}
        <span className="instr-name">moduł Budżet · tracker · 4 propozycje układu (dane przykładowe)</span>
      </h1>
      <p className="note">
        Przychody, wydatki stałe i kredyty (rata, liczba rat, termin spłaty) na przykładowych danych.
        Wybierz układ, który Ci pasuje — na jego bazie zbudujemy realny moduł.
      </p>
      <div className="lab-grid budget-lab">
        <Card title="V1 · Klasyczny bilans" desc="Przychody vs wydatki, poniżej lista kredytów z paskiem postępu, ratą, terminem i liczbą pozostałych rat. Czytelne jak wyciąg.">
          <V1 />
        </Card>
        <Card title="V2 · Dashboard kafelkowy" desc="Kafelki (przychody / wydatki / zostaje / stopa oszczędności), struktura wydatków i kredyty jako karty z pierścieniem postępu.">
          <V2 />
        </Card>
        <Card title="V3 · Przepływ pieniędzy" desc="Jeden pasek: przychód zjadany przez kategorie wydatków, zielona reszta to wolne środki. Kredyty jako oś czasu spłaty.">
          <V3 />
        </Card>
        <Card title="V4 · Kredyty w centrum" desc="Nacisk na dług: łączne zadłużenie, suma rat, a każdy kredyt jako szczegółowa karta (rata, spłacono, zostało, harmonogram).">
          <V4 />
        </Card>
      </div>
    </div>
  );
}
