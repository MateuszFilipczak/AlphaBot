// Budżet module shared config + pure month-view math. Categories are now
// user-managed (fetched from the API); this file only keeps the pure helpers.

export const LOANS_COLOR = "#5b6cff"; // synthetic "raty" slice in the chart
export const NO_CAT_COLOR = "#5b5b58"; // items whose category was deleted

// ---- month helpers ("YYYY-MM") ----
export const monthKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const parseMonth = (m) => ({ y: +m.slice(0, 4), mo: +m.slice(5, 7) });
export const monthsBetween = (a, b) => {
  const A = parseMonth(a), B = parseMonth(b);
  return (B.y - A.y) * 12 + (B.mo - A.mo);
};
export const addMonths = (m, n) => {
  const { y, mo } = parseMonth(m);
  const idx = y * 12 + (mo - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
};
const PL_MONTHS = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec",
  "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];
export const monthLabel = (m) => {
  const { y, mo } = parseMonth(m);
  return `${PL_MONTHS[mo - 1]} ${y}`;
};

// Loan state (snapshot model) as of a selected month: the loan counts as a
// monthly expense in any month up to end_month; % is paid vs the original
// principal; remaining installments are estimated from the outstanding
// balance ÷ installment (so overpayments show up).
export function loanState(loan, month) {
  const remaining = loan.remaining ?? 0;
  const principal = loan.principal ?? 0;
  const finished = month > loan.end_month || remaining <= 0;
  const active = month <= loan.end_month && remaining > 0;
  const paid = Math.max(0, principal - remaining);
  const pct = principal > 0
    ? Math.min(100, Math.max(0, (paid / principal) * 100))
    : (finished ? 100 : 0);
  const left = loan.installment > 0 ? Math.ceil(remaining / loan.installment) : 0;
  return {
    active,
    finished,
    upcoming: false,
    paid,
    remaining,
    pct,
    left,           // szacowana liczba pozostałych rat
    endMonth: loan.end_month,
  };
}
