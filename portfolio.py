"""Portfolio P&L, stop-loss and max-drawdown monitoring.

Not an "agent" (no Claude calls) — pure numbers from the DB + yfinance.
"""
from __future__ import annotations

import logging

from config import MAX_DRAWDOWN_PCT, STOP_LOSS_PCT
from data.yahoo import get_current_price
from db import (
    add_deposit,
    get_cash_flows_total,
    get_total_deposited,
    get_transactions,
    get_usd_portfolio_id,
    record_equity_snapshot,
)
from engine import build_positions, cash_balance
from notify import send_notification

logger = logging.getLogger("alphabot.portfolio")


def compute_positions() -> list[dict]:
    """Returns per-open-lot P&L for the USD portfolio (the CLI/scheduler's
    portfolio). Lots are derived from transactions via FIFO — one entry per
    open buy lot, so stop-loss alerts still compare against each entry price,
    exactly like the pre-transactions model. Lots whose price can't be fetched
    are still included with price=None so callers can surface the gap."""
    txns = get_transactions(get_usd_portfolio_id())
    positions = []
    for ticker, state in build_positions(txns).items():
        if not state["open_lots"]:
            continue
        price = get_current_price(ticker)
        for lot in state["open_lots"]:
            pnl_pct = None
            pnl_usd = None
            if price is not None:
                pnl_pct = (price - lot["price"]) / lot["price"] * 100
                pnl_usd = (price - lot["price"]) * lot["shares_remaining"]
            positions.append({
                "id": lot["txn_id"],
                "ticker": ticker,
                "shares": lot["shares_remaining"],
                "buy_price": lot["price"],
                "buy_date": lot["date"],
                "current_price": price,
                "pnl_pct": pnl_pct,
                "pnl_usd": pnl_usd,
            })
    return positions


def compute_drawdown(positions: list[dict]) -> dict:
    """Total drawdown = (cost basis - current value) / cost basis, for positions
    we could actually price. Returns 0 drawdown when there's nothing to compare."""
    priced = [p for p in positions if p["current_price"] is not None]
    total_cost = sum(p["buy_price"] * p["shares"] for p in priced)
    total_value = sum(p["current_price"] * p["shares"] for p in priced)
    if total_cost <= 0:
        return {"total_cost": 0.0, "total_value": 0.0, "drawdown_pct": 0.0}
    drawdown_pct = max(0.0, (total_cost - total_value) / total_cost * 100)
    return {"total_cost": total_cost, "total_value": total_value, "drawdown_pct": drawdown_pct}


def compute_capital_summary(positions: list[dict] | None = None, drawdown: dict | None = None) -> dict:
    """Deposited capital vs. capital committed to open positions.

    - total_deposited: sum of the USD portfolio's `deposits` rows
    - invested: cost basis (buy_price * shares) of ALL open positions, priced or not —
      capital committed is capital committed even if we can't fetch a live quote right now
    - available: cash balance = deposits − (buys + fees) + (sells − fees); can go
      negative if you over-invested — that's a signal, not an error
    - total_value / pnl_usd / pnl_pct: reuse compute_drawdown's priced-only totals, so the
      P&L figure matches what's actually shown per-position
    """
    if positions is None:
        positions = compute_positions()
    if drawdown is None:
        drawdown = compute_drawdown(positions)

    usd_id = get_usd_portfolio_id()
    total_deposited = get_total_deposited(usd_id)
    invested = sum(p["buy_price"] * p["shares"] for p in positions)
    # cash starts from ALL flows (incl. dividend/interest income), while
    # total_deposited reports contributed capital only
    available = cash_balance(get_cash_flows_total(usd_id), get_transactions(usd_id))

    pnl_usd = drawdown["total_value"] - drawdown["total_cost"]
    pnl_pct = (pnl_usd / drawdown["total_cost"] * 100) if drawdown["total_cost"] > 0 else 0.0

    return {
        "total_deposited": total_deposited,
        "invested": invested,
        "available": available,
        "total_value": drawdown["total_value"],
        "pnl_usd": pnl_usd,
        "pnl_pct": pnl_pct,
    }


