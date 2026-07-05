"""FastAPI backend for the local web app (python main.py web).

Serves the JSON API under /api/* and the built React frontend
(web/frontend/dist) for everything else. Same SQLite DB as the CLI;
the AI agents are untouched — this is purely a portfolio-tracking UX.

Conventions:
- Every float sourced from yfinance passes through safe_float (NaN/inf →
  None) before it can reach a sum or a JSON response.
- Money in `positions[*]` price fields is NATIVE (the instrument's trading
  currency); the `*_pc` fields and all top-level totals are in the
  PORTFOLIO's currency, converted at the current yfinance FX rate (cached
  15 min) — an approximation, flagged to the UI via `fx_rates`.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
import webbrowser
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor
from datetime import date as date_type
from pathlib import Path
from time import time

import requests
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

import db
from importers.xtb import parse_xtb_export, rate_is_unity
from data.yahoo import (
    get_close_series,
    get_current_price,
    get_history,
    get_instrument_info,
    safe_float,
)
from valuation import reconstruct_history
from engine import (
    OversellError,
    build_positions,
    cash_balance,
    position_summary,
    replay_fifo,
    validate_sell,
)

logger = logging.getLogger("alphabot.web")

app = FastAPI(title="AlphaBot", docs_url=None, redoc_url=None)

FRONTEND_DIST = Path(__file__).resolve().parent / "frontend" / "dist"

# yfinance quotes are delayed anyway; a short TTL cache keeps dashboard
# refreshes snappy and avoids hammering Yahoo when flipping between views.
_PRICE_TTL_S = 60
_price_cache: dict[str, tuple[float, float | None]] = {}
_price_lock = threading.Lock()

# FX rates move slowly relative to how the app is used — 15 min TTL (spec).
_FX_TTL_S = 900
_fx_cache: dict[str, tuple[float, float | None]] = {}


def _cached_price(ticker: str) -> float | None:
    now = time()
    with _price_lock:
        hit = _price_cache.get(ticker)
        if hit and now - hit[0] < _PRICE_TTL_S:
            return hit[1]
    price = safe_float(get_current_price(ticker))
    with _price_lock:
        _price_cache[ticker] = (now, price)
    return price


def _prices_for(tickers: list[str]) -> dict[str, float | None]:
    if not tickers:
        return {}
    with ThreadPoolExecutor(max_workers=min(8, len(tickers))) as pool:
        return dict(zip(tickers, pool.map(_cached_price, tickers)))


def _fx_rate(from_cur: str | None, to_cur: str) -> float | None:
    """Current from→to rate via Yahoo's `EURPLN=X`-style tickers, cached
    15 min. Unknown/same currency → 1.0; a failed quote → None (caller
    decides the fallback and surfaces the gap)."""
    if not from_cur or from_cur == to_cur:
        return 1.0
    pair = f"{from_cur}{to_cur}=X"
    now = time()
    hit = _fx_cache.get(pair)
    if hit and now - hit[0] < _FX_TTL_S:
        return hit[1]
    rate = safe_float(get_current_price(pair))
    _fx_cache[pair] = (now, rate)
    return rate


def _ensure_instrument(ticker: str) -> dict | None:
    """Instrument metadata from the local cache, fetched from yfinance the
    first time a ticker shows up. Fail-soft: no metadata → None (we retry on
    the next transaction rather than caching a failure)."""
    ticker = ticker.upper()
    cached = db.get_instrument(ticker)
    if cached:
        return cached
    info = get_instrument_info(ticker)
    if info is None:
        return None
    db.upsert_instrument(info["ticker"], info["name"], info["type"],
                         info["exchange"], info["currency"])
    return db.get_instrument(ticker)


def _get_portfolio_or_404(portfolio_id: int):
    portfolio = db.get_portfolio_by_id(portfolio_id)
    if portfolio is None:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    return portfolio


# ---- Request models ---------------------------------------------------------

def _normalize_iso_date(v: str | None) -> str | None:
    """Dates must travel the whole stack as ISO (YYYY-MM-DD) regardless of the
    browser's locale — anything else (02/07/2026 etc.) is rejected outright,
    never silently misparsed. Full ISO timestamps are truncated to the day."""
    if v is None:
        return v
    from datetime import datetime

    try:
        return datetime.fromisoformat(v).date().isoformat()
    except ValueError:
        raise ValueError("date must be ISO format (YYYY-MM-DD)")


class TransactionIn(BaseModel):
    ticker: str = Field(min_length=1, max_length=12)
    type: str = Field(pattern="^(BUY|SELL)$")
    shares: float = Field(gt=0)
    price: float = Field(ge=0)
    fee: float = Field(default=0.0, ge=0)
    date: str | None = None  # ISO date; defaults to today
    note: str | None = None

    _date_iso = field_validator("date")(classmethod(lambda cls, v: _normalize_iso_date(v)))


class DepositIn(BaseModel):
    amount: float = Field(gt=0)
    date: str | None = None

    _date_iso = field_validator("date")(classmethod(lambda cls, v: _normalize_iso_date(v)))


class WithdrawalIn(BaseModel):
    amount: float = Field(gt=0)
    date: str | None = None
    note: str | None = None

    _date_iso = field_validator("date")(classmethod(lambda cls, v: _normalize_iso_date(v)))


class DepositUpdate(BaseModel):
    amount: float = Field(gt=0)
    date: str
    note: str | None = None

    _date_iso = field_validator("date")(classmethod(lambda cls, v: _normalize_iso_date(v)))


class PortfolioIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    currency: str = Field(pattern="^(USD|EUR|PLN|GBP)$")


class PortfolioRename(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class InstrumentTypeIn(BaseModel):
    type: str = Field(pattern="^(EQUITY|ETF|ETC)$")


class ImportOperationIn(BaseModel):
    """One row the user accepted on the import preview screen. The ticker may
    differ from the parser's mapping — the preview lets the user correct it."""
    kind: str = Field(pattern="^(BUY|SELL|DEPOSIT|WITHDRAWAL|TRANSFER|SUBTRANSFER|DIVIDEND|TAX|INTEREST|RIGHTS)$")
    cash_type: str | None = Field(default=None, pattern="^(DEPOSIT|WITHDRAWAL)$")
    ticker: str | None = Field(default=None, max_length=12)
    date: str
    shares: float | None = Field(default=None, gt=0)
    price: float | None = Field(default=None, ge=0)
    amount: float = Field(gt=0)
    external_id: str | None = None
    note: str | None = None

    _date_iso = field_validator("date")(classmethod(lambda cls, v: _normalize_iso_date(v)))


