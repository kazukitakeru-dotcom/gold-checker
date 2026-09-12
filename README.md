# 金価格チェッカー

今の金価格が **2026年2月20日と比べてどうか**、そして **過去の価格帯の中で高値圏かどうか** を
スマートフォンで数秒で確認するための PWA です。GitHub Pages で公開し、価格データは
GitHub Actions が自動で更新します。手動で価格を入力する必要はありません。

```
現在の金価格   23,964 円/g
2026/2/20      27,503 円/g
基準日から     −3,539 円/g（−12.9%）
過去1年の位置  上位 62% → 標準
```

---

## 1. データの取得元

価格は 2 系統を別々に保存しています。どちらも API キー不要で、GitHub Secrets の設定も要りません。

| 系列 | 内容 | 取得元 | 期間 |
| --- | --- | --- | --- |
| `retail` | 店頭小売価格（税込）・店頭買取価格（税込）、円/g | [田中貴金属工業](https://gold.tanaka.co.jp/commodity/souba/) | 直近 12 か月ぶん（以後は日々蓄積） |
| `market` | 市場価格（税抜）、円/g | [LBMA Gold Price PM](https://www.lbma.org.uk/prices-and-data/precious-metal-prices) × [ECB 日次参照為替レート](https://data.ecb.europa.eu/) | 1999-01-04 以降 |

* **画面の基本表示は `retail`（店頭小売価格・税込）** です。国内で金を売買するときに実際に目にする価格で、
  基準日 2026/2/20 の 27,503 円/g もこの価格です。
* **`market` は税抜の理論市場価格** です。`LBMA 建値（USD/トロイオンス）× USD/JPY ÷ 31.1034768` で計算しています。
  店頭価格とは別物なので、画面上でも必ず区別して表示しています。
* 過去 3 年・5 年・全期間の分析は、`retail` の履歴がまだ 12 か月ぶんしかないため `market` に自動で切り替わります。
  切り替わった場合は画面にその旨を表示します。`retail` の履歴が伸びれば自動的に `retail` が使われるようになります。

### 選定理由と、採用しなかった取得元

* **LBMA** … 金の国際的な公式建値。1968 年からの JSON を無償公開しており、API キーも不要。
* **ECB** … 日次参照為替レートを SDMX API で無償公開。取得できない場合は同じ ECB データを配信する
  [Frankfurter](https://frankfurter.dev/) へ自動フォールバックします。
* **田中貴金属** … 国内で最も広く参照される店頭価格。`robots.txt` は `Allow: /` で、
  取得は 1 日 2 回のみに抑えています。
* 採用しなかったもの … Stooq（自動アクセスを遮断）、exchangerate.host / GoldAPI / metalpriceapi
  （API キー必須。フロントエンドに鍵を置けず、無料枠も薄い）。

### 整合性の確認（2026-09-11 時点）

```
LBMA 4,386.25 USD/oz × 154.04 JPY/USD ÷ 31.1034768 = 21,722 円/g（税抜）
田中貴金属 店頭小売 23,964 円/g（税込） ÷ 1.10        = 21,785 円/g
差 0.3%
```

---

## 2. ファイル構成

```
.
├─ index.html                       画面
├─ style.css                        スタイル（ダークテーマ・スマホ最優先）
├─ script.js                        表示と分析（data/*.json を読むだけ）
├─ sw.js                            Service Worker（オフライン表示）
├─ manifest.json                    PWA マニフェスト
├─ icons/                           アイコン（生成済み）
├─ data/
│  ├─ latest.json                   最新値・取得状態・出典
│  ├─ history.json                  日次の価格履歴（2 系列）
│  └─ baseline.json                 基準日 2026-02-20 の固定データ
├─ scripts/
│  ├─ update_prices.py              取得・検証・保存のエントリポイント
│  ├─ validate.py                   データ検証ルール
│  ├─ test_update.py                自己テスト（ネットワーク不要）
│  ├─ providers/
│  │  ├─ _http.py                   HTTP 共通処理
│  │  ├─ lbma.py                    LBMA 建値
│  │  ├─ ecb.py                     ECB 為替（Frankfurter フォールバック）
│  │  └─ tanaka.py                  田中貴金属の店頭価格
│  └─ tools/make_icons.py           アイコン生成（開発時のみ）
└─ .github/workflows/
   ├─ update-gold-price.yml         価格データの自動更新
   └─ deploy-pages.yml              GitHub Pages への公開
```

**フロントエンドと価格取得は完全に分離** しています。`script.js` は `data/*.json` しか読みません。
取得元が停止・仕様変更した場合に直すのは `scripts/providers/` だけです。

---

## 3. セットアップ

### 3-1. リポジトリを GitHub へ置く

```bash
git remote add origin https://github.com/<ユーザー名>/gold-checker.git
git branch -M main
git push -u origin main
```

### 3-2. GitHub Pages を有効にする

リポジトリの **Settings → Pages** で、**Source** に **GitHub Actions** を選びます。
`deploy-pages.yml` が `main` への push ごとに公開します。

（`Deploy from a branch` を選んでも動きます。その場合は Branch に `main` / `/ (root)` を指定してください。
`.nojekyll` を置いてあるので Jekyll の処理は走りません。）

### 3-3. Actions に書き込み権限を与える

**Settings → Actions → General → Workflow permissions** で
**Read and write permissions** を選びます。価格データの更新コミットに必要です。

### 3-4. 初回実行

**Actions → 金価格データの自動更新 → Run workflow** で手動実行し、`data/` が更新されることを確認します。

APIキーやトークンは一切不要です。**フロントエンドに秘密情報は含まれていません。**

---

## 4. 自動更新の仕組み

`.github/workflows/update-gold-price.yml` が平日 2 回動きます。

| cron（UTC） | 日本時間 | 目的 |
| --- | --- | --- |
| `40 8 * * 1-5` | 17:40 | 田中貴金属の当日最終公表（17:00）を取り込む |
| `30 16 * * 1-5` | 翌 01:30 | LBMA の PM 建値（ロンドン 15:00）を取り込む |

各取得元へのアクセスは 1 回の実行につき数リクエストだけです。無意味な高頻度アクセスはしません。

処理の流れは次のとおりです。

1. `scripts/test_update.py` で検証ロジックとパーサを自己テストする
2. 各取得元から価格を取得する
3. 検証する（後述）
4. 検証を通った値だけを `data/*.json` へ書き込む
5. 差分があればコミットして push する（差分がなければ何もしない）
6. 更新ワークフローの完了を受けて `deploy-pages.yml` が公開しなおす

6 が必要なのは、`GITHUB_TOKEN` による push が `push` イベントを発火させない
GitHub の仕様のためです。そのままだとデータだけ更新されて公開サイトが古いままになります。
`deploy-pages.yml` は `workflow_run` で更新ワークフローの完了を受け取り、
`main` の最新を明示的にチェックアウトして公開します。

---

## 5. データ品質の担保

`scripts/validate.py` に検証ルールをまとめてあります。**検証に通らなかった値は保存しません。**
その場合は既存の正常データがそのまま維持されます。

* 円/g として 300〜200,000 円の範囲外は破棄（0 円・null・NaN・異常値をここで落とす）
* 前営業日比の変化率が許容範囲（1 営業日で 10%、休場を挟む場合は日数の平方根で緩和、上限 35%）を
  超えた点は破棄
* 系列全体の 1%（かつ 3 件）を超えて破棄された場合は、取得元の仕様変更を疑って **更新を中止**
* 買取価格が小売価格を上回るなど、あり得ない組み合わせも中止条件
* 書き込みは一時ファイル経由。途中で失敗しても壊れた JSON が残らない
* 両方の取得元が失敗した場合は非ゼロ終了（Actions が失敗として記録される）。データは書き換えない

画面側でも、取得に失敗した系列は赤いバナーで
「最新データを取得できませんでした / 前回取得：○時間前」と表示し、
古い価格を最新価格として見せることはありません。

---

## 6. 価格位置の判定基準

「現在価格より高かった日が期間全体の何 % か」を `topPercent` として、7 段階で判定します。
天井突破と床抜けは割合ではなく、期間中の最高値・最安値を更新したかどうかで優先的に判定します。

| 条件 | 判定 | 色・演出 |
| --- | --- | --- |
| 期間中の最高値以上 | ▲▲ 天井突破 | 赤。脈動する発光、カード全体が光る |
| 上位 5% 以内 | ▲ 天井 | 赤橙 |
| 上位 25% 以内 | ▲ 高値 | 橙 |
| 上位 75% 以内 | 平均 | 灰（現在価格は金色のまま） |
| 上位 95% 以内 | ▼ 安値 | 水色 |
| それ以外 | ▼ 底値 | 青 |
| 期間中の最安値以下 | ▼▼ 床抜け | 紫。脈動する発光、カード全体が光る |

判定色は価格位置カードと、最上部の現在価格の両方に連動します。
全期間を選べば天井突破は「史上最高値の更新」、1 年なら「1 年ぶりの高値」を意味します。

しきい値は `script.js` 冒頭の `CONFIG.rankThresholds` と `CONFIG.rankExtremes` にまとまっています。ここだけ直せば変更できます。
色は `style.css` 冒頭の `--lv-*` 変数で変更できます。
集計期間（`CONFIG.periods`）、判定に必要な最低データ数（`CONFIG.minPointsForRank`）も同様です。

---

## 7. ローカルでの動作確認

```bash
python scripts/test_update.py          # 検証ロジックの自己テスト（ネットワーク不要）
python scripts/update_prices.py --dry-run   # 取得だけ試す（ファイルは書かない）
python scripts/update_prices.py        # data/*.json を更新する
python -m http.server 8000             # ブラウザで http://localhost:8000 を開く
```

`file://` で直接開くと `fetch` が失敗します。必ず HTTP サーバー経由で開いてください。

アイコンを作り直す場合のみ Pillow が必要です（本番の取得処理は標準ライブラリのみで動きます）。

```bash
pip install pillow
python scripts/tools/make_icons.py
```

---

## 8. 基準日を変更する

`scripts/update_prices.py` の `BASELINE_DATE` と `BASELINE_LABEL` を書き換えてから、
Actions を `rebuild_baseline` にチェックを入れて手動実行します（またはローカルで
`python scripts/update_prices.py --rebuild-baseline`）。
`data/baseline.json` は通常の更新では上書きされない固定データです。

---

## 9. 今後の拡張について

`data/` のデータ構造は、将来的に次を足せるようにしてあります。

* 購入価格・保有重量・取得価格の記録（`latest.json` とは別ファイルに保持する想定）
* 目標売却価格の設定と、到達時の通知
* 他の貴金属（プラチナ・銀）の系列追加。`scripts/providers/tanaka.py` の URL を差し替えるだけで取得できます

系列は `history.json` の `series` にキーを足すだけで増やせます。

---

## 10. 注意

* 表示は情報提供のみを目的としたものです。売買の判断は自己責任でお願いします。
* 純度計算は金の含有量から求めた理論価格です。実際の買取価格ではありません。
  買取手数料、業者ごとの価格差、製品としての価値は考慮していません。
* 価格の著作権・権利は各取得元に帰属します。本アプリは出典を明示したうえで表示しています。
