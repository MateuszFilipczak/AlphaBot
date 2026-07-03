import { useEffect, useRef, useState } from "react";
import { LineSeries, LineStyle, createChart } from "lightweight-charts";
import { getHistory } from "../api.js";
import { fmtMoney, pnlClass } from "../format.js";

const C = {
  surface: "#1a1a19",
  grid: "#2c2c2a",
  axis: "#383835",
  muted: "#898781",
  ink2: "#c3c2b7",
  accent: "#3987e5",
};

const RANGES = [
  ["1mo", "1M"],
  ["3mo", "3M"],
  ["1y", "1R"],
  ["max", "MAX"],
];

// Portfolio value over time (reconstructed day by day on the backend) with a
// subtle dashed line of net contributed capital — the gap between the two IS
// the profit, visible at a glance.
export default function PortfolioChart({ portfolioId, currency, refreshTick }) {
  const boxRef = useRef(null);
  const [range, setRange] = useState("max");
  const [points, setPoints] = useState(null);
  const [tooltip, setTooltip] = useState(null); // {x, point}

  useEffect(() => {
    if (!portfolioId) return;
    setPoints(null);
    getHistory(portfolioId, range)
      .then((d) => setPoints(d.points))
      .catch(() => setPoints([]));
  }, [portfolioId, range, refreshTick]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !points || points.length < 2) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: C.surface }, textColor: C.muted, attributionLogo: false },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.axis },
      timeScale: { borderColor: C.axis },
      crosshair: {
        vertLine: { color: C.muted, labelBackgroundColor: C.axis },
        horzLine: { visible: false, labelVisible: false },
      },
    });

    const valueSeries = chart.addSeries(LineSeries, {
      color: C.accent,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    valueSeries.setData(points.map((p) => ({ time: p.date, value: p.value })));

    const depositedSeries = chart.addSeries(LineSeries, {
      color: C.muted,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    depositedSeries.setData(points.map((p) => ({ time: p.date, value: p.deposited })));

    const byDate = new Map(points.map((p) => [p.date, p]));
    const onMove = (param) => {
      if (!param.time || !param.point || !byDate.has(param.time)) {
        setTooltip(null);
        return;
      }
      setTooltip({ x: param.point.x, point: byDate.get(param.time) });
    };
    chart.subscribeCrosshairMove(onMove);
    chart.timeScale().fitContent();

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      setTooltip(null);
    };
  }, [points]);

  if (points !== null && points.length < 2) return null; // nothing to plot yet

  const profit = tooltip ? tooltip.point.value - tooltip.point.deposited : null;

  return (
    <div className="chart-card" style={{ marginBottom: 24 }}>
      <div className="chart-controls">
        <span className="chart-title">Wartość portfela</span>
        <div className="seg" role="group" aria-label="Zakres historii">
          {RANGES.map(([value, label]) => (
            <button
              key={value}
              className={range === value ? "active" : ""}
              onClick={() => setRange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-box history" ref={boxRef}>
        {points === null && <div className="chart-msg">Ładowanie historii…</div>}
        {tooltip && (
          <div
            className="chart-tooltip"
            style={{
              left: Math.max(4, Math.min(tooltip.x + 12, (boxRef.current?.clientWidth ?? 320) - 190)),
              top: 8,
            }}
          >
            <div className="t-muted">{tooltip.point.date}</div>
            <div>Wartość: <b>{fmtMoney(tooltip.point.value, currency)}</b></div>
            <div>Wpłacono: {fmtMoney(tooltip.point.deposited, currency)}</div>
            <div className={pnlClass(profit)}>
              Zysk: {fmtMoney(profit, currency, { sign: true })}
            </div>
          </div>
        )}
      </div>
      <div className="legend">
        <span>
          <span className="dot" style={{ background: C.accent }} />
          wartość portfela
        </span>
        <span>
          <span className="dot" style={{ background: C.muted }} />
          ‑ ‑ wpłacony kapitał (netto)
        </span>
      </div>
    </div>
  );
}