class ImportCommitIn(BaseModel):
    operations: list[ImportOperationIn]


def _current_cash(portfolio) -> float:
    """Portfolio cash right now: net deposits − (buys + fees) + (sells − fees),
    foreign-currency transactions converted at the current rate (1:1 when the
    rate is unavailable — same policy as the summary endpoint)."""
    pcur = portfolio["currency"]
    txns = db.get_transactions(portfolio["id"])
    instruments = db.get_instruments(sorted({t["ticker"] for t in txns}))

    def txn_currency(t: dict) -> str | None:
        return t.get("currency") or (instruments.get(t["ticker"]) or {}).get("currency")

    def rate_for(currency: str | None) -> float:
        r = _fx_rate(currency or pcur, pcur)
        return r if r is not None else 1.0

    txns_fx = [{**t, "currency": txn_currency(t)} for t in txns]
    return cash_balance(db.get_cash_flows_total(portfolio["id"]), txns_fx, fx=rate_for)


# ---- Portfolios & summary ---------------------------------------------------

@app.get("/api/portfolios")
def list_portfolios():
    # txn_count/deposit_count let the UI pick the right delete flow
    return db.get_portfolios_with_counts()


def _clean_portfolio_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nazwa portfela nie może być pusta")
    return name


def _duplicate_name_400(name: str, currency: str) -> HTTPException:
    return HTTPException(
        status_code=400, detail=f"Portfel „{name}” już istnieje w walucie {currency}"
    )


# Name uniqueness (per currency) is enforced solely by the UNIQUE (name,
# currency) constraint — no check-then-write pre-scan, so a concurrent
# duplicate can't slip past into a 500.

@app.post("/api/portfolios", status_code=201)
def create_portfolio(body: PortfolioIn):
    name = _clean_portfolio_name(body.name)
    try:
        return {"id": db.add_portfolio(name, body.currency)}
    except sqlite3.IntegrityError:
        raise _duplicate_name_400(name, body.currency)


@app.put("/api/portfolios/{portfolio_id}")
def rename_portfolio(portfolio_id: int, body: PortfolioRename):
    portfolio = _get_portfolio_or_404(portfolio_id)
    name = _clean_portfolio_name(body.name)
    try:
        db.rename_portfolio(portfolio_id, name)
    except sqlite3.IntegrityError:
        raise _duplicate_name_400(name, portfolio["currency"])
    return {"id": portfolio_id}


@app.delete("/api/portfolios/{portfolio_id}")
def remove_portfolio(portfolio_id: int, force: bool = False):
    """Empty portfolio: plain delete. Portfolio with data: requires
    ?force=true and cascades — its transactions and cash flows are gone for
    good (the UI shows the counts and asks for explicit confirmation)."""
    _get_portfolio_or_404(portfolio_id)
    if db.portfolio_is_empty(portfolio_id):
        db.delete_portfolio(portfolio_id)
        return {"deleted": portfolio_id, "transactions": 0, "deposits": 0}
    if not force:
        raise HTTPException(
            status_code=400,
            detail="Portfel ma transakcje lub wpłaty — usunięcie z danymi wymaga force=true",
        )
    txns, deps = db.delete_portfolio_cascade(portfolio_id)
    _history_cache.pop(portfolio_id, None)
    return {"deleted": portfolio_id, "transactions": txns, "deposits": deps}


def _sales_cash_totals(state: dict) -> tuple[float, float, float] | None:
    """(invested, proceeds, realized) in the PORTFOLIO currency, from the
    broker-settled amounts — FX-exact, matching the broker's own Profit/Loss.
    None when any involved transaction lacks cash_amount (manual entries)."""
    sales = state["sales"]
    if not sales or any(s["realized_cash"] is None for s in sales):
        return None
    return (
        sum(s["cash_cost"] for s in sales),
        sum(s["cash_proceeds"] for s in sales),
        sum(s["realized_cash"] for s in sales),
    )


