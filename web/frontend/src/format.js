// Money/percent formatting per portfolio currency.
const LOCALES = { USD: "en-US", EUR: "de-DE", PLN: "pl-PL" };

export function fmtMoney(value, currency = "USD", { sign = false } = {}) {
  if (value === null || value === undefined) return "—";
  const nf = new Intl.NumberFormat(LOCALES[currency] ?? "en-US", {
    style: "currency",
    currency,
    signDisplay: sign ? "exceptZero" : "auto",
  });
  return nf.format(value);
}

export function fmtPct(value, { sign = true } = {}) {
  if (value === null || value === undefined) return "—";
  const nf = new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: sign ? "exceptZero" : "auto",
  });
  return `${nf.format(value)}%`;
}

export function fmtShares(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 6 }).format(value);
}

export function fmtDate(iso) {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

// CSS class for P&L coloring
export const pnlClass = (v) => (v === null || v === undefined ? "" : v >= 0 ? "pnl-up" : "pnl-down");
