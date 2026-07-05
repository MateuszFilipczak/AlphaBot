import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AreaSeries, BaselineSeries, LineSeries, LineStyle, createChart } from "lightweight-charts";
import { getHistory, getSummary } from "../api.js";
import { fmtMoney, fmtPct, pnlClass } from "../format.js";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 5: portfolio-value chart styles + "open positions value" hero layouts.
// Fed with real data. Not linked from the UI: /lab?p=17&range=1y

const C = {
  surface: "#1a1a19",
  grid: "#2c2c2a",
  axis: "#383835",
  muted: "#898781",
  accent: "#3987e5",
  up: "#0ca30c",
  down: "#d03b3b",
};

// portfolio value is a reconstructed DAILY series — no intraday, so ranges
// start at "1 tydzień" (5 sesji); otherwise same labels as the stock chart
const RANGES = [
  ["5d", "1T"],
  ["1mo", "1M"],
  ["3mo", "3M"],
  ["6mo", "6M"],
  ["1y", "1R"],
  ["5y", "5L"],
  ["max", "MAX"],
];

const ALLOC = ["#3987e5", "#0ca30c", "#c98500", "#9b59b6", "#e0553b", "#16a3a3", "#7a8b3a"];

const BASE_OPTS = {
  autoSize: true,
  layout: { background: { color: C.surface }, textColor: C.muted, attributionLogo: false },
  grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
  rightPriceScale: { borderColor: C.axis },
  timeScale: { borderColor: C.axis },
  crosshair: {
    vertLine: { color: C.muted, labelBackgroundColor: C.axis },
    horzLine: { visible: false, labelVisible: false },
  },
};

// ---- Portfolio value chart, four styles -------------------------------------
function PVChart({ points, variant }) {
  const boxRef = useRef(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !points || points.length < 2) return;
    const chart = createChart(el, BASE_OPTS);
    const last = points[points.length - 1];
    const up = last.value >= last.deposited;

    if (variant === "profit") {
      // net profit over time (value − contributed): baseline at 0, green up
      const s = chart.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: 0 },
        topLineColor: C.up,
        topFillColor1: "rgba(12, 163, 12, 0.30)",
        topFillColor2: "rgba(12, 163, 12, 0.02)",
        bottomLineColor: C.down,
        bottomFillColor1: "rgba(208, 59, 59, 0.02)",
        bottomFillColor2: "rgba(208, 59, 59, 0.30)",
        lineWidth: 2,
      });
      s.setData(points.map((p) => ({ time: p.date, value: p.value - p.deposited })));
    } else if (variant === "band") {
      // contributed capital as a filled floor; the accent band above it = profit
      const dep = chart.addSeries(AreaSeries, {
        lineColor: C.muted,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        topColor: "rgba(137, 135, 129, 0.16)",
        bottomColor: "rgba(137, 135, 129, 0.02)",
        crosshairMarkerVisible: false,
      });
      dep.setData(points.map((p) => ({ time: p.date, value: p.deposited })));
      const val = chart.addSeries(AreaSeries, {
        lineColor: C.accent,
        lineWidth: 2,
        topColor: "rgba(57, 135, 229, 0.30)",
        bottomColor: "rgba(57, 135, 229, 0.03)",
      });
      val.setData(points.map((p) => ({ time: p.date, value: p.value })));
    } else {
      const color = variant === "outcome" ? (up ? C.up : C.down) : C.accent;
      const rgb = variant === "outcome" ? (up ? "12, 163, 12" : "208, 59, 59") : "57, 135, 229";
      const val = chart.addSeries(AreaSeries, {
        lineColor: color,
        lineWidth: 2,
        topColor: `rgba(${rgb}, 0.34)`,
        bottomColor: `rgba(${rgb}, 0.02)`,
        lastValueVisible: true,
      });
      val.setData(points.map((p) => ({ time: p.date, value: p.value })));
      if (variant === "gradient") {
        const dep = chart.addSeries(LineSeries, {
          color: C.muted,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        dep.setData(points.map((p) => ({ time: p.date, value: p.deposited })));
      }
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, variant]);
  return <div className="lab-box" ref={boxRef} />;
}