@app.get("/api/portfolios/{portfolio_id}/summary")
def portfolio_summary(portfolio_id: int):
    portfolio = _get_portfolio_or_404(portfolio_id)
    pcur = portfolio["currency"]
    txns = db.get_transactions(portfolio_id)
    deposited = db.get_total_deposited(portfolio_id)
    states = build_positions(txns)

    open_tickers = [t for t, s in states.items() if s["shares_owned"] > 1e-9]
    prices = _prices_for(open_tickers)
    instruments = db.get_instruments(open_tickers)

    fx_rates: dict[str, float] = {}       # currencies actually converted
    fx_unavailable: list[str] = []        # currencies we couldn't get a rate for

    def rate_for(currency: str | None) -> float:
        """Portfolio-currency rate with a visible-degradation fallback: if the
        FX quote is unavailable we use 1.0 and report it in fx_unavailable
        instead of silently dropping the position (or 500ing)."""
        cur = currency or pcur
        r = _fx_rate(cur, pcur)
        if r is None:
            if cur not in fx_unavailable:
                fx_unavailable.append(cur)
            return 1.0
        if cur != pcur:
            fx_rates[cur] = r
        return r

    positions = []
    positions_value = 0.0   # portfolio currency; unpriced positions at cost
    unrealized_total = 0.0  # portfolio currency
    realized_total = 0.0    # portfolio currency
    unpriced = []
    for ticker in sorted(open_tickers):
        summary = position_summary(states[ticker], prices.get(ticker))
        inst = instruments.get(ticker) or _ensure_instrument(ticker)
        icur = (inst or {}).get("currency") or pcur
        rate = rate_for(icur)
        priced = summary["market_value"] is not None

        if priced:
            value_pc = summary["market_value"] * rate
            unrealized_pc = summary["unrealized_pnl"] * rate
            unrealized_total += unrealized_pc
        else:
            # no quote right now — count the position at its cost basis
            value_pc = summary["cost_basis"] * rate
            unrealized_pc = None
            unpriced.append(ticker)
        positions_value += value_pc
        # partial sells of a still-open ticker: FX-exact when possible
        cash_totals = _sales_cash_totals(states[ticker])
        realized_total += cash_totals[2] if cash_totals else summary["realized_pnl"] * rate

        positions.append({
            "ticker": ticker,
            "name": (inst or {}).get("name") or ticker,
            "type": (inst or {}).get("type") or "EQUITY",
            "currency": icur,
            "priced": priced,
            "fx_rate": rate if icur != pcur else None,
            # native (instrument currency):
            **{k: summary[k] for k in (
                "shares", "avg_cost", "cost_basis", "current_price",
                "market_value", "unrealized_pnl", "unrealized_pnl_pct",
            )},
            # portfolio currency:
            "value_pc": value_pc,
            "unrealized_pnl_pc": unrealized_pc,
        })

    # transactions that predate the currency column have currency=NULL — fall
    # back to the instrument's trading currency so their cash flows convert too
    def txn_fx_currency(t: dict) -> str | None:
        if t.get("currency"):
            return t["currency"]
        inst = instruments.get(t["ticker"]) or db.get_instrument(t["ticker"])
        return (inst or {}).get("currency")

    # fully-sold tickers: realized results only, clickable into the same
    # detail view (chart + sale history) as open positions. Imported trades
    # carry broker-settled amounts, so the portfolio-currency figures are
    # FX-exact (the broker's own Profit/Loss); manual entries fall back to
    # native × current rate (the usual approximation).
    closed_positions = []
    for ticker in sorted(t for t, s in states.items() if s["shares_owned"] <= 1e-9):
        state = states[ticker]
        if not state["sales"]:
            continue
        inst = db.get_instrument(ticker) or _ensure_instrument(ticker)
        icur = (inst or {}).get("currency") or pcur
        rate = rate_for(icur)
        cost_sold = sum(s["cost_basis"] for s in state["sales"])
        proceeds = sum(s["proceeds"] for s in state["sales"])
        realized = state["realized_pnl"]
        cash_totals = _sales_cash_totals(state)
        if cash_totals:
            invested_pc, proceeds_pc, realized_pc = cash_totals
        else:
            invested_pc, proceeds_pc, realized_pc = cost_sold * rate, proceeds * rate, realized * rate
        realized_total += realized_pc
        closed_positions.append({
            "ticker": ticker,
            "name": (inst or {}).get("name") or ticker,
            "type": (inst or {}).get("type") or "EQUITY",
            "currency": icur,
            "shares_sold": sum(s["shares"] for s in state["sales"]),
            "invested": cost_sold,                    # native
            "proceeds": proceeds,                     # native
            "realized_pnl": realized,                 # native
            # portfolio currency (FX-exact when the trades were imported):
            "invested_pc": invested_pc,
            "proceeds_pc": proceeds_pc,
            "realized_pnl_pc": realized_pc,
            "realized_pnl_pct": (realized_pc / invested_pc * 100) if invested_pc > 0 else 0.0,
            "fx_exact": cash_totals is not None,
            "first_date": min(t["date"][:10] for t in txns if t["ticker"] == ticker),
            "last_sell_date": max(s["date"][:10] for s in state["sales"]),
        })

    txns_fx = [{**t, "currency": txn_fx_currency(t)} for t in txns]
    cash = cash_balance(db.get_cash_flows_total(portfolio_id), txns_fx, fx=rate_for)
    # Lifetime profit is money-weighted: everything the portfolio is worth now
    # minus the capital actually contributed. This picks up investment income
    # (dividends, interest) and FX gains on cash flows, which per-position
    # realized+unrealized (instrument currency × today's rate) can't see.
    total_pnl = cash + positions_value - deposited
    # % of gross capital ever paid in — net contributed can be ~0 or negative
    # on accounts that withdrew their gains, which would blow the ratio up.
    contributed_in, contributed_out = db.get_contribution_totals(portfolio_id)
    total_pnl_pct = (total_pnl / contributed_in * 100) if contributed_in > 0 else 0.0

    return {
        "portfolio": dict(portfolio),
        "deposited": deposited,
        "contributed_in": contributed_in,    # bank deposits + transfers in
        "contributed_out": contributed_out,  # withdrawals + transfers out
        "cash": cash,
        "positions_value": positions_value,
        "realized_pnl": realized_total,
        "unrealized_pnl": unrealized_total,
        "total_pnl": total_pnl,
        "total_pnl_pct": total_pnl_pct,
        "unpriced_tickers": unpriced,   # quotes we couldn't fetch right now
        "fx_rates": fx_rates,           # e.g. {"PLN": 0.234} → note "approximate" in UI
        "fx_unavailable": fx_unavailable,
        "positions": positions,
        "closed_positions": closed_positions,
    }


