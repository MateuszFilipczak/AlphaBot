"""Legacy-schema migration: old `portfolio` positions become BUY transactions
in the USD portfolio, old `deposits.amount_usd` rows get portfolio_id/currency."""
import sqlite3

import pytest

import db


@pytest.fixture()
def legacy_db(tmp_path, monkeypatch):
    """A DB file with the pre-web schema and some data, wired into db.py."""
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE portfolio (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            shares REAL NOT NULL,
            buy_price REAL NOT NULL,
            buy_date TEXT NOT NULL
        );
        CREATE TABLE deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            amount_usd REAL NOT NULL,
            date TEXT NOT NULL
        );
        INSERT INTO portfolio (ticker, shares, buy_price, buy_date)
            VALUES ('AAPL', 2, 185.5, '2025-11-03T10:00:00+00:00'),
                   ('NVDA', 1, 900.0, '2025-12-01T10:00:00+00:00');
        INSERT INTO deposits (amount_usd, date) VALUES (1000, '2025-11-01T09:00:00+00:00');
    """)
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DB_PATH", path)
    return path


def test_legacy_data_migrates_to_usd_portfolio(legacy_db):
    db.init_db()

    usd_id = db.get_usd_portfolio_id()
    txns = db.get_transactions(usd_id)
    assert [(t["ticker"], t["type"], t["shares"], t["price"]) for t in txns] == [
        ("AAPL", "BUY", 2, 185.5),
        ("NVDA", "BUY", 1, 900.0),
    ]
    assert all(t["fee"] == 0 for t in txns)

    deposits = db.get_deposits(usd_id)
    assert len(deposits) == 1
    assert deposits[0]["amount"] == 1000
    assert deposits[0]["currency"] == "USD"
    assert db.get_total_deposited(usd_id) == 1000

    # three seeded portfolios
    assert {p["currency"] for p in db.get_portfolios()} == {"USD", "EUR", "PLN"}


def test_migration_is_idempotent(legacy_db):
    db.init_db()
    db.init_db()  # second run must not duplicate anything
    usd_id = db.get_usd_portfolio_id()
    assert len(db.get_transactions(usd_id)) == 2
    assert len(db.get_deposits(usd_id)) == 1
    assert len(db.get_portfolios()) == 3
