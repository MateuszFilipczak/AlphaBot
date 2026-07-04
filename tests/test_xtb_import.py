"""XTB xlsx import: parser (volumes, partial fills, Excel serial dates,
transfers, amount validation), duplicate detection via external_id, and the
preview/commit API flow."""
from datetime import datetime
from io import BytesIO
from pathlib import Path

import openpyxl
import pytest
from fastapi.testclient import TestClient

import db
import web.server as server
from importers.xtb import map_ticker, parse_xtb_export

REAL_EXPORT = Path("/Users/mateusz/Downloads/54998934/export_nowy.xlsx")


def build_xtb_xlsx(cash_rows, closed_rows=()):
    """An in-memory workbook shaped exactly like XTB's export: metadata junk
    above the header, a Total row at the bottom, both sheets present."""
    wb = openpyxl.Workbook()
    closed = wb.active
    closed.title = "Closed Positions"
    closed.append(["Account", "12345678"])
    closed.append(["Closed Positions", ""])
    closed.append(["Instrument", "Category", "Ticker", "Type", "Volume", "Open Price"])
    for row in closed_rows:
        closed.append(row)
    closed.append(["Profit/loss"])

    cash = wb.create_sheet("Cash Operations")
    cash.append(["Account number", "12345678"])
    cash.append(["Cash Operations", ""])
    cash.append(["Date from (UTC)", datetime(2025, 9, 30, 22)])
    cash.append(["Type", "Ticker", "Instrument", "Time", "Amount", "ID", "Comment", "Product"])
    for row in cash_rows:
        cash.append(row)
    cash.append(["Total", None, None, None, 1.37])

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


SAMPLE_ROWS = [
    ["Stock purchase", "EGLN.UK", "Physical Gold", datetime(2026, 6, 1, 10, 36),
     "-67.12", "1288170641", "OPEN BUY 0.8942 @ 75.0600", "My Trades"],
    # partial fill: volume of THIS operation is before the slash
    ["Stock purchase", "VWCE.DE", "FTSE All-World", datetime(2026, 5, 29, 7, 5),
     -37.26, "1284805510", "OPEN BUY 0.228/1.228 @ 163.40", "My Trades"],
    # Excel serial date instead of a datetime (46174 = 2026-06-01)
    ["Stock purchase", "AAPL.US", "Apple", 46174.44,
     -371.0, "1284805999", "OPEN BUY 2 @ 185.50", "My Trades"],
    ["Stock sale", "AAPL.US", "Apple", datetime(2026, 6, 2, 15, 0),
     190.0, "1290000001", "CLOSE BUY 1 @ 190.00", "My Trades"],
    ["Deposit", "", "", datetime(2026, 5, 28, 17, 16),
     492.84, "1284343298", "Pekao S.A. deposit, id=33282295", "My Trades"],
    ["Transfer", "", "", datetime(2026, 6, 1, 10, 35),
     126.99, "1288169899", "Currency conversion, PLN to EUR from TA: 1 to: 2", "My Trades"],
    # amount clearly off shares×price → row-level warning
    ["Stock purchase", "SXR8.DE", "Core S&P 500", datetime(2026, 5, 29, 7, 6),
     -100.0, "1284806253", "OPEN BUY 0.1021 @ 699.50", "My Trades"],
    ["Dividend", "KO.US", "Coca-Cola", datetime(2026, 5, 20, 12, 0),
     1.23, "1280000000", "KO.US USD 0.485/ SHR", "My Trades"],
]


# ---- Parser -----------------------------------------------------------------

