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


class NoUsdPortfolioError(RuntimeError):
    """The USD portfolio the CLI/scheduler target does not exist (portfolios
    are user-deletable in the web app)."""


def _has_composite_name_unique(conn: sqlite3.Connection) -> bool:
    """True if portfolios already enforces UNIQUE (name, currency). Probes the
    actual index (not the DDL text in sqlite_master) so a formatting-only edit
    to the CREATE statement can't retrigger the rebuild on every start."""
    for idx in conn.execute("PRAGMA index_list('portfolios')"):
        if idx["unique"]:
            cols = [c["name"] for c in conn.execute(f"PRAGMA index_info('{idx['name']}')")]
            if cols == ["name", "currency"]:
                return True
    return False


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS portfolios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'PLN', 'GBP')),
                UNIQUE (name, currency)
            )
        """)

        # older DBs have a CHECK without GBP or a UNIQUE on name alone (names
        # are only unique per currency now) — SQLite can't alter constraints,
        # so rebuild the table once (ids are preserved, FKs stay valid). The
        # missing composite UNIQUE also identifies pre-GBP schemas: GBP entered
        # the CHECK before this constraint existed.
        if not _has_composite_name_unique(conn):
            old_seq = conn.execute(
                "SELECT seq FROM sqlite_sequence WHERE name = 'portfolios'"
            ).fetchone()
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.execute("""
                CREATE TABLE portfolios_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'PLN', 'GBP')),
                    UNIQUE (name, currency)
                )
            """)
            conn.execute("INSERT INTO portfolios_new (id, name, currency) SELECT id, name, currency FROM portfolios")
            conn.execute("DROP TABLE portfolios")
            conn.execute("ALTER TABLE portfolios_new RENAME TO portfolios")
            # DROP TABLE erased the AUTOINCREMENT high-water mark; restore it so
            # ids of previously deleted portfolios are never handed out again
            # (a stale ?p= URL would silently show a different portfolio).
            if old_seq is not None:
                conn.execute("DELETE FROM sqlite_sequence WHERE name = 'portfolios'")
                conn.execute(
                    "INSERT INTO sqlite_sequence (name, seq) VALUES ('portfolios', ?)",
                    (old_seq["seq"],),
                )
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
                currency TEXT,
                external_id TEXT,
                cash_amount REAL
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
                note TEXT,
                external_id TEXT,
                -- CONTRIBUTION (capital in/out) | INCOME (dividends, interest,
                -- their taxes) | RETURN (rights-issue proceeds: not profit,
                -- but not user-deposited capital either). No CHECK on purpose:
                -- this enum already grew once and SQLite can't alter a CHECK.
                category TEXT NOT NULL DEFAULT 'CONTRIBUTION'
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

        # ---- Budżet module -------------------------------------------------
        # Recurring monthly income/expenses. No CHECK on category (open set,
        # validated in the API) — this enum will grow. Global (single
        # household), so no portfolio_id.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS budget_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL CHECK (type IN ('INCOME', 'EXPENSE')),
                name TEXT NOT NULL,
                amount REAL NOT NULL CHECK (amount >= 0),
                category TEXT NOT NULL DEFAULT 'inne',
                note TEXT
            )
        """)
        # Loans repaid in equal installments. Month-view derives paid/remaining
        # Snapshot model: the user enters the CURRENT state (outstanding
        # balance + current installment + last-payment month), which is robust
        # to in-progress loans, rate changes and overpayments — no attempt to
        # derive from a start date. principal is the original sum (for the %
        # bar); a loan counts as a monthly expense in any month ≤ end_month.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS budget_loans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                principal REAL NOT NULL DEFAULT 0 CHECK (principal >= 0),   -- kwota pierwotna
                remaining REAL NOT NULL DEFAULT 0 CHECK (remaining >= 0),   -- pozostało do spłaty
                installment REAL NOT NULL CHECK (installment > 0),
                end_month TEXT NOT NULL,                                    -- 'YYYY-MM' ostatnia rata
                shared_installment REAL NOT NULL DEFAULT 0,
                note TEXT
            )
        """)
        # User-managed categories (name + colour) referenced by budget_items.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS budget_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK (kind IN ('INCOME', 'EXPENSE')),
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#94a3b8',
                position INTEGER NOT NULL DEFAULT 0
            )
        """)
        # budget_items gained category_id (managed categories) and month
        # (NULL = recurring monthly; 'YYYY-MM' = a one-off in that month).
        bi_cols = {r["name"] for r in conn.execute("PRAGMA table_info(budget_items)")}
        if "category_id" not in bi_cols:
            conn.execute("ALTER TABLE budget_items ADD COLUMN category_id INTEGER REFERENCES budget_categories(id)")
        if "month" not in bi_cols:
            conn.execute("ALTER TABLE budget_items ADD COLUMN month TEXT")
        # shared_amount: the part of this expense someone else covers/owes
        # (e.g. a partner's share); 0 = fully the user's.
        if "shared_amount" not in bi_cols:
            conn.execute("ALTER TABLE budget_items ADD COLUMN shared_amount REAL NOT NULL DEFAULT 0")
        bl_cols = {r["name"] for r in conn.execute("PRAGMA table_info(budget_loans)")}
        if "shared_installment" not in bl_cols:
            conn.execute("ALTER TABLE budget_loans ADD COLUMN shared_installment REAL NOT NULL DEFAULT 0")
            bl_cols.add("shared_installment")
        # migrate old (installment × count from start_month) → snapshot model
        if "end_month" not in bl_cols:
            cur_month = datetime.now(timezone.utc).strftime("%Y-%m")

            def _add_months(m, n):
                idx = int(m[:4]) * 12 + (int(m[5:7]) - 1) + n
                return f"{idx // 12}-{idx % 12 + 1:02d}"

            def _months_between(a, b):
                return (int(b[:4]) - int(a[:4])) * 12 + (int(b[5:7]) - int(a[5:7]))

            conn.execute("""
                CREATE TABLE budget_loans_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    principal REAL NOT NULL DEFAULT 0 CHECK (principal >= 0),
                    remaining REAL NOT NULL DEFAULT 0 CHECK (remaining >= 0),
                    installment REAL NOT NULL CHECK (installment > 0),
                    end_month TEXT NOT NULL,
                    shared_installment REAL NOT NULL DEFAULT 0,
                    note TEXT
                )
            """)
            for r in conn.execute("SELECT * FROM budget_loans").fetchall():
                count, start, inst = r["installments_count"], r["start_month"], r["installment"]
                elapsed = max(0, min(count, _months_between(start, cur_month) + 1))
                remaining = max(0.0, (count - elapsed) * inst)
                conn.execute(
                    """INSERT INTO budget_loans_new (id, name, principal, remaining, installment, end_month, shared_installment, note)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (r["id"], r["name"], r["principal"], remaining, inst,
                     _add_months(start, count - 1), r["shared_installment"], r["note"]),
                )
            old_seq = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='budget_loans'").fetchone()
            conn.execute("DROP TABLE budget_loans")
            conn.execute("ALTER TABLE budget_loans_new RENAME TO budget_loans")
            if old_seq is not None:
                conn.execute("DELETE FROM sqlite_sequence WHERE name='budget_loans'")
                conn.execute("INSERT INTO sqlite_sequence (name, seq) VALUES ('budget_loans', ?)", (old_seq["seq"],))
        # Recurring INCOME sources hold a name/category only; the actual amount
        # is entered per month (salary varies), stored here. Expenses stay
        # fixed. On first creation, seed the current month from any income
        # amounts already entered, so existing data isn't lost.
        income_amounts_existed = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='budget_income_amounts'"
        ).fetchone()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS budget_income_amounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL REFERENCES budget_items(id),
                month TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                UNIQUE (item_id, month)
            )
        """)
        if not income_amounts_existed:
            cur_month = datetime.now(timezone.utc).strftime("%Y-%m")
            for row in conn.execute(
                "SELECT id, amount FROM budget_items WHERE type = 'INCOME' AND month IS NULL AND amount > 0"
            ).fetchall():
                conn.execute(
                    "INSERT INTO budget_income_amounts (item_id, month, amount) VALUES (?, ?, ?)",
                    (row["id"], cur_month, row["amount"]),
                )
        # seed a well-separated default palette ONLY into an empty table, so
        # user edits/deletions stick (same posture as the starter portfolios)
        if conn.execute("SELECT COUNT(*) AS n FROM budget_categories").fetchone()["n"] == 0:
            defaults = [
                ("EXPENSE", "Mieszkanie", "#3b82f6"), ("EXPENSE", "Media", "#06b6d4"),
                ("EXPENSE", "Transport", "#f59e0b"), ("EXPENSE", "Jedzenie", "#22c55e"),
                ("EXPENSE", "Zdrowie", "#ef4444"), ("EXPENSE", "Rozrywka", "#a855f7"),
                ("EXPENSE", "Subskrypcje", "#ec4899"), ("EXPENSE", "Ubezpieczenia", "#eab308"),
                ("EXPENSE", "Inne", "#94a3b8"),
                ("INCOME", "Wypłata", "#22c55e"), ("INCOME", "Dodatkowe", "#06b6d4"),
                ("INCOME", "Inne", "#94a3b8"),
            ]
            for pos, (kind, name, color) in enumerate(defaults):
                conn.execute(
                    "INSERT INTO budget_categories (kind, name, color, position) VALUES (?, ?, ?, ?)",
                    (kind, name, color, pos),
                )

        # transactions.currency (the instrument's trading currency) arrived
        # with the FX-awareness feature — add it to DBs that predate it.
        txn_cols = {r["name"] for r in conn.execute("PRAGMA table_info(transactions)")}
        if "currency" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN currency TEXT")
        # external_id (broker-side operation id, e.g. from an XTB export)
        # arrived with the import feature — it's what makes re-importing the
        # same file a no-op instead of a duplication.
        if "external_id" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN external_id TEXT")
        # cash_amount: the trade's EXACT portfolio-currency cash flow (fees
        # included), known for imports. NULL = derive shares×price at the
        # current FX rate (the pre-import approximation for manual entries).
        if "cash_amount" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN cash_amount REAL")

        # deposits.type/note arrived with withdrawals support — add to older DBs
        # (existing rows default to DEPOSIT, which is what they all were).
        dep_cols = {r["name"] for r in conn.execute("PRAGMA table_info(deposits)")}
        if "type" not in dep_cols:
            conn.execute("ALTER TABLE deposits ADD COLUMN type TEXT NOT NULL DEFAULT 'DEPOSIT'")
        if "note" not in dep_cols:
            conn.execute("ALTER TABLE deposits ADD COLUMN note TEXT")
        if "external_id" not in dep_cols:
            conn.execute("ALTER TABLE deposits ADD COLUMN external_id TEXT")
        # category separates contributed capital (deposits/withdrawals/
        # transfers) from investment income (dividends, interest, their
        # taxes) and capital returns (rights issues) — income is P&L, not
        # capital, so it must not skew "wpłacono łącznie" or the profit pct.
        if "category" not in dep_cols:
            conn.execute("""ALTER TABLE deposits ADD COLUMN category TEXT NOT NULL
                            DEFAULT 'CONTRIBUTION'""")

        # earlier builds created category with CHECK(... IN (CONTRIBUTION,
        # INCOME)) — too narrow once RETURN arrived, and SQLite can't drop a
        # CHECK: rebuild the table once without it (ids preserved; the
        # external-id unique index is recreated below, after _migrate_legacy)
        dep_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='deposits'"
        ).fetchone()["sql"]
        if "CHECK (category" in dep_sql:
            conn.execute("""
                CREATE TABLE deposits_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    amount REAL NOT NULL CHECK (amount > 0),
                    date TEXT NOT NULL,
                    portfolio_id INTEGER REFERENCES portfolios(id),
                    currency TEXT,
                    type TEXT NOT NULL DEFAULT 'DEPOSIT' CHECK (type IN ('DEPOSIT', 'WITHDRAWAL')),
                    note TEXT,
                    external_id TEXT,
                    category TEXT NOT NULL DEFAULT 'CONTRIBUTION'
                )
            """)
            conn.execute("""INSERT INTO deposits_new (id, amount, date, portfolio_id, currency, type, note, external_id, category)
                            SELECT id, amount, date, portfolio_id, currency, type, note, external_id, category FROM deposits""")
            old_seq = conn.execute(
                "SELECT seq FROM sqlite_sequence WHERE name = 'deposits'"
            ).fetchone()
            conn.execute("DROP TABLE deposits")
            conn.execute("ALTER TABLE deposits_new RENAME TO deposits")
            if old_seq is not None:
                conn.execute("DELETE FROM sqlite_sequence WHERE name = 'deposits'")
                conn.execute(
                    "INSERT INTO sqlite_sequence (name, seq) VALUES ('deposits', ?)",
                    (old_seq["seq"],),
                )

        # Seed the three starter portfolios ONLY on a fresh DB — portfolios are
        # user-managed now, so a deleted one must not resurrect on next start.
        if conn.execute("SELECT COUNT(*) AS n FROM portfolios").fetchone()["n"] == 0:
            for currency in ("USD", "EUR", "PLN"):
                conn.execute(
                    "INSERT INTO portfolios (name, currency) VALUES (?, ?)",
                    (currency, currency),
                )

        _migrate_legacy(conn)

        # one broker operation may land in a portfolio only once; created
        # after _migrate_legacy — legacy deposits gain portfolio_id there
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_id
            ON transactions(portfolio_id, external_id) WHERE external_id IS NOT NULL
        """)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_external_id
            ON deposits(portfolio_id, external_id) WHERE external_id IS NOT NULL
        """)


