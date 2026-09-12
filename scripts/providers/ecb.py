"""ECB（欧州中央銀行）の日次参照為替レートから JPY/USD を組み立てる。

- 取得元: https://data-api.ecb.europa.eu/service/data/EXR/...
- 内容  : D.JPY.EUR（1ユーロあたり円）と D.USD.EUR（1ユーロあたりドル）
- 期間  : 1999-01-04 以降
- 条件  : API キー不要・公開 SDMX API

ECB が取得できない場合は Frankfurter（同じ ECB 参照レートを配信する
公開 API）へフォールバックする。
"""

from __future__ import annotations

import csv
import io
import json

from ._http import FetchError, fetch_text

ECB_URL = (
    "https://data-api.ecb.europa.eu/service/data/EXR/D.JPY+USD.EUR.SP00.A"
    "?format=csvdata&detail=dataonly"
)
FRANKFURTER_URL = "https://api.frankfurter.dev/v1/{start}..?base=USD&symbols=JPY"

SOURCE_NAME = "ECB 日次参照為替レート"
SOURCE_URL = "https://data.ecb.europa.eu/"


def _from_ecb(start: str | None) -> dict[str, float]:
    url = ECB_URL + (f"&startPeriod={start}" if start else "")
    reader = csv.DictReader(io.StringIO(fetch_text(url)))

    jpy_per_eur: dict[str, float] = {}
    usd_per_eur: dict[str, float] = {}
    for row in reader:
        date = row.get("TIME_PERIOD")
        raw_value = row.get("OBS_VALUE")
        currency = row.get("CURRENCY")
        if not date or not raw_value:
            continue
        try:
            value = float(raw_value)
        except ValueError:
            continue
        if value <= 0:
            continue
        if currency == "JPY":
            jpy_per_eur[date] = value
        elif currency == "USD":
            usd_per_eur[date] = value

    series: dict[str, float] = {}
    for date, jpy in jpy_per_eur.items():
        usd = usd_per_eur.get(date)
        if usd:
            series[date] = jpy / usd
    if not series:
        raise FetchError("ECB から有効な為替レートを取得できませんでした")
    return series


def _from_frankfurter(start: str | None) -> dict[str, float]:
    payload = json.loads(fetch_text(FRANKFURTER_URL.format(start=start or "1999-01-04")))
    series: dict[str, float] = {}
    for date, rates in (payload.get("rates") or {}).items():
        value = rates.get("JPY")
        if value:
            series[date] = float(value)
    if not series:
        raise FetchError("Frankfurter から有効な為替レートを取得できませんでした")
    return series


def fetch_jpy_per_usd(start: str | None = None) -> tuple[dict[str, float], str]:
    """USD/JPY の日次系列と、実際に使った取得元名を返す。"""
    try:
        return _from_ecb(start), SOURCE_NAME
    except Exception as ecb_error:  # noqa: BLE001
        try:
            return _from_frankfurter(start), "Frankfurter（ECB 参照レート）"
        except Exception:  # noqa: BLE001
            raise FetchError(f"為替レートの取得に失敗しました: {ecb_error}") from ecb_error
