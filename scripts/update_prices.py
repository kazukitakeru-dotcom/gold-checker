#!/usr/bin/env python3
"""金価格データを取得して data/*.json を更新する。

使い方:
    python scripts/update_prices.py                    # 通常更新
    python scripts/update_prices.py --dry-run          # ファイルを書かずに結果だけ表示

設計方針:
    * 取得元ごとの処理は scripts/providers/ に分離してある。
    * 検証に通らなかった値は保存しない（既存の正常データを維持する）。
    * フロントエンド（index.html / script.js）は data/*.json しか読まない。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import validate  # noqa: E402
from providers import ecb, lbma, tanaka  # noqa: E402
from providers._http import FetchError  # noqa: E402

JST = timezone(timedelta(hours=9), "JST")
TROY_OUNCE_IN_GRAMS = 31.1034768

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
LATEST_PATH = os.path.join(DATA_DIR, "latest.json")
# 基準日はアプリ側（script.js）でユーザーが選ぶ設定なので、ここでは扱わない。

# 為替が公表されない日に、直前のレートを何日まで流用するか。
FX_FORWARD_FILL_DAYS = 7

RETAIL_META = {
    "id": "retail",
    "label": "店頭小売価格（税込）",
    "short_label": "店頭小売",
    "unit": "円/g",
    "price_type": "店頭小売価格（税込）",
    "tax_included": True,
    "note": "履歴は営業日 9:30 公表値。最新値はその日の最終公表値。",
    "source": {"name": tanaka.SOURCE_NAME, "url": tanaka.SOURCE_URL},
}

MARKET_META = {
    "id": "market",
    "label": "市場価格（税抜）",
    "short_label": "市場価格",
    "unit": "円/g",
    "price_type": "LBMA 建値を円換算した市場価格（税抜・手数料抜き）",
    "tax_included": False,
    "note": "LBMA Gold Price（USD/トロイオンス）× ECB 日次参照為替（USD/JPY）÷ 31.1034768",
    "source": {
        "name": lbma.SOURCE_NAME + " / " + ecb.SOURCE_NAME,
        "url": lbma.SOURCE_URL,
    },
}


# --------------------------------------------------------------------------
# 入出力
# --------------------------------------------------------------------------

def load_json(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        print("[warn] " + path + " を読み込めませんでした: " + str(error))
        return None


def write_json(path, payload):
    """一時ファイル経由で書き込み、途中で壊れたファイルを残さない。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=os.path.dirname(path), delete=False, suffix=".tmp"
    )
    try:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
        handle.close()
        os.replace(handle.name, path)
    except Exception:
        handle.close()
        if os.path.exists(handle.name):
            os.unlink(handle.name)
        raise


def points_to_dict(points):
    result = {}
    for row in points or []:
        if not row or len(row) < 2 or row[1] is None:
            continue
        result[str(row[0])] = float(row[1])
    return result


def dict_to_points(series, decimals):
    result = []
    for key in sorted(series):
        value = round(float(series[key]), decimals)
        result.append([key, int(value) if decimals == 0 else value])
    return result


# --------------------------------------------------------------------------
# 系列の組み立て
# --------------------------------------------------------------------------

def build_market_series():
    """LBMA 建値と ECB 為替から 円/g の市場価格系列を作る。"""
    usd_per_ounce, gold_source = lbma.fetch_usd_per_ounce()
    jpy_per_usd, fx_source = ecb.fetch_jpy_per_usd()

    if not usd_per_ounce or not jpy_per_usd:
        raise FetchError("市場価格の計算に必要なデータが揃いませんでした")

    fx_dates = sorted(jpy_per_usd)
    series = {}
    details = {}

    fx_index = 0
    last_fx_date = None
    for key in sorted(usd_per_ounce):
        while fx_index < len(fx_dates) and fx_dates[fx_index] <= key:
            last_fx_date = fx_dates[fx_index]
            fx_index += 1
        if last_fx_date is None:
            continue

        gap = (date.fromisoformat(key) - date.fromisoformat(last_fx_date)).days
        if gap > FX_FORWARD_FILL_DAYS:
            continue

        ounce = usd_per_ounce[key]
        rate = jpy_per_usd[last_fx_date]
        if not validate.in_range(ounce, validate.USD_PER_OUNCE_RANGE):
            continue
        if not validate.in_range(rate, validate.JPY_PER_USD_RANGE):
            continue

        series[key] = ounce * rate / TROY_OUNCE_IN_GRAMS
        details[key] = {
            "usd_per_ounce": ounce,
            "jpy_per_usd": rate,
            "fx_date": last_fx_date,
        }

    meta = dict(MARKET_META)
    meta["source"] = {"name": gold_source + " / " + fx_source, "url": lbma.SOURCE_URL}
    return series, meta, details


def merge_series(existing, fresh):
    """既存データを土台に、新しく取れた分を上書きする。"""
    merged = dict(existing)
    merged.update(fresh)
    return merged


def public_meta(meta):
    return {
        "label": meta["label"],
        "short_label": meta["short_label"],
        "unit": meta["unit"],
        "price_type": meta["price_type"],
        "tax_included": meta["tax_included"],
        "note": meta["note"],
        "source": meta["source"],
    }