def test_parser_on_synthetic_export():
    result = parse_xtb_export(build_xtb_xlsx(SAMPLE_ROWS))
    ops = result["operations"]
    by_kind = {}
    for op in ops:
        by_kind.setdefault(op["kind"], []).append(op)

    assert len(by_kind["BUY"]) == 4
    assert len(by_kind["SELL"]) == 1
    assert len(by_kind["DEPOSIT"]) == 1
    assert len(by_kind["TRANSFER"]) == 1

    egln = next(o for o in ops if o["external_id"] == "1288170641")
    assert egln["ticker"] == "EGLN.L"  # .UK → .L
    assert egln["shares"] == pytest.approx(0.8942)
    assert egln["price"] == pytest.approx(75.06)
    assert egln["amount"] == pytest.approx(67.12)  # string amount coerced
    assert egln["warning"] is None

    partial = next(o for o in ops if o["external_id"] == "1284805510")
    assert partial["shares"] == pytest.approx(0.228)  # NOT 1.228

    serial = next(o for o in ops if o["external_id"] == "1284805999")
    assert serial["date"] == "2026-06-01"  # 46174.44 days since 1899-12-30
    assert serial["ticker"] == "AAPL"  # .US → no suffix

    sale = next(o for o in ops if o["kind"] == "SELL")
    assert (sale["shares"], sale["price"]) == (1, 190.0)

    transfer = next(o for o in ops if o["kind"] == "TRANSFER")
    assert transfer["note"] == "przewalutowanie z PLN"
    assert transfer["amount"] == pytest.approx(126.99)

    mismatch = next(o for o in ops if o["external_id"] == "1284806253")
    assert mismatch["warning"] is not None  # 100.0 vs 0.1021×699.50 = 71.42

    # unsupported Dividend row → file-level warning, not an operation
    assert all(o["external_id"] != "1280000000" for o in ops)
    assert any("Dividend" in w for w in result["warnings"])


def test_amount_within_tolerance_no_warning():
    rows = [["Stock purchase", "VWCE.DE", "x", datetime(2026, 1, 2),
             -163.9, "1", "OPEN BUY 1 @ 163.48", "My Trades"]]  # 0.26% off
    op = parse_xtb_export(build_xtb_xlsx(rows))["operations"][0]
    assert op["warning"] is None


def test_closed_positions_with_rows_warns():
    closed = [["FTSE All-World", "ETF", "VWCE.DE", "BUY", 1.0, 100.0]]
    result = parse_xtb_export(build_xtb_xlsx(SAMPLE_ROWS[:1], closed_rows=closed))
    assert any("Closed Positions" in w for w in result["warnings"])
    assert len(result["operations"]) == 1  # nothing duplicated from that sheet


def test_not_an_xtb_file_raises():
    wb = openpyxl.Workbook()
    buf = BytesIO()
    wb.save(buf)
    with pytest.raises(ValueError, match="Cash Operations"):
        parse_xtb_export(buf.getvalue())
    with pytest.raises(ValueError):
        parse_xtb_export(b"definitely not xlsx")


def test_suffix_mapping():
    assert map_ticker("EGLN.UK") == "EGLN.L"
    assert map_ticker("CDR.PL") == "CDR.WA"
    assert map_ticker("AAPL.US") == "AAPL"
    assert map_ticker("SXR8.DE") == "SXR8.DE"
    assert map_ticker("TTE.FR") == "TTE.PA"
    assert map_ticker("ASML.NL") == "ASML.AS"
    assert map_ticker("ENI.IT") == "ENI.MI"
    assert map_ticker("SAN.ES") == "SAN.MC"
    assert map_ticker("WEIRD.XX") == "WEIRD.XX"  # unknown suffix passes through


@pytest.mark.skipif(not REAL_EXPORT.exists(), reason="real XTB export not present")
def test_parser_on_real_export():
    result = parse_xtb_export(REAL_EXPORT.read_bytes())
    ops = result["operations"]
    kinds = [o["kind"] for o in ops]
    assert kinds.count("BUY") == 18
    assert kinds.count("DEPOSIT") == 4
    assert kinds.count("TRANSFER") == 3
    assert result["warnings"] == []
    assert all(o["warning"] is None for o in ops)  # amounts all reconcile
    partial = next(o for o in ops if o["external_id"] == "1284805510")
    assert partial["shares"] == pytest.approx(0.228)


# ---- API: preview + commit ---------------------------------------------------

@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "_cached_price", lambda ticker: 100.0)
    monkeypatch.setattr(server, "get_current_price", lambda ticker: 100.0)
    monkeypatch.setattr(server, "get_instrument_info", lambda t: {
        "ticker": t.upper(), "name": f"{t.upper()} Inc.", "type": "ETF",
        "exchange": "TEST", "currency": "EUR",
    } if t.upper() != "BOGUS.XX" else None)
    server._price_cache.clear()
    server._fx_cache.clear()
    server._history_cache.clear()
    return TestClient(server.app)


