"""Cash withdrawals: reduce cash, are blocked beyond the balance, and show up
in the deposits history with type=WITHDRAWAL."""
import pytest
from fastapi.testclient import TestClient

import web.server as server


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "_cached_price", lambda ticker: 100.0)
    monkeypatch.setattr(server, "get_current_price", lambda ticker: 100.0)
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} Inc.", "type": "EQUITY",
        "exchange": "TEST", "currency": "PLN",
    })
    server._price_cache.clear()
    server._fx_cache.clear()
    return TestClient(server.app)


@pytest.fixture()
def pid(client):
    # the PLN portfolio is untouched by the other test files → clean cash state
    return next(p["id"] for p in client.get("/api/portfolios").json() if p["currency"] == "PLN")


def cash(client, pid):
    return client.get(f"/api/portfolios/{pid}/summary").json()["cash"]


def test_withdrawal_reduces_cash_and_shows_in_history(client, pid):
    start = cash(client, pid)
    r = client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 1000, "date": "2026-01-02"})
    assert r.status_code == 201
    r = client.post(f"/api/portfolios/{pid}/withdrawals", json={
        "amount": 300, "date": "2026-01-10", "note": "na wakacje",
    })
    assert r.status_code == 201

    assert cash(client, pid) == pytest.approx(start + 1000 - 300)

    history = client.get(f"/api/portfolios/{pid}/deposits").json()
    w = next(d for d in history if d["type"] == "WITHDRAWAL")
    assert w["amount"] == 300  # stored positive; the type carries the direction
    assert w["note"] == "na wakacje"
    assert w["currency"] == "PLN"
    # net contributed capital reflects the withdrawal
    summary = client.get(f"/api/portfolios/{pid}/summary").json()
    assert summary["deposited"] == pytest.approx(start + 700)


def test_withdrawal_beyond_cash_is_blocked(client, pid):
    available = cash(client, pid)
    r = client.post(f"/api/portfolios/{pid}/withdrawals", json={"amount": available + 500})
    assert r.status_code == 400
    assert "dostępna gotówka" in r.json()["detail"]
    assert cash(client, pid) == pytest.approx(available)  # nothing changed


def test_withdrawal_must_be_positive(client, pid):
    assert client.post(f"/api/portfolios/{pid}/withdrawals", json={"amount": -5}).status_code == 422
    assert client.post(f"/api/portfolios/{pid}/withdrawals", json={"amount": 0}).status_code == 422


def test_cli_withdrawal_validation(monkeypatch):
    """portfolio.add_withdrawal_and_notify enforces the same cash rule."""
    import portfolio as pf

    monkeypatch.setattr(pf, "compute_capital_summary", lambda *a, **k: {"available": 50.0})
    with pytest.raises(pf.InsufficientCashError):
        pf.add_withdrawal_and_notify(100.0)
