/* =====================================================================
   金価格チェッカー
   ---------------------------------------------------------------------
   このファイルは data/*.json を読んで表示するだけで、価格の取得は行わない。
   取得処理は scripts/ 配下（GitHub Actions から実行）に分離してある。
   ===================================================================== */

'use strict';

/* ---------------------------------------------------------------------
   設定
   判定しきい値・期間・純度はここだけを直せば変更できる。
--------------------------------------------------------------------- */

const CONFIG = {
  dataDir: 'data/',

  /* 価格位置の判定しきい値。
     topPercent = 集計期間のうち「現在価格より高かった日」の割合（%）。
     値が小さいほど現在価格が高い。上から順に評価し、最初に一致したものを使う。 */
  rankThresholds: [
    { maxTopPercent: 5,   key: 'ceiling', label: '天井', icon: '▲' },
    { maxTopPercent: 25,  key: 'high',    label: '高値', icon: '▲' },
    { maxTopPercent: 75,  key: 'average', label: '平均', icon: '' },
    { maxTopPercent: 95,  key: 'low',     label: '安値', icon: '▼' },
    { maxTopPercent: 100, key: 'bottom',  label: '底値', icon: '▼' }
  ],

  /* 割合ではなく「期間中の最高値・最安値を更新したか」で判定する 2 段階。
     しきい値より優先して評価する。 */
  rankExtremes: {
    breakout: {
      key: 'breakout', label: '天井突破', icon: '▲▲', extreme: true,
      description: '期間中の最高値を更新しています'
    },
    floorbreak: {
      key: 'floorbreak', label: '床抜け', icon: '▼▼', extreme: true,
      description: '期間中の最安値を更新しています'
    }
  },

  /* データ不足で判定できないとき。 */
  rankUnknown: { key: 'unknown', label: 'データ不足', icon: '', extreme: false },

  /* 期間の定義。days が null なら全期間。 */
  periods: {
    '1m':  { label: '1か月',  days: 31 },
    '3m':  { label: '3か月',  days: 92 },
    '6m':  { label: '6か月',  days: 183 },
    '1y':  { label: '1年',    days: 365 },
    '3y':  { label: '3年',    days: 1095 },
    '5y':  { label: '5年',    days: 1826 },
    'all': { label: '全期間', days: null }
  },
  rankPeriodIds: ['1y', '3y', '5y', 'all'],
  chartPeriodIds: ['1m', '3m', '6m', '1y', '3y', '5y', 'all'],

  /* 価格位置の算出に必要な最低データ数。これ未満なら判定しない。 */
  minPointsForRank: 20,

  /* データが古いとみなす基準。 */
  staleGeneratedHours: 40,
  staleDataDays: 5,

  /* 純度（金の含有率）。 */
  purities: [
    { id: 'k24', label: '24K（純金 99.99%）', ratio: 0.9999 },
    { id: 'k22', label: '22K（91.7%）',       ratio: 0.9167 },
    { id: 'k18', label: '18K（75.0%）',       ratio: 0.75 },
    { id: 'k14', label: '14K（58.5%）',       ratio: 0.585 },
    { id: 'k10', label: '10K（41.7%）',       ratio: 0.4167 },
    { id: 'k9',  label: '9K（37.5%）',        ratio: 0.375 }
  ],

  /* チャートの描画点数の上限（これを超えたら間引く）。 */
  maxChartPoints: 520,

  /* 選択中の系列が期間をこの割合以上カバーしていれば、そのまま使う。
     下回ったときだけ、より長い履歴のある市場価格系列へ切り替える。 */
  seriesCoverageTolerance: 0.85
};

/* ---------------------------------------------------------------------
   状態
--------------------------------------------------------------------- */

const state = {
  latest: null,
  history: null,
  baseline: null,
  fromCache: false,
  seriesId: 'retail',
  rankPeriodId: '1y',
  chartPeriodId: '1y',
  chartPoints: [],
  chartGeometry: null
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------
   小さなユーティリティ
--------------------------------------------------------------------- */

function formatNumber(value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return Number(value).toLocaleString('ja-JP', {
    minimumFractionDigits: digits || 0,
    maximumFractionDigits: digits || 0
  });
}

function formatSigned(value, digits) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return sign + formatNumber(Math.abs(value), digits);
}

function formatDate(iso, withYear) {
  if (!iso) return '--';
  const parts = String(iso).slice(0, 10).split('-');
  if (parts.length < 3) return iso;
  const md = Number(parts[1]) + '/' + Number(parts[2]);
  return withYear === false ? md : parts[0] + '/' + md;
}