def _migrate_legacy(conn: sqlite3.Connection):
    """One-time move of pre-web-app data into the new model:
    - `portfolio` rows (open positions) become BUY transactions in the USD
      portfolio; the old table is renamed to `portfolio_migrated_backup` so
      this never runs twice (and the raw data stays recoverable).
    - `deposits` gains portfolio_id/amount/currency columns; legacy amount_usd
      rows are attributed to the USD portfolio.
    """
    dep_cols = {r["name"] for r in conn.execute("PRAGMA table_info(deposits)")}
    needs_deposit_migration = "portfolio_id" not in dep_cols
    has_legacy = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portfolio'"
    ).fetchone()
    if not needs_deposit_migration and not has_legacy:
        return

    # A USD portfolio always exists here: on a legacy DB the portfolios table
    # was just created and seeded in this same transaction, and once migration
    # has committed the early return above fires before this point (deleting
    # portfolios only became possible after migration support shipped).
    usd_id = conn.execute("SELECT id FROM portfolios WHERE currency = 'USD' ORDER BY id").fetchone()["id"]

    if needs_deposit_migration:
        conn.execute("ALTER TABLE deposits ADD COLUMN portfolio_id INTEGER REFERENCES portfolios(id)")
        conn.execute("ALTER TABLE deposits ADD COLUMN currency TEXT")
        conn.execute("ALTER TABLE deposits RENAME COLUMN amount_usd TO amount")
        conn.execute(
            "UPDATE deposits SET portfolio_id = ?, currency = 'USD' WHERE portfolio_id IS NULL",
            (usd_id,),
        )

    # legacy positions table -> BUY transactions in the USD portfolio
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
        row = conn.execute("SELECT id FROM portfolios WHERE currency = 'USD' ORDER BY id").fetchone()
        if row is None:
            raise NoUsdPortfolioError(
                "No USD portfolio exists (it may have been deleted in the web app). "
                "Create one there to use the CLI portfolio commands."
            )
        return row["id"]


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
                    note: str | None = None, currency: str | None = None,
                    external_id: str | None = None,
                    cash_amount: float | None = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO transactions (portfolio_id, ticker, type, shares, price, fee, date, note, currency, external_id, cash_amount)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (portfolio_id, ticker.upper(), type_, shares, price, fee, date or _now(), note, currency, external_id, cash_amount),
        )
        return cur.lastrowid