# ---- Portfolio value history (reconstructed, not snapshotted) ----------------

_HISTORY_RANGES = {"1mo": 31, "3mo": 92, "1y": 366, "max": None}
_history_cache: dict[int, tuple[int, list[dict]]] = {}


@app.get("/api/portfolios/{portfolio_id}/history")
def portfolio_history(portfolio_id: int, range: str = Query("max")):
    """Day-by-day portfolio value since the first operation, rebuilt from the
    transaction/deposit ledger with historical closes and FX rates (one batch
    request per ticker/pair). Cached in memory; the signature covers every
    ledger row and today's date, so any edit — or a new day — invalidates it."""
    if range not in _HISTORY_RANGES:
        raise HTTPException(status_code=400, detail=f"range must be one of {sorted(_HISTORY_RANGES)}")
    portfolio = _get_portfolio_or_404(portfolio_id)
    pcur = portfolio["currency"]
    txns = db.get_transactions(portfolio_id)
    deps = [dict(d) for d in db.get_deposits(portfolio_id)]
    if not txns and not deps:
        return {"currency": pcur, "points": []}

    signature = hash((
        date_type.today().isoformat(),
        tuple(sorted((t["id"], t["date"], t["ticker"], t["type"], t["shares"], t["price"],
                      t.get("fee") or 0, t.get("currency") or "") for t in txns)),
        tuple(sorted((d["id"], d["date"], d["amount"], d.get("type") or "DEPOSIT") for d in deps)),
    ))
    cached = _history_cache.get(portfolio_id)
    if cached and cached[0] == signature:
        points = cached[1]
    else:
        start = min(x["date"][:10] for x in [*txns, *deps])
        instruments = db.get_instruments(sorted({t["ticker"] for t in txns}))
        txns_fx = [
            {**t, "currency": t.get("currency") or (instruments.get(t["ticker"]) or {}).get("currency")}
            for t in txns
        ]

        price_series = {}
        for ticker in sorted({t["ticker"] for t in txns}):
            series = get_close_series(ticker, start)
            if series is None:
                # no historical quotes at all — anchor on the transaction
                # prices themselves (step function), better than valuing at 0
                series = {t["date"][:10]: t["price"] for t in txns if t["ticker"] == ticker}
            price_series[ticker] = series

        fx_series = {}
        for currency in sorted({t["currency"] for t in txns_fx if t["currency"] and t["currency"] != pcur}):
            fx_series[currency] = get_close_series(f"{currency}{pcur}=X", start) or {}

        points = reconstruct_history(deps, txns_fx, price_series, fx_series, pcur)
        _history_cache[portfolio_id] = (signature, points)

    days = _HISTORY_RANGES[range]
    if days is not None and len(points) > days:
        points = points[-days:]
    return {"currency": pcur, "points": points}


# ---- Deposits ---------------------------------------------------------------

@app.get("/api/portfolios/{portfolio_id}/deposits")
def list_deposits(portfolio_id: int):
    _get_portfolio_or_404(portfolio_id)
    return [dict(d) for d in db.get_deposits(portfolio_id)]


@app.post("/api/portfolios/{portfolio_id}/deposits", status_code=201)
def create_deposit(portfolio_id: int, body: DepositIn):
    _get_portfolio_or_404(portfolio_id)
    deposit_id = db.add_deposit(body.amount, portfolio_id, body.date or date_type.today().isoformat())
    return {"id": deposit_id}


def _min_running_cash(portfolio, deposits: list[dict]) -> float:
    """Lowest cash balance at any point of the portfolio's timeline, replaying
    deposits/withdrawals and transaction cash flows day by day (inflows before
    outflows within one day, foreign currencies at the current rate — the same
    approximation as everywhere else)."""
    pcur = portfolio["currency"]
    txns = db.get_transactions(portfolio["id"])
    instruments = db.get_instruments(sorted({t["ticker"] for t in txns}))

    def rate_for(currency: str | None) -> float:
        r = _fx_rate(currency or pcur, pcur)
        return r if r is not None else 1.0

    events = []  # (day, inflow_first_priority, amount)
    for d in deposits:
        signed = d["amount"] if d.get("type", "DEPOSIT") == "DEPOSIT" else -d["amount"]
        events.append((d["date"][:10], 0 if signed >= 0 else 1, signed))
    for t in txns:
        exact = t.get("cash_amount")  # broker-settled amount (imports): exact
        if exact is not None:
            flow = -exact if t["type"] == "BUY" else exact
        else:
            currency = t.get("currency") or (instruments.get(t["ticker"]) or {}).get("currency")
            fee = t.get("fee", 0.0) or 0.0
            gross = t["shares"] * t["price"]
            flow = (-(gross + fee) if t["type"] == "BUY" else gross - fee) * rate_for(currency)
        events.append((t["date"][:10], 0 if flow >= 0 else 1, flow))

    cash = 0.0
    lowest = 0.0
    for _, _, amount in sorted(events, key=lambda e: (e[0], e[1])):
        cash += amount
        lowest = min(lowest, cash)
    return lowest