function formatDateTime(iso) {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function shiftDays(iso, days) {
  const date = new Date(iso + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const a = new Date(String(fromIso).slice(0, 10) + 'T00:00:00Z').getTime();
  const b = new Date(String(toIso).slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function relativeTime(iso) {
  if (!iso) return '不明';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '不明';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return minutes + '分前';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + '時間前';
  return Math.round(hours / 24) + '日前';
}

function hoursSince(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / 3600000;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

/* ---------------------------------------------------------------------
   データ読み込み
--------------------------------------------------------------------- */

async function loadJson(name) {
  const response = await fetch(CONFIG.dataDir + name, { cache: 'no-cache' });
  if (!response.ok) throw new Error(name + ' の取得に失敗しました (' + response.status + ')');
  if (response.headers.get('x-from-cache') === '1') state.fromCache = true;
  return response.json();
}

async function loadAll() {
  state.fromCache = false;
  const [latest, history, baseline] = await Promise.all([
    loadJson('latest.json'),
    loadJson('history.json'),
    loadJson('baseline.json').catch(() => null)
  ]);
  state.latest = latest;
  state.history = history;
  state.baseline = baseline;
}

/* ---------------------------------------------------------------------
   系列の取り扱い
--------------------------------------------------------------------- */

function seriesOf(id) {
  return (state.history && state.history.series && state.history.series[id]) || null;
}

function latestOf(id) {
  return (state.latest && state.latest.series && state.latest.series[id]) || null;
}

function seriesPoints(id) {
  const series = seriesOf(id);
  return (series && series.points) || [];
}

/**
 * 現在価格（系列に対応する最新値）。
 * 取得に失敗した回でも、前回成功時の値が latest.json に引き継がれているので
 * それをそのまま使う（日付表示と価格がずれないようにするため）。
 * それも無い場合だけ履歴の末尾にフォールバックする。
 */
function currentPrice(id) {
  const latest = latestOf(id);
  if (latest && typeof latest.price === 'number') return latest.price;
  const points = seriesPoints(id);
  return points.length ? points[points.length - 1][1] : null;
}

function currentDate(id) {
  const latest = latestOf(id);
  if (latest && latest.date) return latest.date;
  const points = seriesPoints(id);
  return points.length ? points[points.length - 1][0] : null;
}

/** 期間の開始日（系列の最新日から遡る）。days が null なら null。 */
function periodStart(id, periodId) {
  const period = CONFIG.periods[periodId];
  if (!period || period.days === null) return null;
  const end = currentDate(id) || (state.latest && state.latest.generated_at || '').slice(0, 10);
  return end ? shiftDays(end, -period.days) : null;
}

/**
 * 期間に対して使う系列を決める。
 * 希望の系列がその期間をカバーしていなければ、より長い市場価格系列へ切り替える。
 */
function resolveSeries(preferredId, periodId) {
  const preferred = seriesOf(preferredId);
  const market = seriesOf('market');
  const period = CONFIG.periods[periodId];
  if (!preferred) return { id: 'market', switched: preferredId !== 'market', partial: false };

  const preferredStart = preferred.points.length ? preferred.points[0][0] : null;
  const marketStart = market && market.points.length ? market.points[0][0] : null;

  if (period.days === null) {
    if (preferredId !== 'market' && marketStart && preferredStart && marketStart < preferredStart) {
      return { id: 'market', switched: true, partial: false };
    }
    return { id: preferredId, switched: false, partial: false };
  }

  const need = periodStart(preferredId, periodId);
  if (preferredStart && need && preferredStart <= need) {
    return { id: preferredId, switched: false, partial: false };
  }

  // 期間の大半をカバーできているなら、わざわざ別系列へ切り替えない。
  if (preferredStart && need) {
    const end = currentDate(preferredId);
    const covered = end ? daysBetween(preferredStart, end) / period.days : 0;
    if (covered >= CONFIG.seriesCoverageTolerance) {
      return { id: preferredId, switched: false, partial: true };
    }
  }

  if (preferredId !== 'market' && marketStart && need && marketStart <= need) {
    return { id: 'market', switched: true, partial: false };
  }
  const useMarket = preferredId !== 'market' && marketStart && preferredStart && marketStart < preferredStart;
  return { id: useMarket ? 'market' : preferredId, switched: Boolean(useMarket), partial: true };
}

function slicePoints(id, periodId) {
  const points = seriesPoints(id);
  const start = periodStart(id, periodId);
  if (!start) return points.slice();
  return points.filter((point) => point[0] >= start);
}

/* ---------------------------------------------------------------------
   価格位置の計算
--------------------------------------------------------------------- */

function analyse(points, price) {
  if (!points.length || typeof price !== 'number') return null;

  let higher = 0;
  let lower = 0;
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;
  let maxDate = null;
  let minDate = null;

  for (const [date, value] of points) {
    if (value > price) higher += 1;
    else if (value < price) lower += 1;
    if (value > max) { max = value; maxDate = date; }
    if (value < min) { min = value; minDate = date; }
    sum += value;
  }

  const count = points.length;
  return {
    count: count,
    higher: higher,
    lower: lower,
    topPercent: (higher / count) * 100,
    percentile: (lower / count) * 100,
    rank: higher + 1,
    max: max,
    min: min,
    avg: sum / count,
    maxDate: maxDate,
    minDate: minDate,
    from: points[0][0],
    to: points[count - 1][0]
  };
}

/**
 * 7 段階の判定。
 * 期間中の最高値以上なら天井突破、最安値以下なら床抜けを優先し、
 * それ以外は topPercent のしきい値で決める。
 */
function judge(result, price) {
  if (price >= result.max) return CONFIG.rankExtremes.breakout;
  if (price <= result.min) return CONFIG.rankExtremes.floorbreak;
  for (const threshold of CONFIG.rankThresholds) {
    if (result.topPercent <= threshold.maxTopPercent) return threshold;
  }
  return CONFIG.rankThresholds[CONFIG.rankThresholds.length - 1];
}

/** 判定に応じて、価格位置カードと現在価格の色・演出を切り替える。 */
function applyLevel(verdict) {
  const extreme = Boolean(verdict.extreme);

  const rankCard = document.querySelector('.rank');
  rankCard.dataset.level = verdict.key;

  const badgeEl = $('rank-badge');
  badgeEl.innerHTML = (verdict.icon ? '<span class="badge__icon" aria-hidden="true">' + verdict.icon + '</span>' : '') +
    escapeHtml(verdict.label);
  badgeEl.classList.toggle('is-extreme', extreme);
  $('rank-top').classList.toggle('is-extreme', extreme);

  // 現在価格: 平均・判定不能のときは本来の金色のまま、それ以外は判定色に連動させる。
  const hero = document.querySelector('.hero');
  if (verdict.key === 'average' || verdict.key === 'unknown') {
    delete hero.dataset.level;
  } else {
    hero.dataset.level = verdict.key;
  }
  $('current-price').classList.toggle('is-extreme', extreme);
}

/* ---------------------------------------------------------------------
   描画: 状態バナー
--------------------------------------------------------------------- */

function renderBanner() {
  const banner = $('status-banner');
  const blocks = [];
  const latest = state.latest;

  for (const id of ['retail', 'market']) {
    const entry = latestOf(id);
    if (!entry) continue;
    if (entry.ok === false) {
      blocks.push({
        level: 'error',
        title: (entry.label || id) + 'の最新データを取得できませんでした',
        body: '前回取得：' + relativeTime(entry.last_success) +
          '（' + formatDate(entry.date) + ' 時点の価格を表示しています）'
      });
    } else if (entry.date && daysBetween(entry.date, new Date().toISOString().slice(0, 10)) > CONFIG.staleDataDays) {
      blocks.push({
        level: 'warn',
        title: (entry.label || id) + 'が ' + formatDate(entry.date) + ' から更新されていません',
        body: '休場が続いている可能性もありますが、取得元の仕様変更も考えられます。'
      });
    }
  }

  if (latest && hoursSince(latest.generated_at) > CONFIG.staleGeneratedHours) {
    blocks.push({
      level: 'warn',
      title: 'データの自動更新が止まっている可能性があります',
      body: '最終更新：' + formatDateTime(latest.generated_at) + '（' + relativeTime(latest.generated_at) + '）'
    });
  }

  if (state.fromCache || !navigator.onLine) {
    blocks.push({
      level: 'info',
      title: 'オフラインのため保存済みのデータを表示しています',
      body: '最終更新：' + formatDateTime(latest && latest.generated_at)
    });
  }

  if (!blocks.length) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }

  const level = blocks.some((b) => b.level === 'error') ? 'error'
    : blocks.some((b) => b.level === 'warn') ? 'warn' : 'info';
  banner.className = 'banner' + (level === 'error' ? '' : ' banner--' + level);
  banner.innerHTML = blocks
    .map((b) => '<b>' + escapeHtml(b.title) + '</b>' + escapeHtml(b.body))
    .join('<hr style="border:0;border-top:1px solid currentColor;opacity:.25;margin:8px 0">');
  banner.hidden = false;
}

/* ---------------------------------------------------------------------
   描画: 現在価格
--------------------------------------------------------------------- */

function renderHero() {
  const entry = latestOf('retail');
  if (!entry) return;

  const price = currentPrice('retail');
  $('current-price').textContent = formatNumber(price);
  $('hero-type').textContent = entry.price_type || '店頭小売価格（税込）';
  $('current-buy').textContent = formatNumber(entry.buy_price);

  // 前日比: 履歴（9:30 公表系列）の前営業日と比較する。
  const points = seriesPoints('retail');
  const date = entry.date;
  let previous = null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i][0] < date) { previous = points[i]; break; }
  }
  const changeEl = $('current-change');
  if (previous && typeof price === 'number') {
    const diff = price - previous[1];
    const rate = (diff / previous[1]) * 100;
    const tone = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
    changeEl.innerHTML = '前営業日比 <span class="' + tone + '">' +
      escapeHtml(formatSigned(diff)) + ' 円/g（' + escapeHtml(formatSigned(rate, 2)) + '%）</span>';
  } else {
    changeEl.textContent = '';
  }

  const source = (entry.source && entry.source.name) || '不明';
  const published = entry.published_at ? formatDateTime(entry.published_at) + ' 公表' : formatDate(entry.date);
  $('current-meta').textContent =
    'データ提供元：' + source + ' ／ ' + published +
    ' ／ 最終更新：' + formatDateTime(state.latest && state.latest.generated_at);
}

/* ---------------------------------------------------------------------
   描画: 基準日との比較
--------------------------------------------------------------------- */

function renderBaseline() {
  const baselineDate = (state.latest && state.latest.baseline_date) ||
    (state.baseline && state.baseline.date);
  const entry = state.baseline && state.baseline.series && state.baseline.series.retail;
  const price = currentPrice('retail');

  $('baseline-date-label').textContent = formatDate(baselineDate);
  $('legend-base-date').textContent = formatDate(baselineDate);
  $('baseline-current').textContent = formatNumber(price);

  const deltaEl = $('baseline-delta');
  if (!entry || typeof price !== 'number') {
    $('baseline-price').textContent = '--';
    $('baseline-diff').textContent = '--';
    $('baseline-rate').textContent = '';
    deltaEl.className = 'delta is-flat';
    $('baseline-note').textContent = '基準日のデータが見つかりません。';
    return;
  }

  const diff = price - entry.price;
  const rate = (diff / entry.price) * 100;

  $('baseline-price').textContent = formatNumber(entry.price);
  $('baseline-diff').textContent = formatSigned(diff) + ' 円/g';
  $('baseline-rate').textContent = formatSigned(rate, 1) + '%';
  deltaEl.className = 'delta ' + (diff > 0 ? 'is-up' : diff < 0 ? 'is-down' : 'is-flat');

  const marketBase = state.baseline.series.market;
  const marketNow = currentPrice('market');
  let note = '基準日・現在価格とも ' +
    ((latestOf('retail') && latestOf('retail').price_type) || '店頭小売価格（税込）') + 'で比較しています。';
  if (marketBase && typeof marketNow === 'number') {
    const marketDiff = marketNow - marketBase.price;
    const marketRate = (marketDiff / marketBase.price) * 100;
    note += '市場価格（税抜）では ' + formatNumber(marketBase.price) + ' 円/g → ' +
      formatNumber(marketNow) + ' 円/g（' + formatSigned(marketRate, 1) + '%）。';
  }
  $('baseline-note').textContent = note;
}

/* ---------------------------------------------------------------------
   描画: 価格位置
--------------------------------------------------------------------- */

function renderRank() {
  const resolved = resolveSeries(state.seriesId, state.rankPeriodId);
  const series = seriesOf(resolved.id);
  const points = slicePoints(resolved.id, state.rankPeriodId);
  const price = currentPrice(resolved.id);
  const result = points.length >= CONFIG.minPointsForRank ? analyse(points, price) : null;

  const valueEl = $('rank-top');
  const badgeEl = $('rank-badge');
  const markerEl = $('rank-marker');
  const periodLabel = CONFIG.periods[state.rankPeriodId].label;

  if (!result) {
    valueEl.textContent = '--';
    applyLevel(CONFIG.rankUnknown);
    markerEl.style.left = '50%';
    $('rank-sentence').textContent =
      '判定に必要なデータがまだ足りません（' + points.length + ' 日分 / 最低 ' +
      CONFIG.minPointsForRank + ' 日分）。';
    $('rank-stats').innerHTML = '';
    $('rank-note').textContent = '';
    return;
  }

  const verdict = judge(result, price);
  const topRounded = result.topPercent < 1 && result.topPercent > 0
    ? result.topPercent.toFixed(1)
    : Math.round(result.topPercent);

  valueEl.textContent = topRounded;
  applyLevel(verdict);
  markerEl.style.left = Math.min(100, Math.max(0, result.percentile)) + '%';

  $('rank-sentence').innerHTML =
    (verdict.extreme
      ? '<span class="rank__alert">' + escapeHtml(verdict.icon + ' 過去' + periodLabel + 'の' +
          (verdict.key === 'breakout' ? '最高値' : '最安値') + 'を更新しています') + '</span>'
      : '') +
    '過去' + escapeHtml(periodLabel) + '（' + escapeHtml(formatDate(result.from)) + '〜' +
    escapeHtml(formatDate(result.to)) + '・<b>' + result.count + '</b>営業日）のうち、' +
    '現在価格より高かった日は <b>' + escapeHtml(String(topRounded)) + '%</b>（' +
    result.higher + '日）。高い順で <b>' + result.rank + '</b> 位です。';

  const digits = resolved.id === 'market' ? 0 : 0;
  const cells = [
    ['最高値', formatNumber(result.max, digits), formatDate(result.maxDate)],
    ['最安値', formatNumber(result.min, digits), formatDate(result.minDate)],
    ['平均値', formatNumber(result.avg, digits), periodLabel + 'の平均'],
    ['現在価格', formatNumber(price, digits), formatDate(currentDate(resolved.id))]
  ];
  $('rank-stats').innerHTML = cells.map(([label, value, sub]) =>
    '<div class="stats__cell"><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) +
    ' <small>円/g</small></dd><dd><small>' + escapeHtml(sub) + '</small></dd></div>'
  ).join('');

  const notes = [];
  notes.push('集計対象：' + (series.label || resolved.id));
  if (resolved.switched) {
    notes.push('選択中の系列はこの期間のデータがないため、より長い履歴のある市場価格（税抜）で判定しています。');
  }
  if (resolved.partial) {
    notes.push('データは ' + formatDate(result.from) + ' 以降しかないため、期間全体はカバーしていません。');
  }
  const thresholdText = CONFIG.rankThresholds.map((t, i, all) =>
    (i === all.length - 1 ? 'それ以外' : '上位' + t.maxTopPercent + '%以内') + '=' + t.label
  ).join(' / ');
  notes.push('判定基準：期間最高値以上=天井突破 / ' + thresholdText + ' / 期間最安値以下=床抜け');
  $('rank-note').textContent = notes.join(' ');
}

/* ---------------------------------------------------------------------
   描画: チャート
--------------------------------------------------------------------- */

function downsample(points, limit) {
  if (points.length <= limit) return points.slice();
  const buckets = Math.max(2, Math.floor(limit / 2));
  const size = points.length / buckets;
  const result = [];
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor(i * size);
    const end = Math.min(points.length, Math.floor((i + 1) * size));
    if (end <= start) continue;
    let lowIndex = start;
    let highIndex = start;
    for (let j = start; j < end; j += 1) {
      if (points[j][1] < points[lowIndex][1]) lowIndex = j;
      if (points[j][1] > points[highIndex][1]) highIndex = j;
    }
    const first = Math.min(lowIndex, highIndex);
    const second = Math.max(lowIndex, highIndex);
    result.push(points[first]);
    if (second !== first) result.push(points[second]);
  }
  const last = points[points.length - 1];
  if (result[result.length - 1][0] !== last[0]) result.push(last);
  return result;
}