def get_transaction(txn_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM transactions WHERE id = ?", (txn_id,)).fetchone()
        return dict(row) if row else None


def update_transaction(txn_id: int, ticker: str, type_: str, shares: float,
                       price: float, fee: float, date: str,
                       note: str | None, currency: str | None,
                       cash_amount: float | None = None):
    with get_conn() as conn:
        conn.execute(
            """UPDATE transactions
               SET ticker = ?, type = ?, shares = ?, price = ?, fee = ?, date = ?,
                   note = ?, currency = ?, cash_amount = ?
               WHERE id = ?""",
            (ticker.upper(), type_, shares, price, fee, date, note, currency, cash_amount, txn_id),
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
                type_: str = "DEPOSIT", note: str | None = None,
                external_id: str | None = None,
                category: str = "CONTRIBUTION") -> int:
    """Records a cash flow (DEPOSIT or WITHDRAWAL, amount always positive) in
    the portfolio's own currency. category CONTRIBUTION = capital in/out,
    INCOME = investment proceeds (dividends, interest…) — cash either way,
    but only contributions count as deposited capital. Defaults to the USD
    portfolio so the legacy CLI (`python main.py deposit 250`) keeps working."""
    if portfolio_id is None:
        portfolio_id = get_usd_portfolio_id()
    with get_conn() as conn:
        currency = conn.execute(
            "SELECT currency FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()["currency"]
        cur = conn.execute(
            """INSERT INTO deposits (amount, date, portfolio_id, currency, type, note, external_id, category)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (amount, date or _now(), portfolio_id, currency, type_, note, external_id, category),
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


def get_external_ids(portfolio_id: int) -> set[str]:
    """Broker-side ids already recorded in this portfolio (transactions and
    cash flows alike) — the import preview marks these rows as duplicates."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT external_id FROM transactions
               WHERE portfolio_id = ? AND external_id IS NOT NULL
               UNION
               SELECT external_id FROM deposits
               WHERE portfolio_id = ? AND external_id IS NOT NULL""",
            (portfolio_id, portfolio_id),
        ).fetchall()
        return {r["external_id"] for r in rows}


def get_total_deposited(portfolio_id: int | None = None) -> float:
    """Net non-profit capital: deposits minus withdrawals over CONTRIBUTION
    and RETURN rows — everything except investment income. This is the base
    the lifetime P&L formula subtracts, so INCOME (and only INCOME) lands in
    profit; RETURN (rights issues) is excluded from profit here while still
    staying out of the user-facing "suma wpłat" (get_contribution_totals)."""
    if portfolio_id is None:
        portfolio_id = get_usd_portfolio_id()
    with get_conn() as conn:
        row = conn.execute(
            """SELECT COALESCE(SUM(CASE WHEN type = 'WITHDRAWAL' THEN -amount ELSE amount END), 0) AS total
               FROM deposits WHERE portfolio_id = ? AND category != 'INCOME'""",
            (portfolio_id,),
        ).fetchone()
        return float(row["total"])


def get_cash_flows_total(portfolio_id: int) -> float:
    """Signed sum of EVERY cash flow (contributions and income alike) — the
    starting point for the portfolio's cash balance."""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT COALESCE(SUM(CASE WHEN type = 'WITHDRAWAL' THEN -amount ELSE amount END), 0) AS total
               FROM deposits WHERE portfolio_id = ?""",
            (portfolio_id,),
        ).fetchone()
        return float(row["total"])


def get_contribution_totals(portfolio_id: int) -> tuple[float, float]:
    """(inflows, outflows) of contributed capital: bank deposits + transfers
    in vs withdrawals + transfers out. Investment income is excluded from
    both. The inflow total is also the stable denominator for the profit
    percentage — net contributed capital can be near zero (or negative) on
    accounts that withdrew their gains."""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT
                 COALESCE(SUM(CASE WHEN type = 'DEPOSIT' THEN amount END), 0) AS inflow,
                 COALESCE(SUM(CASE WHEN type = 'WITHDRAWAL' THEN amount END), 0) AS outflow
               FROM deposits WHERE portfolio_id = ? AND category = 'CONTRIBUTION'""",
            (portfolio_id,),
        ).fetchone()
        return float(row["inflow"]), float(row["outflow"])


# ---- Budżet module ----------------------------------------------------------

def get_budget_items(type_: str | None = None) -> list[dict]:
    query = "SELECT * FROM budget_items"
    params: list = []
    if type_ is not None:
        query += " WHERE type = ?"
        params.append(type_)
    query += " ORDER BY id"
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def add_budget_item(type_: str, name: str, amount: float, category_id: int | None,
                    month: str | None, note: str | None, shared_amount: float = 0.0) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO budget_items (type, name, amount, category_id, month, note, shared_amount)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (type_, name, amount, category_id, month, note, shared_amount),
        )
        return cur.lastrowid


def update_budget_item(item_id: int, name: str, amount: float, category_id: int | None,
                       month: str | None, note: str | None, shared_amount: float = 0.0) -> bool:
    """Name/amount/category/month/note/shared are editable; type is immutable
    (delete and re-add to flip income↔expense). month NULL = recurring,
    'YYYY-MM' = one-off. Returns False if the id doesn't exist."""
    with get_conn() as conn:
        cur = conn.execute(
            """UPDATE budget_items
               SET name = ?, amount = ?, category_id = ?, month = ?, note = ?, shared_amount = ?
               WHERE id = ?""",
            (name, amount, category_id, month, note, shared_amount, item_id),
        )
        return cur.rowcount > 0


def delete_budget_item(item_id: int) -> bool:
    with get_conn() as conn:
        # detach per-month income amounts first so the FK doesn't reject it
        conn.execute("DELETE FROM budget_income_amounts WHERE item_id = ?", (item_id,))
        return conn.execute("DELETE FROM budget_items WHERE id = ?", (item_id,)).rowcount > 0


# ---- Per-month income amounts ----

def get_income_amounts(month: str) -> dict[int, float]:
    """{item_id: amount} for recurring income sources in a given month.
    Sources without a row that month are simply absent (treated as 0)."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT item_id, amount FROM budget_income_amounts WHERE month = ?", (month,)
        ).fetchall()
        return {r["item_id"]: r["amount"] for r in rows}


def set_income_amount(item_id: int, month: str, amount: float):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO budget_income_amounts (item_id, month, amount) VALUES (?, ?, ?)
               ON CONFLICT(item_id, month) DO UPDATE SET amount = excluded.amount""",
            (item_id, month, amount),
        )


