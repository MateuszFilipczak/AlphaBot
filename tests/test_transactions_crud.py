"""Edit (PUT) and hard-delete (DELETE) of transactions, including the
negative-holdings guard: no operation may leave a sell without covering
buys anywhere in the history."""
import pytest
from fastapi.testclient import TestClient

import web.server as server


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "_cached_price", lambda ticker: 100.0)
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} Inc.", "type": "EQUITY",
        "exchange": "TEST", "currency": "USD",
    })
    server._price_cache.clear()
    server._fx_cache.clear()
    return TestClient(server.app)


@pytest.fixture()
def pid(client):
    return next(p["id"] for p in client.get("/api/portfolios").json() if p["currency"] == "USD")


def add(client, pid, **kw):
    body = {"fee": 0, **kw}
    r = client.post(f"/api/portfolios/{pid}/transactions", json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_delete_transaction_removes_it_from_history(client, pid):
    buy_id = add(client, pid, ticker="CRUD1", type="BUY", shares=10, price=50, date="2026-01-05")
    r = client.delete(f"/api/transactions/{buy_id}")
    assert r.status_code == 200
    assert client.get(f"/api/positions/{pid}/CRUD1").status_code == 404  # no txns left


def test_delete_buy_covering_a_sell_is_blocked(client, pid):
    buy_id = add(client, pid, ticker="CRUD2", type="BUY", shares=10, price=50, date="2026-01-05")
    add(client, pid, ticker="CRUD2", type="SELL", shares=5, price=60, date="2026-02-05")

    r = client.delete(f"/api/transactions/{buy_id}")
    assert r.status_code == 400
    assert "ujemny stan akcji" in r.json()["detail"]

    # position is untouched
    detail = client.get(f"/api/positions/{pid}/CRUD2").json()
    assert detail["summary"]["shares"] == pytest.approx(5)


def test_delete_sell_is_allowed_and_restores_lot(client, pid):
    add(client, pid, ticker="CRUD3", type="BUY", shares=10, price=50, date="2026-01-05")
    sell_id = add(client, pid, ticker="CRUD3", type="SELL", shares=5, price=60, date="2026-02-05")

    r = client.delete(f"/api/transactions/{sell_id}")
    assert r.status_code == 200
    detail = client.get(f"/api/positions/{pid}/CRUD3").json()
    assert detail["summary"]["shares"] == pytest.approx(10)
    assert detail["summary"]["realized_pnl"] == pytest.approx(0)


def test_edit_shrinking_buy_below_sold_amount_is_blocked(client, pid):
    buy_id = add(client, pid, ticker="CRUD4", type="BUY", shares=10, price=50, date="2026-01-05")
    add(client, pid, ticker="CRUD4", type="SELL", shares=5, price=60, date="2026-02-05")

    r = client.put(f"/api/transactions/{buy_id}", json={
        "ticker": "CRUD4", "type": "BUY", "shares": 3, "price": 50, "date": "2026-01-05",
    })
    assert r.status_code == 400
    assert "ujemny stan akcji" in r.json()["detail"]


def test_edit_moving_buy_after_sell_is_blocked(client, pid):
    buy_id = add(client, pid, ticker="CRUD5", type="BUY", shares=10, price=50, date="2026-01-05")
    add(client, pid, ticker="CRUD5", type="SELL", shares=5, price=60, date="2026-02-05")

    # same size, but re-dated after the sell → sell would predate its cover
    r = client.put(f"/api/transactions/{buy_id}", json={
        "ticker": "CRUD5", "type": "BUY", "shares": 10, "price": 50, "date": "2026-03-01",
    })
    assert r.status_code == 400


def test_edit_price_recomputes_realized_pnl(client, pid):
    buy_id = add(client, pid, ticker="CRUD6", type="BUY", shares=10, price=50, date="2026-01-05")
    add(client, pid, ticker="CRUD6", type="SELL", shares=10, price=60, date="2026-02-05")

    r = client.put(f"/api/transactions/{buy_id}", json={
        "ticker": "CRUD6", "type": "BUY", "shares": 10, "price": 40, "date": "2026-01-05",
    })
    assert r.status_code == 200
    detail = client.get(f"/api/positions/{pid}/CRUD6").json()
    # realized recomputed: 10*(60-40) instead of 10*(60-50)
    assert detail["summary"]["realized_pnl"] == pytest.approx(200)


def test_edit_and_delete_unknown_transaction_404(client):
    assert client.delete("/api/transactions/99999").status_code == 404
    assert client.put("/api/transactions/99999", json={
        "ticker": "X", "type": "BUY", "shares": 1, "price": 1,
    }).status_code == 404
