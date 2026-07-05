"""Unit tests for engine.py — pure FIFO/cash math, no DB, no network."""
import pytest

from engine import (
    OversellError,
    build_positions,
    cash_balance,
    position_summary,
    replay_fifo,
    shares_owned,
    validate_sell,
)


def buy(id, shares, price, date, fee=0.0, ticker="AAPL"):
    return {"id": id, "ticker": ticker, "type": "BUY", "shares": shares,
            "price": price, "fee": fee, "date": date, "note": None}


def sell(id, shares, price, date, fee=0.0, ticker="AAPL"):
    return {"id": id, "ticker": ticker, "type": "SELL", "shares": shares,
            "price": price, "fee": fee, "date": date, "note": None}


# ---- FIFO lot matching -------------------------------------------------------

def test_partial_sell_consumes_oldest_lot_first():
    state = replay_fifo([
        buy(1, 10, 100, "2026-01-01"),
        buy(2, 10, 120, "2026-02-01"),
        sell(3, 5, 150, "2026-03-01"),
    ])
    # 5 shares come off the January lot
    assert state["shares_owned"] == 15
    assert len(state["open_lots"]) == 2
    assert state["open_lots"][0]["shares_remaining"] == 5
    assert state["open_lots"][0]["price"] == 100
    assert state["open_lots"][1]["shares_remaining"] == 10
    # realized: 5 * (150 - 100) = 250
    assert state["realized_pnl"] == pytest.approx(250)
    assert state["sales"][0]["matched"] == [
        {"buy_txn_id": 1, "shares": 5, "buy_price": 100}
    ]


def test_sell_spanning_multiple_lots():
    state = replay_fifo([
        buy(1, 10, 100, "2026-01-01"),
        buy(2, 10, 120, "2026-02-01"),
        sell(3, 15, 130, "2026-03-01"),
    ])
    # 10 @ 100 + 5 @ 120 matched; realized = 10*30 + 5*10 = 350
    assert state["shares_owned"] == 5
    assert len(state["open_lots"]) == 1
    assert state["open_lots"][0]["price"] == 120
    assert state["realized_pnl"] == pytest.approx(350)
    assert [m["buy_txn_id"] for m in state["sales"][0]["matched"]] == [1, 2]


def test_fifo_ordered_by_date_not_insert_order():
    # back-dated buy inserted later must still be consumed first
    state = replay_fifo([
        buy(2, 10, 120, "2026-02-01"),
        buy(5, 10, 100, "2026-01-01"),  # older date, higher id
        sell(9, 10, 130, "2026-03-01"),
    ])
    # the January lot (price 100) goes first
    assert state["realized_pnl"] == pytest.approx(300)
    assert state["open_lots"][0]["price"] == 120


def test_fractional_shares():
    state = replay_fifo([
        buy(1, 0.5, 200, "2026-01-01"),
        sell(2, 0.25, 300, "2026-02-01"),
    ])
    assert state["shares_owned"] == pytest.approx(0.25)
    assert state["realized_pnl"] == pytest.approx(0.25 * 100)


# ---- Fees --------------------------------------------------------------------

def test_fees_reduce_realized_pnl():
    state = replay_fifo([
        buy(1, 10, 100, "2026-01-01", fee=10),
        sell(2, 5, 150, "2026-02-01", fee=5),
    ])
    # basis: 5*100 + half the buy fee (5) = 505; proceeds: 5*150 - 5 = 745
    sale = state["sales"][0]
    assert sale["cost_basis"] == pytest.approx(505)
    assert sale["proceeds"] == pytest.approx(745)
    assert sale["realized_pnl"] == pytest.approx(240)
    # the open half of the lot keeps the other half of the buy fee
    lot = state["open_lots"][0]
    assert lot["fee_remaining"] == pytest.approx(5)
    assert lot["cost_basis"] == pytest.approx(5 * 100 + 5)


def test_unrealized_pnl_net_of_remaining_buy_fee():
    state = replay_fifo([buy(1, 10, 100, "2026-01-01", fee=10)])
    summary = position_summary(state, current_price=110)
    # market 1100 - (1000 cost + 10 fee) = 90
    assert summary["unrealized_pnl"] == pytest.approx(90)
    assert summary["market_value"] == pytest.approx(1100)
    assert summary["avg_cost"] == pytest.approx(100)


def test_position_summary_without_price_is_fail_soft():
    state = replay_fifo([buy(1, 10, 100, "2026-01-01")])
    summary = position_summary(state, current_price=None)
    assert summary["market_value"] is None
    assert summary["unrealized_pnl"] is None
    assert summary["shares"] == 10


# ---- Same-day transactions (regression: sell rejected on buy's date) ----------

def test_sell_same_day_as_buy_is_valid():
    # BUY must be replayed before SELL on the identical date
    state = replay_fifo([
        buy(1, 3, 100, "2026-07-02"),
        sell(2, 2, 110, "2026-07-02"),
    ])
    assert state["shares_owned"] == 1
    assert state["realized_pnl"] == pytest.approx(20)


def test_validate_sell_candidate_without_id_same_day():
    # regression: a not-yet-inserted candidate (id=None) used to sort BEFORE
    # same-day buys and see 0 shares held
    txns = [
        buy(2, 1, 200, "2026-07-02"),
        buy(3, 2, 400, "2026-07-02"),
    ]
    validate_sell(txns, sell(None, 2, 300, "2026-07-02"))  # must not raise


