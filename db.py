"""SQLite persistence: portfolios, transactions, deposits, scanner signals,
equity history.

The database file is created automatically on first use (init_db() runs
CREATE TABLE IF NOT EXISTS for everything the app needs). No migrations
framework — schema changes are additive statements inside init_db(), and
one-off data migrations (like the legacy `portfolio` table → `transactions`
move below) run there too, guarded so they're idempotent.

Data model (since the web app):
- `portfolios`: one row per currency bucket (seeded USD/EUR/PLN). Positions
  are NOT stored — they are derived from `transactions` via engine.replay_fifo.
- `transactions`: BUY/SELL rows per portfolio+ticker.
- `deposits`: cash paid in, per portfolio, in that portfolio's currency.
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from config import DB_PATH


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


SUPPORTED_CURRENCIES = ("USD", "EUR", "PLN", "GBP")


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS portfolios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'PLN', 'GBP'))
            )
        """)

        # older DBs have a CHECK without GBP — SQLite can't alter constraints,
        # so rebuild the table once (ids are preserved, FKs stay valid)
        table_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='portfolios'"
        ).fetchone()["sql"]
        if "'GBP'" not in table_sql:
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.execute("""
                CREATE TABLE portfolios_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'PLN', 'GBP'))
                )
            """)
            conn.execute("INSERT INTO portfolios_new (id, name, currency) SELECT id, name, currency FROM portfolios")
            conn.execute("DROP TABLE portfolios")
            conn.execute("ALTER TABLE portfolios_new RENAME TO portfolios")
            conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                portfolio_id INTEGER NOT NULL REFERENCES portfolios(id),
                ticker TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('BUY', 'SELL')),
                shares REAL NOT NULL CHECK (shares > 0),
                price REAL NOT NULL CHECK (price >= 0),
                fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
                date TEXT NOT NULL,
                note TEXT,
                currency TEXT
            )
        """)
        # `deposits` holds all cash flows in/out of a portfolio. Amounts are
        # always positive; `type` says which way the money went — explicit
        # intent beats signed amounts (no accidental double negation in
        # UI/CLI), and the sign logic lives only in get_total_deposited().
        conn.execute("""
            CREATE TABLE IF NOT EXISTS deposits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                amount REAL NOT NULL CHECK (amount > 0),
                date TEXT NOT NULL,
                portfolio_id INTEGER REFERENCES portfolios(id),
                currency TEXT,
                type TEXT NOT NULL DEFAULT 'DEPOSIT' CHECK (type IN ('DEPOSIT', 'WITHDRAWAL')),
                note TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS instruments (
                ticker TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'EQUITY',
                exchange TEXT NOT NULL DEFAULT '',
                currency TEXT,
                fetched_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT NOT NULL,
                reason TEXT,
                entry_zone TEXT,
                stop_loss REAL,
                target REAL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS equity_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                total_cost REAL NOT NULL,
                total_value REAL NOT NULL,
                drawdown_pct REAL NOT NULL,
                recorded_at TEXT NOT NULL
            )
        """)

        # transactions.currency (the instrument's trading currency) arrived
        # with the FX-awareness feature — add it to DBs that predate it.
        txn_cols = {r["name"] for r in conn.execute("PRAGMA table_info(transactions)")}
        if "currency" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN currency TEXT")

        # deposits.type/note arrived with withdrawals support — add to older DBs
        # (existing rows default to DEPOSIT, which is what they all were).
        dep_cols = {r["name"] for r in conn.execute("PRAGMA table_info(deposits)")}
        if "type" not in dep_cols:
            conn.execute("ALTER TABLE deposits ADD COLUMN type TEXT NOT NULL DEFAULT 'DEPOSIT'")
        if "note" not in dep_cols:
            conn.execute("ALTER TABLE deposits ADD COLUMN note TEXT")

        # Seed the three starter portfolios ONLY on a fresh DB — portfolios are
        # user-managed now, so a deleted one must not resurrect on next start.
        if conn.execute("SELECT COUNT(*) AS n FROM portfolios").fetchone()["n"] == 0:
            for currency in ("USD", "EUR", "PLN"):
                conn.execute(
                    "INSERT INTO portfolios (name, currency) VALUES (?, ?)",
                    (currency, currency),
                )

        _migrate_legacy(conn)


def _migrate_legacy(conn: sqlite3.Connection):
    """One-time move of pre-web-app data into the new model:
    - `portfolio` rows (open positions) become BUY transactions in the USD
      portfolio; the old table is renamed to `portfolio_migrated_backup` so
      this never runs twice (and the raw data stays recoverable).
    - `deposits` gains portfolio_id/amount/currency columns; legacy amount_usd
      rows are attributed to the USD portfolio.
    """
    usd_id = conn.execute("SELECT id FROM portfolios WHERE currency = 'USD'").fetchone()["id"]

    # deposits: add the new columns if this DB predates them
    dep_cols = {r["name"] for r in conn.execute("PRAGMA table_info(deposits)")}
    if "portfolio_id" not in dep_cols:
        conn.execute("ALTER TABLE deposits ADD COLUMN portfolio_id INTEGER REFERENCES portfolios(id)")
        conn.execute("ALTER TABLE deposits ADD COLUMN currency TEXT")
        conn.execute("ALTER TABLE deposits RENAME COLUMN amount_usd TO amount")
        conn.execute(
            "UPDATE deposits SET portfolio_id = ?, currency = 'USD' WHERE portfolio_id IS NULL",
            (usd_id,),
        )

    # legacy positions table -> BUY transactions in the USD portfolio
    has_legacy = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portfolio'"
    ).fetchone()
    if has_legacy:
        for row in conn.execute("SELECT * FROM portfolio ORDER BY buy_date, id"):
            conn.execute(
                """INSERT INTO transactions (portfolio_id, ticker, type, shares, price, fee, date, note)
                   VALUES (?, ?, 'BUY', ?, ?, 0, ?, 'migrated from legacy portfolio table')""",
                (usd_id, row["ticker"], row["shares"], row["buy_price"], row["buy_date"]),
            )
        conn.execute("ALTER TABLE portfolio RENAME TO portfolio_migrated_backup")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- Portfolios -------------------------------------------------------------

def get_portfolios() -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM portfolios ORDER BY id").fetchall()


def get_portfolios_with_counts() -> list[dict]:
    """Portfolios plus how much data each holds — the UI needs the counts to
    pick the right delete flow (simple confirm vs. cascade warning)."""
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT p.*,
                   (SELECT COUNT(*) FROM transactions t WHERE t.portfolio_id = p.id) AS txn_count,
                   (SELECT COUNT(*) FROM deposits d WHERE d.portfolio_id = p.id) AS deposit_count
            FROM portfolios p ORDER BY p.id
        """).fetchall()
        return [dict(r) for r in rows]


