"""Market screener + Claude-driven signal selection.

Screens a curated US universe (tech / healthcare / fintech) against 5 simple
criteria, keeps candidates meeting >=3 of them (max 10), then asks Claude to
pick the top 3 with a reason, entry zone, stop-loss and target.
"""
import json
import logging

from agents.llm import MODEL, get_client
from data.yahoo import get_market_snapshot, get_screener_metrics
from db import get_portfolio, record_signal
from notify import send_notification

logger = logging.getLogger("alphabot.scanner")

UNIVERSE = {
    "tech": [
        "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMD", "CRM", "ADBE",
        "NOW", "PANW", "SNOW", "CRWD", "AVGO", "ORCL", "INTU",
    ],
    "healthcare": [
        "UNH", "JNJ", "LLY", "PFE", "ABBV", "MRK", "TMO", "ISRG",
        "VRTX", "REGN", "DXCM", "IDXX",
    ],
    "fintech": [
        "V", "MA", "PYPL", "XYZ", "COIN", "SOFI", "FI", "AXP", "MSCI", "SPGI",
    ],
}

MIN_MARKET_CAP = 2_000_000_000
MAX_PE = 30
MIN_REVENUE_GROWTH = 0.10
RSI_LOW, RSI_HIGH = 35, 65
MIN_CRITERIA_MET = 3
MAX_CANDIDATES = 10

