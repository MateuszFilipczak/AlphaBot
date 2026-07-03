"""Day-by-day portfolio value reconstruction — backward from the ledger, not
from snapshots. Pure math (no DB, no network): the caller supplies deposits,
transactions and sparse historical price/FX series; this module fills the
calendar, forward-fills quotes over non-trading days and returns one point per
day from the first operation to `today`.

value(day) = cash(day) + Σ_ticker shares(ticker, day) × close(ticker, day) × fx(day)
cash(day)  = Σ deposits≤day − withdrawals≤day − buys≤day (with fees) + sells≤day (net of fees)

Foreign-currency amounts (both position values and transaction cash flows) are
converted at the historical FX rate of that day, forward-filled like prices.
"""
from __future__ import annotations

from datetime import date as date_type, timedelta


def _day(iso: str) -> date_type:
    return date_type.fromisoformat(iso[:10])


def _ffill(sparse: dict[str, float], days: list[date_type]) -> dict[date_type, float | None]:
    """Sparse {iso_date: value} → dense per-day series. Weekends/holidays get
    the last known value; days before the first quote get the first known one
    (harmless — holdings are zero before the first transaction anyway)."""
    if not sparse:
        return {d: None for d in days}
    known = sorted((_day(k), v) for k, v in sparse.items())
    out: dict[date_type, float | None] = {}
    i = -1
    current = known[0][1]  # backfill before the first quote
    for d in days:
        while i + 1 < len(known) and known[i + 1][0] <= d:
            i += 1
            current = known[i][1]
        out[d] = current
    return out


def reconstruct_history(
    deposits: list[dict],
    transactions: list[dict],
    price_series: dict[str, dict[str, float]],
    fx_series: dict[str, dict[str, float]],
    portfolio_currency: str,
    today: date_type | None = None,
) -> list[dict]:
    """Returns [{"date": iso, "value": float, "deposited": float, "cash": float}]
    for every day from the first operation through `today` (inclusive).

    - deposits: rows with amount/date/type (DEPOSIT|WITHDRAWAL)
    - transactions: rows with ticker/type/shares/price/fee/date/currency
    - price_series: {ticker: {iso_date: close}} — sparse, trading days only
    - fx_series: {currency: {iso_date: rate_to_portfolio_currency}} — sparse
    """
    today = today or date_type.today()
    op_days = [_day(d["date"]) for d in deposits] + [_day(t["date"]) for t in transactions]
    if not op_days:
        return []
    start = min(op_days)
    days = [start + timedelta(days=i) for i in range((today - start).days + 1)]

    tickers = sorted({t["ticker"] for t in transactions})
    closes = {t: _ffill(price_series.get(t, {}), days) for t in tickers}
    rates = {c: _ffill(series, days) for c, series in fx_series.items()}

    def fx_on(currency: str | None, d: date_type) -> float:
        if not currency or currency == portfolio_currency:
            return 1.0
        r = rates.get(currency, {}).get(d)
        return r if r is not None else 1.0  # missing rate → 1:1, same policy as summary

    # events grouped by day; within one day inflows land before outflows so a
    # same-day deposit→buy (or sell→buy) sequence is reconstructed correctly
    cash_by_day: dict[date_type, float] = {}
    net_deposited_by_day: dict[date_type, float] = {}
    shares_delta: dict[date_type, dict[str, float]] = {}

    for dep in deposits:
        d = _day(dep["date"])
        signed = dep["amount"] if dep.get("type", "DEPOSIT") == "DEPOSIT" else -dep["amount"]
        cash_by_day[d] = cash_by_day.get(d, 0.0) + signed
        net_deposited_by_day[d] = net_deposited_by_day.get(d, 0.0) + signed

    for txn in transactions:
        d = _day(txn["date"])
        fee = txn.get("fee", 0.0) or 0.0
        gross = txn["shares"] * txn["price"]
        rate = fx_on(txn.get("currency"), d)
        flow = (-(gross + fee) if txn["type"] == "BUY" else gross - fee) * rate
        cash_by_day[d] = cash_by_day.get(d, 0.0) + flow
        sign = 1.0 if txn["type"] == "BUY" else -1.0
        shares_delta.setdefault(d, {})[txn["ticker"]] = (
            shares_delta.get(d, {}).get(txn["ticker"], 0.0) + sign * txn["shares"]
        )

    points = []
    cash = 0.0
    deposited = 0.0
    held: dict[str, float] = {t: 0.0 for t in tickers}
    for d in days:
        cash += cash_by_day.get(d, 0.0)
        deposited += net_deposited_by_day.get(d, 0.0)
        for ticker, delta in shares_delta.get(d, {}).items():
            held[ticker] += delta

        positions_value = 0.0
        for ticker in tickers:
            shares = held[ticker]
            if shares <= 1e-12:
                continue
            close = closes[ticker].get(d)
            if close is None:
                continue  # no quote ever — the position simply isn't valued
            currency = next(
                (t.get("currency") for t in transactions if t["ticker"] == ticker and t.get("currency")),
                None,
            )
            positions_value += shares * close * fx_on(currency, d)

        points.append({
            "date": d.isoformat(),
            "value": cash + positions_value,
            "deposited": deposited,
            "cash": cash,
        })
    return points