def get_portfolio_by_id(portfolio_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone()


def get_usd_portfolio_id() -> int:
    """The CLI (add/deposit/balance/portfolio) and the scheduler's stop-loss
    monitor operate on the USD portfolio, matching pre-web behavior."""
    with get_conn() as conn:
        return conn.execute("SELECT id FROM portfolios WHERE currency = 'USD' ORDER BY id").fetchone()["id"]


def add_portfolio(name: str, currency: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO portfolios (name, currency) VALUES (?, ?)", (name, currency)
        )
        return cur.lastrowid


def rename_portfolio(portfolio_id: int, name: str):
    with get_conn() as conn:
        conn.execute("UPDATE portfolios SET name = ? WHERE id = ?", (name, portfolio_id))


def portfolio_is_empty(portfolio_id: int) -> bool:
    with get_conn() as conn:
        txns = conn.execute(
            "SELECT COUNT(*) AS n FROM transactions WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchone()["n"]
        deps = conn.execute(
            "SELECT COUNT(*) AS n FROM deposits WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchone()["n"]
        return txns == 0 and deps == 0


def delete_portfolio(portfolio_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM portfolios WHERE id = ?", (portfolio_id,))


def delete_portfolio_cascade(portfolio_id: int) -> tuple[int, int]:
    """Deletes a portfolio WITH all its transactions and cash flows.
    Returns (deleted_transactions, deleted_deposits)."""
    with get_conn() as conn:
        txns = conn.execute(
            "DELETE FROM transactions WHERE portfolio_id = ?", (portfolio_id,)
        ).rowcount
        deps = conn.execute(
            "DELETE FROM deposits WHERE portfolio_id = ?", (portfolio_id,)
        ).rowcount
        conn.execute("DELETE FROM portfolios WHERE id = ?", (portfolio_id,))
        return txns, deps


# ---- Transactions -----------------------------------------------------------

def add_transaction(portfolio_id: int, ticker: str, type_: str, shares: float,
                    price: float, fee: float = 0.0, date: str | None = None,
                    note: str | None = None, currency: str | None = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO transactions (portfolio_id, ticker, type, shares, price, fee, date, note, currency)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (portfolio_id, ticker.upper(), type_, shares, price, fee, date or _now(), note, currency),
        )
        return cur.lastrowid


def get_transaction(txn_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM transactions WHERE id = ?", (txn_id,)).fetchone()
        return dict(row) if row else None


def update_transaction(txn_id: int, ticker: str, type_: str, shares: float,
                       price: float, fee: float, date: str,
                       note: str | None, currency: str | None):
    with get_conn() as conn:
        conn.execute(
            """UPDATE transactions
               SET ticker = ?, type = ?, shares = ?, price = ?, fee = ?, date = ?, note = ?, currency = ?
               WHERE id = ?""",
            (ticker.upper(), type_, shares, price, fee, date, note, currency, txn_id),
        )


def delete_transaction(txn_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))


def get_transactions(portfolio_id: int, ticker: str | None = None) -> list[dict]:
    """FIFO-ordered (date, then id) transaction dicts, ready for engine.py."""
    query = "SELECT * FROM transactions WHERE portfolio_id = ?"
    params: list = [portfolio_id]
    if ticker is not None:
        query += " AND ticker = ?"
        params.append(ticker.upper())
    query += " ORDER BY date, id"
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


# ---- Instruments (metadata cache) --------------------------------------------

def get_instrument(ticker: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM instruments WHERE ticker = ?", (ticker.upper(),)
        ).fetchone()
        return dict(row) if row else None


def upsert_instrument(ticker: str, name: str, type_: str, exchange: str, currency: str | None):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO instruments (ticker, name, type, exchange, currency, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(ticker) DO UPDATE SET
                   name = excluded.name, type = excluded.type,
                   exchange = excluded.exchange, currency = excluded.currency,
                   fetched_at = excluded.fetched_at""",
            (ticker.upper(), name, type_, exchange, currency, _now()),
        )


def set_instrument_type(ticker: str, type_: str):
    """Manual override of the instrument type (Yahoo often labels ETCs as ETF
    or EQUITY). Survives cache refreshes because _ensure_instrument only
    fetches when the row is missing."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE instruments SET type = ? WHERE ticker = ?", (type_, ticker.upper())
        )


def get_instruments(tickers: list[str]) -> dict[str, dict]:
    if not tickers:
        return {}
    placeholders = ",".join("?" * len(tickers))
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM instruments WHERE ticker IN ({placeholders})",
            [t.upper() for t in tickers],
        ).fetchall()
        return {r["ticker"]: dict(r) for r in rows}


# ---- Signals ----------------------------------------------------------------

def record_signal(ticker: str, reason: str, entry_zone: str, stop_loss: float, target: float):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO signals (ticker, reason, entry_zone, stop_loss, target, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (ticker.upper(), reason, entry_zone, stop_loss, target, _now()),
        )


def get_recent_signals(limit: int = 20) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM signals ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()


# ---- Equity / drawdown history ----------------------------------------------

def record_equity_snapshot(total_cost: float, total_value: float, drawdown_pct: float):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO equity_history (total_cost, total_value, drawdown_pct, recorded_at)
               VALUES (?, ?, ?, ?)""",
            (total_cost, total_value, drawdown_pct, _now()),
        )


# ---- Deposits ---------------------------------------------------------------

def add_deposit(amount: float, portfolio_id: int | None = None, date: str | None = None,
                type_: str = "DEPOSIT", note: str | None = None) -> int:
    """Records a cash flow (DEPOSIT or WITHDRAWAL, amount always positive) in
    the portfolio's own currency. Defaults to the USD portfolio so the legacy
    CLI (`python main.py deposit 250`) keeps working."""
    if portfolio_id is None:
        portfolio_id = get_usd_portfolio_id()
    with get_conn() as conn:
        currency = conn.execute(
            "SELECT currency FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()["currency"]
        cur = conn.execute(
            """INSERT INTO deposits (amount, date, portfolio_id, currency, type, note)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (amount, date or _now(), portfolio_id, currency, type_, note),
        )
        return cur.lastrowid


def get_deposit(deposit_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM deposits WHERE id = ?", (deposit_id,)).fetchone()
        return dict(row) if row else None


def update_deposit(deposit_id: int, amount: float, date: str, note: str | None):
    """Edits a cash flow's amount/date/note. The type (DEPOSIT/WITHDRAWAL)
    is immutable — delete and re-add to change direction."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE deposits SET amount = ?, date = ?, note = ? WHERE id = ?",
            (amount, date, note, deposit_id),
        )


def delete_deposit(deposit_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM deposits WHERE id = ?", (deposit_id,))


def get_deposits(portfolio_id: int | None = None) -> list[sqlite3.Row]:
    with get_conn() as conn:
        if portfolio_id is None:
            return conn.execute("SELECT * FROM deposits ORDER BY date").fetchall()
        return conn.execute(
            "SELECT * FROM deposits WHERE portfolio_id = ? ORDER BY date", (portfolio_id,)
        ).fetchall()


def get_total_deposited(portfolio_id: int | None = None) -> float:
    """Net contributed capital: deposits minus withdrawals."""
    if portfolio_id is None:
        portfolio_id = get_usd_portfolio_id()
    with get_conn() as conn:
        row = conn.execute(
            """SELECT COALESCE(SUM(CASE WHEN type = 'WITHDRAWAL' THEN -amount ELSE amount END), 0) AS total
               FROM deposits WHERE portfolio_id = ?""",
            (portfolio_id,),
        ).fetchone()
        return float(row["total"])


init_db()