function renderChart() {
  const resolved = resolveSeries(state.seriesId, state.chartPeriodId);
  const raw = slicePoints(resolved.id, state.chartPeriodId);
  const svg = $('chart');
  const series = seriesOf(resolved.id);

  const notes = [];
  if (resolved.switched) {
    notes.push('選択中の系列はこの期間のデータがないため、' + (series ? series.label : '市場価格') +
      'で表示しています。');
  }
  if (resolved.partial && raw.length) {
    notes.push('データは ' + formatDate(raw[0][0]) + ' 以降しかないため、期間全体はカバーしていません。');
  }
  $('chart-note').textContent = notes.join(' ');

  if (raw.length < 2) {
    svg.innerHTML = '<text x="180" y="105" text-anchor="middle" fill="#6f7889" font-size="11">' +
      'この期間のデータがありません</text>';
    state.chartPoints = [];
    state.chartGeometry = null;
    return;
  }

  const points = downsample(raw, CONFIG.maxChartPoints);
  const baselineDate = (state.latest && state.latest.baseline_date) || null;
  const baselineEntry = state.baseline && state.baseline.series && state.baseline.series[resolved.id];
  const baselinePrice = baselineEntry ? baselineEntry.price : null;

  const left = 6;
  const right = 300;
  const top = 16;
  const bottom = 176;

  const firstTime = new Date(points[0][0]).getTime();
  const lastTime = new Date(points[points.length - 1][0]).getTime();
  const span = Math.max(1, lastTime - firstTime);

  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point[1] < min) min = point[1];
    if (point[1] > max) max = point[1];
  }

  const baselineInWindow = Boolean(
    baselineDate && baselinePrice && points[0][0] <= baselineDate && baselineDate <= points[points.length - 1][0]
  );
  if (baselineInWindow) {
    min = Math.min(min, baselinePrice);
    max = Math.max(max, baselinePrice);
  }

  const pad = (max - min) * 0.12 || Math.max(1, max * 0.01);
  const low = min - pad;
  const high = max + pad;

  const xOf = (iso) => left + ((new Date(iso).getTime() - firstTime) / span) * (right - left);
  const yOf = (value) => bottom - ((value - low) / (high - low)) * (bottom - top);

  const coords = points.map((point) => [xOf(point[0]), yOf(point[1])]);
  const line = coords.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2)).join(' ');
  const area = line + ' L' + right.toFixed(2) + ' ' + bottom + ' L' + left.toFixed(2) + ' ' + bottom + ' Z';

  const parts = [];
  parts.push(
    '<defs><linearGradient id="fillGradient" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#e8b647" stop-opacity="0.30"/>' +
    '<stop offset="100%" stop-color="#e8b647" stop-opacity="0"/>' +
    '</linearGradient></defs>'
  );

  // 目盛り（上下2本）
  for (const value of [high - pad, low + pad]) {
    const y = yOf(value);
    parts.push('<line x1="' + left + '" y1="' + y.toFixed(2) + '" x2="' + right + '" y2="' + y.toFixed(2) +
      '" stroke="#ffffff" stroke-opacity="0.07"/>');
    parts.push('<text x="' + (right + 6) + '" y="' + (y + 3.2).toFixed(2) +
      '" fill="#6f7889" font-size="9" font-family="inherit">' + formatNumber(value) + '</text>');
  }

  parts.push('<path d="' + area + '" fill="url(#fillGradient)"/>');
  parts.push('<path d="' + line + '" fill="none" stroke="#e8b647" stroke-width="1.6" ' +
    'stroke-linejoin="round" stroke-linecap="round"/>');

  if (baselineInWindow) {
    const baseY = yOf(baselinePrice);
    const baseX = xOf(baselineDate);
    parts.push('<line x1="' + left + '" y1="' + baseY.toFixed(2) + '" x2="' + right + '" y2="' + baseY.toFixed(2) +
      '" stroke="#7f8aa0" stroke-width="1" stroke-dasharray="3 3"/>');
    parts.push('<line x1="' + baseX.toFixed(2) + '" y1="' + top + '" x2="' + baseX.toFixed(2) + '" y2="' + bottom +
      '" stroke="#7f8aa0" stroke-width="1" stroke-dasharray="3 3"/>');
    parts.push('<circle cx="' + baseX.toFixed(2) + '" cy="' + baseY.toFixed(2) +
      '" r="3.4" fill="#0f1115" stroke="#c3cad6" stroke-width="1.6"/>');
    const anchor = baseX > (left + right) / 2 ? 'end' : 'start';
    const labelX = anchor === 'end' ? baseX - 6 : baseX + 6;
    parts.push('<text x="' + labelX.toFixed(2) + '" y="' + (top - 4) + '" text-anchor="' + anchor +
      '" fill="#9aa3b2" font-size="8.5" font-family="inherit">基準 ' +
      escapeHtml(formatDate(baselineDate, false)) + '</text>');
  }

  const lastCoord = coords[coords.length - 1];
  parts.push('<circle cx="' + lastCoord[0].toFixed(2) + '" cy="' + lastCoord[1].toFixed(2) +
    '" r="3.6" fill="#f7d071" stroke="#0f1115" stroke-width="1.4"/>');

  parts.push('<text x="' + left + '" y="196" fill="#6f7889" font-size="9" font-family="inherit">' +
    escapeHtml(formatDate(points[0][0])) + '</text>');
  parts.push('<text x="' + right + '" y="196" text-anchor="end" fill="#6f7889" font-size="9" ' +
    'font-family="inherit">' + escapeHtml(formatDate(points[points.length - 1][0])) + '</text>');

  parts.push('<g id="chart-cursor" style="display:none">' +
    '<line y1="' + top + '" y2="' + bottom + '" stroke="#ffffff" stroke-opacity="0.28" stroke-width="1"/>' +
    '<circle r="3.4" fill="#f7d071" stroke="#0f1115" stroke-width="1.4"/></g>');

  svg.innerHTML = parts.join('');

  state.chartPoints = points;
  state.chartGeometry = { left, right, top, bottom, firstTime, span, low, high };
}

