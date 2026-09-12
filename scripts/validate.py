"""取得した価格データの検証ルール。

「取得に失敗したのに 0 円や異常値を正常値として保存してしまう」ことを
防ぐのがこのモジュールの役割。ここを通らなかった値は保存しない。
"""

from __future__ import annotations

from datetime import date, timedelta

# 円/g として現実的にありうる範囲。ここを外れた値は取得失敗とみなす。
PRICE_MIN_JPY_PER_G = 300.0
PRICE_MAX_JPY_PER_G = 200_000.0

# 1 営業日あたりに許容する変化率。休場を挟む場合は日数の平方根で緩める。
MAX_DAILY_CHANGE = 0.10
MAX_GAP_CHANGE = 0.35

# 系列全体のうちこの割合を超えて弾かれた場合は、取得元の仕様変更を疑って中止する。
MAX_REJECT_RATIO = 0.01

# 為替・ドル建て価格の妥当範囲。
USD_PER_OUNCE_RANGE = (100.0, 30_000.0)
JPY_PER_USD_RANGE = (50.0, 400.0)


class ValidationError(RuntimeError):
    """検証に通らず、更新を中止すべき状態。"""


def in_range(value: float, bounds: tuple[float, float]) -> bool:
    low, high = bounds
    return isinstance(value, (int, float)) and value == value and low <= value <= high


def is_plausible_price(value) -> bool:
    """円/g として妥当な値かどうか。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    if number != number or number in (float("inf"), float("-inf")):
        return False
    return PRICE_MIN_JPY_PER_G <= number <= PRICE_MAX_JPY_PER_G


def allowed_change(gap_days: int) -> float:
    """休場日数を考慮した許容変化率。"""
    gap = max(1, gap_days)
    return min(MAX_GAP_CHANGE, MAX_DAILY_CHANGE * (gap ** 0.5))


def clean_series(series: dict[str, float], label: str) -> tuple[dict[str, float], list[str]]:
    """日次系列から異常値を取り除く。

    戻り値は (採用した系列, 弾いた理由のリスト)。
    弾いた割合が大きすぎる場合は ValidationError を送出する。
    """
    accepted: dict[str, float] = {}
    rejected: list[str] = []
    previous_date: date | None = None
    previous_value: float | None = None

    for key in sorted(series):
        value = series[key]
        if not is_plausible_price(value):
            rejected.append(f"{label} {key}: 値域外 ({value})")
            continue
        value = float(value)

        try:
            current_date = date.fromisoformat(key)
        except ValueError:
            rejected.append(f"{label} {key}: 日付が不正")
            continue

        if previous_value is not None and previous_date is not None:
            gap = (current_date - previous_date).days
            change = abs(value - previous_value) / previous_value
            if change > allowed_change(gap):
                rejected.append(
                    f"{label} {key}: 前回比 {change:.1%} は許容外 "
                    f"({previous_value:.1f} -> {value:.1f}, {gap}日)"
                )
                continue

        accepted[key] = value
        previous_date = current_date
        previous_value = value

    if series and len(rejected) > max(3, len(series) * MAX_REJECT_RATIO):
        raise ValidationError(
            f"{label}: {len(series)} 件中 {len(rejected)} 件が検証に失敗したため更新を中止します"
        )
    return accepted, rejected


def check_latest_against_history(
    value: float, history: dict[str, float], as_of: str, label: str
) -> None:
    """最新値が既存履歴から見て不自然に飛んでいないか確認する。"""
    if not is_plausible_price(value):
        raise ValidationError(f"{label}: 最新値 {value} は値域外です")
    if not history:
        return

    last_key = max(history)
    last_value = history[last_key]
    try:
        gap = (date.fromisoformat(as_of) - date.fromisoformat(last_key)).days
    except ValueError:
        gap = 1
    if gap <= 0:
        gap = 1

    change = abs(float(value) - last_value) / last_value
    if change > allowed_change(gap):
        raise ValidationError(
            f"{label}: 最新値の前回比 {change:.1%} が許容外です "
            f"({last_key} {last_value:.1f} -> {as_of} {float(value):.1f})"
        )


def is_stale(as_of: str, today: date, max_age_days: int) -> bool:
    """データが古すぎるかどうか。"""
    try:
        return date.fromisoformat(as_of) < today - timedelta(days=max_age_days)
    except ValueError:
        return True