// ---- Sparkline (SVG) for the hero -------------------------------------------
function Sparkline({ series, up, w = 240, h = 60 }) {
  if (!series || series.length < 2) return null;
  const vals = series.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pts = series.map((p, i) => [
    (i / (series.length - 1)) * w,
    h - ((p.value - min) / span) * (h - 8) - 4,
  ]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const col = up ? C.up : C.down;
  const id = up ? "spark-up" : "spark-down";
  return (
    <svg width={w} height={h} className="spark">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.35" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L ${w} ${h} L 0 ${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={col} strokeWidth="2" />
    </svg>
  );
}

// allocation segments of open positions (by portfolio-currency value)
function allocation(summary) {
  const total = summary.positions_value || 0;
  const segs = [...summary.positions]
    .filter((p) => p.value_pc > 0)
    .sort((a, b) => b.value_pc - a.value_pc)
    .map((p, i) => ({
      ticker: p.ticker,
      value: p.value_pc,
      pct: total > 0 ? (p.value_pc / total) * 100 : 0,
      color: ALLOC[i % ALLOC.length],
    }));
  return { segs, total };
}

function HeroFrame({ title, desc, children }) {
  return (
    <div className="lab-card">
      <h3>{title}</h3>
      <p className="lab-desc">{desc}</p>
      {children}
    </div>
  );
}

export default function ChartLab() {
  const [params] = useSearchParams();
  const pid = params.get("p");
  const [range, setRange] = useState(params.get("range") ?? "1y");
  const [points, setPoints] = useState(null);
  const [summary, setSummary] = useState(null);
  const [spark, setSpark] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!pid) return setError("Podaj portfel: /lab?p=<id>");
    getHistory(pid, range).then((d) => setPoints(d.points)).catch((e) => setError(e.message));
  }, [pid, range]);

  useEffect(() => {
    if (!pid) return;
    getSummary(pid).then(setSummary).catch((e) => setError(e.message));
    // a stable sparkline for the hero, independent of the chart's range
    getHistory(pid, "3mo").then((d) => setSpark(d.points)).catch(() => setSpark([]));
  }, [pid]);

  if (error) return <div className="app"><div className="empty">{error}</div></div>;
  if (!points || !summary) return <div className="app"><div className="loading">Ładowanie laboratorium…</div></div>;

  const cur = summary.portfolio.currency;
  const pv = summary.positions_value;
  const unreal = summary.unrealized_pnl;
  const investedOpen = pv - unreal; // cost basis of open positions
  const unrealPct = investedOpen > 0 ? (unreal / investedOpen) * 100 : 0;
  const up = unreal >= 0;
  const { segs } = allocation(summary);
  const ring = segs.length
    ? (() => {
        let acc = 0;
        const stops = segs.map((s) => {
          const from = (acc / pv) * 360;
          acc += s.value;
          const to = (acc / pv) * 360;
          return `${s.color} ${from.toFixed(1)}deg ${to.toFixed(1)}deg`;
        });
        return `conic-gradient(${stops.join(", ")})`;
      })()
    : "none";

  const Delta = () => (
    <span className={`hero-delta ${pnlClass(unreal)}`}>
      {fmtMoney(unreal, cur, { sign: true })} ({fmtPct(unrealPct)})
    </span>
  );

  return (
    <div className="app lab">
      <Link className="back" to={pid ? `/?p=${pid}` : "/"}>← Wróć do aplikacji</Link>
      <h1>
        Laboratorium — runda 5{" "}
        <span className="instr-name">portfel #{pid} · {cur} · wykres wartości + ekspozycja pozycji</span>
      </h1>

      {/* ---- Section 1: portfolio value chart ---- */}
      <div className="section-head">
        <h2>Wykres wartości portfela — 4 style</h2>
        <div className="seg" role="group" aria-label="Zakres">
          {RANGES.map(([v, l]) => (
            <button key={v} className={range === v ? "active" : ""} onClick={() => setRange(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {points.length < 2 ? (
        <div className="empty">Za mało danych w tym zakresie.</div>
      ) : (
        <div className="lab-grid">
          <HeroFrame title="W1 · Gradient + linia wpłat" desc="Miękki niebieski gradient wartości i przerywana linia wpłaconego kapitału — luka między nimi to zysk.">
            <PVChart points={points} variant="gradient" />
          </HeroFrame>
          <HeroFrame title="W2 · Kolor wyniku" desc="Cały obszar zielony, gdy wartość jest nad wpłatami, czerwony gdy pod — natychmiastowy sygnał, bez czytania liczb.">
            <PVChart points={points} variant="outcome" />
          </HeroFrame>
          <HeroFrame title="W3 · Wstęga zysku" desc="Wpłacony kapitał jako wypełniona podłoga; niebieskie pasmo ponad nią to narastający zysk.">
            <PVChart points={points} variant="band" />
          </HeroFrame>
          <HeroFrame title="W4 · Sam zysk (od zera)" desc="Wartość minus wpłaty — linia bazowa na zerze, nad nią zielono, pod nią czerwono. Pokazuje wyłącznie wynik.">
            <PVChart points={points} variant="profit" />
          </HeroFrame>
        </div>
      )}

      {/* ---- Section 2: open positions value hero ---- */}
      <h2 style={{ marginTop: 30 }}>Ekspozycja „Wartość otwartych pozycji" nad kafelkami — 4 układy</h2>
      <div className="lab-grid">
        <HeroFrame title="H1 · Liczba + sparkline" desc="Duża kwota, kolorowa zmiana niezrealizowana i miniwykres trendu wartości z 3 miesięcy.">
          <div className="hero hero-spark">
            <div>
              <div className="hero-label">Wartość otwartych pozycji</div>
              <div className="hero-value">{fmtMoney(pv, cur)}</div>
              <Delta />
            </div>
            <Sparkline series={spark} up={up} />
          </div>
        </HeroFrame>

        <HeroFrame title="H2 · Pasek alokacji" desc="Kwota nad poziomym paskiem udziału pozycji — od razu widać, co waży najwięcej w portfelu.">
          <div className="hero">
            <div className="hero-label">Wartość otwartych pozycji</div>
            <div className="hero-row">
              <span className="hero-value">{fmtMoney(pv, cur)}</span>
              <Delta />
            </div>
            <div className="alloc-bar">
              {segs.map((s) => (
                <span key={s.ticker} className="alloc-seg" style={{ width: `${s.pct}%`, background: s.color }} title={`${s.ticker} ${s.pct.toFixed(1)}%`} />
              ))}
            </div>
            <div className="alloc-legend">
              {segs.map((s) => (
                <span key={s.ticker}><i style={{ background: s.color }} />{s.ticker} {s.pct.toFixed(0)}%</span>
              ))}
            </div>
          </div>
        </HeroFrame>

        <HeroFrame title="H3 · Pierścień alokacji" desc="Kwota w środku pierścienia udziału pozycji — najbardziej dashboardowy akcent.">
          <div className="hero hero-ring">
            <div className="ring" style={{ background: ring }}>
              <div className="ring-hole">
                <div className="hero-value sm">{fmtMoney(pv, cur)}</div>
                <Delta />
              </div>
            </div>
            <div className="alloc-legend col">
              {segs.map((s) => (
                <span key={s.ticker}><i style={{ background: s.color }} />{s.ticker} {s.pct.toFixed(0)}%</span>
              ))}
            </div>
          </div>
        </HeroFrame>

        <HeroFrame title="H4 · Karta premium" desc="Wyróżniona karta z gradientem, dużą kwotą, zmianą i chipami największych pozycji.">
          <div className="hero hero-premium">
            <div className="hero-label">Wartość otwartych pozycji</div>
            <div className="hero-value xl">{fmtMoney(pv, cur)}</div>
            <Delta />
            <div className="chip-row">
              {segs.slice(0, 5).map((s) => (
                <span key={s.ticker} className="pos-chip" style={{ borderColor: s.color }}>
                  <i style={{ background: s.color }} />{s.ticker}
                  <b>{fmtMoney(s.value, cur)}</b>
                </span>
              ))}
            </div>
          </div>
        </HeroFrame>
      </div>

      <p className="note">
        Zakres wykresu działa jak w widoku akcji (wartość portfela jest dzienna, więc od 1T w górę).
        Parametry: <code>/lab?p=…&range=…</code>
      </p>
    </div>
  );
}