@pytest.fixture()
def portfolio_id(client):
    r = client.post("/api/portfolios", json={"name": "Import testowy", "currency": "EUR"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    yield pid
    client.delete(f"/api/portfolios/{pid}?force=true")


def upload(client, pid, content):
    return client.post(
        f"/api/portfolios/{pid}/import/xtb",
        files={"file": ("export.xlsx", content,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )


def test_preview_commit_and_reimport_flow(client, portfolio_id):
    content = build_xtb_xlsx(SAMPLE_ROWS)

    preview = upload(client, portfolio_id, content)
    assert preview.status_code == 200, preview.text
    ops = preview.json()["operations"]
    assert len(ops) == 7
    assert all(op["already_exists"] is False for op in ops)
    assert all(op["ticker_verified"] is True for op in ops if op["ticker"])

    commit = client.post(
        f"/api/portfolios/{portfolio_id}/import/xtb/commit",
        json={"operations": ops},
    )
    assert commit.status_code == 201, commit.text
    assert commit.json() == {"imported": 7, "skipped_duplicates": 0}

    # engine state after import: buys minus the 1-share sale
    summary = client.get(f"/api/portfolios/{portfolio_id}/summary").json()
    tickers = {p["ticker"]: p for p in summary["positions"]}
    assert tickers["AAPL"]["shares"] == pytest.approx(1.0)  # 2 bought, 1 sold
    assert tickers["EGLN.L"]["shares"] == pytest.approx(0.8942)
    deposits = client.get(f"/api/portfolios/{portfolio_id}/deposits").json()
    assert len(deposits) == 2  # Deposit + Transfer
    assert any(d["note"] == "przewalutowanie z PLN" for d in deposits)

    # re-import of the same file: everything flagged, commit imports nothing
    preview2 = upload(client, portfolio_id, content)
    ops2 = preview2.json()["operations"]
    assert all(op["already_exists"] is True for op in ops2)
    commit2 = client.post(
        f"/api/portfolios/{portfolio_id}/import/xtb/commit",
        json={"operations": ops2},
    )
    assert commit2.json() == {"imported": 0, "skipped_duplicates": 7}
    assert len(client.get(f"/api/portfolios/{portfolio_id}/deposits").json()) == 2


def test_unverified_ticker_flagged_in_preview(client, portfolio_id):
    rows = [["Stock purchase", "BOGUS.XX", "Mystery", datetime(2026, 1, 2),
             -100.0, "42", "OPEN BUY 1 @ 100.00", "My Trades"]]
    ops = upload(client, portfolio_id, build_xtb_xlsx(rows)).json()["operations"]
    assert ops[0]["ticker_verified"] is False


def test_commit_rejects_uncovered_sell(client, portfolio_id):
    ops = [{"kind": "SELL", "ticker": "AAPL", "date": "2026-01-02",
            "shares": 1, "price": 100.0, "amount": 100.0,
            "external_id": "777", "note": None}]
    r = client.post(f"/api/portfolios/{portfolio_id}/import/xtb/commit",
                    json={"operations": ops})
    assert r.status_code == 400
    assert "AAPL" in r.json()["detail"]
    # nothing was written
    assert client.get(f"/api/portfolios/{portfolio_id}/summary").json()["positions"] == []


def test_commit_imported_transactions_use_portfolio_currency(client, portfolio_id):
    rows = [["Stock purchase", "EGLN.UK", "Physical Gold", datetime(2026, 6, 1),
             "-67.12", "1288170641", "OPEN BUY 0.8942 @ 75.0600", "My Trades"]]
    ops = upload(client, portfolio_id, build_xtb_xlsx(rows)).json()["operations"]
    client.post(f"/api/portfolios/{portfolio_id}/import/xtb/commit",
                json={"operations": ops})
    txns = db.get_transactions(portfolio_id, "EGLN.L")
    # GBp-quoted LSE instrument: the file's price stays, currency is the
    # portfolio's (XTB charged the account currency) — never rescaled
    assert txns[0]["price"] == pytest.approx(75.06)
    assert txns[0]["currency"] == "EUR"
    assert txns[0]["external_id"] == "1288170641"
