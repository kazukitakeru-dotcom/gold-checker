#!/usr/bin/env python3
"""検証ロジックとパース処理の自己テスト（ネットワーク不要）。

    python scripts/test_update.py

GitHub Actions では価格取得の前にこれを実行し、パーサや検証ルールを
壊したまま本番データを上書きしてしまうことを防ぐ。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import update_prices  # noqa: E402
import validate  # noqa: E402
from providers import tanaka  # noqa: E402

FAILURES: list[str] = []


def check(condition, message: str) -> None:
    if condition:
        print("  ok   " + message)
    else:
        print("  NG   " + message)
        FAILURES.append(message)


# --------------------------------------------------------------------------
# 値域の検証
# --------------------------------------------------------------------------

def test_plausible_price() -> None:
    print("[値域の検証]")
    check(validate.is_plausible_price(23964), "通常の価格は採用される")
    check(not validate.is_plausible_price(0), "0 円は弾く")
    check(not validate.is_plausible_price(None), "None は弾く")
    check(validate.is_plausible_price("23964"), "数値として読める文字列は採用される")
    check(not validate.is_plausible_price("価格未取得"), "数値でない文字列は弾く")
    check(not validate.is_plausible_price(float("nan")), "NaN は弾く")
    check(not validate.is_plausible_price(float("inf")), "無限大は弾く")
    check(not validate.is_plausible_price(1_000_000), "異常に高い価格は弾く")
    check(not validate.is_plausible_price(-100), "負の価格は弾く")


# --------------------------------------------------------------------------
# 系列の検証
# --------------------------------------------------------------------------

def test_clean_series() -> None:
    print("[系列の検証]")

    healthy = {
        "2026-02-17": 27000,
        "2026-02-18": 27200,
        "2026-02-19": 27100,
        "2026-02-20": 27503,
        "2026-02-21": 27400,
    }
    cleaned, rejected = validate.clean_series(healthy, "test")
    check(len(cleaned) == 5 and not rejected, "正常な系列はそのまま通る")

    with_zero = dict(healthy)
    with_zero["2026-02-24"] = 0
    cleaned, rejected = validate.clean_series(with_zero, "test")
    check("2026-02-24" not in cleaned, "0 円は系列から除外される")

    with_spike = dict(healthy)
    with_spike["2026-02-24"] = 55000
    cleaned, rejected = validate.clean_series(with_spike, "test")
    check("2026-02-24" not in cleaned, "前日比 2 倍の跳ねは除外される")

    broken = {f"2026-03-{day:02d}": (0 if day % 2 else 27000) for day in range(1, 29)}
    try:
        validate.clean_series(broken, "test")
        check(False, "大量に壊れている系列は ValidationError になる")
    except validate.ValidationError:
        check(True, "大量に壊れている系列は ValidationError になる")

    gap = {"2026-02-20": 27503, "2026-03-20": 30000}
    cleaned, rejected = validate.clean_series(gap, "test")
    check(len(cleaned) == 2, "期間が空いた場合の変化は許容幅が広がる")


def test_latest_check() -> None:
    print("[最新値の検証]")
    history = {"2026-09-10": 24063.0, "2026-09-11": 23769.0}

    validate.check_latest_against_history(23964, history, "2026-09-11", "test")
    check(True, "妥当な最新値は通る")

    for bad in (0, None, 999999):
        try:
            validate.check_latest_against_history(bad, history, "2026-09-11", "test")
            check(False, f"異常値 {bad} は ValidationError になる")
        except validate.ValidationError:
            check(True, f"異常値 {bad} は ValidationError になる")

    try:
        validate.check_latest_against_history(40000, history, "2026-09-11", "test")
        check(False, "前日比 +68% は ValidationError になる")
    except validate.ValidationError:
        check(True, "前日比 +68% は ValidationError になる")


# --------------------------------------------------------------------------
# 田中貴金属ページのパース
# --------------------------------------------------------------------------

LATEST_FIXTURE = """
<html><body>
<h2>地金価格</h2>
<p>2026年09月11日 17:00公表(日本時間)</p>
<table>
  <tr><th>&nbsp;</th><th>店頭小売価格（税込）</th><th>小売価格前日比</th>
      <th>店頭買取価格（税込）</th><th>買取価格前日比</th></tr>
  <tr><th>金</th><td>23,964 円</td><td>-99 円</td><td>23,415 円</td><td>-292 円</td></tr>
  <tr><th>プラチナ</th><td>10,118 円</td><td>-355 円</td><td>9,569 円</td><td>-481 円</td></tr>
