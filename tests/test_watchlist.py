"""Watchlist: per-portfolio watched tickers — CRUD, duplicates, cascade
delete, and (crucially) immunity to broker imports."""
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import web.server as server
from tests.test_xtb_import import build_xtb_xlsx


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "_cached_price", lambda ticker: 123.45)
    monkeypatch.setattr(server, "get_current_price", lambda ticker: 123.45)
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} Inc.", "type": "EQUITY",
        "exchange": "TEST", "currency": "EUR",
    })
    server._price_cache.clear()
    server._fx_cache.clear()
    return TestClient(server.app)


@pytest.fixture()
def pid(client):
    r = client.post("/api/portfolios", json={"name": "Watch test", "currency": "EUR"})
    pid = r.json()["id"]
    yield pid
    client.delete(f"/api/portfolios/{pid}?force=true")


def test_watch_crud_and_enrichment(client, pid):
    r = client.post(f"/api/portfolios/{pid}/watchlist", json={"ticker": "nvda"})
    assert r.status_code == 201
    wid = r.json()["id"]

    [row] = client.get(f"/api/portfolios/{pid}/watchlist").json()
    assert row["ticker"] == "NVDA"  # uppercased
    assert row["name"] == "NVDA Inc."
    assert row["price"] == 123.45

    assert client.delete(f"/api/watchlist/{wid}").status_code == 200
    assert client.get(f"/api/portfolios/{pid}/watchlist").json() == []
    assert client.delete(f"/api/watchlist/{wid}").status_code == 404


def test_watch_duplicate_rejected(client, pid):
    assert client.post(f"/api/portfolios/{pid}/watchlist", json={"ticker": "AAPL"}).status_code == 201
    r = client.post(f"/api/portfolios/{pid}/watchlist", json={"ticker": "aapl"})
    assert r.status_code == 400
    assert "już obserwowany" in r.json()["detail"]


def test_import_does_not_touch_watchlist(client, pid):
    """Re-importing broker data must leave watched tickers untouched — the
    whole point of keeping the watchlist in its own table."""
    client.post(f"/api/portfolios/{pid}/watchlist", json={"ticker": "NVDA"})
    client.post(f"/api/portfolios/{pid}/watchlist", json={"ticker": "EGLN.L"})

    rows = [["Stock purchase", "EGLN.UK", "Physical Gold", datetime(2026, 6, 1),
             "-67.12", "9901", "OPEN BUY 0.8942 @ 75.0600", "My Trades"],
            ["Deposit", "", "", datetime(2026, 5, 28), 500.0, "9902", "dep", "My Trades"]]
    content = build_xtb_xlsx(rows)
    for _ in range(2):  # import + re-import
        ops = client.post(
            f"/api/portfolios/{pid}/import/xtb",
            files={"file": ("e.xlsx", content,
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        ).json()["operations"]
        client.post(f"/api/portfolios/{pid}/import/xtb/commit", json={"operations": ops})

    watched = [w["ticker"] for w in client.get(f"/api/portfolios/{pid}/watchlist").json()]
    assert watched == ["NVDA", "EGLN.L"]


def test_cascade_delete_removes_watchlist(client):
    import db

    pid = client.post("/api/portfolios", json={"name": "Watch cascade", "currency": "USD"}).json()["id"]
    client.post(f"/api/portfolios/{pid}/watchlist", json={"ticker": "MSFT"})
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 100, "date": "2026-01-02"})
    assert client.delete(f"/api/portfolios/{pid}?force=true").status_code == 200
    # no orphaned rows for the DELETED portfolio's id (query the table
    # directly — a fresh portfolio would get a new id, proving nothing)
    assert db.get_watchlist(pid) == []

    # plain (non-cascade) delete of a watch-only portfolio cleans up too
    pid2 = client.post("/api/portfolios", json={"name": "Watch cascade 2", "currency": "USD"}).json()["id"]
    client.post(f"/api/portfolios/{pid2}/watchlist", json={"ticker": "AAPL"})
    assert client.delete(f"/api/portfolios/{pid2}").status_code == 200
    assert db.get_watchlist(pid2) == []


def test_position_detail_for_watched_only_ticker(client, pid):
    client.post(f"/api/portfolios/{pid}/watchlist", json={"ticker": "NVDA"})
    r = client.get(f"/api/positions/{pid}/NVDA")
    assert r.status_code == 200
    d = r.json()
    assert d["transactions"] == [] and d["lots"] == []
    assert d["summary"]["shares"] == 0
    assert d["watched"] is True
    # unwatched + untraded ticker still 404s
    assert client.get(f"/api/positions/{pid}/TSLA").status_code == 404