def _validate_deposit_change(portfolio, new_rows: list[dict], operation: str):
    """The edit/delete may not push the running cash balance negative at any
    point in history. Portfolios that are already negative somewhere (e.g.
    buys recorded before their deposit) keep their current floor — the change
    just must not make things worse."""
    current = [dict(d) for d in db.get_deposits(portfolio["id"])]
    floor = min(0.0, _min_running_cash(portfolio, current))
    if _min_running_cash(portfolio, new_rows) < floor - 1e-9:
        raise HTTPException(
            status_code=400,
            detail=f"Nie można {operation}: saldo gotówki byłoby ujemne w historii "
                   f"(późniejsze zakupy/wypłaty straciłyby pokrycie)",
        )


@app.put("/api/deposits/{deposit_id}")
def update_deposit(deposit_id: int, body: DepositUpdate):
    old = db.get_deposit(deposit_id)
    if old is None:
        raise HTTPException(status_code=404, detail="Deposit not found")
    portfolio = db.get_portfolio_by_id(old["portfolio_id"])
    new_rows = [
        {**d, "amount": body.amount, "date": body.date, "note": body.note}
        if d["id"] == deposit_id else dict(d)
        for d in (dict(r) for r in db.get_deposits(old["portfolio_id"]))
    ]
    _validate_deposit_change(portfolio, new_rows, "zapisać zmian")
    db.update_deposit(deposit_id, body.amount, body.date, body.note)
    return {"id": deposit_id}


@app.delete("/api/deposits/{deposit_id}")
def remove_deposit(deposit_id: int):
    old = db.get_deposit(deposit_id)
    if old is None:
        raise HTTPException(status_code=404, detail="Deposit not found")
    portfolio = db.get_portfolio_by_id(old["portfolio_id"])
    new_rows = [dict(d) for d in db.get_deposits(old["portfolio_id"]) if d["id"] != deposit_id]
    _validate_deposit_change(portfolio, new_rows, "usunąć wpisu")
    db.delete_deposit(deposit_id)
    return {"deleted": deposit_id}


@app.post("/api/portfolios/{portfolio_id}/withdrawals", status_code=201)
def create_withdrawal(portfolio_id: int, body: WithdrawalIn):
    portfolio = _get_portfolio_or_404(portfolio_id)
    cash = _current_cash(portfolio)
    if body.amount > cash + 1e-9:
        raise HTTPException(
            status_code=400,
            detail=f"Nie można wypłacić {body.amount:.2f} — dostępna gotówka: {cash:.2f} {portfolio['currency']}",
        )
    withdrawal_id = db.add_deposit(
        body.amount, portfolio_id, body.date or date_type.today().isoformat(),
        type_="WITHDRAWAL", note=body.note,
    )
    return {"id": withdrawal_id}


# ---- Transactions -----------------------------------------------------------

def _txn_currency(ticker: str, portfolio) -> str | None:
    inst = _ensure_instrument(ticker)
    return (inst or {}).get("currency") or portfolio["currency"]


@app.post("/api/portfolios/{portfolio_id}/transactions", status_code=201)
def create_transaction(portfolio_id: int, body: TransactionIn):
    portfolio = _get_portfolio_or_404(portfolio_id)
    ticker = body.ticker.upper().strip()
    txn_date = body.date or date_type.today().isoformat()

    if body.type == "SELL":
        existing = db.get_transactions(portfolio_id, ticker)
        candidate = {
            "id": None, "ticker": ticker, "type": "SELL", "shares": body.shares,
            "price": body.price, "fee": body.fee, "date": txn_date, "note": body.note,
        }
        try:
            validate_sell(existing, candidate)
        except OversellError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    txn_id = db.add_transaction(
        portfolio_id, ticker, body.type, body.shares, body.price,
        body.fee, txn_date, body.note, currency=_txn_currency(ticker, portfolio),
    )
    return {"id": txn_id}


def _replay_or_400(transactions: list[dict], operation: str):
    """Hard edit/delete guard: the resulting history must never go share-
    negative at any point (e.g. a sell left without its covering buy)."""
    try:
        replay_fifo(transactions)
    except OversellError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Nie można {operation}: historia miałaby ujemny stan akcji ({exc})",
        )


