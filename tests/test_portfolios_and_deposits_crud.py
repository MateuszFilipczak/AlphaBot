"""Portfolio management (create/rename/delete), instrument type override,
deposit/withdrawal edit+delete with the negative-cash guard, and the
portfolio-history endpoint."""
import pytest
from uuid import uuid4
from fastapi.testclient import TestClient

import web.server as server


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "_cached_price", lambda ticker: 100.0)
    monkeypatch.setattr(server, "get_current_price", lambda ticker: 100.0)
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} Inc.", "type": "EQUITY",
        "exchange": "TEST", "currency": "USD",
    })
    server._price_cache.clear()
    server._fx_cache.clear()
    server._history_cache.clear()
    return TestClient(server.app)


def make_portfolio(client, name, currency="USD"):
    r = client.post("/api/portfolios", json={"name": name, "currency": currency})
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ---- Portfolio management ------------------------------------------------------

def test_create_rename_delete_portfolio(client):
    pid = make_portfolio(client, "IKE testowe", "PLN")
    assert any(p["name"] == "IKE testowe" and p["currency"] == "PLN"
               for p in client.get("/api/portfolios").json())

    r = client.put(f"/api/portfolios/{pid}", json={"name": "IKE 2026"})
    assert r.status_code == 200
    assert any(p["name"] == "IKE 2026" for p in client.get("/api/portfolios").json())

    assert client.delete(f"/api/portfolios/{pid}").status_code == 200
    assert not any(p["id"] == pid for p in client.get("/api/portfolios").json())


def test_gbp_portfolio_allowed(client):
    pid = make_portfolio(client, "GBP broker", "GBP")
    p = next(p for p in client.get("/api/portfolios").json() if p["id"] == pid)
    assert p["currency"] == "GBP"
    client.delete(f"/api/portfolios/{pid}")


def test_duplicate_name_rejected_within_currency(client):
    make_portfolio(client, "Dubel")
    r = client.post("/api/portfolios", json={"name": "Dubel", "currency": "USD"})
    assert r.status_code == 400
    assert "już istnieje" in r.json()["detail"]


def test_same_name_allowed_across_currencies(client):
    make_portfolio(client, "Główny - XTB", "PLN")
    pid_eur = make_portfolio(client, "Główny - XTB", "EUR")
    assert any(p["id"] == pid_eur and p["currency"] == "EUR"
               for p in client.get("/api/portfolios").json())


def test_rename_collision_scoped_to_currency(client):
    make_portfolio(client, "Broker A", "PLN")
    pid_pln = make_portfolio(client, "Broker B", "PLN")
    pid_eur = make_portfolio(client, "Broker C", "EUR")

    # rename into a name taken in the SAME currency -> 400
    r = client.put(f"/api/portfolios/{pid_pln}", json={"name": "Broker A"})
    assert r.status_code == 400
    assert "już istnieje" in r.json()["detail"]

    # same name is fine in a different currency
    r = client.put(f"/api/portfolios/{pid_eur}", json={"name": "Broker A"})
    assert r.status_code == 200


def test_whitespace_only_name_rejected(client):
    r = client.post("/api/portfolios", json={"name": "   ", "currency": "USD"})
    assert r.status_code == 400
    assert "pusta" in r.json()["detail"]

    pid = make_portfolio(client, "Prawdziwy")
    r = client.put(f"/api/portfolios/{pid}", json={"name": " "})
    assert r.status_code == 400
    assert any(p["name"] == "Prawdziwy" for p in client.get("/api/portfolios").json())


def test_rename_to_own_name_is_noop_not_conflict(client):
    pid = make_portfolio(client, "Stała nazwa")
    r = client.put(f"/api/portfolios/{pid}", json={"name": "Stała nazwa"})
    assert r.status_code == 200


def test_invalid_currency_rejected(client):
    r = client.post("/api/portfolios", json={"name": "X", "currency": "CHF"})
    assert r.status_code == 422


def test_delete_nonempty_portfolio_requires_force(client):
    pid = make_portfolio(client, "Pełny")
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 100, "date": "2026-01-02"})
    r = client.delete(f"/api/portfolios/{pid}")
    assert r.status_code == 400
    assert "force" in r.json()["detail"]
    # portfolio and its data survive the refused delete
    assert client.get(f"/api/portfolios/{pid}/summary").status_code == 200