# --------------------------------------------------------------------------
# メイン処理
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="金価格データを更新する")
    parser.add_argument("--dry-run", action="store_true", help="ファイルを書き込まない")
    args = parser.parse_args()

    now = datetime.now(JST)

    history = load_json(HISTORY_PATH) or {"series": {}}
    previous_latest = load_json(LATEST_PATH) or {"series": {}}
    stored_series = history.get("series") or {}

    retail_history = points_to_dict((stored_series.get("retail") or {}).get("points"))
    market_history = points_to_dict((stored_series.get("market") or {}).get("points"))

    errors = []
    warnings = []
    latest_series = {}

    # ---- 田中貴金属（店頭小売・買取） -----------------------------------
    retail_meta = dict(RETAIL_META)
    try:
        fresh_daily = tanaka.fetch_daily_retail_history()
        cleaned, rejected = validate.clean_series(fresh_daily, "retail")
        warnings.extend(rejected)
        retail_history = merge_series(retail_history, cleaned)

        latest = tanaka.fetch_latest()
        before_latest = dict(
            (key, value) for key, value in retail_history.items() if key < latest["date"]
        )
        validate.check_latest_against_history(
            latest["retail_price"], before_latest, latest["date"], "retail"
        )
        if not validate.is_plausible_price(latest["buy_price"]):
            raise validate.ValidationError("retail: 買取価格が値域外です")
        if latest["buy_price"] > latest["retail_price"]:
            raise validate.ValidationError("retail: 買取価格が小売価格を上回っています")

        latest_series["retail"] = {
            "ok": True,
            "date": latest["date"],
            "published_at": latest["published_at"],
            "price": latest["retail_price"],
            "buy_price": latest["buy_price"],
            "last_success": now.isoformat(timespec="seconds"),
            "error": None,
        }
    except (FetchError, validate.ValidationError, ValueError, KeyError) as error:
        message = "店頭小売価格の取得に失敗: " + str(error)
        errors.append(message)
        previous = (previous_latest.get("series") or {}).get("retail") or {}
        carried = dict(
            (key, value)
            for key, value in previous.items()
            if key not in ("ok", "error")
        )
        carried["ok"] = False
        carried["error"] = message
        latest_series["retail"] = carried

    # ---- LBMA + ECB（市場価格） -----------------------------------------
    market_meta = dict(MARKET_META)
    market_details = {}
    try:
        fresh_market, market_meta, market_details = build_market_series()
        cleaned, rejected = validate.clean_series(fresh_market, "market")
        warnings.extend(rejected)
        if not cleaned:
            raise validate.ValidationError("market: 有効な価格が 1 件もありません")
        market_history = merge_series(market_history, cleaned)

        latest_key = max(cleaned)
        detail = market_details.get(latest_key, {})
        latest_series["market"] = {
            "ok": True,
            "date": latest_key,
            "published_at": None,
            "price": round(cleaned[latest_key], 1),
            "usd_per_ounce": detail.get("usd_per_ounce"),
            "jpy_per_usd": detail.get("jpy_per_usd"),
            "last_success": now.isoformat(timespec="seconds"),
            "error": None,
        }
    except (FetchError, validate.ValidationError, ValueError, KeyError) as error:
        message = "市場価格の取得に失敗: " + str(error)
        errors.append(message)
        previous = (previous_latest.get("series") or {}).get("market") or {}
        carried = dict(
            (key, value)
            for key, value in previous.items()
            if key not in ("ok", "error")
        )
        carried["ok"] = False
        carried["error"] = message
        latest_series["market"] = carried

    if len(errors) >= 2:
        print("[error] すべての取得元で失敗しました。既存データを維持します。")
        for message in errors:
            print("  - " + message)
        return 1

    # ---- 書き出し --------------------------------------------------------
    retail_block = dict(retail_meta)
    retail_block["points"] = dict_to_points(retail_history, 0)
    market_block = dict(market_meta)
    market_block["points"] = dict_to_points(market_history, 1)

    history_payload = {
        "generated_at": now.isoformat(timespec="seconds"),
        "series": {"retail": retail_block, "market": market_block},
    }

    retail_latest = dict(latest_series["retail"])
    retail_latest.update(public_meta(retail_meta))
    market_latest = dict(latest_series["market"])
    market_latest.update(public_meta(market_meta))

    latest_payload = {
        "generated_at": now.isoformat(timespec="seconds"),
        "timezone": "Asia/Tokyo",
        "series": {"retail": retail_latest, "market": market_latest},
        "errors": errors,
    }

    if args.dry_run:
        print(json.dumps(latest_payload, ensure_ascii=False, indent=2))
    else:
        write_json(HISTORY_PATH, history_payload)
        write_json(LATEST_PATH, latest_payload)

    for message in warnings[:20]:
        print("[warn] " + message)
    for message in errors:
        print("[error] " + message)
    print(
        "[ok] retail "
        + str(len(retail_history))
        + " 点 (最新 "
        + str(latest_series["retail"].get("date"))
        + ") / market "
        + str(len(market_history))
        + " 点 (最新 "
        + str(latest_series["market"].get("date"))
        + ")"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
