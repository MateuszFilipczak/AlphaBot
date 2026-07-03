"""Chart transaction markers: every returned marker time must exist in the
candles (snapped server-side; weekend transactions land on Friday/Monday)."""
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import web.server as server


def business_days_df(start, end):
    idx = pd.date_range(start, end, freq="B")  # Mon-Fri
    base = [100.0 + i for i in range(len(idx))]
    return pd.DataFrame(
        {"Open": base, "High": [v + 1 for v in base], "Low": [v - 1 for v in base], "Close": base},
        index=idx,
    )


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "_cached_price", lambda ticker: 110.0)
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} Inc.", "type": "EQUITY",
        "exchange": "TEST", "currency": "USD",
    })
    monkeypatch.setattr(server, "get_history",
                        lambda ticker, period="3mo", interval="1d": business_days_df("2026-06-01", "2026-06-12"))
    server._price_cache.clear()
    return TestClient(server.app)


@pytest.fixture()
def pid(client):
    return next(p["id"] for p in client.get("/api/portfolios").json() if p["currency"] == "USD")


def test_two_buys_produce_two_markers_on_existing_candles(client, pid):
    for date, shares in (("2026-06-02", 1), ("2026-06-10", 2)):
        r = client.post(f"/api/portfolios/{pid}/transactions", json={
            "ticker": "MARK1", "type": "BUY", "shares": shares, "price": 100, "date": date,
        })
        assert r.status_code == 201

    chart = client.get(f"/api/chart/MARK1?range=3mo&interval=1d&portfolio_id={pid}").json()
    candle_times = {c["time"] for c in chart["candles"]}

    assert len(chart["markers"]) == 2
    for m in chart["markers"]:
        assert m["time"] in candle_times, f"marker time {m['time']} not on any candle"
        assert m["type"] == "BUY"
        assert m["status"] == "open"
    assert [m["time"] for m in chart["markers"]] == ["2026-06-02", "2026-06-10"]


def test_weekend_transactions_snap_to_nearest_session(client, pid):
    # 2026-06-06 = Saturday (nearest session: Friday 06-05),
    # 2026-06-07 = Sunday   (nearest session: Monday 06-08)
    for date in ("2026-06-06", "2026-06-07"):
        r = client.post(f"/api/portfolios/{pid}/transactions", json={
            "ticker": "MARK2", "type": "BUY", "shares": 1, "price": 100, "date": date,
        })
        assert r.status_code == 201

    chart = client.get(f"/api/chart/MARK2?range=3mo&interval=1d&portfolio_id={pid}").json()
    candle_times = {c["time"] for c in chart["candles"]}

    assert [m["time"] for m in chart["markers"]] == ["2026-06-05", "2026-06-08"]
    for m in chart["markers"]:
        assert m["time"] in candle_times
        assert m["date"] in ("2026-06-06", "2026-06-07")  # original date kept for the tooltip


def test_marker_after_last_candle_snaps_to_last_session(client, pid):
    # e.g. a buy made today before the market has produced a candle
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "MARK3", "type": "BUY", "shares": 1, "price": 100, "date": "2026-06-14",
    })
    assert r.status_code == 201
    chart = client.get(f"/api/chart/MARK3?range=3mo&interval=1d&portfolio_id={pid}").json()
    assert [m["time"] for m in chart["markers"]] == ["2026-06-12"]  # last business day


def test_marker_before_range_is_dropped(client, pid):
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "MARK4", "type": "BUY", "shares": 1, "price": 100, "date": "2026-05-01",
    })
    assert r.status_code == 201
    chart = client.get(f"/api/chart/MARK4?range=3mo&interval=1d&portfolio_id={pid}").json()
    assert chart["markers"] == []


def test_sell_marker_and_closed_buy_classification(client, pid):
    for body in (
        {"ticker": "MARK5", "type": "BUY", "shares": 2, "price": 100, "date": "2026-06-02"},
        {"ticker": "MARK5", "type": "SELL", "shares": 2, "price": 120, "date": "2026-06-10"},
    ):
        assert client.post(f"/api/portfolios/{pid}/transactions", json=body).status_code == 201

    chart = client.get(f"/api/chart/MARK5?range=3mo&interval=1d&portfolio_id={pid}").json()
    statuses = {(m["type"], m["status"]) for m in chart["markers"]}
    assert statuses == {("BUY", "closed"), ("SELL", "sell")}