function setupChartCursor() {
  const wrap = document.querySelector('.chart__wrap');
  const svg = $('chart');
  const tip = $('chart-tip');

  function hide() {
    tip.hidden = true;
    const cursor = svg.querySelector('#chart-cursor');
    if (cursor) cursor.style.display = 'none';
  }

  function move(event) {
    const geometry = state.chartGeometry;
    const points = state.chartPoints;
    if (!geometry || points.length < 2) return;

    const rect = svg.getBoundingClientRect();
    const scale = 360 / rect.width;
    const x = (event.clientX - rect.left) * scale;
    const ratio = (x - geometry.left) / (geometry.right - geometry.left);
    const targetTime = geometry.firstTime + Math.min(1, Math.max(0, ratio)) * geometry.span;

    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const distance = Math.abs(new Date(points[i][0]).getTime() - targetTime);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }

    const point = points[best];
    const px = geometry.left +
      ((new Date(point[0]).getTime() - geometry.firstTime) / geometry.span) *
      (geometry.right - geometry.left);
    const py = geometry.bottom -
      ((point[1] - geometry.low) / (geometry.high - geometry.low)) *
      (geometry.bottom - geometry.top);

    const cursor = svg.querySelector('#chart-cursor');
    if (cursor) {
      cursor.style.display = '';
      cursor.querySelector('line').setAttribute('x1', px);
      cursor.querySelector('line').setAttribute('x2', px);
      cursor.querySelector('circle').setAttribute('cx', px);
      cursor.querySelector('circle').setAttribute('cy', py);
    }

    tip.innerHTML = '<b>' + escapeHtml(formatNumber(point[1])) + ' 円/g</b>' +
      escapeHtml(formatDate(point[0]));
    tip.hidden = false;
    const tipX = Math.min(rect.width - 40, Math.max(40, px / scale));
    tip.style.left = tipX + 'px';
  }

  wrap.addEventListener('pointerdown', (event) => { wrap.setPointerCapture(event.pointerId); move(event); });
  wrap.addEventListener('pointermove', (event) => { if (event.buttons || event.pointerType === 'mouse') move(event); });
  wrap.addEventListener('pointerup', hide);
  wrap.addEventListener('pointercancel', hide);
  wrap.addEventListener('pointerleave', hide);
}