def test_same_day_buy_first_even_with_lower_sell_id():
    # id order must not override the BUY-before-SELL rule within one day
    state = replay_fifo([
        sell(1, 5, 120, "2026-07-02"),
        buy(9, 5, 100, "2026-07-02"),
    ])
    assert state["shares_owned"] == 0
    assert state["realized_pnl"] == pytest.approx(100)


def test_same_day_timestamped_and_plain_dates_mix():
    # legacy rows carry full ISO timestamps; comparison is day-granular
    state = replay_fifo([
        buy(1, 2, 100, "2026-07-02T15:30:00+00:00"),
        sell(2, 2, 110, "2026-07-02"),
    ])
    assert state["shares_owned"] == 0


# ---- Oversell validation -------------------------------------------------------

def test_sell_more_than_owned_raises():
    with pytest.raises(OversellError):
        replay_fifo([
            buy(1, 10, 100, "2026-01-01"),
            sell(2, 11, 120, "2026-02-01"),
        ])


def test_sell_with_no_position_raises():
    with pytest.raises(OversellError):
        replay_fifo([sell(1, 1, 120, "2026-02-01")])


def test_backdated_sell_before_buy_raises():
    txns = [buy(1, 10, 100, "2026-02-01")]
    candidate = sell(None, 5, 120, "2026-01-15")  # before the only buy
    with pytest.raises(OversellError):
        validate_sell(txns, candidate)


def test_validate_sell_accepts_exact_holdings():
    txns = [buy(1, 10, 100, "2026-01-01")]
    validate_sell(txns, sell(None, 10, 120, "2026-02-01"))  # no raise


def test_shares_owned():
    txns = [
        buy(1, 10, 100, "2026-01-01"),
        sell(2, 4, 120, "2026-02-01"),
        buy(3, 2, 90, "2026-03-01", ticker="MSFT"),
    ]
    assert shares_owned(txns, "AAPL") == 6
    assert shares_owned(txns, "MSFT") == 2


# ---- Cash --------------------------------------------------------------------

def test_cash_balance_deposits_buys_sells_fees():
    txns = [
        buy(1, 10, 100, "2026-01-01", fee=2),    # -1002
        sell(2, 5, 150, "2026-02-01", fee=3),    # +747
    ]
    assert cash_balance(2000, txns) == pytest.approx(2000 - 1002 + 747)


def test_cash_can_go_negative():
    txns = [buy(1, 10, 100, "2026-01-01")]
    assert cash_balance(500, txns) == pytest.approx(-500)


# ---- Multi-ticker grouping ------------------------------------------------------

def test_build_positions_groups_by_ticker():
    txns = [
        buy(1, 10, 100, "2026-01-01", ticker="AAPL"),
        buy(2, 3, 400, "2026-01-02", ticker="MSFT"),
        sell(3, 10, 110, "2026-02-01", ticker="AAPL"),
    ]
    positions = build_positions(txns)
    assert positions["AAPL"]["shares_owned"] == 0
    assert positions["AAPL"]["realized_pnl"] == pytest.approx(100)
    assert positions["MSFT"]["shares_owned"] == 3


def test_cash_basis_realized_fifo():
    """Imported trades carry cash_amount (broker-settled portfolio-currency
    amounts) — FIFO on those must reproduce the broker's FX-exact P/L."""
    txns = [
        # EUR instrument on a PLN account: prices EUR, cash_amount PLN
        {"id": 1, "ticker": "X", "type": "BUY", "shares": 2, "price": 100.0,
         "fee": 0, "date": "2026-01-05", "cash_amount": 860.0},   # rate 4.30
        {"id": 2, "ticker": "X", "type": "BUY", "shares": 1, "price": 110.0,
         "fee": 0, "date": "2026-01-10", "cash_amount": 451.0},   # rate 4.10
        # sells 2.5 shares: 2.0 from lot 1 + 0.5 from lot 2
        {"id": 3, "ticker": "X", "type": "SELL", "shares": 2.5, "price": 120.0,
         "fee": 0, "date": "2026-02-01", "cash_amount": 1275.0},  # rate 4.25
    ]
    state = replay_fifo(txns)
    [sale] = state["sales"]
    assert sale["cash_proceeds"] == pytest.approx(1275.0)
    assert sale["cash_cost"] == pytest.approx(860.0 + 451.0 * 0.5)
    assert sale["realized_cash"] == pytest.approx(1275.0 - 1085.5)
    # native FIFO still works alongside
    assert sale["realized_pnl"] == pytest.approx(2.5 * 120 - (2 * 100 + 0.5 * 110))


def test_cash_basis_none_when_any_leg_manual():
    txns = [
        {"id": 1, "ticker": "X", "type": "BUY", "shares": 1, "price": 100.0,
         "fee": 0, "date": "2026-01-05"},  # manual: no cash_amount
        {"id": 2, "ticker": "X", "type": "SELL", "shares": 1, "price": 120.0,
         "fee": 0, "date": "2026-02-01", "cash_amount": 510.0},
    ]
    [sale] = replay_fifo(txns)["sales"]
    assert sale["realized_cash"] is None
    assert sale["cash_cost"] is None
    # and the reverse: imported buy, manual sell
    txns2 = [
        {"id": 1, "ticker": "X", "type": "BUY", "shares": 1, "price": 100.0,
         "fee": 0, "date": "2026-01-05", "cash_amount": 430.0},
        {"id": 2, "ticker": "X", "type": "SELL", "shares": 1, "price": 120.0,
         "fee": 0, "date": "2026-02-01"},
    ]
    [sale2] = replay_fifo(txns2)["sales"]
    assert sale2["realized_cash"] is None
