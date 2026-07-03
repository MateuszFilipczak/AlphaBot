"""Day-by-day portfolio value reconstruction (valuation.py) — pure math,
synthetic prices, verified to the cent."""
from datetime import date

import pytest

from valuation import reconstruct_history


def dep(id, amount, d, type_="DEPOSIT"):
    return {"id": id, "amount": amount, "date": d, "type": type_}


def txn(id, ticker, type_, shares, price, d, fee=0.0, currency=None):
    return {"id": id, "ticker": ticker, "type": type_, "shares": shares,
            "price": price, "fee": fee, "date": d, "currency": currency}


def test_full_scenario_day_by_day():
    """deposit → BUY → price rises → partial SELL → withdrawal."""
    deposits = [
        dep(1, 1000, "2026-01-01"),
        dep(2, 100, "2026-01-08", type_="WITHDRAWAL"),
    ]
    transactions = [
        txn(1, "TST", "BUY", 10, 50, "2026-01-02", fee=2),
        txn(2, "TST", "SELL", 5, 80, "2026-01-07", fee=3),
    ]
    # sparse closes: weekend 01-03/01-04 missing, 01-06 missing
    prices = {"TST": {"2026-01-02": 50.0, "2026-01-05": 60.0, "2026-01-07": 80.0, "2026-01-08": 80.0}}

    points = reconstruct_history(deposits, transactions, prices, {}, "USD",
                                 today=date(2026, 1, 8))

    expected = [
        ("2026-01-01", 1000.0, 1000.0),            # deposit only
        ("2026-01-02", 498 + 10 * 50.0, 1000.0),   # buy: cash 1000-502, 10 shares @ 50
        ("2026-01-03", 998.0, 1000.0),             # weekend → forward-filled close
        ("2026-01-04", 998.0, 1000.0),
        ("2026-01-05", 498 + 10 * 60.0, 1000.0),   # price rises to 60
        ("2026-01-06", 1098.0, 1000.0),            # no quote → ffill 60
        ("2026-01-07", 895 + 5 * 80.0, 1000.0),    # sell 5@80 fee 3: cash 498+397
        ("2026-01-08", 795 + 5 * 80.0, 900.0),     # withdrawal 100
    ]
    assert [(p["date"], p["value"], p["deposited"]) for p in points] == [
        (d, pytest.approx(v), pytest.approx(dv)) for d, v, dv in expected
    ]


def test_foreign_currency_position_uses_historical_fx():
    """PLN-quoted instrument in a EUR portfolio: both the buy's cash flow and
    the daily valuation convert at that day's (forward-filled) FX rate."""
    deposits = [dep(1, 1000, "2026-02-02")]
    transactions = [txn(1, "DNP.WA", "BUY", 10, 40, "2026-02-03", currency="PLN")]
    prices = {"DNP.WA": {"2026-02-03": 40.0, "2026-02-05": 50.0}}
    fx = {"PLN": {"2026-02-02": 0.25, "2026-02-05": 0.20}}  # 02-03/02-04 ffill 0.25

    points = reconstruct_history(deposits, transactions, prices, fx, "EUR",
                                 today=date(2026, 2, 5))
    by_date = {p["date"]: p for p in points}

    # buy: 400 PLN * 0.25 (ffilled from 02-02) = 100 EUR out of cash
    assert by_date["2026-02-03"]["cash"] == pytest.approx(1000 - 100)
    assert by_date["2026-02-03"]["value"] == pytest.approx(900 + 10 * 40 * 0.25)
    # 02-04: price ffill 40, rate ffill 0.25
    assert by_date["2026-02-04"]["value"] == pytest.approx(900 + 100)
    # 02-05: new price and new rate
    assert by_date["2026-02-05"]["value"] == pytest.approx(900 + 10 * 50 * 0.20)


def test_no_operations_returns_empty():
    assert reconstruct_history([], [], {}, {}, "USD", today=date(2026, 1, 1)) == []


def test_ticker_without_any_quotes_is_not_valued():
    deposits = [dep(1, 500, "2026-01-01")]
    transactions = [txn(1, "GHOST", "BUY", 1, 100, "2026-01-01")]
    points = reconstruct_history(deposits, transactions, {}, {}, "USD",
                                 today=date(2026, 1, 2))
    # cash reflects the buy, but the position can't be valued (no series at all)
    assert points[-1]["cash"] == pytest.approx(400)
    assert points[-1]["value"] == pytest.approx(400)


def test_same_day_deposit_and_buy():
    deposits = [dep(1, 1000, "2026-01-05")]
    transactions = [txn(1, "TST", "BUY", 10, 100, "2026-01-05")]
    prices = {"TST": {"2026-01-05": 100.0}}
    points = reconstruct_history(deposits, transactions, prices, {}, "USD",
                                 today=date(2026, 1, 5))
    assert points[0]["cash"] == pytest.approx(0)
    assert points[0]["value"] == pytest.approx(1000)