def test_force_delete_cascades_transactions_and_deposits(client):
    pid = make_portfolio(client, "Kasowany")
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 1000, "date": "2026-01-02"})
    client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "CASC1", "type": "BUY", "shares": 2, "price": 100, "date": "2026-01-05",
    })
    other = make_portfolio(client, "Ocalały")
    client.post(f"/api/portfolios/{other}/deposits", json={"amount": 50, "date": "2026-01-02"})

    r = client.delete(f"/api/portfolios/{pid}?force=true")
    assert r.status_code == 200
    assert r.json() == {"deleted": pid, "transactions": 1, "deposits": 1}
    assert client.get(f"/api/portfolios/{pid}/summary").status_code == 404
    # the other portfolio's data is untouched
    deposits = client.get(f"/api/portfolios/{other}/deposits").json()
    assert len(deposits) == 1 and deposits[0]["amount"] == 50


def test_portfolio_list_includes_data_counts(client):
    pid = make_portfolio(client, "Liczniki")
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 100, "date": "2026-01-02"})
    client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "CNT1", "type": "BUY", "shares": 1, "price": 10, "date": "2026-01-05",
    })
    p = next(p for p in client.get("/api/portfolios").json() if p["id"] == pid)
    assert (p["txn_count"], p["deposit_count"]) == (1, 1)
    # counts drive the UI delete flow: this one needs the force path
    assert client.delete(f"/api/portfolios/{pid}").status_code == 400
    assert client.delete(f"/api/portfolios/{pid}?force=true").status_code == 200


# ---- Instrument type override ---------------------------------------------------

def test_instrument_type_override_to_etc(client):
    pid = make_portfolio(client, "ETC test")
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 1000, "date": "2026-01-02"})
    client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "EGLN.T", "type": "BUY", "shares": 1, "price": 50, "date": "2026-01-05",
    })
    # Yahoo said EQUITY; the user corrects it to ETC
    r = client.put("/api/instrument/EGLN.T", json={"type": "ETC"})
    assert r.status_code == 200
    assert r.json()["type"] == "ETC"
    # override survives and shows up in the summary position
    summary = client.get(f"/api/portfolios/{pid}/summary").json()
    assert summary["positions"][0]["type"] == "ETC"

    assert client.put("/api/instrument/EGLN.T", json={"type": "FUND"}).status_code == 422


def test_derive_instrument_type_etc_heuristic():
    """Yahoo labels ETCs as EQUITY (they're legally companies, e.g. iShares
    Physical Metals plc) or ETF — the name is the reliable signal."""
    from data.yahoo import derive_instrument_type

    assert derive_instrument_type("EQUITY", "ISHARES PHYSICAL METALS PLC ISH") == "ETC"
    assert derive_instrument_type("ETF", "iShares Physical Gold ETC") == "ETC"
    assert derive_instrument_type("ETF", "WisdomTree Physical Silver") == "ETC"
    assert derive_instrument_type("EQUITY", None, "Invesco Physical Gold ETC") == "ETC"

    # no false positives on ordinary names
    assert derive_instrument_type("EQUITY", "Apple Inc.") == "EQUITY"
    assert derive_instrument_type("ETF", "Vanguard FTSE All-World U.ETF R") == "ETF"
    assert derive_instrument_type("EQUITY", "Barrick Gold Corporation") == "EQUITY"
    assert derive_instrument_type("EQUITY", "Physical Therapy Corp") == "EQUITY"
    # "ETC" must be a standalone word, not a fragment
    assert derive_instrument_type("ETF", "GETCO Holdings ETF") == "ETF"
    assert derive_instrument_type(None, "Unknown Co") == "EQUITY"


# ---- Deposit/withdrawal edit & delete --------------------------------------------

@pytest.fixture()
def funded(client):
    """Fresh portfolio: deposit 1000 (01-02) → BUY 800 (01-05) → withdraw 150
    (01-10). Cash: 50. Any edit that breaks coverage must be rejected."""
    # uuid, NOT id(client): CPython reuses object addresses across tests, and
    # a leftover same-named portfolio from a previous test would 400 here
    pid = make_portfolio(client, f"Fundusz-{uuid4().hex[:12]}")
    r = client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 1000, "date": "2026-01-02"})
    dep_id = r.json()["id"]
    client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "FUND1", "type": "BUY", "shares": 8, "price": 100, "date": "2026-01-05",
    })
    r = client.post(f"/api/portfolios/{pid}/withdrawals", json={
        "amount": 150, "date": "2026-01-10", "note": "stara notatka",
    })
    wd_id = r.json()["id"]
    yield pid, dep_id, wd_id
    client.delete(f"/api/portfolios/{pid}?force=true")


