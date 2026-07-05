"""Pure portfolio math: FIFO lot matching, realized/unrealized P&L, cash.

No DB, no network — takes plain transaction/deposit dicts so it's trivially
unit-testable. The DB layer (db.py) and the web API (web/server.py) both feed
it rows and render the results.

Transaction dict shape (matches the `transactions` table):
    {"id": int, "ticker": str, "type": "BUY"|"SELL", "shares": float,
     "price": float, "fee": float, "date": str, "note": str|None}

FIFO conventions:
- Transactions are processed in (date, id) order — the oldest lots are
  consumed first by sells.
- Buy fees are baked into a lot's cost basis proportionally to shares:
  selling half a lot realizes half of its buy fee.
- A sell's fee reduces that sale's realized P&L in full.
- All P&L figures are therefore net of fees.
"""
from __future__ import annotations


class OversellError(ValueError):
    """A SELL exceeds the shares held at its point in the FIFO timeline."""

    def __init__(self, ticker: str, requested: float, owned: float):
        self.ticker = ticker
        self.requested = requested
        self.owned = owned
        super().__init__(
            f"Cannot sell {requested:g} {ticker}: only {owned:g} shares held at that date"
        )


def _sorted(transactions: list[dict]) -> list[dict]:
    """FIFO timeline order. Dates are day-granular in the UI, so within one
    day the true sequence is unknowable — the tie-break is BUY before SELL
    (same-day buy-then-sell MUST be legal), then insertion id. A missing id
    (a candidate not yet inserted, see validate_sell) sorts last within its
    day+type group, matching the id it would get on insert."""
    def key(t):
        day = (t["date"] or "")[:10]
        type_rank = 0 if t["type"] == "BUY" else 1
        tid = t.get("id")
        return (day, type_rank, tid if tid is not None else float("inf"))
    return sorted(transactions, key=key)


def replay_fifo(transactions: list[dict]) -> dict:
    """Replays all transactions of ONE ticker and returns:

    {
      "open_lots": [
          {"txn_id", "date", "price", "shares_initial", "shares_remaining",
           "fee_remaining",       # unrealized share of the buy fee
           "cost_basis"}          # shares_remaining * price + fee_remaining
      ],
      "sales": [
          {"txn_id", "date", "shares", "price", "fee", "note",
           "proceeds",            # shares * price - fee
           "cost_basis",          # FIFO-matched basis incl. proportional buy fees
           "realized_pnl",        # proceeds - cost_basis
           "cash_proceeds",       # broker-settled portfolio-currency amount (or None)
           "cash_cost",           # FIFO-matched share of the buys' settled amounts (or None)
           "realized_cash",       # cash_proceeds - cash_cost — FX-EXACT realized
                                  # P&L in the portfolio currency; None when any
                                  # involved transaction lacks cash_amount
           "matched": [{"buy_txn_id", "shares", "buy_price"}]}
      ],
      "shares_owned": float,
      "realized_pnl": float,     # sum over sales (instrument currency)
    }

    Prices are in the instrument's currency. Transactions imported from a
    broker export additionally carry `cash_amount` — the exact settled amount
    in the portfolio's currency; the cash_* fields FIFO-match those amounts,
    reproducing the broker's own FX-exact Profit/Loss per sale.

    Raises OversellError if any sell exceeds holdings at its point in time.
    """
    open_lots: list[dict] = []
    sales: list[dict] = []

    for txn in _sorted(transactions):
        if txn["type"] == "BUY":
            open_lots.append({
                "txn_id": txn.get("id"),
                "date": txn["date"],
                "price": txn["price"],
                "shares_initial": txn["shares"],
                "shares_remaining": txn["shares"],
                "fee_initial": txn.get("fee", 0.0) or 0.0,
                "fee_remaining": txn.get("fee", 0.0) or 0.0,
                "cash_initial": txn.get("cash_amount"),  # settled amount, or None
            })
            continue

        # SELL — consume oldest lots first
        to_sell = txn["shares"]
        owned = sum(lot["shares_remaining"] for lot in open_lots)
        if to_sell > owned + 1e-9:
            raise OversellError(txn["ticker"], to_sell, owned)

        matched = []
        cost_basis = 0.0
        cash_cost = 0.0
        cash_known = True  # every matched lot must carry a settled amount
        remaining = to_sell
        for lot in open_lots:
            if remaining <= 1e-12:
                break
            take = min(lot["shares_remaining"], remaining)
            if take <= 0:
                continue
            fee_share = (
                lot["fee_initial"] * (take / lot["shares_initial"])
                if lot["shares_initial"] > 0 else 0.0
            )
            cost_basis += take * lot["price"] + fee_share
            if lot["cash_initial"] is not None and lot["shares_initial"] > 0:
                cash_cost += lot["cash_initial"] * (take / lot["shares_initial"])
            else:
                cash_known = False
            lot["shares_remaining"] -= take
            lot["fee_remaining"] -= fee_share
            matched.append({
                "buy_txn_id": lot["txn_id"],
                "shares": take,
                "buy_price": lot["price"],
            })
            remaining -= take

        open_lots = [l for l in open_lots if l["shares_remaining"] > 1e-9]

        fee = txn.get("fee", 0.0) or 0.0
        proceeds = txn["shares"] * txn["price"] - fee
        sell_cash = txn.get("cash_amount")
        cash_exact = sell_cash is not None and cash_known
        sales.append({
            "txn_id": txn.get("id"),
            "date": txn["date"],
            "shares": txn["shares"],
            "price": txn["price"],
            "fee": fee,
            "note": txn.get("note"),
            "proceeds": proceeds,
            "cost_basis": cost_basis,
            "realized_pnl": proceeds - cost_basis,
            "cash_proceeds": sell_cash if cash_exact else None,
            "cash_cost": cash_cost if cash_exact else None,
            "realized_cash": (sell_cash - cash_cost) if cash_exact else None,
            "matched": matched,
        })

    for lot in open_lots:
        lot["cost_basis"] = lot["shares_remaining"] * lot["price"] + lot["fee_remaining"]

    return {
        "open_lots": open_lots,
        "sales": sales,
        "shares_owned": sum(l["shares_remaining"] for l in open_lots),
        "realized_pnl": sum(s["realized_pnl"] for s in sales),
    }


