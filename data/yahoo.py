"""Thin wrapper around yfinance. Every function fails soft: on any error it
logs and returns None (or an empty structure) instead of raising, so a bad
ticker or a flaky Yahoo response never crashes the caller.
"""
from __future__ import annotations

import logging
import math
import re

import pandas as pd
import yfinance as yf

logger = logging.getLogger("alphabot.yahoo")


def safe_float(value) -> float | None:
    """NaN/inf/None/unparseable → None. Every float that leaves the yfinance
    layer must pass through here — raw NaN poisons sums downstream and is not
    JSON-serializable, so an unsanitized quote can 500 an API endpoint."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def get_info(ticker: str) -> dict | None:
    try:
        info = yf.Ticker(ticker).get_info()
        if not info or info.get("regularMarketPrice") is None and info.get("currentPrice") is None:
            return None
        return info
    except Exception as exc:
        logger.warning("get_info(%s) failed: %s", ticker, exc)
        return None


def get_history(ticker: str, period: str = "6mo", interval: str = "1d") -> pd.DataFrame | None:
    try:
        df = yf.Ticker(ticker).history(period=period, interval=interval)
        if df is None or df.empty:
            return None
        return df
    except Exception as exc:
        logger.warning("get_history(%s) failed: %s", ticker, exc)
        return None


def get_current_price(ticker: str) -> float | None:
    """Current price with a fallback chain — some listings (e.g. WSE tickers
    like DNP.WA) miss one source while another works fine:
      1. fast_info.last_price
      2. info.currentPrice / info.regularMarketPrice
      3. history(period="5d") → last Close
    Each failed step logs a warning so gaps are diagnosable; only when all
    three fail does this return None ("cena niedostępna")."""
    tk = yf.Ticker(ticker)

    try:
        price = safe_float(getattr(tk.fast_info, "last_price", None))
        if price is not None:
            return price
    except Exception as exc:
        logger.warning("get_current_price(%s): fast_info.last_price raised: %s", ticker, exc)
    logger.warning("get_current_price(%s): fast_info.last_price unavailable, trying info", ticker)

    try:
        info = tk.get_info() or {}
        price = safe_float(info.get("currentPrice"))
        if price is None:
            price = safe_float(info.get("regularMarketPrice"))
        if price is not None:
            return price
    except Exception as exc:
        logger.warning("get_current_price(%s): get_info() raised: %s", ticker, exc)
    logger.warning("get_current_price(%s): info current/regularMarketPrice unavailable, trying history", ticker)

    hist = get_history(ticker, period="5d")
    if hist is not None and not hist.empty:
        try:
            price = safe_float(hist["Close"].iloc[-1])
            if price is not None:
                return price
        except (IndexError, KeyError):
            pass
    logger.warning("get_current_price(%s): all price sources failed", ticker)
    return None


def get_close_series(ticker: str, start: str) -> dict[str, float] | None:
    """Sparse {iso_date: close} from `start` (ISO day) to today, one batch
    request per ticker — feeds the portfolio-value reconstruction. Fails soft."""
    try:
        df = yf.Ticker(ticker).history(start=start, interval="1d")
        if df is None or df.empty or "Close" not in df:
            return None
        out = {}
        for idx, value in df["Close"].items():
            v = safe_float(value)
            if v is not None:
                out[idx.strftime("%Y-%m-%d")] = v
        return out or None
    except Exception as exc:
        logger.warning("get_close_series(%s) failed: %s", ticker, exc)
        return None


# Commodity trackers (ETCs) are legally companies — e.g. "iShares Physical
# Metals plc" — so Yahoo's quoteType calls them EQUITY (or ETF); the name is
# the reliable signal. Matches a standalone "ETC" or "physical <metal>".
_ETC_NAME_RE = re.compile(
    r"\betc\b|\bphysical\b.*\b(?:gold|silver|platinum|palladium|metals?)\b", re.IGNORECASE
)


def derive_instrument_type(quote_type: str | None, *names: str | None) -> str:
    """Yahoo's quoteType corrected for ETCs by inspecting the instrument
    names. Pure helper (unit-tested); manual overrides via the web app still
    win, since cached instruments are never re-fetched."""
    if _ETC_NAME_RE.search(" ".join(n for n in names if n)):
        return "ETC"
    return quote_type or "EQUITY"


def get_instrument_info(ticker: str) -> dict | None:
    """Instrument metadata for the web app's `instruments` cache: name,
    quote type (EQUITY/ETF/ETC/...), exchange and trading currency. Fails soft."""
    info = get_info(ticker)
    if info is None:
        return None
    return {
        "ticker": ticker.upper(),
        "name": info.get("shortName") or info.get("longName") or ticker.upper(),
        "type": derive_instrument_type(
            info.get("quoteType"), info.get("shortName"), info.get("longName")
        ),
        "exchange": info.get("fullExchangeName") or info.get("exchange") or "",
        "currency": info.get("currency"),
    }


def calculate_rsi(closes: pd.Series, period: int = 14) -> float | None:
    """Standard Wilder RSI on a series of closing prices."""
    if closes is None or len(closes) < period + 1:
        return None
    delta = closes.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(window=period).mean()
    avg_loss = loss.rolling(window=period).mean()
    last_gain = avg_gain.iloc[-1]
    last_loss = avg_loss.iloc[-1]
    if last_loss == 0:
        return 100.0
    rs = last_gain / last_loss
    rsi = 100 - (100 / (1 + rs))
    return float(rsi) if pd.notna(rsi) else None


def volume_above_30d_avg(df: pd.DataFrame) -> bool | None:
    if df is None or len(df) < 31 or "Volume" not in df:
        return None
    avg_30d = df["Volume"].iloc[-31:-1].mean()
    latest = df["Volume"].iloc[-1]
    if pd.isna(avg_30d) or avg_30d == 0:
        return None
    return bool(latest > avg_30d)


def get_screener_metrics(ticker: str) -> dict | None:
    """Pull the fields the scanner's screening criteria need, in one place."""
    info = get_info(ticker)
    hist = get_history(ticker, period="6mo")
    if info is None or hist is None:
        return None

    closes = hist["Close"]
    rsi = calculate_rsi(closes)
    vol_above_avg = volume_above_30d_avg(hist)

    return {
        "ticker": ticker,
        "name": info.get("shortName") or info.get("longName") or ticker,
        "market_cap": info.get("marketCap"),
        "pe_ratio": info.get("trailingPE"),
        "revenue_growth": info.get("revenueGrowth"),  # fraction, e.g. 0.12 = 12%
        "rsi": rsi,
        "volume_above_30d_avg": vol_above_avg,
        "current_price": safe_float(closes.iloc[-1]) if len(closes) else None,
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }


def get_market_snapshot() -> dict:
    """S&P 500 daily move + VIX level, best-effort. Missing pieces are None."""
    snapshot = {"sp500_change_pct": None, "sp500_price": None, "vix": None}
    try:
        sp500 = get_history("^GSPC", period="5d")
        if sp500 is not None and len(sp500) >= 2:
            prev, last = sp500["Close"].iloc[-2], sp500["Close"].iloc[-1]
            snapshot["sp500_change_pct"] = round((last - prev) / prev * 100, 2)
            snapshot["sp500_price"] = round(float(last), 2)
    except Exception as exc:
        logger.warning("S&P 500 snapshot failed: %s", exc)

    try:
        vix = get_history("^VIX", period="5d")
        if vix is not None and len(vix) >= 1:
            snapshot["vix"] = round(float(vix["Close"].iloc[-1]), 2)
    except Exception as exc:
        logger.warning("VIX snapshot failed: %s", exc)

    return snapshot