def test_shrinking_deposit_below_later_buy_is_blocked(client, funded):
    pid, dep_id, _ = funded
    r = client.put(f"/api/deposits/{dep_id}", json={"amount": 100, "date": "2026-01-02"})
    assert r.status_code == 400
    assert "ujemne" in r.json()["detail"]


def test_deleting_covering_deposit_is_blocked(client, funded):
    pid, dep_id, _ = funded
    r = client.delete(f"/api/deposits/{dep_id}")
    assert r.status_code == 400


def test_moving_deposit_after_buy_is_blocked(client, funded):
    pid, dep_id, _ = funded
    r = client.put(f"/api/deposits/{dep_id}", json={"amount": 1000, "date": "2026-01-06"})
    assert r.status_code == 400  # the 01-05 buy would predate its funding


def test_growing_withdrawal_beyond_cash_is_blocked(client, funded):
    pid, _, wd_id = funded
    r = client.put(f"/api/deposits/{wd_id}", json={"amount": 250, "date": "2026-01-10"})
    assert r.status_code == 400


def test_valid_edit_and_delete_pass(client, funded):
    pid, _, wd_id = funded
    r = client.put(f"/api/deposits/{wd_id}", json={
        "amount": 120, "date": "2026-01-11", "note": "nowa notatka",
    })
    assert r.status_code == 200
    history = client.get(f"/api/portfolios/{pid}/deposits").json()
    w = next(d for d in history if d["id"] == wd_id)
    assert (w["amount"], w["date"], w["note"]) == (120, "2026-01-11", "nowa notatka")
    assert client.get(f"/api/portfolios/{pid}/summary").json()["cash"] == pytest.approx(80)

    assert client.delete(f"/api/deposits/{wd_id}").status_code == 200
    assert client.get(f"/api/portfolios/{pid}/summary").json()["cash"] == pytest.approx(200)


def test_edit_unknown_deposit_404(client):
    assert client.put("/api/deposits/99999", json={"amount": 1, "date": "2026-01-01"}).status_code == 404
    assert client.delete("/api/deposits/99999").status_code == 404


# ---- Portfolio history endpoint ---------------------------------------------------

def test_history_endpoint_reconstructs_and_invalidates_cache(client, monkeypatch):
    closes = {"HIST1": {"2026-01-05": 100.0, "2026-01-07": 120.0}}
    monkeypatch.setattr(server, "get_close_series", lambda ticker, start: closes.get(ticker))

    pid = make_portfolio(client, "Historia")
    client.post(f"/api/portfolios/{pid}/deposits", json={"amount": 1000, "date": "2026-01-05"})
    client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "HIST1", "type": "BUY", "shares": 5, "price": 100, "date": "2026-01-05",
    })

    points = client.get(f"/api/portfolios/{pid}/history?range=max").json()["points"]
    by_date = {p["date"]: p for p in points}
    assert by_date["2026-01-05"]["value"] == pytest.approx(500 + 5 * 100)
    assert by_date["2026-01-06"]["value"] == pytest.approx(1000)   # ffill 100
    assert by_date["2026-01-07"]["value"] == pytest.approx(500 + 5 * 120)
    assert by_date["2026-01-07"]["deposited"] == pytest.approx(1000)

    # a new transaction must invalidate the cache (signature covers all rows)
    client.post(f"/api/portfolios/{pid}/transactions", json={
        "ticker": "HIST1", "type": "SELL", "shares": 5, "price": 120, "date": "2026-01-07",
    })
    points = client.get(f"/api/portfolios/{pid}/history?range=max").json()["points"]
    by_date = {p["date"]: p for p in points}
    assert by_date["2026-01-07"]["value"] == pytest.approx(500 + 600)  # all cash now
    assert by_date["2026-01-07"]["cash"] == pytest.approx(1100)

    assert client.get(f"/api/portfolios/{pid}/history?range=bad").status_code == 400


def test_history_empty_portfolio(client):
    pid = make_portfolio(client, "Pusty hist")
    r = client.get(f"/api/portfolios/{pid}/history")
    assert r.status_code == 200
    assert r.json()["points"] == []
    client.delete(f"/api/portfolios/{pid}")
