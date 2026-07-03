"""Deep-dive fundamental research on a single ticker: pulls data from
yfinance, then has Claude write the analysis.
"""
from __future__ import annotations

import logging

from agents.llm import MODEL, get_client
from data.yahoo import get_history, get_info
from notify import send_notification

logger = logging.getLogger("alphabot.research")


def _gather_fundamentals(ticker: str) -> dict | None:
    info = get_info(ticker)
    if info is None:
        return None
    hist = get_history(ticker, period="1y")

    fundamentals = {
        "ticker": ticker,
        "name": info.get("shortName") or info.get("longName"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "market_cap": info.get("marketCap"),
        "pe_ratio": info.get("trailingPE"),
        "forward_pe": info.get("forwardPE"),
        "peg_ratio": info.get("pegRatio"),
        "revenue_growth": info.get("revenueGrowth"),
        "earnings_growth": info.get("earningsGrowth"),
        "profit_margins": info.get("profitMargins"),
        "debt_to_equity": info.get("debtToEquity"),
        "free_cashflow": info.get("freeCashflow"),
        "dividend_yield": info.get("dividendYield"),
        "beta": info.get("beta"),
        "52w_high": info.get("fiftyTwoWeekHigh"),
        "52w_low": info.get("fiftyTwoWeekLow"),
        "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
        "target_mean_price": info.get("targetMeanPrice"),
        "recommendation": info.get("recommendationKey"),
        "short_summary": (info.get("longBusinessSummary") or "")[:600],
    }

    if hist is not None and len(hist) >= 2:
        fundamentals["price_1y_ago"] = float(hist["Close"].iloc[0])
        fundamentals["price_change_1y_pct"] = round(
            (fundamentals["current_price"] - fundamentals["price_1y_ago"]) / fundamentals["price_1y_ago"] * 100, 2
        ) if fundamentals["current_price"] else None

    return fundamentals


def research_ticker(ticker: str) -> str:
    """Returns the analysis text. Raises no exceptions for a bad/missing ticker —
    returns a graceful message instead."""
    ticker = ticker.upper().strip()
    fundamentals = _gather_fundamentals(ticker)
    if fundamentals is None:
        return f"Nie udało się pobrać danych dla {ticker} z Yahoo Finance. Sprawdź czy ticker jest poprawny."

    client = get_client()
    prompt = f"""Fundamental data for {ticker} (from yfinance):
{fundamentals}

Write a concise fundamental analysis for a retail investor covering:
1. Business quality & sector positioning (1-2 sentences)
2. Valuation (P/E, PEG, forward P/E vs sector norms)
3. Growth (revenue/earnings growth, margins)
4. Financial health (debt, free cash flow)
5. Bottom line: is this attractive at the current price, and why/why not

Ground every claim in the numbers provided. If a field is missing/None, say so rather than
guessing. Keep it under 250 words, plain text, no markdown headers."""

    response = client.messages.create(
        model=MODEL,
        max_tokens=1500,
        thinking={"type": "disabled"},
        system=(
            "You are AlphaBot's fundamental research analyst for US equities (NYSE/NASDAQ). "
            "Be direct and skeptical — flag red flags as readily as strengths."
        ),
        messages=[{"role": "user", "content": prompt}],
    )

    return next((b.text for b in response.content if b.type == "text"), "Brak odpowiedzi od Claude.")


def run_research_and_notify(ticker: str):
    analysis = research_ticker(ticker)
    send_notification(
        title=f"📈 Research: {ticker.upper()}",
        message=analysis,
        priority="default",
        tags=["mag", "moneybag"],
    )
    return analysis