def format_portfolio_message(positions: list[dict], drawdown: dict, capital: dict) -> str:
    lines = []
    if not positions:
        lines.append("Brak otwartych pozycji w portfelu.")
    else:
        for p in positions:
            if p["current_price"] is None:
                lines.append(f"• {p['ticker']}: {p['shares']}x @ ${p['buy_price']:.2f} — brak aktualnej ceny")
                continue
            sign = "+" if p["pnl_pct"] >= 0 else ""
            lines.append(
                f"• {p['ticker']}: {p['shares']}x @ ${p['buy_price']:.2f} -> ${p['current_price']:.2f} "
                f"({sign}{p['pnl_pct']:.1f}%, {sign}${p['pnl_usd']:.2f})"
            )

    pnl_sign = "+" if capital["pnl_usd"] >= 0 else ""
    lines.append("")
    lines.append(f"💵 Wpłacono łącznie: ${capital['total_deposited']:.2f}")
    lines.append(f"📌 Zainwestowano: ${capital['invested']:.2f}")
    lines.append(f"🟢 Dostępne: ${capital['available']:.2f}")
    lines.append(f"📈 Wartość portfela: ${capital['total_value']:.2f}")
    lines.append(f"Total P&L: {pnl_sign}${capital['pnl_usd']:.2f} ({pnl_sign}{capital['pnl_pct']:.1f}%)")
    lines.append(f"Drawdown: {drawdown['drawdown_pct']:.1f}% (limit: {MAX_DRAWDOWN_PCT}%)")
    return "\n".join(lines)


def run_portfolio_and_notify():
    positions = compute_positions()
    drawdown = compute_drawdown(positions)
    capital = compute_capital_summary(positions, drawdown)
    if positions:
        record_equity_snapshot(drawdown["total_cost"], drawdown["total_value"], drawdown["drawdown_pct"])
    message = format_portfolio_message(positions, drawdown, capital)
    send_notification(title="💼 Portfolio", message=message, priority="default", tags=["moneybag"])
    return positions, drawdown, capital


def add_deposit_and_notify(amount_usd: float) -> dict:
    add_deposit(amount_usd)
    capital = compute_capital_summary()
    send_notification(
        title="💰 Deposit Recorded",
        message=f"💰 Deposit ${amount_usd:.2f} recorded. Available capital: ${capital['available']:.2f}",
        priority="default",
        tags=["moneybag", "heavy_plus_sign"],
    )
    return capital


class InsufficientCashError(ValueError):
    """Withdrawal larger than the available cash balance."""


def add_withdrawal_and_notify(amount_usd: float) -> dict:
    """Records a cash withdrawal from the USD portfolio. Refuses to withdraw
    more than the current cash balance (same rule as the web API)."""
    capital = compute_capital_summary()
    if amount_usd > capital["available"] + 1e-9:
        raise InsufficientCashError(
            f"Nie można wypłacić ${amount_usd:.2f} — dostępna gotówka: ${capital['available']:.2f}"
        )
    add_deposit(amount_usd, type_="WITHDRAWAL")
    capital = compute_capital_summary()
    send_notification(
        title="💸 Withdrawal Recorded",
        message=f"💸 Withdrawal ${amount_usd:.2f} recorded. Available capital: ${capital['available']:.2f}",
        priority="default",
        tags=["moneybag", "heavy_minus_sign"],
    )
    return capital


def check_stop_losses_and_drawdown():
    """Meant to be called on a schedule during market hours. Fires urgent
    ntfy alerts on individual stop-loss breaches and on max portfolio drawdown."""
    positions = compute_positions()
    if not positions:
        return

    for p in positions:
        if p["pnl_pct"] is None:
            continue
        if p["pnl_pct"] <= -STOP_LOSS_PCT:
            send_notification(
                title="⚠️ STOP LOSS ALERT",
                message=f"{p['ticker']}: {p['pnl_pct']:.1f}% (wejście ${p['buy_price']:.2f} -> ${p['current_price']:.2f})",
                priority="urgent",
                tags=["warning", "chart_with_downwards_trend"],
            )
            logger.warning("Stop-loss breached for %s: %.1f%%", p["ticker"], p["pnl_pct"])

    drawdown = compute_drawdown(positions)
    record_equity_snapshot(drawdown["total_cost"], drawdown["total_value"], drawdown["drawdown_pct"])
    if drawdown["drawdown_pct"] > MAX_DRAWDOWN_PCT:
        send_notification(
            title="🛑 MAX DRAWDOWN",
            message=(
                f"Portfel przekroczył maksymalny drawdown: {drawdown['drawdown_pct']:.1f}% "
                f"(limit {MAX_DRAWDOWN_PCT}%). Wartość: ${drawdown['total_value']:.2f} "
                f"vs koszt ${drawdown['total_cost']:.2f}."
            ),
            priority="urgent",
            tags=["stop_sign", "rotating_light"],
        )
        logger.warning("Max drawdown exceeded: %.1f%%", drawdown["drawdown_pct"])
