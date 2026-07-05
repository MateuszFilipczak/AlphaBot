"""End-to-end test through the FastAPI app against a temp SQLite DB
(see conftest.py): deposit → 2x BUY → partial SELL → verify lots,
realized FIFO P&L and cash. Yahoo prices are stubbed — no network."""
import pytest
from fastapi.testclient import TestClient

import web.server as server

FAKE_PRICE = 150.0


@pytest.fixture()
def client(monkeypatch):
    # stub the quote source and instrument metadata — no network in tests
    monkeypatch.setattr(server, "_cached_price", lambda ticker: FAKE_PRICE)
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} Inc.", "type": "EQUITY",
        "exchange": "TEST", "currency": "USD",
    })
    server._price_cache.clear()
    server._fx_cache.clear()
    return TestClient(server.app)


@pytest.fixture()
def usd_portfolio(client):
    portfolios = client.get("/api/portfolios").json()
    return next(p for p in portfolios if p["currency"] == "USD")


def test_full_flow(client, usd_portfolio):
    pid = usd_portfolio["id"]

    # 1. deposit 5000
    r = client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 5000, "date": "2026-01-02"})
    assert r.status_code == 201

    # 2. two buys: 10 @ 100 (fee 2) and 10 @ 120 (fee 2)
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "test1", "type": "BUY", "shares": 10, "price": 100,
        "fee": 2, "date": "2026-01-05",
    })
    assert r.status_code == 201
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "TEST1", "type": "BUY", "shares": 10, "price": 120,
        "fee": 2, "date": "2026-02-05",
    })
    assert r.status_code == 201

    # 3. partial sell: 15 @ 140, fee 3 → FIFO eats lot 1 fully + half of lot 2
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "TEST1", "type": "SELL", "shares": 15, "price": 140,
        "fee": 3, "date": "2026-03-01",
    })
    assert r.status_code == 201

    # --- position detail: lots + realized P&L -------------------------------
    detail = client.get(f"/api/positions/{pid}/TEST1").json()

    assert len(detail["lots"]) == 1
    lot = detail["lots"][0]
    assert lot["shares_remaining"] == pytest.approx(5)
    assert lot["price"] == pytest.approx(120)
    # half of lot 2's fee stays with the open half
    assert lot["fee_remaining"] == pytest.approx(1)
    assert lot["value_today"] == pytest.approx(5 * FAKE_PRICE)

    assert len(detail["sales"]) == 1
    sale = detail["sales"][0]
    # proceeds: 15*140 - 3 = 2097
    # basis: (10*100 + 2) + (5*120 + 1) = 1603 → realized = 494
    assert sale["proceeds"] == pytest.approx(2097)
    assert sale["cost_basis"] == pytest.approx(1603)
    assert sale["realized_pnl"] == pytest.approx(494)

    # --- summary: cash / tiles ------------------------------------------------
    summary = client.get(f"/api/portfolios/{pid}/summary").json()
    # cash = 5000 - 1002 - 1202 + 2097 = 4893
    assert summary["cash"] == pytest.approx(4893)
    assert summary["deposited"] == pytest.approx(5000)
    assert summary["realized_pnl"] == pytest.approx(494)
    # open: 5 @ 120 (+1 fee) valued at FAKE_PRICE → unrealized = 750 - 601 = 149
    assert summary["unrealized_pnl"] == pytest.approx(149)
    assert summary["positions_value"] == pytest.approx(750)
    assert summary["total_pnl"] == pytest.approx(494 + 149)

    positions = summary["positions"]
    assert len(positions) == 1
    assert positions[0]["ticker"] == "TEST1"
    assert positions[0]["shares"] == pytest.approx(5)

    # --- oversell is rejected with 400 ---------------------------------------
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "TEST1", "type": "SELL", "shares": 6, "price": 140,
    })
    assert r.status_code == 400
    assert "only 5" in r.json()["detail"]

    # exact remaining amount is fine
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "TEST1", "type": "SELL", "shares": 5, "price": 140,
        "date": "2026-03-02",
    })
    assert r.status_code == 201


def test_deposit_gets_portfolio_currency(client):
    portfolios = client.get("/api/portfolios").json()
    eur = next(p for p in portfolios if p["currency"] == "EUR")
    client.post(f"/api/portfolios/{eur['id']}/deposits", json={"amount": 100})
    deposits = client.get(f"/api/portfolios/{eur['id']}/deposits").json()
    assert deposits[-1]["currency"] == "EUR"
    assert deposits[-1]["amount"] == 100