/* ---------------------------------------------------------------------
   描画: 純度・重量計算
--------------------------------------------------------------------- */

function calcBases() {
  const bases = [];
  const retail = latestOf('retail');
  const market = latestOf('market');
  if (retail) {
    bases.push({ id: 'buy', label: '店頭買取価格（税込）', price: retail.buy_price });
    bases.push({ id: 'retail', label: '店頭小売価格（税込）', price: retail.price });
  }
  if (market && typeof market.price === 'number') {
    bases.push({ id: 'market', label: '市場価格（税抜）', price: market.price });
  }
  return bases.filter((base) => typeof base.price === 'number');
}

function renderCalc() {
  const purity = CONFIG.purities.find((item) => item.id === $('calc-purity').value) || CONFIG.purities[0];
  const bases = calcBases();
  const base = bases.find((item) => item.id === $('calc-base').value) || bases[0];
  const weight = parseFloat($('calc-weight').value);

  if (!base || !Number.isFinite(weight) || weight < 0) {
    $('calc-result').textContent = '--';
    $('calc-formula').textContent = '';
    return;
  }

  const total = base.price * purity.ratio * weight;
  $('calc-result').textContent = formatNumber(total);
  $('calc-formula').textContent =
    formatNumber(base.price) + ' 円/g × ' + (purity.ratio * 100).toFixed(2) + '% × ' +
    weight + ' g';
}

