import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import { fmtShares } from "../format.js";

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

// The backend snaps marker times to existing candles (weekend transaction →
// Friday/Monday); this is just a safety filter so a stray time can never
// reach lightweight-charts, which silently drops markers at unknown times.
function onCandles(markers, candles) {
  const times = new Set(candles.map((c) => c.time));
  return markers.filter((m) => times.has(m.time));
}

export default function PriceChart({ candles, markers, currentPrice, mode }) {
  const boxRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);

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
      series = chart.addSeries(LineSeries, {
        color: C.accent,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
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

    // transaction markers: green = open buy lots, gray = closed buys + sells
    const visible = onCandles(markers ?? [], candles);
    const markersByTime = new Map();
    for (const m of visible) {
      if (!markersByTime.has(m.time)) markersByTime.set(m.time, []);
      markersByTime.get(m.time).push(m);
    }
    createSeriesMarkers(
      series,
      visible.map((m) => ({
        time: m.time,
        position: m.type === "BUY" ? "belowBar" : "aboveBar",
        color: m.status === "open" ? C.up : C.muted,
        shape: "circle",
        size: 2,
      }))
    );

    // marker tooltip: date, shares, price of every transaction on that candle
    const onMove = (param) => {
      if (!param.time || !param.point || !markersByTime.has(param.time)) {
        setTooltip(null);
        return;
      }
      setTooltip({
        x: Math.min(param.point.x + 12, el.clientWidth - 170),
        y: Math.max(param.point.y - 10, 6),
        items: markersByTime.get(param.time),
      });
    };
    chart.subscribeCrosshairMove(onMove);
    chart.timeScale().fitContent();

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      setTooltip(null);
    };
  }, [candles, markers, currentPrice, mode]);

  return (
    <div className="chart-box" ref={boxRef}>
      {tooltip && (
        <div className="chart-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.items.map((m, i) => (
            <div key={i}>
              <span className={m.type === "BUY" ? "pnl-up" : ""}>
                {m.type === "BUY" ? "Kupno" : "Sprzedaż"}
              </span>{" "}
              <span className="t-muted">{m.date}</span> · {fmtShares(m.shares)} szt. @{" "}
              {m.price}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