@app.put("/api/transactions/{txn_id}")
def update_transaction(txn_id: int, body: TransactionIn):
    old = db.get_transaction(txn_id)
    if old is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    portfolio = db.get_portfolio_by_id(old["portfolio_id"])
    new_ticker = body.ticker.upper().strip()
    txn_date = body.date or old["date"]
    updated = {
        "id": txn_id, "ticker": new_ticker, "type": body.type, "shares": body.shares,
        "price": body.price, "fee": body.fee, "date": txn_date, "note": body.note,
    }

    if new_ticker == old["ticker"]:
        txns = [updated if t["id"] == txn_id else t
                for t in db.get_transactions(old["portfolio_id"], old["ticker"])]
        _replay_or_400(txns, "zapisać zmian")
    else:
        # moved to another ticker: both histories must stay valid
        old_txns = [t for t in db.get_transactions(old["portfolio_id"], old["ticker"])
                    if t["id"] != txn_id]
        _replay_or_400(old_txns, "zapisać zmian")
        new_txns = db.get_transactions(old["portfolio_id"], new_ticker) + [updated]
        _replay_or_400(new_txns, "zapisać zmian")

    db.update_transaction(
        txn_id, new_ticker, body.type, body.shares, body.price, body.fee,
        txn_date, body.note, currency=_txn_currency(new_ticker, portfolio),
    )
    return {"id": txn_id}


@app.delete("/api/transactions/{txn_id}")
def remove_transaction(txn_id: int):
    """Hard delete — for mis-entered transactions. This is NOT a sell: the row
    simply disappears from history and every derived number is recomputed."""
    old = db.get_transaction(txn_id)
    if old is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    remaining = [t for t in db.get_transactions(old["portfolio_id"], old["ticker"])
                 if t["id"] != txn_id]
    _replay_or_400(remaining, "usunąć transakcji")
    db.delete_transaction(txn_id)
    return {"deleted": txn_id}


# ---- Instrument metadata ------------------------------------------------------

@app.get("/api/instrument/{ticker}")
def instrument(ticker: str):
    inst = _ensure_instrument(ticker)
    if inst is None:
        raise HTTPException(status_code=404, detail="Instrument metadata unavailable")
    return inst


@app.put("/api/instrument/{ticker}")
def set_instrument_type(ticker: str, body: InstrumentTypeIn):
    """Manual type override — Yahoo often labels ETCs (commodity trackers)
    as ETF or EQUITY, so the user can correct it per instrument."""
    if db.get_instrument(ticker) is None and _ensure_instrument(ticker) is None:
        raise HTTPException(status_code=404, detail="Instrument metadata unavailable")
    db.set_instrument_type(ticker, body.type)
    return db.get_instrument(ticker)


# ---- Import (XTB) -----------------------------------------------------------

_IMPORT_MAX_BYTES = 10 * 1024 * 1024

# proceeds of investing (P&L), as opposed to capital moved in/out. Rights
# issues are deliberately NOT income (their cash usually offsets a dilution
# drop in the share price — counting them as profit would double-count) but
# not user-contributed capital either → the third bucket, RETURN.
_INCOME_KINDS = {"DIVIDEND", "TAX", "INTEREST"}


def _import_category(kind: str) -> str:
    if kind in _INCOME_KINDS:
        return "INCOME"
    if kind == "RIGHTS":
        return "RETURN"
    return "CONTRIBUTION"