/* ---------------------------------------------------------------------
   描画: データの出典
--------------------------------------------------------------------- */

function renderSources() {
  const rows = [];
  for (const id of ['retail', 'market']) {
    const entry = latestOf(id);
    if (!entry) continue;
    const source = entry.source || {};
    const status = entry.ok === false
      ? '<span class="is-error">取得失敗（' + escapeHtml(String(entry.error || '')) + '）</span>'
      : '正常';
    rows.push(
      '<div class="sources__row">' +
      '<dt>' + escapeHtml(entry.label || id) + '</dt>' +
      '<dd>価格種別：' + escapeHtml(entry.price_type || '--') + '</dd>' +
      '<dd>提供元：' + escapeHtml(source.name || '--') +
      (source.url ? ' <a href="' + escapeHtml(source.url) + '" target="_blank" rel="noopener">' +
        escapeHtml(source.url) + '</a>' : '') + '</dd>' +
      '<dd>データ日付：' + escapeHtml(formatDate(entry.date)) +
      ' ／ 状態：' + status + '</dd>' +
      (entry.note ? '<dd>' + escapeHtml(entry.note) + '</dd>' : '') +
      '</div>'
    );
  }

  const history = state.history;
  if (history && history.series) {
    const counts = Object.keys(history.series).map((id) => {
      const series = history.series[id];
      const points = series.points || [];
      if (!points.length) return escapeHtml(series.short_label || id) + '：データなし';
      return escapeHtml(series.short_label || id) + '：' + points.length + '件（' +
        escapeHtml(formatDate(points[0][0])) + '〜' + escapeHtml(formatDate(points[points.length - 1][0])) + '）';
    });
    rows.push('<div class="sources__row"><dt>蓄積データ</dt><dd>' + counts.join('<br>') + '</dd></div>');
  }

  rows.push('<div class="sources__row"><dt>最終更新</dt><dd>' +
    escapeHtml(formatDateTime(state.latest && state.latest.generated_at)) +
    '（' + escapeHtml(relativeTime(state.latest && state.latest.generated_at)) + '）</dd></div>');

  $('sources-list').innerHTML = rows.join('');
  $('app-version').textContent = 'データ生成: ' + formatDateTime(state.latest && state.latest.generated_at);
}

