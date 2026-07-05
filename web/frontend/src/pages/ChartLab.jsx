import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AreaSeries, LineSeries, LineStyle, createChart } from "lightweight-charts";
import { getChart, getPosition } from "../api.js";

// ---- Chart lab (/lab) --------------------------------------------------------
// Playground for chart styling proposals, fed with REAL data from the API.
// Round 2: variant A won — A plus three A-flavoured riffs, all with the app's
// transaction dots. Not linked from the UI: /lab?ticker=ORSTED.CO&p=17&range=1y

const C = {
  surface: "#1a1a19",
  grid: "#2c2c2a",
  axis: "#383835",
  muted: "#898781",
  accent: "#3987e5",
  up: "#0ca30c",
  down: "#d03b3b",
};

const BASE_OPTS = {
  autoSize: true,
  layout: { background: { color: C.surface }, textColor: C.muted, attributionLogo: false },
  grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
  rightPriceScale: { borderColor: C.axis },
  timeScale: { borderColor: C.axis, rightOffset: 4 },
  crosshair: {
    vertLine: { color: C.muted, labelBackgroundColor: C.axis },
    horzLine: { color: C.muted, labelBackgroundColor: C.axis },
  },
};

const dotClass = (m) =>
  m.type === "SELL" ? "dot-sell" : m.status === "open" ? "dot-open" : "dot-closed";

// One marker in the chosen visual style. Colour semantics across the new
// styles: buy green, sell red; a buy lot already closed by sells is dimmed.
function Marker({ d, style }) {
  const m = d.m;
  const buy = m.type === "BUY";
  const closed = m.status === "closed";
  const cls = `${buy ? "buy" : "sell"} ${closed ? "closed" : ""}`;
  const title = `${buy ? "Kupno" : "Sprzedaż"} ${m.shares} @ ${m.price} (${m.date})`;
  switch (style) {
    case "badges":
      return (
        <span className={`mk mk-badge ${cls}`} style={{ left: d.x, top: d.y }} title={title}>
          {buy ? "K" : "S"}
        </span>
      );
    case "arrows":
      return (
        <span
          className={`mk mk-arrow ${cls}`}
          style={{ left: d.x, top: buy ? d.y + 11 : d.y - 11 }}
          title={title}
        />
      );
    case "pins":
      return (
        <span
          className={`mk mk-pin ${cls} ${buy ? "below" : "above"}`}
          style={{ left: d.x, top: d.y }}
          title={title}
        />
      );
    case "pinarrows": // M3's stem + M2's directional arrowhead
      return (
        <span
          className={`mk mk-pinarrow ${cls} ${buy ? "below" : "above"}`}
          style={{ left: d.x, top: d.y }}
          title={title}
        />
      );
    case "rings":
      return <span className={`mk mk-ring ${cls}`} style={{ left: d.x, top: d.y }} title={title} />;
    default: // current app dots
      return <div className={`txn-dot ${dotClass(m)}`} style={{ left: d.x, top: d.y }} title={title} />;
  }
}