@app.post("/api/portfolios/{portfolio_id}/import/xtb")
async def preview_xtb_import(portfolio_id: int, file: UploadFile = File(...)):
    """Parse an XTB xlsx export and return the operations for the preview
    screen — nothing is written here. Each operation carries `already_exists`
    (its XTB id is in this portfolio) and, for trades, `ticker_verified`
    (Yahoo knows the mapped ticker; false → the UI offers a manual correction
    field) plus an amount-vs-shares×price verdict that accounts for foreign
    currencies (the implied rate IS the FX rate for e.g. a DKK instrument on
    a PLN account — only same-currency mismatches are real errors)."""
    portfolio = _get_portfolio_or_404(portfolio_id)
    content = await file.read()
    if len(content) > _IMPORT_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Plik jest za duży (limit 10 MB)")
    try:
        parsed = parse_xtb_export(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    existing = db.get_external_ids(portfolio_id)
    trade_tickers = sorted({
        op["ticker"] for op in parsed["operations"]
        if op["ticker"] and op["kind"] in ("BUY", "SELL")
    })
    instruments = {t: _ensure_instrument(t) for t in trade_tickers}  # fail-soft: None → unverified

    # manually-entered transactions have no external_id, so the id-based
    # duplicate check can't see them — match by substance instead, or the
    # import doubles positions entered by hand before the import feature
    manual = {
        (t["ticker"], t["type"], t["date"][:10])
        : (t["shares"], t["price"])
        for ticker in trade_tickers
        for t in db.get_transactions(portfolio_id, ticker)
        if not t.get("external_id")
    }

    def matches_manual(op) -> bool:
        key = (op["ticker"], op["kind"], op["date"])
        if key not in manual:
            return False
        shares, price = manual[key]
        return (abs(shares - op["shares"]) < 1e-6
                and abs(price - op["price"]) <= 0.005 * max(price, op["price"]))

    for op in parsed["operations"]:
        op["already_exists"] = op["external_id"] is not None and op["external_id"] in existing
        if op["kind"] not in ("BUY", "SELL"):
            op["ticker_verified"] = None
            op["instrument_currency"] = None
            op["similar_exists"] = False
            continue
        op["similar_exists"] = not op["already_exists"] and matches_manual(op)
        inst = instruments.get(op["ticker"]) if op["ticker"] else None
        op["ticker_verified"] = (inst is not None) if op["ticker"] else None
        icur = (inst or {}).get("currency")
        op["instrument_currency"] = icur
        rate = op.get("implied_rate")
        if rate is not None and not rate_is_unity(rate, op["amount"]):
            if icur is None:
                op["warning"] = f"cena wygląda na obcą walutę (implikowany kurs {rate:.4g})"
            elif icur == portfolio["currency"]:
                op["warning"] = (
                    f"kwota {op['amount']:.2f} nie zgadza się z ilość×cena "
                    f"({(op['shares'] or 0) * (op['price'] or 0):.2f})"
                )
            # differing known currency: the rate is the FX conversion — fine
    return {"operations": parsed["operations"], "warnings": parsed["warnings"]}


def _import_txn_currency(op: ImportOperationIn, portfolio) -> str:
    """Currency an imported trade is recorded in. XTB comment prices are in
    the instrument's currency: when |Amount| ≈ shares×price the instrument
    trades in the account currency (also the GBp-on-LSE case — the paid price
    is never rescaled); otherwise take Yahoo's instrument currency, with GBp
    normalized to GBP since XTB prices are in pounds, not pence."""
    rate = op.amount / (op.shares * op.price) if op.shares and op.price else None
    if rate is None or rate_is_unity(rate, op.amount):
        return portfolio["currency"]
    icur = (_ensure_instrument(op.ticker) or {}).get("currency")
    if icur == "GBp":
        icur = "GBP"
    return icur or portfolio["currency"]


@app.post("/api/portfolios/{portfolio_id}/import/xtb/commit", status_code=201)
def commit_xtb_import(portfolio_id: int, body: ImportCommitIn):
    """Persist the rows the user kept selected. Duplicates (external_id already
    in the portfolio) are skipped, the whole batch is FIFO-validated per ticker
    BEFORE any write. Trades keep the file's prices in the instrument's
    currency (see _import_txn_currency); every other kind is a cash flow in
    the deposits table, direction from `cash_type`."""
    portfolio = _get_portfolio_or_404(portfolio_id)
    existing = db.get_external_ids(portfolio_id)

    to_import: list[ImportOperationIn] = []
    skipped = 0
    seen: set[str] = set()
    for op in body.operations:
        if op.external_id and (op.external_id in existing or op.external_id in seen):
            skipped += 1
            continue
        if op.kind in ("BUY", "SELL"):
            if not (op.ticker or "").strip() or op.shares is None or op.price is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Operacja {op.kind} (ID {op.external_id}) wymaga tickera, ilości i ceny",
                )
        if op.external_id:
            seen.add(op.external_id)
        to_import.append(op)

    # every sell must be covered at its point in the merged timeline — check
    # per ticker before writing anything, so a rejected import writes nothing
    txn_ops = [op for op in to_import if op.kind in ("BUY", "SELL")]
    for ticker in sorted({op.ticker.upper().strip() for op in txn_ops}):
        candidates = [
            {"id": None, "ticker": ticker, "type": op.kind, "shares": op.shares,
             "price": op.price, "fee": 0.0, "date": op.date, "note": op.note}
            for op in txn_ops if op.ticker.upper().strip() == ticker
        ]
        try:
            replay_fifo(db.get_transactions(portfolio_id, ticker) + candidates)
        except OversellError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Import odrzucony: sprzedaż bez pokrycia dla {ticker} ({exc})",
            )

    imported = 0
    for op in to_import:
        if op.kind in ("BUY", "SELL"):
            db.add_transaction(
                portfolio_id, op.ticker.upper().strip(), op.kind, op.shares, op.price,
                0.0, op.date, op.note, currency=_import_txn_currency(op, portfolio),
                external_id=op.external_id,
                cash_amount=op.amount,  # the exact settled amount — cash stays true
            )
        else:  # dividends, interest, taxes, transfers… — cash flows
            db.add_deposit(op.amount, portfolio_id, op.date,
                           type_=op.cash_type or "DEPOSIT", note=op.note,
                           external_id=op.external_id,
                           category=_import_category(op.kind))
        imported += 1
    return {"imported": imported, "skipped_duplicates": skipped}


# ---- Position detail --------------------------------------------------------

@app.get("/api/positions/{portfolio_id}/{ticker}")
def position_detail(portfolio_id: int, ticker: str):
    portfolio = _get_portfolio_or_404(portfolio_id)
    ticker = ticker.upper()
    txns = db.get_transactions(portfolio_id, ticker)
    if not txns:
        raise HTTPException(status_code=404, detail="No transactions for this ticker")

    state = replay_fifo(txns)
    price = _cached_price(ticker)
    summary = position_summary(state, price)
    inst = db.get_instrument(ticker) or _ensure_instrument(ticker)

    lots = []
    for lot in state["open_lots"]:
        value_today = pnl = pnl_pct = None
        if price is not None:
            value_today = lot["shares_remaining"] * price
            pnl = value_today - lot["cost_basis"]
            pnl_pct = (pnl / lot["cost_basis"] * 100) if lot["cost_basis"] > 0 else 0.0
        lots.append({**lot, "value_today": value_today, "pnl": pnl, "pnl_pct": pnl_pct})

    icur = (inst or {}).get("currency") or portfolio["currency"]
    return {
        "ticker": ticker,
        "instrument": inst,  # {name, type, exchange, currency} or None
        "currency": icur,
        "portfolio_currency": portfolio["currency"],
        # current instrument→portfolio rate, for ≈-converting rows that lack a
        # broker-settled amount; None when currencies match or no quote
        "fx_rate": _fx_rate(icur, portfolio["currency"]) if icur != portfolio["currency"] else None,
        "summary": summary,
        "lots": lots,
        "sales": state["sales"],
        "transactions": txns,
    }


# ---- Chart ------------------------------------------------------------------

