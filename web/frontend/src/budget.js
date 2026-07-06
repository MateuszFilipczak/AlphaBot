// Budżet module shared config + pure month-view math.

// Expense categories: colours drive the "struktura wydatków" chart. Loan
// installments are their own synthetic category ("raty"), computed per month.
export const EXPENSE_CATEGORIES = [
  { key: "mieszkanie", label: "Mieszkanie", color: "#3987e5" },
  { key: "media", label: "Media", color: "#16a3a3" },
  { key: "transport", label: "Transport", color: "#c98500" },
  { key: "jedzenie", label: "Jedzenie", color: "#0ca30c" },
  { key: "zdrowie", label: "Zdrowie", color: "#e0553b" },
  { key: "rozrywka", label: "Rozrywka", color: "#9b59b6" },
  { key: "subskrypcje", label: "Subskrypcje", color: "#d081c9" },
  { key: "inne", label: "Inne", color: "#7a8b3a" },
];

export const INCOME_CATEGORIES = [
  { key: "wyplata", label: "Wypłata" },
  { key: "dodatkowe", label: "Dodatkowe wpływy" },
  { key: "inne", label: "Inne" },
];

export const LOANS_COLOR = "#5b6cff"; // synthetic "raty" category in the chart

export const catLabel = (key) =>
  EXPENSE_CATEGORIES.find((c) => c.key === key)?.label ??
  INCOME_CATEGORIES.find((c) => c.key === key)?.label ?? key;
export const catColor = (key) =>
  EXPENSE_CATEGORIES.find((c) => c.key === key)?.color ?? "#7a8b3a";

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
const PL_MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca",
  "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
export const monthLabel = (m) => {
  const { y, mo } = parseMonth(m);
  return `${PL_MONTHS[mo - 1]} ${y}`;
};

// Loan state as of a selected month: how many installments have been paid by
// then, what remains, and whether the loan is active that month (an ended or
// not-yet-started loan doesn't count toward that month's expenses).
export function loanState(loan, month) {
  const elapsed = Math.max(0, Math.min(loan.installments_count, monthsBetween(loan.start_month, month) + 1));
  const paidCount = elapsed;
  const left = loan.installments_count - paidCount;
  const total = loan.installments_count * loan.installment; // suma do spłaty
  const paid = paidCount * loan.installment;
  const endMonth = addMonths(loan.start_month, loan.installments_count - 1);
  const active = month >= loan.start_month && month <= endMonth;
  return {
    active,
    paidCount,
    left,
    total,
    paid,
    remaining: total - paid,
    pct: (paidCount / loan.installments_count) * 100,
    endMonth,
    finished: month > endMonth,
    upcoming: month < loan.start_month,
  };
}
