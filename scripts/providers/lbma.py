"""LBMA（ロンドン地金市場協会）が公開する金の公式建値を取得する。

- 取得元: https://prices.lbma.org.uk/json/gold_pm.json
- 内容  : LBMA Gold Price PM（1トロイオンスあたり USD / GBP / EUR）
- 頻度  : ロンドン営業日の 1 日 1 回
- 条件  : API キー不要・公開 JSON
"""

from __future__ import annotations

import json

from ._http import FetchError, fetch_text

PM_URL = "https://prices.lbma.org.uk/json/gold_pm.json"
AM_URL = "https://prices.lbma.org.uk/json/gold_am.json"

SOURCE_NAME = "LBMA Gold Price PM"
SOURCE_URL = "https://www.lbma.org.uk/prices-and-data/precious-metal-prices"


def _parse(raw: str) -> dict[str, float]:
    """LBMA の JSON を {"YYYY-MM-DD": USD/oz} へ変換する。"""
    payload = json.loads(raw)
    series: dict[str, float] = {}
    for row in payload:
        date = row.get("d")
        values = row.get("v") or []
        if not date or not values:
            continue
        usd = values[0]
        if usd is None:
            continue
        try:
            usd = float(usd)
        except (TypeError, ValueError):
            continue
        if usd <= 0:
            continue
        series[date] = usd
    return series


def fetch_usd_per_ounce() -> tuple[dict[str, float], str]:
    """USD/トロイオンスの日次系列と、実際に使った建値名を返す。

    PM 建値が取れない場合のみ AM 建値へフォールバックする。
    """
    try:
        return _parse(fetch_text(PM_URL)), SOURCE_NAME
    except (FetchError, json.JSONDecodeError) as pm_error:
        try:
            return _parse(fetch_text(AM_URL)), "LBMA Gold Price AM"
        except Exception:  # noqa: BLE001
            raise FetchError(f"LBMA の価格取得に失敗しました: {pm_error}") from pm_error
