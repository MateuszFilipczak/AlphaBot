"""Parser for XTB account exports (xlsx) — pure like engine.py: bytes in,
operation dicts out, no DB and no network. The web layer decides what to do
with the result (duplicate detection, ticker verification, persisting).

XTB's "Cash Operations" sheet is the source of truth: stock purchases/sales
appear there alongside deposits and currency transfers, with the volume and
price embedded in the Comment column ("OPEN BUY 0.8942 @ 75.0600"). Prices in
those comments are in the ACCOUNT currency (XTB converts on the fly), which is
why an imported transaction keeps the file's price and the portfolio's
currency — notably for LSE instruments Yahoo quotes in GBp (pence): the XTB
price is what was actually paid, so it is never rescaled here.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from io import BytesIO

# XTB ticker suffix → Yahoo suffix. ".US" maps to no suffix at all.
SUFFIX_MAP = {
    ".UK": ".L",
    ".PL": ".WA",
    ".US": "",
    ".DE": ".DE",
    ".FR": ".PA",
    ".NL": ".AS",
    ".IT": ".MI",
    ".ES": ".MC",
}

CASH_SHEET = "Cash Operations"
CLOSED_SHEET = "Closed Positions"
CASH_HEADER = ("Type", "Ticker", "Instrument", "Time", "Amount", "ID", "Comment", "Product")

# "OPEN BUY 0.8942 @ 75.0600" / "CLOSE BUY 2 @ 163.40" — and partial fills
# "OPEN BUY 0.228/1.228 @ 163.40" where the volume of THIS operation is the
# number before the slash (the total position size follows it).
_COMMENT_RE = re.compile(
    r"(?:OPEN|CLOSE)\s+(?:BUY|SELL)\s+([\d.,]+)(?:/[\d.,]+)?\s*@\s*([\d.,]+)"
)

# |Amount| must match shares×price up to rounding: 1% relative, plus a small
# absolute allowance so a €0.5 operation doesn't trip on a 1-cent rounding.
_AMOUNT_REL_TOL = 0.01
_AMOUNT_ABS_TOL = 0.02

_EXCEL_EPOCH = datetime(1899, 12, 30)


def map_ticker(xtb_ticker: str) -> str:
    """XTB ticker → Yahoo ticker via the suffix table; unknown suffixes pass
    through unchanged (the preview lets the user correct them by hand)."""
    ticker = xtb_ticker.strip().upper()
    for suffix, yahoo in SUFFIX_MAP.items():
        if ticker.endswith(suffix):
            return ticker[: -len(suffix)] + yahoo
    return ticker


def _to_float(value) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip().replace(",", "."))
    except ValueError:
        return None


def _to_iso_date(value) -> str | None:
    """XTB's Time column arrives as a datetime, an Excel serial number
    (days since 1899-12-30, e.g. 46174.44) or occasionally text."""
    if isinstance(value, datetime):
        return value.date().isoformat()
    serial = _to_float(value)
    if serial is not None and 1 < serial < 200000:
        return (_EXCEL_EPOCH + timedelta(days=serial)).date().isoformat()
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.strip()).date().isoformat()
        except ValueError:
            return None
    return None


def _parse_comment(comment: str) -> tuple[float, float] | None:
    m = _COMMENT_RE.search(comment or "")
    if not m:
        return None
    shares = _to_float(m.group(1))
    price = _to_float(m.group(2))
    if shares is None or price is None or shares <= 0 or price < 0:
        return None
    return shares, price


def _amount_mismatch(amount: float, shares: float, price: float) -> bool:
    expected = shares * price
    tolerance = max(_AMOUNT_REL_TOL * max(abs(amount), expected), _AMOUNT_ABS_TOL)
    return abs(abs(amount) - expected) > tolerance


def parse_xtb_export(content: bytes) -> dict:
    """Parse an XTB xlsx export into operation dicts + file-level warnings.

    Returns {"operations": [...], "warnings": [...]}; raises ValueError when
    the file is not an XTB export (missing sheet/header). Each operation:
    kind BUY/SELL/DEPOSIT/TRANSFER, ticker (Yahoo-mapped, None for cash ops),
    xtb_ticker, date (ISO), shares/price (None for cash ops), amount (always
    positive), external_id (XTB's ID column), note, warning (row-level).
    """
    import openpyxl  # local import: keeps `import db`-style startup light

    try:
        wb = openpyxl.load_workbook(BytesIO(content), read_only=True, data_only=True)
    except Exception as exc:
        raise ValueError(f"Nie można odczytać pliku xlsx: {exc}") from exc

    if CASH_SHEET not in wb.sheetnames:
        raise ValueError(f"Brak arkusza „{CASH_SHEET}” — to nie wygląda na eksport XTB")

    warnings: list[str] = []
    operations: list[dict] = []

    ws = wb[CASH_SHEET]
    ws.reset_dimensions()  # XTB writes broken dimension metadata (A1:A1)
    rows = ws.iter_rows(values_only=True)

    header_seen = False
    for row in rows:
        if not header_seen:
            if row and tuple(str(c or "").strip() for c in row[: len(CASH_HEADER)]) == CASH_HEADER:
                header_seen = True
            continue

        cells = list(row) + [None] * (len(CASH_HEADER) - len(row))
        op_type, ticker, _instrument, time_val, amount_val, ext_id, comment, _product = (
            cells[: len(CASH_HEADER)]
        )
        op_type = str(op_type or "").strip()
        if not op_type or op_type == "Total":
            continue

        amount = _to_float(amount_val)
        date = _to_iso_date(time_val)
        external_id = str(ext_id).strip() if ext_id not in (None, "") else None
        comment = str(comment or "").strip()

        if date is None or amount is None:
            warnings.append(f"Pominięto wiersz „{op_type}” (ID {external_id}): brak daty lub kwoty")
            continue

        if op_type in ("Stock purchase", "Stock sale"):
            kind = "BUY" if op_type == "Stock purchase" else "SELL"
            parsed = _parse_comment(comment)
            if parsed is None:
                warnings.append(
                    f"Pominięto {kind} {ticker} (ID {external_id}): "
                    f"nie rozpoznano ilości/ceny w komentarzu „{comment}”"
                )
                continue
            shares, price = parsed
            warning = None
            if _amount_mismatch(amount, shares, price):
                warning = (
                    f"kwota {abs(amount):.2f} nie zgadza się z ilość×cena "
                    f"({shares * price:.2f})"
                )
            xtb_ticker = str(ticker or "").strip()
            operations.append({
                "kind": kind,
                "xtb_ticker": xtb_ticker,
                "ticker": map_ticker(xtb_ticker) if xtb_ticker else None,
                "date": date,
                "shares": shares,
                "price": price,
                "amount": abs(amount),
                "external_id": external_id,
                "note": None,
                "warning": warning,
            })
        elif op_type in ("Deposit", "Transfer"):
            operations.append({
                "kind": "DEPOSIT" if op_type == "Deposit" else "TRANSFER",
                "xtb_ticker": None,
                "ticker": None,
                "date": date,
                "shares": None,
                "price": None,
                "amount": abs(amount),
                "external_id": external_id,
                "note": "przewalutowanie z PLN" if op_type == "Transfer" else None,
                "warning": None,
            })
        else:
            warnings.append(f"Pominięto nieobsługiwany typ operacji „{op_type}” (ID {external_id})")

    if not header_seen:
        raise ValueError(f"Nie znaleziono nagłówka w arkuszu „{CASH_SHEET}”")

    # Closed positions import via their Cash Operations rows — never twice.
    if CLOSED_SHEET in wb.sheetnames:
        closed = _count_closed_rows(wb[CLOSED_SHEET])
        if closed:
            warnings.append(
                f"Arkusz „{CLOSED_SHEET}” zawiera {closed} pozycji — zamknięte pozycje "
                f"importują się z Cash Operations, nie są duplikowane"
            )

    return {"operations": operations, "warnings": warnings}


def _count_closed_rows(ws) -> int:
    """Data rows in Closed Positions, i.e. rows after its header that carry an
    instrument (summary rows like 'Profit/loss' have nothing in column 3)."""
    ws.reset_dimensions()
    count = 0
    header_seen = False
    for row in ws.iter_rows(values_only=True):
        first = str(row[0] or "").strip() if row else ""
        if not header_seen:
            if first == "Instrument":
                header_seen = True
            continue
        if len(row) > 2 and row[2] not in (None, ""):
            count += 1
    return count
