# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AlphaBot is a personal investment assistant CLI for the US market (NYSE/NASDAQ). It screens a curated
stock universe with yfinance, has Claude pick and reason about top candidates, tracks a manually-entered
portfolio in SQLite, and pushes everything to the user's phone via ntfy.sh. It never places trades —
it's signals + monitoring only; execution and `add`/`deposit` entries are always manual.

## Commands

```bash
# Setup
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# then fill in .env (ANTHROPIC_API_KEY, NTFY_TOPIC) — alphabot.db is created automatically on first import of db.py

# Run
python main.py                       # start the scheduler (blocking): morning briefing + stop-loss monitor
python main.py scan                  # run the scanner once, notify via ntfy
python main.py research TICKER       # fundamental deep-dive on one ticker
python main.py gurus                 # Buffett/Ackman/Burry recent moves (web search)
python main.py add TICKER SHARES PRICE
python main.py deposit AMOUNT
python main.py balance
python main.py portfolio
python main.py web                   # local web app (FastAPI + built React frontend) at :8000

# Tests (FIFO engine, migration, API e2e — tests/conftest.py points ALPHABOT_DB at a temp file)
python -m pytest tests/

# Frontend rebuild (only needed when web/frontend/src changes; dist/ is committed)
cd web/frontend && npm install && npm run build
```

## Architecture

**Layering:** `main.py` (argparse CLI, one subcommand per feature) → feature modules (`agents/*.py`,
`portfolio.py`, `web/server.py`) → shared primitives (`db.py`, `engine.py`, `notify.py`,
`data/yahoo.py`, `agents/llm.py`). Each CLI command lazily imports its handler function inside the
`cmd_*` function (not at module top) so `--help` stays fast and a missing `ANTHROPIC_API_KEY` doesn't
block non-Claude commands like `balance`.

**Transactions data model (since the web app):** positions are NOT stored — they are derived from
BUY/SELL rows in `transactions` (per portfolio, per ticker) by `engine.py`, which is pure math (no DB,
no network, fully unit-tested in `tests/`). Sells settle FIFO (oldest lots first); the timeline is
day-granular with BUY-before-SELL as the same-day tie-break (then insertion id; a candidate without
an id sorts last) — same-day buy-then-sell must always be legal. Buy fees are folded into lot cost
basis proportionally, sell fees reduce that sale's realized P&L; cash = deposits − (buys + fees) +
(sells − fees). API dates are normalized/validated to ISO YYYY-MM-DD in the request models. Oversells raise `engine.OversellError` — the API converts that to a 400.
Three currency portfolios (USD/EUR/PLN) are seeded in `portfolios`; the CLI and scheduler operate on
the USD one (`db.get_usd_portfolio_id()`). Legacy `portfolio`-table positions and `amount_usd` deposits
migrate automatically in `db._migrate_legacy()` (idempotent — the old table is renamed to
`portfolio_migrated_backup`).

**Web app:** `web/server.py` (FastAPI) exposes `/api/*` (summary, deposits, transaction CRUD, position
detail with lots, OHLC chart data with transaction markers, instrument metadata, Yahoo ticker-search
proxy) and serves the built React SPA from `web/frontend/dist` with an index.html catch-all for
client-side routes. Quotes go through a 60s TTL cache, FX rates (Yahoo `EURPLN=X`-style pairs) through
a 15-min one. The frontend (React + Vite + lightweight-charts, dark theme, Polish copy) keeps the
active portfolio in the URL (`?p=`); after any write the views refetch via a shared refresh tick — no
page reloads.

**NaN discipline:** every float leaving yfinance passes `data.yahoo.safe_float` (NaN/inf → None) —
raw NaN is not JSON-serializable and once poisoned a summary sum into a 500. Unpriced positions count
into portfolio totals at cost basis, flagged via `unpriced_tickers`/`priced`.

**Currencies:** an instrument's trading currency (from yfinance, cached in `instruments` along with
name/type/exchange) can differ from its portfolio's — allowed deliberately (brokers convert on the
fly). Native prices stay native; `*_pc` fields and all summary totals are converted at the current
FX rate with `fx_rates` exposed so the UI can label them as approximations; a missing FX quote falls
back to 1:1 and is reported in `fx_unavailable` rather than dropping the position or erroring.
Transactions store their instrument currency at write time; NULL-currency legacy rows fall back to
the instrument's currency during cash conversion.

**Transaction edit/delete:** PUT/DELETE `/api/transactions/{id}` hard-replay the affected ticker
history (`_replay_or_400`) and reject with a 400 any edit/delete that would leave a sell without
covering buys at any point in the timeline. Delete is a hard delete (mis-entered rows), not a sell.

**Cash flows:** the `deposits` table holds both directions — `type` DEPOSIT/WITHDRAWAL with amounts
always positive (explicit intent over signed amounts; the sign lives only in
`db.get_total_deposited()`, which returns net contributed capital). Withdrawals are validated
against the current cash balance (web `POST /withdrawals` and CLI `withdraw` alike). Deposit rows
are editable/deletable (PUT/DELETE `/api/deposits/{id}`) guarded by `_min_running_cash`: the change
may not push the running cash balance below its current floor at any point in the timeline (inflows
count before outflows within a day; legacy already-negative histories keep their floor).

**Portfolios are user-managed** (POST/PUT/DELETE `/api/portfolios`; delete only when empty). The
three starter portfolios seed ONLY into an empty table so deletions stick. `SUPPORTED_CURRENCIES`
includes GBP — older DBs get the portfolios table rebuilt once in init_db (SQLite can't alter a
CHECK). The CLI still targets the oldest USD portfolio via `get_usd_portfolio_id()`.