# ---- Budżet categories ----

def get_budget_categories(kind: str | None = None) -> list[dict]:
    query = "SELECT * FROM budget_categories"
    params: list = []
    if kind is not None:
        query += " WHERE kind = ?"
        params.append(kind)
    query += " ORDER BY position, id"
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def add_budget_category(kind: str, name: str, color: str) -> int:
    with get_conn() as conn:
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM budget_categories WHERE kind = ?",
            (kind,),
        ).fetchone()["p"]
        cur = conn.execute(
            "INSERT INTO budget_categories (kind, name, color, position) VALUES (?, ?, ?, ?)",
            (kind, name, color, pos),
        )
        return cur.lastrowid


def update_budget_category(cat_id: int, name: str, color: str) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE budget_categories SET name = ?, color = ? WHERE id = ?",
            (name, color, cat_id),
        )
        return cur.rowcount > 0


def delete_budget_category(cat_id: int) -> bool:
    """Deletes a category; items pointing at it fall back to no category
    (shown as 'Bez kategorii') rather than blocking the delete. Items are
    detached FIRST so the FK constraint doesn't reject the delete."""
    with get_conn() as conn:
        conn.execute("UPDATE budget_items SET category_id = NULL WHERE category_id = ?", (cat_id,))
        return conn.execute("DELETE FROM budget_categories WHERE id = ?", (cat_id,)).rowcount > 0


def get_budget_loans() -> list[dict]:
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM budget_loans ORDER BY id").fetchall()]


def add_budget_loan(name: str, principal: float, remaining: float, installment: float,
                    end_month: str, note: str | None, shared_installment: float = 0.0) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO budget_loans (name, principal, remaining, installment, end_month, note, shared_installment)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (name, principal, remaining, installment, end_month, note, shared_installment),
        )
        return cur.lastrowid


def update_budget_loan(loan_id: int, name: str, principal: float, remaining: float,
                       installment: float, end_month: str, note: str | None,
                       shared_installment: float = 0.0) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            """UPDATE budget_loans
               SET name = ?, principal = ?, remaining = ?, installment = ?,
                   end_month = ?, note = ?, shared_installment = ?
               WHERE id = ?""",
            (name, principal, remaining, installment, end_month, note, shared_installment, loan_id),
        )
        return cur.rowcount > 0


def delete_budget_loan(loan_id: int) -> bool:
    with get_conn() as conn:
        return conn.execute("DELETE FROM budget_loans WHERE id = ?", (loan_id,)).rowcount > 0


init_db()