PICKS_SCHEMA = {
    "type": "object",
    "properties": {
        "market_commentary": {
            "type": "string",
            "description": "2-4 sentence US market mood: S&P 500, VIX, overall sentiment.",
        },
        "picks": {
            "type": "array",
            "minItems": 0,
            "maxItems": 3,
            "items": {
                "type": "object",
                "properties": {
                    "ticker": {"type": "string"},
                    "reason": {"type": "string", "description": "Why this stock, 1-2 sentences."},
                    "entry_zone": {"type": "string", "description": "e.g. '$180-$185'"},
                    "stop_loss": {"type": "number"},
                    "target": {"type": "number"},
                },
                "required": ["ticker", "reason", "entry_zone", "stop_loss", "target"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["market_commentary", "picks"],
    "additionalProperties": False,
}


def _score_candidate(metrics: dict) -> int:
    score = 0
    if metrics.get("market_cap") and metrics["market_cap"] > MIN_MARKET_CAP:
        score += 1
    pe = metrics.get("pe_ratio")
    if pe is None or pe < MAX_PE:  # missing PE is fine — treated as a growth stock
        score += 1
    rg = metrics.get("revenue_growth")
    if rg is not None and rg > MIN_REVENUE_GROWTH:
        score += 1
    rsi = metrics.get("rsi")
    if rsi is not None and RSI_LOW <= rsi <= RSI_HIGH:
        score += 1
    if metrics.get("volume_above_30d_avg") is True:
        score += 1
    return score


def screen_universe() -> list[dict]:
    candidates = []
    for sector, tickers in UNIVERSE.items():
        for ticker in tickers:
            metrics = get_screener_metrics(ticker)
            if metrics is None:
                continue
            metrics["sector_bucket"] = sector
            metrics["criteria_met"] = _score_candidate(metrics)
            if metrics["criteria_met"] >= MIN_CRITERIA_MET:
                candidates.append(metrics)

    candidates.sort(key=lambda m: (m["criteria_met"], m.get("market_cap") or 0), reverse=True)
    return candidates[:MAX_CANDIDATES]


def _ask_claude_for_picks(candidates: list[dict], market: dict) -> dict:
    client = get_client()

    candidate_lines = []
    for c in candidates:
        candidate_lines.append(
            f"- {c['ticker']} ({c.get('name')}, {c.get('sector')}): "
            f"price=${c.get('current_price')}, market_cap=${c.get('market_cap')}, "
            f"PE={c.get('pe_ratio')}, revenue_growth={c.get('revenue_growth')}, "
            f"RSI={c.get('rsi')}, volume_above_30d_avg={c.get('volume_above_30d_avg')}, "
            f"criteria_met={c['criteria_met']}/5"
        )
    candidates_block = "\n".join(candidate_lines) if candidate_lines else "(no candidates passed the screen today)"

    prompt = f"""US market snapshot:
- S&P 500: {market.get('sp500_price')} ({market.get('sp500_change_pct')}% today)
- VIX: {market.get('vix')}

Candidate stocks that passed >=3/5 screening criteria (market cap, P/E, revenue growth, RSI 35-65, volume above 30d avg):
{candidates_block}

Pick the top 3 candidates (fewer if fewer look genuinely attractive — never force picks).
For each: a concrete reason grounded in the metrics above, a realistic entry zone, a stop-loss
price and a target price. Also write a short market commentary covering S&P 500 momentum, VIX
level, and general risk sentiment. Be concise and concrete — no filler."""

    response = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        thinking={"type": "disabled"},
        output_config={"format": {"type": "json_schema", "schema": PICKS_SCHEMA}},
        system=(
            "You are AlphaBot's equity scanner analyst. You select short-term swing-trade "
            "candidates for a retail investor from a pre-screened US stock list (NYSE/NASDAQ). "
            "Ground every claim in the numbers you were given — never invent data."
        ),
        messages=[{"role": "user", "content": prompt}],
    )

    text = next((b.text for b in response.content if b.type == "text"), "{}")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        logger.error("Failed to parse Claude scanner output: %s", text)
        return {"market_commentary": "Analysis unavailable (parse error).", "picks": []}


def _portfolio_pnl_summary() -> str:
    from data.yahoo import get_current_price

    positions = get_portfolio()
    if not positions:
        return "Brak otwartych pozycji."

    lines = []
    for p in positions:
        price = get_current_price(p["ticker"])
        if price is None:
            lines.append(f"- {p['ticker']}: brak notowania")
            continue
        pnl_pct = (price - p["buy_price"]) / p["buy_price"] * 100
        sign = "+" if pnl_pct >= 0 else ""
        lines.append(f"- {p['ticker']}: {sign}{pnl_pct:.1f}% (wejście ${p['buy_price']:.2f} -> ${price:.2f})")
    return "\n".join(lines)


def scan_market() -> dict:
    """Run the full screen + Claude selection. Returns the structured result."""
    market = get_market_snapshot()
    candidates = screen_universe()
    result = _ask_claude_for_picks(candidates, market)
    result["market"] = market
    result["candidate_count"] = len(candidates)

    for pick in result.get("picks", []):
        try:
            record_signal(
                ticker=pick["ticker"],
                reason=pick["reason"],
                entry_zone=pick["entry_zone"],
                stop_loss=pick["stop_loss"],
                target=pick["target"],
            )
        except Exception as exc:
            logger.warning("Failed to record signal for %s: %s", pick.get("ticker"), exc)

    return result


def format_scan_message(result: dict, include_portfolio: bool = True) -> str:
    lines = []
    picks = result.get("picks", [])
    if not picks:
        lines.append("Brak sygnałów spełniających kryteria dzisiaj.")
    else:
        for i, p in enumerate(picks, 1):
            lines.append(
                f"{i}. {p['ticker']} — {p['reason']}\n"
                f"   Wejście: {p['entry_zone']} | Stop-loss: ${p['stop_loss']} | Target: ${p['target']}"
            )

    lines.append("")
    lines.append(f"📊 Komentarz rynkowy: {result.get('market_commentary', '')}")

    if include_portfolio:
        lines.append("")
        lines.append("💼 Portfel:")
        lines.append(_portfolio_pnl_summary())

    return "\n".join(lines)


def run_scan_and_notify(title: str = "🔍 AlphaBot Scan"):
    result = scan_market()
    message = format_scan_message(result)
    send_notification(title=title, message=message, priority="default", tags=["mag", "chart_with_upwards_trend"])
    return result


def run_morning_briefing():
    return run_scan_and_notify(title="📊 Morning Briefing")
