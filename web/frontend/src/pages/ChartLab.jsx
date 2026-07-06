import { Link } from "react-router-dom";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 10b: arrange ONLY the four mid panels (Przychody / Wydatki / Dodatkowe
// / Rozliczenie) relative to each other. Summary tiles, struktura and kredyty
// stay put above/below. Panel internals use the production classes unchanged.

const LOANS_COLOR = "#5b6cff";

function IncomePanel() {
  return (
    <div className="bud-panel">
      <div className="panel-head"><h4>Przychody stałe</h4><button className="btn small">+ Źródło</button></div>
      <div className="bud-row"><span>Wypłata</span><b className="pnl-up">20 223 zł</b></div>
      <div className="bud-row"><span>Koszt uzyskania</span><b className="pnl-up">1 221 zł</b></div>
      <div className="bud-row total"><span>Razem</span><b className="pnl-up">21 444 zł</b></div>
    </div>
  );
}
function ExpensePanel() {
  const rows = [["Czynsz", "#3b82f6", "929 zł"], ["Prąd", "#06b6d4", "200 zł"],
    ["Telefon i Internet", "#06b6d4", "135 zł"], ["YouTube Premium", "#ec4899", "60 zł"],
    ["Microsoft", "#ec4899", "30 zł"], ["Apple", "#ec4899", "15 zł"]];
  const loans = [["Hipoteczny", "3 275 zł"], ["Samochodowy", "2 794 zł"], ["Gotówkowy", "311 zł"], ["KKOP", "2 000 zł"]];
  return (
    <div className="bud-panel">
      <div className="panel-head"><h4>Wydatki stałe</h4><button className="btn small">+ Wydatek</button></div>
      {rows.map(([n, c, v]) => (
        <div className="bud-row" key={n}><span><i className="cat-dot" style={{ background: c }} />{n}</span><b>{v}</b></div>
      ))}
      {loans.map(([n, v]) => (
        <div className="bud-row muted-row" key={n}><span><i className="cat-dot" style={{ background: LOANS_COLOR }} />{n}<small>rata kredytu</small></span><b>{v}</b></div>
      ))}
      <div className="bud-row total"><span>Razem</span><b className="pnl-down">9 800 zł</b></div>
    </div>
  );
}
function ExtraPanel() {
  return (
    <div className="bud-panel">
      <div className="panel-head"><h4>Dodatkowe w tym miesiącu</h4><button className="btn small">+ Wydatek jednorazowy</button></div>
      <div className="bud-row"><span><i className="cat-dot" style={{ background: "#f59e0b" }} />Ubezpieczenie auta<small>Transport</small></span><b>1 200 zł</b></div>
      <div className="bud-row total"><span>Razem</span><b className="pnl-down">−1 200 zł</b></div>
    </div>
  );
}
function SettlePanel() {
  return (
    <div className="bud-panel">
      <h4>Rozliczenie z żoną — lipiec 2026</h4>
      <div className="bud-row"><span>Kredyt hipoteczny<small>z 3 275 zł</small></span><b className="accent">1 500 zł</b></div>
      <div className="bud-row"><span>Czynsz<small>z 929 zł</small></span><b className="accent">460 zł</b></div>
      <div className="bud-row total"><span>Żona ma oddać</span><b className="accent">1 960 zł</b></div>
      <div className="split-note muted">Twój udział w wydatkach: 7 840 zł (z 9 800 zł)</div>
    </div>
  );
}

function Fixed({ label }) {
  return <div className="arr-fixed">{label} <span>(zostaje bez zmian)</span></div>;
}

function LabCard({ title, desc, children }) {
  return (
    <div className="lab-card lab-card-wide">
      <h3>{title}</h3>
      <p className="lab-desc">{desc}</p>
      <div className="lb-stage">
        <Fixed label="▏ Kafelki podsumowania + Struktura wydatków" />
        {children}
        <Fixed label="▏ Kredyty" />
      </div>
    </div>
  );
}

export default function ChartLab() {
  return (
    <div className="app lab">
      <Link className="back" to="/">← Wróć do aplikacji</Link>
      <h1>
        Laboratorium — runda 10{" "}
        <span className="instr-name">układ 4 paneli budżetu · wnętrze bez zmian</span>
      </h1>
      <p className="note">
        Podsumowanie, struktura wydatków i kredyty zostają na swoich miejscach. Poniżej propozycje,
        jak ułożyć tylko te cztery panele między sobą, żeby krótki panel Przychodów się nie rozciągał.
      </p>

      <LabCard
        title="A1 · Mozaika — krótkie w lewej kolumnie"
        desc="Lewa kolumna: Przychody + Rozliczenie + Dodatkowe jeden pod drugim. Prawa: wysokie Wydatki. Nic się nie rozciąga, wysokości się równoważą."
      >
        <div className="arr-bento">
          <div className="arr-col"><IncomePanel /><SettlePanel /><ExtraPanel /></div>
          <div className="arr-col"><ExpensePanel /></div>
        </div>
      </LabCard>

      <LabCard
        title="A2 · Siatka 2×2"
        desc="Przychody | Wydatki w górnym rzędzie, Dodatkowe | Rozliczenie w dolnym. Każdy panel dopasowany do treści (bez rozciągania w pionie)."
      >
        <div className="arr-grid">
          <IncomePanel /><ExpensePanel />
          <ExtraPanel /><SettlePanel />
        </div>
      </LabCard>

      <LabCard
        title="A3 · Wydatki szeroko + reszta w słupku"
        desc="Wydatki zajmują szeroką kolumnę, a trzy krótkie panele (Przychody, Dodatkowe, Rozliczenie) układają się w węższej kolumnie obok."
      >
        <div className="arr-mainside">
          <div className="arr-col"><ExpensePanel /></div>
          <div className="arr-col"><IncomePanel /><ExtraPanel /><SettlePanel /></div>
        </div>
      </LabCard>
    </div>
  );
}