// One configurable "A-family" chart: gradient area + pulse dot + txn markers.
function AreaLab({ line, markers, markerStyle = "dots", avgCostLine = null, glow = false, outcome = false, tall = false }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [pulse, setPulse] = useState(null);
  const [dots, setDots] = useState([]);

  const up = line.length > 1 && line[line.length - 1].value >= line[0].value;
  const color = outcome ? (up ? C.up : C.down) : C.accent;
  const rgb = outcome ? (up ? "12, 163, 12" : "208, 59, 59") : "57, 135, 229";

  useEffect(() => {
    const el = boxRef.current;
    const chart = createChart(el, BASE_OPTS);
    if (glow) {
      // soft halo: a wide translucent copy of the line under the area
      const halo = chart.addSeries(LineSeries, {
        color: `rgba(${rgb}, 0.22)`,
        lineWidth: 4,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      halo.setData(line);
    }
    const series = chart.addSeries(AreaSeries, {
      lineColor: color,
      lineWidth: 2,
      topColor: `rgba(${rgb}, 0.34)`,
      bottomColor: `rgba(${rgb}, 0.02)`,
      priceLineVisible: true,
      crosshairMarkerRadius: 5,
    });
    series.setData(line);
    if (avgCostLine != null) {
      series.createPriceLine({
        price: avgCostLine,
        color: C.muted,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "śr. zakup",
      });
    }
    chart.timeScale().fitContent();
    chartRef.current = chart;
    seriesRef.current = series;

    const closeByTime = new Map(line.map((p) => [p.time, p.value]));
    const update = () => {
      const ts = chart.timeScale();
      const paneW = ts.width();
      const paneH = el.clientHeight - ts.height();
      // pulse on the last point
      const last = line[line.length - 1];
      const px = last ? ts.timeToCoordinate(last.time) : null;
      const py = last ? series.priceToCoordinate(last.value) : null;
      setPulse(px != null && py != null ? { x: px, y: py } : null);
      // transaction dots, same semantics as the real view: on the line,
      // same-day duplicates stack outward, clipped to the pane
      const stack = new Map();
      const next = [];
      for (const m of markers ?? []) {
        const v = closeByTime.get(m.time);
        if (v == null) continue;
        const x = ts.timeToCoordinate(m.time);
        if (x == null || x < 0 || x > paneW) continue;
        const y = series.priceToCoordinate(v);
        if (y == null) continue;
        const key = `${m.time}|${m.type}`;
        const n = stack.get(key) ?? 0;
        stack.set(key, n + 1);
        const yD = m.type === "BUY" ? y + n * 14 : y - n * 14;
        if (yD < 0 || yD > paneH) continue;
        next.push({ x, y: yD, m });
      }
      setDots(next);
    };
    update();
    const raf = requestAnimationFrame(update);
    chart.timeScale().subscribeVisibleLogicalRangeChange(update);
    return () => {
      cancelAnimationFrame(raf);
      chart.remove();
      setPulse(null);
      setDots([]);
    };
  }, [line, markers, avgCostLine, glow, outcome]);

  return (
    <div className={`lab-box ${tall ? "tall" : ""} ${glow ? "lab-glow-soft" : ""}`} ref={boxRef}>
      {dots.map((d, i) => (
        <Marker key={i} d={d} style={markerStyle} />
      ))}
      {pulse && (
        <span
          className="pulse-dot"
          style={{ left: pulse.x, top: pulse.y, background: color, color }}
        />
      )}
    </div>
  );
}

function LabCard({ title, desc, children }) {
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
  const ticker = (params.get("ticker") ?? "ORSTED.CO").toUpperCase();
  const pid = params.get("p");
  const range = params.get("range") ?? "1y";
  const [data, setData] = useState(null);
  const [avgCost, setAvgCost] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getChart(ticker, range, pid).then(setData).catch((e) => setError(e.message));
    if (pid) {
      // average buy price over the WHOLE history (works for closed positions)
      getPosition(pid, ticker)
        .then((d) => {
          const buys = d.transactions.filter((t) => t.type === "BUY");
          const shares = buys.reduce((a, t) => a + t.shares, 0);
          const cost = buys.reduce((a, t) => a + t.shares * t.price, 0);
          if (shares > 0) setAvgCost(cost / shares);
        })
        .catch(() => {});
    }
  }, [ticker, pid, range]);

  if (error) return <div className="app"><div className="empty">Błąd: {error}</div></div>;
  if (!data) return <div className="app"><div className="loading">Ładowanie laboratorium…</div></div>;

  const line = data.candles.map((c) => ({ time: c.time, value: c.close }));
  const markers = data.markers;

  return (
    <div className="app lab">
      <Link className="back" to={pid ? `/position/${ticker}?p=${pid}` : "/"}>
        ← Wróć do aplikacji
      </Link>
      <h1>
        Laboratorium wykresów — runda 4: M2 vs M3{" "}
        <span className="instr-name">
          {ticker} · zakres {range} · duże wykresy do porównania + hybryda na dokładkę
        </span>
      </h1>
      <div className="lab-grid lab-grid-1">
        <LabCard
          title="M2 · Strzałki"
          desc="Zielony ▲ pod linią = kupno, czerwony ▼ nad linią = sprzedaż. Najszybciej czytelny kierunek; przy kilku transakcjach tego samego dnia strzałki układają się w kolumnę."
        >
          <AreaLab line={line} markers={markers} markerStyle="arrows" tall />
        </LabCard>
        <LabCard
          title="M3 · Pinezki na nóżce"
          desc="Nóżka odsuwa główkę od linii — kurs zostaje czysty nawet w gęste dni. Kierunek niesie kolor i strona (pod = kupno, nad = sprzedaż)."
        >
          <AreaLab line={line} markers={markers} markerStyle="pins" tall />
        </LabCard>
        <LabCard
          title="M5 · Hybryda: nóżka + strzałka"
          desc="Rozjemca: nóżka z M3, ale zamiast kółka — grot strzałki z M2 celujący w linię. Odsunięcie i czystość M3 + jednoznaczny kierunek M2."
        >
          <AreaLab line={line} markers={markers} markerStyle="pinarrows" tall />
        </LabCard>
      </div>
      <p className="note">
        Najedź na marker, żeby zobaczyć szczegóły. Zwróć uwagę na 12.08.2025 i 30.04.2026 —
        dni z kilkoma kupnami naraz pokażą, jak każdy wariant znosi zagęszczenie. Parametry:{" "}
        <code>/lab?ticker=…&p=…&range=…</code>
      </p>
    </div>
  );
}