_RANGES = {"1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"}
# intraday ranges need intraday candles — everything longer stays daily
_RANGE_INTERVALS = {"1d": "15m", "5d": "1h"}
_INTERVALS = {"15m", "30m", "1h", "1d", "1wk"}


@app.get("/api/chart/{ticker}")
def chart(ticker: str, range: str = Query("3mo"), interval: str | None = Query(None),
          portfolio_id: int | None = None):
    """OHLC candles from yfinance plus this portfolio's transaction markers.
    Marker status: 'open' = buy lot still (partially) held, 'closed' = buy lot
    fully consumed by sells, 'sell' = a sell transaction. Interval defaults
    per range (15m for 1d, 1h for 5d, 1d otherwise). Markers are day-granular,
    so intraday charts render without them."""
    if range not in _RANGES:
        raise HTTPException(status_code=400, detail=f"range must be one of {sorted(_RANGES)}")
    if interval is None:
        interval = _RANGE_INTERVALS.get(range, "1d")
    if interval not in _INTERVALS:
        raise HTTPException(status_code=400, detail=f"interval must be one of {sorted(_INTERVALS)}")
    ticker = ticker.upper()
    df = get_history(ticker, period=range, interval=interval)
    if df is None:
        raise HTTPException(status_code=404, detail=f"No chart data for {ticker}")

    candles = []
    for idx, row in df.iterrows():
        ohlc = [safe_float(row[k]) for k in ("Open", "High", "Low", "Close")]
        if any(v is None for v in ohlc):  # NaN row (halted session etc.) — drop it
            continue
        candles.append({
            "time": idx.strftime("%Y-%m-%d") if interval.endswith(("d", "wk", "mo")) else int(idx.timestamp()),
            "open": round(ohlc[0], 4),
            "high": round(ohlc[1], 4),
            "low": round(ohlc[2], 4),
            "close": round(ohlc[3], 4),
        })

    # markers snap server-side to the nearest existing candle (a weekend
    # transaction lands on Friday/Monday), so every returned marker time is
    # guaranteed to exist in `candles` — lightweight-charts drops unknown times
    candle_times = [c["time"] for c in candles if isinstance(c["time"], str)]

    def snap_to_candle(day: str) -> str | None:
        if not candle_times or day < candle_times[0]:
            return None  # predates the loaded range — nothing to anchor to
        i = bisect_left(candle_times, day)
        if i >= len(candle_times):
            return candle_times[-1]  # after the last session (e.g. today, pre-open)
        if candle_times[i] == day:
            return day
        before, after = candle_times[i - 1], candle_times[i]
        d = date_type.fromisoformat(day)
        d_before = (d - date_type.fromisoformat(before)).days
        d_after = (date_type.fromisoformat(after) - d).days
        return before if d_before <= d_after else after

    markers = []
    if portfolio_id is not None:
        txns = db.get_transactions(portfolio_id, ticker)
        state = replay_fifo(txns)
        open_buy_ids = {lot["txn_id"] for lot in state["open_lots"]}
        for txn in txns:
            snapped = snap_to_candle(txn["date"][:10])
            if snapped is None:
                continue
            if txn["type"] == "BUY":
                status = "open" if txn["id"] in open_buy_ids else "closed"
            else:
                status = "sell"
            markers.append({
                "time": snapped,
                "type": txn["type"],
                "status": status,
                "shares": txn["shares"],
                "price": txn["price"],
                "date": txn["date"][:10],
            })

    return {
        "ticker": ticker,
        "candles": candles,
        "markers": markers,
        "current_price": _cached_price(ticker),
    }


# ---- Ticker search (Yahoo proxy, avoids CORS in the browser) -----------------

@app.get("/api/search")
def search(q: str = Query(min_length=1)):
    try:
        resp = requests.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": q, "quotesCount": 8, "newsCount": 0},
            headers={"User-Agent": "Mozilla/5.0 (AlphaBot local)"},
            timeout=8,
        )
        resp.raise_for_status()
        quotes = resp.json().get("quotes", [])
    except Exception as exc:  # fail-soft like data/yahoo.py — empty list, not a 500
        logger.warning("Yahoo search failed for %r: %s", q, exc)
        return []

    return [
        {
            "symbol": item.get("symbol"),
            "name": item.get("shortname") or item.get("longname") or "",
            "exchange": item.get("exchDisp") or item.get("exchange") or "",
            "type": item.get("quoteType"),
        }
        for item in quotes
        if item.get("symbol") and item.get("quoteType") in ("EQUITY", "ETF")
    ]


# ---- Frontend (built React app) ----------------------------------------------

if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        # client-side routing: any non-API path gets index.html. no-cache =
        # always revalidate (ETag → 304), so a rebuilt frontend shows up on
        # the next load instead of after a manual hard refresh — the JS/CSS
        # under /assets are content-hashed, only this shell goes stale.
        candidate = FRONTEND_DIST / full_path
        target = candidate if full_path and candidate.is_file() else FRONTEND_DIST / "index.html"
        return FileResponse(target, headers={"Cache-Control": "no-cache"})


def run_server(port: int = 8000, open_browser: bool = True):
    import uvicorn

    if not FRONTEND_DIST.is_dir():
        logger.warning(
            "Frontend not built (web/frontend/dist missing) — API only. "
            "Run: cd web/frontend && npm install && npm run build"
        )
    if open_browser:
        threading.Timer(1.0, webbrowser.open, args=(f"http://localhost:{port}",)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
