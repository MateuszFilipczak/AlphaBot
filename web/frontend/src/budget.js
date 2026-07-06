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

// Loan state as of a selected month (monthly-obligation model): the loan is a
// monthly expense in any month up to end_month; the number of installments
// left counts down exactly from end_month; the % bar (only when a total count
// was given) is paid vs total. No bank balance is tracked.
export function loanState(loan, month) {
  const finished = month > loan.end_month;
  const active = month <= loan.end_month;
  const left = Math.max(0, monthsBetween(month, loan.end_month) + 1);  // rat do końca
  const total = loan.installments_total ?? null;
  const paidRat = total != null ? Math.max(0, total - left) : null;
  const pct = total ? Math.min(100, Math.max(0, (paidRat / total) * 100)) : null;
  return {
    active,
    finished,
    upcoming: false,
    left,                                    // pozostała liczba rat (odlicza się co miesiąc)
    total,
    pct,                                     // null gdy nie podano łącznej liczby rat
    toPay: left * loan.installment,          // ile jeszcze zapłacisz do końca
    endMonth: loan.end_month,
  };
}
