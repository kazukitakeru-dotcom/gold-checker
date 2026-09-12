"""田中貴金属工業が公表する店頭小売価格・店頭買取価格を取得する。

- 取得元: https://gold.tanaka.co.jp/commodity/souba/
          https://gold.tanaka.co.jp/commodity/souba/d-gold.php
- 内容  : 店頭小売価格（税込）/ 店頭買取価格（税込）、1g あたりの円建て価格
- 頻度  : 営業日の 9:30 公表（日中に変更あり。最新は 17:00 公表）
- 条件  : robots.txt は Allow: /。1 日 2 回までのアクセスに留めている。

トップページは「最新の公表値」、d-gold.php は「9:30 公表値の直近 12 か月分の
日次表」を持つ。履歴は 9:30 公表系列、現在値は最新公表値として別々に扱う。
"""

from __future__ import annotations

import re
from datetime import date as date_type

from ._http import FetchError, fetch_text

TOP_URL = "https://gold.tanaka.co.jp/commodity/souba/"
DAILY_URL = "https://gold.tanaka.co.jp/commodity/souba/d-gold.php"

SOURCE_NAME = "田中貴金属工業"
SOURCE_URL = "https://gold.tanaka.co.jp/commodity/souba/"
PRICE_TYPE_RETAIL = "店頭小売価格（税込）"
PRICE_TYPE_BUY = "店頭買取価格（税込）"

_TAG = re.compile(r"<[^>]+>")
_SCRIPT = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S)
_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S)
_TABLE = re.compile(r"<table[^>]*>(.*?)</table>", re.S)
_PUBLISHED = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})\s*公表")
_YEAR_MONTH = re.compile(r"(\d{4})年\s*(\d{1,2})月")
_DAY = re.compile(r"^(\d{1,2})日$")


def _clean(fragment: str) -> str:
    text = _TAG.sub("", fragment)
    text = text.replace("&nbsp;", " ").replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip()


def _rows(html: str) -> list[list[str]]:
    body = _SCRIPT.sub("", html)
    result: list[list[str]] = []
    for row_html in _ROW.findall(body):
        cells = [_clean(cell) for cell in _CELL.findall(row_html)]
        if cells:
            result.append(cells)
    return result


def _to_int(text: str) -> int | None:
    match = re.search(r"(\d{1,3}(?:,\d{3})+|\d+)", text)
    if not match:
        return None
    try:
        return int(match.group(1).replace(",", ""))
    except ValueError:
        return None


def fetch_latest() -> dict:
    """最新公表の店頭小売価格・店頭買取価格を返す。"""
    html = fetch_text(TOP_URL)

    published = _PUBLISHED.search(_SCRIPT.sub("", html))
    if not published:
        raise FetchError("田中貴金属のページから公表日時を読み取れませんでした")
    year, month, day, hour, minute = (int(value) for value in published.groups())

    retail = buy = None
    for cells in _rows(html):
        if cells[0] != "金" or len(cells) < 4:
            continue
        candidate_retail = _to_int(cells[1])
        candidate_buy = _to_int(cells[3])
        if candidate_retail and candidate_buy:
            retail, buy = candidate_retail, candidate_buy
            break
    if retail is None or buy is None:
        raise FetchError("田中貴金属のページから金価格を読み取れませんでした")

    return {
        "date": date_type(year, month, day).isoformat(),
        "published_at": f"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:00+09:00",
        "retail_price": retail,
        "buy_price": buy,
    }


def fetch_daily_retail_history() -> dict[str, int]:
    """9:30 公表の店頭小売価格（税込）の日次表を {"YYYY-MM-DD": 価格} で返す。"""
    html = _SCRIPT.sub("", fetch_text(DAILY_URL))

    for table_html in _TABLE.findall(html):
        rows = [
            [_clean(cell) for cell in _CELL.findall(row_html)]
            for row_html in _ROW.findall(table_html)
        ]
        rows = [row for row in rows if row]
        if len(rows) < 20:
            continue

        header = rows[0]
        columns: dict[int, tuple[int, int]] = {}
        for index, cell in enumerate(header):
            match = _YEAR_MONTH.search(cell)
            if match:
                columns[index] = (int(match.group(1)), int(match.group(2)))
        if len(columns) < 6:
            continue

        series: dict[str, int] = {}
        for row in rows[1:]:
            day_match = _DAY.match(row[0])
            if not day_match:
                continue
            day = int(day_match.group(1))
            for index, (year, month) in columns.items():
                if index >= len(row):
                    continue
                price = _to_int(row[index])
                if price is None:
                    continue
                try:
                    key = date_type(year, month, day).isoformat()
                except ValueError:
                    continue
                series[key] = price
        if series:
            return series

    raise FetchError("田中貴金属の日次価格表を読み取れませんでした")