**Portfolio value history** (`GET /api/portfolios/{id}/history`): reconstructed day-by-day by
`valuation.py` (pure, unit-tested) from the ledger — cash from flows, positions from cumulative
shares × historical closes (`get_close_series`, one batch per ticker), foreign currencies at
historical FX-pair series, everything forward-filled over non-trading days. Cached in-memory per
portfolio; the cache signature hashes every ledger row + today's date, so edits and new days
invalidate automatically. Tickers with no quote history at all fall back to a step function of
their own transaction prices.

**Instrument types:** EQUITY/ETF/ETC with manual override (PUT `/api/instrument/{ticker}`) because
Yahoo frequently mislabels ETCs; the override persists since `_ensure_instrument` only fetches
missing rows. Frontend maps types to badges in `format.js` (`typeLabel`/`typeBadgeClass`).

**Chart transaction markers are HTML overlay dots** (`.txn-dot` divs positioned via
`timeToCoordinate`/`priceToCoordinate`, re-laid-out on pan/zoom/resize), NOT native
lightweight-charts markers — native ones can't do outlines, shadows, hover scaling or rich
tooltips. Sells are diamonds (rotated squares), buys circles (green = open, gray = closed).

**Chart markers** are snapped server-side to the nearest existing candle (weekend → Friday/Monday,
post-close → last session) so every marker time is guaranteed to exist in `candles` —
lightweight-charts silently drops markers at unknown times. The original transaction date is kept
in the marker's `date` field for the tooltip. Frontend uses the v5 marker API
(`createSeriesMarkers`), and the time scale carries a `rightOffset` so fresh-transaction dots don't
hug the right edge.

**Config:** `config.py` loads `.env` once via `python-dotenv` and is the single source of truth for the
model ID (`CLAUDE_MODEL`), budget/risk knobs, and `DB_PATH`. Never hardcode secrets or the model string
elsewhere — import from `config`.

**Claude model choice:** `claude-sonnet-5`, chosen deliberately over Opus — this bot calls Claude
frequently (daily briefing, on-demand research/gurus) against a personal budget, and Sonnet 5 gets
near-Opus quality on this kind of analysis/agentic work at a fraction of the cost. `agents/llm.py`
exposes a single lazily-constructed `get_client()` / `MODEL` pair; all three agents import from there
instead of constructing their own `anthropic.Anthropic()`.

**Two different `thinking` postures, intentionally:**
- `agents/scanner.py` and `agents/research.py` use `thinking={"type": "disabled"}` — deterministic,
  cheap, structured (scanner uses `output_config.format` with a JSON schema to reliably parse picks).
- `agents/guru_tracker.py` deliberately leaves thinking on (`{"type": "adaptive"}`, the Sonnet 5
  default) because disabling it makes the model noticeably less willing to reach for the `web_search`
  tool — see the comment at the top of that file before "optimizing" it away.

**Guru tracker's tool loop:** `agents/guru_tracker.py` handles `stop_reason == "pause_turn"` (server-side
web search hit its iteration cap — resend the conversation as-is to resume, don't append a synthetic
"continue" message) and `stop_reason == "refusal"` separately from the normal text-extraction path. Any
change to the search prompt should preserve this loop.

**Fail-soft data layer:** every function in `data/yahoo.py` catches its own exceptions and returns `None`
(never raises) so a delisted ticker or a flaky Yahoo response degrades gracefully instead of crashing a
scheduled job. Downstream code (`portfolio.py`, `agents/scanner.py`) is written to expect `None` prices
and route around them rather than assuming data is always present.

**Capital accounting** (`portfolio.py`): `compute_positions()` (one entry per open FIFO lot of the USD
portfolio, so stop-loss alerts still compare against each entry price) → `compute_drawdown()` (priced
positions only, clamped at ≥0, feeds the stop-loss/max-drawdown alerts) → `compute_capital_summary()`
(adds deposits from `db.get_total_deposited()`; "invested" uses cost basis of *all* open positions,
priced or not, since committed capital is committed capital regardless of whether a quote is fetchable
right now; "available" is the engine's cash balance). `available` can go negative — that's intentional,
it signals over-investment relative to deposits rather than being clamped.

**Notifications:** `notify.py` posts to ntfy's JSON publish API (not the header-based publish form) —
headers don't reliably carry the UTF-8 emoji/Polish text used throughout the notification copy. If
`NTFY_TOPIC` is unset or still the `.env` placeholder, `send_notification()` prints to stdout instead of
raising, so the whole CLI is usable without ntfy configured.

**Scheduler:** `scheduler.py` uses APScheduler's `BlockingScheduler` with cron triggers in
`Europe/Warsaw` (tracks CET/CEST including DST, per the original CET requirement) — 07:00 daily for the
morning briefing, hourly at :30 between 15:00-22:00 on weekdays for stop-loss/drawdown checks (covers US
market hours in CET). Both jobs are wrapped in `_safe()` so one failing run logs and moves on instead of
killing the whole scheduler.

**Database:** `db.py` calls `init_db()` at import time (`CREATE TABLE IF NOT EXISTS` for `portfolios`,
`transactions`, `deposits`, `signals`, `equity_history`), so `alphabot.db` is created automatically the
first time any module imports `db`. No migrations framework — schema changes are additive `ALTER`/new-
table statements added directly to `init_db()` (guarded to stay idempotent, like `_migrate_legacy()`).
Tests point the DB at a temp file via the `ALPHABOT_DB` env var (read in `config.py`) before importing.

**Stock universe:** `agents/scanner.py`'s `UNIVERSE` dict (tech/healthcare/fintech ticker lists) is a
hardcoded starting set, not a live screener query — yfinance has no screener API. Expanding sector
coverage means editing that dict directly.
