"""Manual FX rate on a foreign transaction: entering the instrument→portfolio
rate (like XTB shows) stores an exact settled amount, making cash and realized
P&L FX-exact instead of the current-rate approximation."""
import pytest
from fastapi.testclient import TestClient

import db
import web.server as server


@pytest.fixture()
def client(monkeypatch):
    # instrument trades in DKK; portfolio will be PLN → a currency mismatch
    monkeypatch.setattr(server, "_cached_price", lambda ticker: 200.0)
    monkeypatch.setattr(server, "get_current_price", lambda ticker: 200.0)
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} A/S", "type": "EQUITY",
        "exchange": "OMX", "currency": "DKK",
    })
    # live DKK→PLN rate that would be used WITHOUT a manual rate
    monkeypatch.setattr(server, "_fx_rate", lambda src, dst: 0.60 if src == "DKK" else 1.0)
    server._price_cache.clear()
    server._fx_cache.clear()
    server._history_cache.clear()
    return TestClient(server.app)


@pytest.fixture()
def pid(client):
    r = client.post("/api/portfolios", json={"name": "DKK ręczny", "currency": "PLN"})
    pid = r.json()["id"]
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 10000, "date": "2026-01-01"})
    yield pid
    client.delete(f"/api/portfolios/{pid}?force=true")


def add(client, pid, **kw):
    r = client.post(f"/api/portfolios/{pid}/transactions", json={"fee": 0, **kw})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_manual_rate_stores_exact_cash_amount(client, pid):
    # buy 10 @ 100 DKK, fee 5 DKK, rate 0.55 → (1000 + 5) × 0.55 = 552.75 PLN
    tid = add(client, pid, ticker="NOVO", type="BUY", shares=10, price=100, fee=5,
              date="2026-01-05", fx_rate=0.55)
    txn = db.get_transaction(tid)
    assert txn["currency"] == "DKK"
    assert txn["cash_amount"] == pytest.approx(552.75)

    # cash uses the EXACT settled amount, not deposit − shares×price×live-rate
    s = client.get(f"/api/portfolios/{pid}/summary").json()
    assert s["cash"] == pytest.approx(10000 - 552.75)
    # foreign OPEN position value still uses the live rate (0.60) — that's the
    # only place an approximation legitimately remains
    assert s["fx_rates"] == {"DKK": 0.60}


def test_manual_rate_makes_realized_pnl_fx_exact(client, pid):
    add(client, pid, ticker="NOVO", type="BUY", shares=10, price=100,
        date="2026-01-05", fx_rate=0.50)   # cost 500 PLN
    add(client, pid, ticker="NOVO", type="SELL", shares=10, price=120,
        date="2026-03-05", fx_rate=0.55)   # proceeds 660 PLN
    s = client.get(f"/api/portfolios/{pid}/summary").json()
    [closed] = s["closed_positions"]
    assert closed["fx_exact"] is True
    assert closed["realized_pnl"] == pytest.approx(200)       # native DKK: 1200−1000
    assert closed["realized_pnl_pc"] == pytest.approx(160)    # PLN: 660−500
    # nothing left to convert at the live rate → no "≈ approximation" note
    assert s["fx_rates"] == {}


def test_no_rate_falls_back_to_approximation(client, pid):
    add(client, pid, ticker="NOVO", type="BUY", shares=10, price=100, date="2026-01-05")
    txn = db.get_transactions(pid, "NOVO")[0]
    assert txn["cash_amount"] is None  # no exact settlement recorded
    s = client.get(f"/api/portfolios/{pid}/summary").json()
    # open position valued at the live rate → the note is legitimately shown
    assert s["fx_rates"] == {"DKK": 0.60}


def test_same_currency_ignores_rate(client, pid, monkeypatch):
    # instrument in PLN (matches portfolio): a stray fx_rate must be ignored
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": "PL Co", "type": "EQUITY",
        "exchange": "WSE", "currency": "PLN",
    })
    tid = add(client, pid, ticker="PKN", type="BUY", shares=10, price=50,
              date="2026-01-05", fx_rate=4.30)
    assert db.get_transaction(tid)["cash_amount"] is None


def test_edit_prefills_and_keeps_exact_amount(client, pid):
    tid = add(client, pid, ticker="NOVO", type="BUY", shares=10, price=100,
              date="2026-01-05", fx_rate=0.50)
    # editing without a rate change (frontend re-sends the implied rate) keeps
    # the exact amount; here we re-send the same rate explicitly
    r = client.put(f"/api/transactions/{tid}", json={
        "ticker": "NOVO", "type": "BUY", "shares": 10, "price": 100, "fee": 0,
        "date": "2026-01-05", "fx_rate": 0.50,
    })
    assert r.status_code == 200
    assert db.get_transaction(tid)["cash_amount"] == pytest.approx(500)
    # dropping the rate on edit reverts to approximation
    client.put(f"/api/transactions/{tid}", json={
        "ticker": "NOVO", "type": "BUY", "shares": 10, "price": 100, "fee": 0,
        "date": "2026-01-05",
    })
    assert db.get_transaction(tid)["cash_amount"] is None