/* ---------------------------------------------------------------------
   UI 部品の組み立て
--------------------------------------------------------------------- */

function buildSegment(container, ids, selectedId, onSelect) {
  container.innerHTML = ids.map((id) =>
    '<button type="button" class="seg__item" role="tab" data-id="' + id + '" aria-selected="' +
    (id === selectedId) + '">' + escapeHtml(CONFIG.periods[id].label) + '</button>'
  ).join('');
  container.querySelectorAll('.seg__item').forEach((button) => {
    button.addEventListener('click', () => {
      container.querySelectorAll('.seg__item').forEach((other) => {
        other.setAttribute('aria-selected', String(other === button));
      });
      onSelect(button.dataset.id);
    });
  });
}

function buildSeriesSelect() {
  const select = $('series-select');
  const options = [];
  for (const id of ['retail', 'market']) {
    const series = seriesOf(id);
    if (series) options.push('<option value="' + id + '">' + escapeHtml(series.label) + '</option>');
  }
  select.innerHTML = options.join('');
  select.value = state.seriesId;
  select.addEventListener('change', () => {
    state.seriesId = select.value;
    renderRank();
    renderChart();
  });
}

function buildCalcControls() {
  $('calc-purity').innerHTML = CONFIG.purities
    .map((item) => '<option value="' + item.id + '">' + escapeHtml(item.label) + '</option>')
    .join('');
  $('calc-base').innerHTML = calcBases()
    .map((item) => '<option value="' + item.id + '">' + escapeHtml(item.label) +
      '　' + formatNumber(item.price) + ' 円/g</option>')
    .join('');
  ['calc-purity', 'calc-base', 'calc-weight'].forEach((id) => {
    $(id).addEventListener('input', renderCalc);
    $(id).addEventListener('change', renderCalc);
  });
}