def test_unknown_portfolio_404(client):
    assert client.get("/api/portfolios/999/summary").status_code == 404


def test_sell_same_day_as_buy_through_api(client, usd_portfolio):
    """Regression: 'Posiadasz: 3 szt.' but SELL on the buy's date was rejected
    with 'only 0 shares held at that date'."""
    pid = usd_portfolio["id"]
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "SAMEDAY", "type": "BUY", "shares": 1, "price": 200, "date": "2026-07-02",
    })
    assert r.status_code == 201
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "SAMEDAY", "type": "BUY", "shares": 2, "price": 400, "date": "2026-07-02",
    })
    assert r.status_code == 201

    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "SAMEDAY", "type": "SELL", "shares": 2, "price": 300, "date": "2026-07-02",
    })
    assert r.status_code == 201, r.text

    detail = client.get(f"/api/positions/{pid}/SAMEDAY").json()
    assert detail["summary"]["shares"] == pytest.approx(1)
    # FIFO: 1 @ 200 + 1 @ 400 matched → realized = (300-200) + (300-400) = 0
    assert detail["summary"]["realized_pnl"] == pytest.approx(0)


def test_non_iso_date_is_rejected_not_misparsed(client, usd_portfolio):
    pid = usd_portfolio["id"]
    for bad in ("02/07/2026", "07/02/2026", "2026.07.02"):
        r = client.post(f"/api/portfolios/{pid}/transactions", json={
            "ticker": "BADDATE", "type": "BUY", "shares": 1, "price": 10, "date": bad,
        })
        assert r.status_code == 422, bad
    # full ISO timestamp normalizes to the day
    r = client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "BADDATE", "type": "BUY", "shares": 1, "price": 10,
        "date": "2026-07-02T10:30:00+00:00",
    })
    assert r.status_code == 201
    detail = client.get(f"/api/positions/{pid}/BADDATE").json()
    assert detail["transactions"][0]["date"] == "2026-07-02"


def test_spa_shell_always_revalidates(client):
    """index.html must carry no-cache — otherwise browsers heuristically cache
    the SPA shell and a rebuilt frontend only shows up after a hard refresh."""
    for path in ("/", "/?p=1", "/favicon.svg"):
        r = client.get(path)
        assert r.status_code == 200
        assert r.headers["cache-control"] == "no-cache", path


def test_closed_positions_in_summary(client):
    """A fully-sold ticker moves from positions to closed_positions with its
    FIFO-realized result, and stays reachable via the position-detail view."""
    r = client.post("/api/portfolios", json={"name": "Zamknięte test", "currency": "USD"})
    pid = r.json()["id"]
    try:
        client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 1000, "date": "2026-01-02"})
        client.post(f"/api/portfolios/{pid}/transactions", json={
            "ticker": "AAPL", "type": "BUY", "shares": 2, "price": 90, "date": "2026-01-05",
        })
        client.post(f"/api/portfolios/{pid}/transactions", json={
            "ticker": "AAPL", "type": "SELL", "shares": 2, "price": 110, "date": "2026-02-05",
        })
        s = client.get(f"/api/portfolios/{pid}/summary").json()
        assert s["positions"] == []
        [closed] = s["closed_positions"]
        assert closed["ticker"] == "AAPL"
        assert closed["shares_sold"] == 2
        assert closed["invested"] == pytest.approx(180)
        assert closed["proceeds"] == pytest.approx(220)
        assert closed["realized_pnl"] == pytest.approx(40)
        assert closed["realized_pnl_pct"] == pytest.approx(40 / 180 * 100)
        assert closed["last_sell_date"] == "2026-02-05"
        # manual entries: no settled amounts → portfolio-currency figures are
        # the current-rate approximation (1:1 here), flagged as not FX-exact
        assert closed["fx_exact"] is False
        assert closed["realized_pnl_pc"] == pytest.approx(40)
        assert closed["invested_pc"] == pytest.approx(180)
        # closed tickers' realized result feeds the summary total
        assert s["realized_pnl"] == pytest.approx(40)
        # the detail view still works for a closed position
        detail = client.get(f"/api/positions/{pid}/AAPL").json()
        assert detail["lots"] == []
        assert detail["summary"]["realized_pnl"] == pytest.approx(40)
    finally:
        client.delete(f"/api/portfolios/{pid}?force=true")
