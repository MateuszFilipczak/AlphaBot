"""NaN sanitization (a NaN quote must never 500 an endpoint) and
cross-currency positions (PLN-quoted instrument in a EUR portfolio)."""
import math

import pytest
from fastapi.testclient import TestClient

import web.server as server


def make_client(monkeypatch, prices: dict, instrument_currency: str):
    """TestClient with yfinance stubbed at the layer server code calls:
    get_current_price (quotes + FX pairs) and get_instrument_info."""
    monkeypatch.setattr(server, "get_current_price", lambda t: prices.get(t))
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} S.A.", "type": "EQUITY",
        "exchange": "WSE", "currency": instrument_currency,
    })
    server._price_cache.clear()
    server._fx_cache.clear()
    return TestClient(server.app)


def portfolio_id(client, currency):
    return next(p["id"] for p in client.get("/api/portfolios").json() if p["currency"] == currency)


# ---- NaN sanitization ---------------------------------------------------------

def test_nan_price_returns_200_and_counts_position_at_cost(monkeypatch):
    client = make_client(monkeypatch, prices={"NANTEST": float("nan")}, instrument_currency="USD")
    pid = portfolio_id(client, "USD")
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 1000, "date": "2026-01-02"})
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "NANTEST", "type": "BUY", "shares": 4, "price": 50,
        "fee": 2, "date": "2026-01-05",
    })
    assert r.status_code == 201

    r = client.get(f"/api/portfolios/{pid}/summary")
    assert r.status_code == 200  # the reported bug: this used to 500 on NaN
    summary = r.json()
    pos = next(p for p in summary["positions"] if p["ticker"] == "NANTEST")

    # no raw NaN anywhere in the position
    assert pos["current_price"] is None
    assert pos["market_value"] is None
    assert pos["unrealized_pnl"] is None
    assert pos["priced"] is False

    # position counts into the total at cost basis (4*50 + 2 fee)
    assert pos["value_pc"] == pytest.approx(202)
    assert "NANTEST" in summary["unpriced_tickers"]
    # and the total is a finite number
    assert math.isfinite(summary["positions_value"])
    assert math.isfinite(summary["total_pnl"])


def test_nan_price_in_position_detail_and_chart_current_price(monkeypatch):
    client = make_client(monkeypatch, prices={"NANTEST": float("nan")}, instrument_currency="USD")
    pid = portfolio_id(client, "USD")
    r = client.get(f"/api/positions/{pid}/NANTEST")
    assert r.status_code == 200
    detail = r.json()
    assert detail["summary"]["market_value"] is None
    assert all(l["value_today"] is None for l in detail["lots"])


def test_safe_float():
    from data.yahoo import safe_float
    assert safe_float(float("nan")) is None
    assert safe_float(float("inf")) is None
    assert safe_float(float("-inf")) is None
    assert safe_float(None) is None
    assert safe_float("abc") is None
    assert safe_float(1.5) == 1.5
    assert safe_float("2.5") == 2.5
    assert safe_float(0) == 0.0


# ---- Cross-currency (PLN instrument in a EUR portfolio) ------------------------

def test_pln_instrument_in_eur_portfolio_converts_at_fx_rate(monkeypatch):
    client = make_client(
        monkeypatch,
        prices={"DNPTEST.WA": 400.0, "PLNEUR=X": 0.25},
        instrument_currency="PLN",
    )
    pid = portfolio_id(client, "EUR")
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 1000, "date": "2026-01-02"})
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "DNPTEST.WA", "type": "BUY", "shares": 2, "price": 380,
        "date": "2026-01-05",
    })
    assert r.status_code == 201

    r = client.get(f"/api/portfolios/{pid}/summary")
    assert r.status_code == 200  # no 500 on mixed currencies
    summary = r.json()
    pos = next(p for p in summary["positions"] if p["ticker"] == "DNPTEST.WA")

    # native values stay in PLN, converted values in EUR at the stubbed rate
    assert pos["currency"] == "PLN"
    assert pos["current_price"] == pytest.approx(400)
    assert pos["market_value"] == pytest.approx(800)      # PLN
    assert pos["fx_rate"] == pytest.approx(0.25)
    assert pos["value_pc"] == pytest.approx(200)          # EUR
    assert pos["unrealized_pnl_pc"] == pytest.approx((800 - 760) * 0.25)

    assert summary["fx_rates"] == {"PLN": pytest.approx(0.25)}
    assert summary["positions_value"] == pytest.approx(200)
    # cash: deposits (EUR) − 760 PLN * 0.25 (approximation at current rate);
    # relative to `deposited` because the shared test DB may hold other deposits
    assert summary["cash"] == pytest.approx(summary["deposited"] - 760 * 0.25)

    # the transaction stored the instrument's currency
    detail = client.get(f"/api/positions/{pid}/DNPTEST.WA").json()
    assert detail["transactions"][0]["currency"] == "PLN"
    assert detail["currency"] == "PLN"


def test_fx_unavailable_falls_back_to_1_and_reports(monkeypatch):
    client = make_client(
        monkeypatch,
        prices={"NOFX.WA": 100.0},  # no PLNEUR=X quote available
        instrument_currency="PLN",
    )
    pid = portfolio_id(client, "EUR")
    client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "NOFX.WA", "type": "BUY", "shares": 1, "price": 100,
        "date": "2026-01-05",
    })
    r = client.get(f"/api/portfolios/{pid}/summary")
    assert r.status_code == 200
    summary = r.json()
    assert "PLN" in summary["fx_unavailable"]
    pos = next(p for p in summary["positions"] if p["ticker"] == "NOFX.WA")
    assert pos["value_pc"] == pytest.approx(100)  # 1:1 fallback, flagged above