/* ---------------------------------------------------------------------
   起動
--------------------------------------------------------------------- */

function renderAll() {
  renderBanner();
  renderHero();
  renderBaseline();
  renderRank();
  renderChart();
  renderCalc();
  renderSources();
}

async function refresh(button) {
  if (button) button.classList.add('is-busy');
  try {
    await loadAll();
    renderAll();
  } catch (error) {
    const banner = $('status-banner');
    banner.className = 'banner';
    banner.innerHTML = '<b>データを読み込めませんでした</b>' + escapeHtml(String(error.message || error));
    banner.hidden = false;
  } finally {
    if (button) button.classList.remove('is-busy');
  }
}

async function init() {
  document.body.classList.add('is-loading');
  try {
    await loadAll();
  } catch (error) {
    document.body.classList.remove('is-loading');
    const banner = $('status-banner');
    banner.className = 'banner';
    banner.innerHTML = '<b>データを読み込めませんでした</b>' + escapeHtml(String(error.message || error));
    banner.hidden = false;
    return;
  }
  document.body.classList.remove('is-loading');

  buildSegment($('rank-periods'), CONFIG.rankPeriodIds, state.rankPeriodId, (id) => {
    state.rankPeriodId = id;
    renderRank();
  });
  buildSegment($('chart-periods'), CONFIG.chartPeriodIds, state.chartPeriodId, (id) => {
    state.chartPeriodId = id;
    renderChart();
  });
  buildSeriesSelect();
  buildCalcControls();
  setupChartCursor();

  renderAll();

  $('refresh-button').addEventListener('click', (event) => refresh(event.currentTarget));
  window.addEventListener('online', () => refresh());
  window.addEventListener('resize', () => renderChart());
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 失敗しても通常表示は可能 */ });
  });
}

document.addEventListener('DOMContentLoaded', init);
