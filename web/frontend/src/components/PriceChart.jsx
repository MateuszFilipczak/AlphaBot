import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  LineStyle,
  createChart,
} from "lightweight-charts";
import { fmtMoney, fmtShares } from "../format.js";

// Palette (dark) — mirrors styles.css custom properties.
const C = {
  surface: "#1a1a19",
  grid: "#2c2c2a",
  axis: "#383835",
  muted: "#898781",
  ink2: "#c3c2b7",
  accent: "#3987e5",
  up: "#0ca30c",
  down: "#d03b3b",
};

// The backend snaps marker times to existing candles; this is just a safety
// filter so a stray time can never produce an unanchored dot.
function onCandles(markers, candles) {
  const times = new Set(candles.map((c) => c.time));
  return markers.filter((m) => times.has(m.time));
}

// Transaction markers are HTML overlay "pins" (stem + head, hanging off the
// price line), not lightweight-charts native markers: native ones can't have
// stems, shadows, hover effects or rich tooltips. Buys hang below the chart
// (green), sells above (red); buy lots already closed by sells are dimmed.
// Pins are re-positioned via chart coordinate APIs on every pan/zoom/resize.
export default function PriceChart({ candles, markers, currentPrice, mode, currency = "USD" }) {
  const boxRef = useRef(null);
  const [dots, setDots] = useState([]); // [{x, y, marker}]
  const [pulse, setPulse] = useState(null); // {x, y} — last price "live" dot (line mode)
  const [tooltip, setTooltip] = useState(null); // {x, y, marker}

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !candles.length) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: C.surface },
        textColor: C.muted,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: C.grid },
        horzLines: { color: C.grid },
      },
      rightPriceScale: { borderColor: C.axis },
      // rightOffset keeps the newest candle (where fresh transaction markers
      // usually sit) away from the edge so the dots are actually visible
      timeScale: { borderColor: C.axis, rightOffset: 6 },
      crosshair: {
        vertLine: { color: C.muted, labelBackgroundColor: C.axis },
        horzLine: { color: C.muted, labelBackgroundColor: C.axis },
      },
    });

    let series;
    if (mode === "candles") {
      series = chart.addSeries(CandlestickSeries, {
        upColor: C.up,
        downColor: C.down,
        wickUpColor: C.up,
        wickDownColor: C.down,
        borderVisible: false,
      });
      series.setData(candles);
    } else {
      // "A1": soft gradient fill under the line + pulsing last-price dot
      series = chart.addSeries(AreaSeries, {
        lineColor: C.accent,
        lineWidth: 2,
        topColor: "rgba(57, 135, 229, 0.34)",
        bottomColor: "rgba(57, 135, 229, 0.02)",
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerRadius: 5,
      });
      series.setData(candles.map((c) => ({ time: c.time, value: c.close })));
    }

    // horizontal line at the current price
    if (currentPrice != null) {
      series.createPriceLine({
        price: currentPrice,
        color: C.ink2,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "teraz",
      });
    }

    const visible = onCandles(markers ?? [], candles);
    const candleByTime = new Map(candles.map((c) => [c.time, c]));

    const updateDots = () => {
      const ts = chart.timeScale();
      // plot-area bounds: the overlay pins aren't clipped by the chart canvas,
      // so one panned/scrolled out of the pane must vanish, not float over
      // the page (pane = container minus right price scale & bottom time axis)
      const paneW = ts.width();
      const paneH = el.clientHeight - ts.height();
      const stack = new Map(); // "time|type" → how many pins already placed
      const next = [];
      for (const m of visible) {
        const x = ts.timeToCoordinate(m.time);
        if (x === null || x < 0 || x > paneW) continue;
        const candle = candleByTime.get(m.time);
        const anchor =
          mode === "candles" ? (m.type === "BUY" ? candle.low : candle.high) : candle.close;
        const y = series.priceToCoordinate(anchor);
        if (y === null) continue;
        // pins anchor at the line/wick and hang away from it; same-day
        // same-direction transactions stack further outward (pin ≈ 18 px)
        const key = `${m.time}|${m.type}`;
        const n = stack.get(key) ?? 0;
        stack.set(key, n + 1);
        const yPin = m.type === "BUY" ? y + n * 18 : y - n * 18;
        if (yPin < 0 || yPin > paneH) continue;
        next.push({ x, y: yPin, marker: m });
      }
      setDots(next);

      // pulsing "live" dot on the last close (line mode only)
      if (mode !== "candles" && candles.length) {
        const last = candles[candles.length - 1];
        const px = ts.timeToCoordinate(last.time);
        const py = series.priceToCoordinate(last.close);
        setPulse(px !== null && py !== null ? { x: px, y: py } : null);
      }
    };

    chart.timeScale().fitContent();
    updateDots();
    const raf = requestAnimationFrame(updateDots); // after first layout pass
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateDots);
    const ro = new ResizeObserver(updateDots);
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateDots);
      ro.disconnect();
      chart.remove();
      setDots([]);
      setPulse(null);
      setTooltip(null);
    };
  }, [candles, markers, currentPrice, mode]);

  const pinClass = (m) =>
    `${m.type === "BUY" ? "buy below" : "sell above"}${m.status === "closed" ? " closed" : ""}`;

  return (
    <div className="chart-box" ref={boxRef}>
      {dots.map((d, i) => (
        <span
          key={i}
          className={`mk mk-pin ${pinClass(d.marker)}`}
          style={{ left: d.x, top: d.y }}
          onMouseEnter={() => setTooltip(d)}
          onMouseLeave={() => setTooltip(null)}
        />
      ))}
      {pulse && (
        <span
          className="pulse-dot"
          style={{ left: pulse.x, top: pulse.y, background: "#3987e5", color: "#3987e5" }}
        />
      )}
      {tooltip && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.max(4, Math.min(tooltip.x - 80, (boxRef.current?.clientWidth ?? 320) - 176)),
            top: Math.max(4, tooltip.y - 78),
          }}
        >
          <div>
            <b className={tooltip.marker.type === "BUY" ? "pnl-up" : ""}>
              {tooltip.marker.type === "BUY" ? "Kupno" : "Sprzedaż"}
            </b>{" "}
            <span className="t-muted">{tooltip.marker.date}</span>
          </div>
          <div>
            {fmtShares(tooltip.marker.shares)} × {fmtMoney(tooltip.marker.price, currency)}
          </div>
          <div className="t-muted">
            Wartość: {fmtMoney(tooltip.marker.shares * tooltip.marker.price, currency)}
          </div>
        </div>
      )}
    </div>
  );
}