def build_positions(transactions: list[dict]) -> dict[str, dict]:
    """Groups a portfolio's transactions by ticker and FIFO-replays each.
    Returns {ticker: replay_fifo(...) result}."""
    by_ticker: dict[str, list[dict]] = {}
    for txn in transactions:
        by_ticker.setdefault(txn["ticker"], []).append(txn)
    return {ticker: replay_fifo(txns) for ticker, txns in by_ticker.items()}


def shares_owned(transactions: list[dict], ticker: str) -> float:
    """Current holdings of one ticker (BUY minus SELL)."""
    return sum(
        t["shares"] if t["type"] == "BUY" else -t["shares"]
        for t in transactions
        if t["ticker"] == ticker
    )


def validate_sell(transactions: list[dict], candidate: dict) -> None:
    """Raises OversellError if inserting `candidate` (a SELL) anywhere in the
    FIFO timeline would sell more shares than held at that point. Replaying
    the full history with the candidate included catches back-dated sells too."""
    ticker_txns = [t for t in transactions if t["ticker"] == candidate["ticker"]]
    replay_fifo(ticker_txns + [candidate])


def position_summary(state: dict, current_price: float | None) -> dict:
    """Adds market-value / unrealized-P&L figures to a replay_fifo() result.
    With no price available the valuation fields are None (fail-soft, matching
    the data-layer convention)."""
    shares = state["shares_owned"]
    cost = sum(l["cost_basis"] for l in state["open_lots"])
    avg_cost = (
        sum(l["shares_remaining"] * l["price"] for l in state["open_lots"]) / shares
        if shares > 0 else 0.0
    )

    market_value = unrealized = unrealized_pct = None
    if current_price is not None:
        market_value = shares * current_price
        unrealized = market_value - cost
        unrealized_pct = (unrealized / cost * 100) if cost > 0 else 0.0

    return {
        "shares": shares,
        "avg_cost": avg_cost,
        "cost_basis": cost,
        "current_price": current_price,
        "market_value": market_value,
        "unrealized_pnl": unrealized,
        "unrealized_pnl_pct": unrealized_pct,
        "realized_pnl": state["realized_pnl"],
    }


def cash_balance(deposits_total: float, transactions: list[dict], fx=None) -> float:
    """Cash = deposits − (buys + fees) + (sells − fees).

    A transaction carrying `cash_amount` (the EXACT portfolio-currency amount
    the broker settled, fees included — known for imported trades) uses it
    as-is. Otherwise `fx` (optional) maps the transaction's currency to a
    portfolio-currency rate: fx(currency) -> float. Used when a portfolio
    holds instruments traded in another currency (e.g. a PLN-quoted stock in
    a EUR portfolio) — the caller supplies current rates, so that path is an
    approximation of the broker's actual settlement-time conversion.
    No fx = everything 1:1."""
    cash = deposits_total
    for t in transactions:
        exact = t.get("cash_amount")
        if exact is not None:
            cash += -exact if t["type"] == "BUY" else exact
            continue
        rate = fx(t.get("currency")) if fx is not None else 1.0
        fee = t.get("fee", 0.0) or 0.0
        if t["type"] == "BUY":
            cash -= (t["shares"] * t["price"] + fee) * rate
        else:
            cash += (t["shares"] * t["price"] - fee) * rate
    return cash