</table>
</body></html>
"""

DAILY_FIXTURE_HEADER = (
    "<tr><th>&nbsp;</th><th>2025年10月</th><th>2025年11月</th><th>2025年12月</th>"
    "<th>2026年1月</th><th>2026年2月</th><th>2026年3月</th><th>2026年4月</th>"
    "<th>2026年5月</th><th>2026年6月</th><th>2026年7月</th><th>2026年8月</th>"
    "<th>2026年9月</th></tr>"
)


def build_daily_fixture() -> str:
    rows = [DAILY_FIXTURE_HEADER]
    for day in range(1, 32):
        cells = "".join(
            "<td>-</td>" if (day + month) % 3 == 0 else f"<td>2{day:01d},{500 + month:03d}</td>"
            for month in range(12)
        )
        rows.append(f"<tr><th>{day}日</th>{cells}</tr>")
    # 2026年2月20日 の値を明示的に差し替える
    rows[20] = (
        "<tr><th>20日</th><td>22,675</td><td>22,893</td><td>-</td><td>26,191</td>"
        "<td>27,503</td><td>-</td><td>27,011</td><td>25,510</td><td>-</td><td>-</td>"
        "<td>25,427</td><td>-</td></tr>"
    )
    return "<html><body><table>" + "".join(rows) + "</table></body></html>"


def test_tanaka_parsers(monkey_html_latest: str, monkey_html_daily: str) -> None:
    print("[田中貴金属ページのパース]")

    original_fetch = tanaka.fetch_text
    try:
        tanaka.fetch_text = lambda url, **kwargs: monkey_html_latest
        latest = tanaka.fetch_latest()
        check(latest["retail_price"] == 23964, "店頭小売価格を読み取れる")
        check(latest["buy_price"] == 23415, "店頭買取価格を読み取れる")
        check(latest["date"] == "2026-09-11", "公表日を読み取れる")
        check(latest["published_at"].endswith("T17:00:00+09:00"), "公表時刻を読み取れる")

        tanaka.fetch_text = lambda url, **kwargs: monkey_html_daily
        history = tanaka.fetch_daily_retail_history()
        check(history.get("2026-02-20") == 27503, "日次表から特定日の値を読み取れる")
        check(len(history) > 100, "日次表から十分な件数を読み取れる")
        check(all(len(key) == 10 for key in history), "日付キーが YYYY-MM-DD 形式")

        tanaka.fetch_text = lambda url, **kwargs: "<html><body>価格情報はありません</body></html>"
        for name, func in (("最新値", tanaka.fetch_latest), ("日次表", tanaka.fetch_daily_retail_history)):
            try:
                func()
                check(False, f"{name}が読めない場合は例外になる")
            except Exception:
                check(True, f"{name}が読めない場合は例外になる")
    finally:
        tanaka.fetch_text = original_fetch


# --------------------------------------------------------------------------
# 円建て換算
# --------------------------------------------------------------------------

def test_conversion() -> None:
    print("[円換算]")
    usd_per_ounce = 4386.25
    jpy_per_usd = 154.0372
    jpy_per_gram = usd_per_ounce * jpy_per_usd / update_prices.TROY_OUNCE_IN_GRAMS
    check(21700 < jpy_per_gram < 21750, f"1g あたり {jpy_per_gram:.1f} 円に換算される")
    check(
        abs(update_prices.TROY_OUNCE_IN_GRAMS - 31.1034768) < 1e-9,
        "トロイオンスの換算係数が正しい",
    )


def test_points_roundtrip() -> None:
    print("[データ形式]")
    points = [["2026-02-20", 27503], ["2026-02-21", 27400]]
    as_dict = update_prices.points_to_dict(points)
    check(as_dict == {"2026-02-20": 27503.0, "2026-02-21": 27400.0}, "points と dict を相互変換できる")
    check(update_prices.dict_to_points(as_dict, 0) == points, "整数系列は整数のまま戻る")
    check(
        update_prices.dict_to_points({"2026-02-20": 21722.46}, 1) == [["2026-02-20", 21722.5]],
        "小数系列は 1 桁に丸められる",
    )
    check(update_prices.points_to_dict([["2026-02-20", None]]) == {}, "None の点は取り込まない")


def main() -> int:
    test_plausible_price()
    test_clean_series()
    test_latest_check()
    test_tanaka_parsers(LATEST_FIXTURE, build_daily_fixture())
    test_conversion()
    test_points_roundtrip()

    print("")
    if FAILURES:
        print(f"失敗 {len(FAILURES)} 件")
        for message in FAILURES:
            print("  - " + message)
        return 1
    print("すべて成功")
    return 0


if __name__ == "__main__":
    sys.exit(main())
