"""HTTP 取得の共通ヘルパー（標準ライブラリのみ）。

外部依存を持たせないことで、GitHub Actions 側で pip install を不要にしている。
"""

from __future__ import annotations

import gzip
import time
import urllib.error
import urllib.request

USER_AGENT = (
    "Mozilla/5.0 (compatible; gold-checker/1.0; "
    "+https://github.com/kazukitakeru-dotcom/gold-checker)"
)

DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "ja,en;q=0.8",
    "Accept-Encoding": "gzip",
}


class FetchError(RuntimeError):
    """取得に失敗したことを表す例外。"""


def fetch_bytes(url: str, timeout: int = 30, retries: int = 3, headers: dict | None = None) -> bytes:
    """URL の内容をバイト列で返す。リトライ付き。"""
    merged = dict(DEFAULT_HEADERS)
    if headers:
        merged.update(headers)

    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers=merged)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body
        except Exception as error:  # noqa: BLE001 - ネットワーク系は全部リトライ対象
            last_error = error
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    raise FetchError(f"{url} の取得に失敗しました: {last_error}")


def fetch_text(url: str, encoding: str = "utf-8", **kwargs) -> str:
    """URL の内容を文字列で返す。"""
    return fetch_bytes(url, **kwargs).decode(encoding, errors="replace")
