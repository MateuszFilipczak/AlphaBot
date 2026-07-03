"""get_current_price fallback chain: fast_info → info → history.
yf.Ticker is mocked — no network."""
import pandas as pd
import pytest

import data.yahoo as yahoo


class FakeFastInfo:
    def __init__(self, last_price=None, raises=False):
        self._last_price = last_price
        self._raises = raises

    @property
    def last_price(self):
        if self._raises:
            raise KeyError("last_price")
        return self._last_price


class FakeTicker:
    """Configured via class attrs set per test (yf.Ticker is called positionally)."""
    fast_info_obj = FakeFastInfo()
    info_obj: dict | None = {}
    info_raises = False
    hist_df: pd.DataFrame | None = None

    def __init__(self, ticker):
        self.ticker = ticker

    @property
    def fast_info(self):
        return type(self).fast_info_obj

    def get_info(self):
        if type(self).info_raises:
            raise RuntimeError("no info")
        return type(self).info_obj

    def history(self, period=None, interval=None):
        df = type(self).hist_df
        return df if df is not None else pd.DataFrame()


@pytest.fixture()
def fake_ticker(monkeypatch):
    class T(FakeTicker):
        pass
    monkeypatch.setattr(yahoo.yf, "Ticker", T)
    return T


def hist(closes):
    return pd.DataFrame({"Close": closes})


def test_fast_info_empty_but_history_works(fake_ticker, caplog):
    """The spec'd case: fast_info empty, info empty, history has data → price."""
    fake_ticker.fast_info_obj = FakeFastInfo(last_price=None)
    fake_ticker.info_obj = {}
    fake_ticker.hist_df = hist([98.0, 101.5])
    with caplog.at_level("WARNING", logger="alphabot.yahoo"):
        assert yahoo.get_current_price("DNP.WA") == pytest.approx(101.5)
    # failed steps are logged for diagnosability
    assert "fast_info.last_price unavailable" in caplog.text
    assert "regularMarketPrice unavailable" in caplog.text


def test_fast_info_wins_when_available(fake_ticker):
    fake_ticker.fast_info_obj = FakeFastInfo(last_price=123.45)
    fake_ticker.info_obj = {"currentPrice": 999}
    assert yahoo.get_current_price("AAPL") == pytest.approx(123.45)


def test_fast_info_nan_falls_through_to_info(fake_ticker):
    fake_ticker.fast_info_obj = FakeFastInfo(last_price=float("nan"))
    fake_ticker.info_obj = {"currentPrice": 55.5}
    assert yahoo.get_current_price("X") == pytest.approx(55.5)


def test_fast_info_raising_falls_through(fake_ticker):
    fake_ticker.fast_info_obj = FakeFastInfo(raises=True)
    fake_ticker.info_obj = {"regularMarketPrice": 77.0}
    assert yahoo.get_current_price("X") == pytest.approx(77.0)


def test_info_raising_falls_through_to_history(fake_ticker):
    fake_ticker.fast_info_obj = FakeFastInfo(last_price=None)
    fake_ticker.info_raises = True
    fake_ticker.hist_df = hist([42.0])
    assert yahoo.get_current_price("X") == pytest.approx(42.0)


def test_all_sources_failing_returns_none(fake_ticker, caplog):
    fake_ticker.fast_info_obj = FakeFastInfo(last_price=None)
    fake_ticker.info_obj = {}
    fake_ticker.hist_df = None
    with caplog.at_level("WARNING", logger="alphabot.yahoo"):
        assert yahoo.get_current_price("GONE") is None
    assert "all price sources failed" in caplog.text
