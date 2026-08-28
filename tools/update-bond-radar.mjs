#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const EASTMONEY_HOSTS = [
  "https://push2delay.eastmoney.com",
  "https://16.push2.eastmoney.com",
  "https://push2.eastmoney.com",
  "https://82.push2.eastmoney.com",
  "https://80.push2.eastmoney.com",
];
const USER_AGENT = "Mozilla/5.0 convertible-bond-sync-radar/1.0";
const BOND_AMOUNT_FLOOR = 10_000_000;
const STOCK_AMOUNT_FLOOR = 30_000_000;
const MIN_STOCK_EFFECTIVE_MOVEMENT = 2;
const MIN_STOCK_UPWARD_RETURN = 0.5;
const MIN_BOND_UPWARD_RETURN = 0.2;
const MIN_STOCK_RANGE_POSITION = 60;
const MIN_BOND_RANGE_POSITION = 55;
const MIN_BOND_CAPTURE_RATIO = 0.25;
const SYNC_ENRICHMENT_POOL_SIZE = 24;
const MIDDAY_MINUTE = "11:30";
const MIN_MIDDAY_SAMPLE_COUNT = 90;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function pearsonCorrelation(left, right) {
  const length = Math.min(left.length, right.length);
  if (length < 3) return null;
  const a = left.slice(0, length);
  const b = right.slice(0, length);
  const meanA = a.reduce((sum, value) => sum + value, 0) / length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / length;
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let index = 0; index < length; index += 1) {
    const deltaA = a[index] - meanA;
    const deltaB = b[index] - meanB;
    numerator += deltaA * deltaB;
    denominatorA += deltaA ** 2;
    denominatorB += deltaB ** 2;
  }
  const denominator = Math.sqrt(denominatorA * denominatorB);
  return denominator > 0 ? clamp(numerator / denominator, -1, 1) : null;
}

export function calculateSync(
  correlation,
  directionAgreement,
  rollingConsistency = directionAgreement,
) {
  const direction = clamp(directionAgreement ?? 0);
  const rolling = clamp(rollingConsistency ?? 0);
  const positivePathCorrelation = Math.max(0, correlation ?? 0);
  return Math.round(
    100 *
      (positivePathCorrelation * 0.5 + direction * 0.3 + rolling * 0.2),
  );
}

export function determineSyncConfidence(sampleCount, activeSampleCount) {
  if (sampleCount < 5) {
    return { level: "insufficient", label: "样本不足", scoreWeight: 0 };
  }
  if (sampleCount < 15 || activeSampleCount < 8) {
    return { level: "preview", label: "早盘预览", scoreWeight: 0.25 };
  }
  if (sampleCount < 30 || activeSampleCount < 15) {
    return { level: "observation", label: "初步观察", scoreWeight: 0.5 };
  }
  if (sampleCount < 60 || activeSampleCount < 30) {
    return { level: "confirmed", label: "正式确认", scoreWeight: 1 };
  }
  return { level: "stable", label: "高置信确认", scoreWeight: 1 };
}

export function calculateVolatilityScore(bondAmplitude, stockAmplitude) {
  return round(bondAmplitude * 0.55 + stockAmplitude * 0.45, 2);
}

function formatChinaTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function marketPhaseAt(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (["Sat", "Sun"].includes(values.weekday)) return "休市";
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  if ((minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900)) {
    return "交易中";
  }
  if (minutes < 570) return "待开盘";
  if (minutes < 780) return "午间休市";
  return "已收盘";
}

export function validateMiddaySnapshot(snapshot, expectedTradeDate) {
  if (snapshot?.tradeDate !== expectedTradeDate) {
    return {
      published: false,
      reason: `行情交易日 ${snapshot?.tradeDate ?? "未知"} 与 ${expectedTradeDate} 不一致`,
    };
  }
  if (!snapshot.latestMinute || snapshot.latestMinute < MIDDAY_MINUTE) {
    throw new Error(
      `午盘分钟数据尚未完整：最新 ${snapshot.latestMinute ?? "未知"}，要求至少 ${MIDDAY_MINUTE}`,
    );
  }
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    throw new Error("午盘快照没有可发布的转债/正股组合");
  }
  const complete = snapshot.items.every(
    (item) =>
      item?.bond?.code &&
      item?.stock?.code &&
      Number.isFinite(item.professionalScore) &&
      item?.sync?.syncMode === "minute-path" &&
      item.sync.tradeDate === expectedTradeDate &&
      item.sync.baselineTime === "09:30" &&
      item.sync.sampleCount >= MIN_MIDDAY_SAMPLE_COUNT &&
      Number.isFinite(item.sync.activeSampleCount) &&
      ["confirmed", "stable"].includes(item.sync.confidenceLevel) &&
      Number.isFinite(item.sync.syncRate),
  );
  if (!complete) {
    throw new Error("午盘快照缺少完整的分钟同步、评分或证券映射字段");
  }
  return { published: true, reason: "午盘快照校验通过" };
}

async function fetchEastmoney(pathname, params, label) {
  let lastError;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const host = EASTMONEY_HOSTS[attempt % EASTMONEY_HOSTS.length];
    const url = new URL(pathname, host);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    try {
      const response = await fetch(url, {
        headers: {
          Referer: "https://quote.eastmoney.com/",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(28_000),
      });
      if (!response.ok) {
        throw new Error(`${label} HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (payload?.rc !== 0 || !payload?.data) {
        throw new Error(`${label} returned an empty payload`);
      }
      return payload.data;
    } catch (error) {
      lastError = error;
      if (attempt < 6) await sleep(450 * (attempt + 1));
    }
  }
  throw new Error(
    `${label} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function fetchBondUniverse() {
  const fields = [
    "f1",
    "f2",
    "f3",
    "f5",
    "f6",
    "f8",
    "f10",
    "f12",
    "f13",
    "f14",
    "f15",
    "f16",
    "f17",
    "f18",
    "f26",
    "f227",
    "f228",
    "f229",
    "f230",
    "f231",
    "f232",
    "f233",
    "f234",
    "f235",
    "f236",
    "f237",
    "f238",
    "f239",
    "f240",
    "f241",
    "f242",
    "f243",
  ].join(",");
  const pageSize = 500;
  const firstPage = await fetchEastmoney(
    "/api/qt/clist/get",
    {
      pn: 1,
      pz: pageSize,
      po: 1,
      np: 1,
      ut: "bd1d9ddb04089700cf9c27f6f7426281",
      fltt: 2,
      invt: 2,
      fid: "f3",
      fs: "b:MK0354",
      fields,
    },
    "convertible-bond universe",
  );
  const rows = [...(firstPage.diff ?? [])];
  const total = Number(firstPage.total ?? rows.length);
  for (let page = 2; rows.length < total; page += 1) {
    const data = await fetchEastmoney(
      "/api/qt/clist/get",
      {
        pn: page,
        pz: pageSize,
        po: 1,
        np: 1,
        ut: "bd1d9ddb04089700cf9c27f6f7426281",
        fltt: 2,
        invt: 2,
        fid: "f3",
        fs: "b:MK0354",
        fields,
      },
      `convertible-bond universe page ${page}`,
    );
    rows.push(...(data.diff ?? []));
    if (!data.diff?.length) break;
  }
  return { total, rows };
}

function chunk(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(values[currentIndex], currentIndex);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

async function fetchStockQuotes(secids) {
  const unique = [...new Set(secids.filter(Boolean))];
  const groups = chunk(unique, 70);
  const pages = await mapLimit(groups, 2, async (group, index) =>
    fetchEastmoney(
      "/api/qt/ulist.np/get",
      {
        fltt: 2,
        invt: 2,
        fields: "f2,f3,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18",
        secids: group.join(","),
      },
      `underlying-stock quotes batch ${index + 1}`,
    ),
  );
  return pages.flatMap((page) => page.diff ?? []);
}

function amplitude(high, low, previousClose) {
  if (!(high > 0) || !(low > 0) || !(previousClose > 0)) return null;
  return ((high - low) / previousClose) * 100;
}

export function effectiveMovement(high, low, previousClose) {
  if (!(high > 0) || !(low > 0) || !(previousClose > 0)) return null;
  return (
    ((Math.max(high, previousClose) - Math.min(low, previousClose)) /
      previousClose) *
    100
  );
}

export function effectiveRangePosition(price, high, low, previousClose) {
  if (
    !(price > 0) ||
    !(high > 0) ||
    !(low > 0) ||
    !(previousClose > 0)
  ) {
    return null;
  }
  const effectiveHigh = Math.max(high, previousClose);
  const effectiveLow = Math.min(low, previousClose);
  if (effectiveHigh === effectiveLow) return 50;
  return clamp(
    ((price - effectiveLow) / (effectiveHigh - effectiveLow)) * 100,
    0,
    100,
  );
}

export function evaluateTrendEligibility(pair) {
  const stockRangePosition = effectiveRangePosition(
    pair.stock.price,
    pair.stock.high,
    pair.stock.low,
    pair.stock.previousClose,
  );
  const bondRangePosition = effectiveRangePosition(
    pair.bond.price,
    pair.bond.high,
    pair.bond.low,
    pair.bond.previousClose,
  );
  const captureRatio =
    Math.max(pair.bond.changePct, 0) /
    Math.max(Math.max(pair.stock.changePct, 0), 0.8);
  const sameDirection =
    pair.bond.changePct > 0 && pair.stock.changePct > 0;
  const stockVolatilityPass =
    pair.stockAmplitude >= MIN_STOCK_EFFECTIVE_MOVEMENT;
  const upwardTrendPass =
    pair.stock.changePct >= MIN_STOCK_UPWARD_RETURN &&
    pair.stock.price >= pair.stock.open &&
    stockRangePosition >= MIN_STOCK_RANGE_POSITION &&
    pair.bond.changePct >= MIN_BOND_UPWARD_RETURN &&
    pair.bond.price >= pair.bond.open &&
    bondRangePosition >= MIN_BOND_RANGE_POSITION &&
    sameDirection;
  const bondElasticityPass = captureRatio >= MIN_BOND_CAPTURE_RATIO;
  const failedReasons = [];
  if (!stockVolatilityPass) failedReasons.push("正股有效波动不足");
  if (!upwardTrendPass) failedReasons.push("转债与正股未形成日内向上结构");
  if (!bondElasticityPass) failedReasons.push("转债跟随弹性不足");
  return {
    passed: stockVolatilityPass && upwardTrendPass && bondElasticityPass,
    stockVolatilityPass,
    upwardTrendPass,
    bondElasticityPass,
    failedReasons,
    stockRangePosition: round(stockRangePosition, 2),
    bondRangePosition: round(bondRangePosition, 2),
    captureRatio: round(captureRatio, 3),
  };
}

function percentile(value, sortedValues) {
  if (!sortedValues.length || !Number.isFinite(value)) return 0;
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedValues[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return sortedValues.length === 1
    ? 100
    : ((low - 1) / (sortedValues.length - 1)) * 100;
}

function sortedFeature(pairs, read) {
  return pairs
    .map(read)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

export function scoreProfessionalCandidates(pairs) {
  const distributions = {
    volatility: sortedFeature(pairs, (pair) => pair.volatilityScore),
    bondAmplitude: sortedFeature(pairs, (pair) => pair.bondAmplitude),
    bondIntradayAmplitude: sortedFeature(
      pairs,
      (pair) => pair.bondIntradayAmplitude,
    ),
    stockIntradayAmplitude: sortedFeature(
      pairs,
      (pair) => pair.stockIntradayAmplitude,
    ),
    bondAmount: sortedFeature(pairs, (pair) => Math.log10(Math.max(pair.bond.amount, 1))),
    bondTurnover: sortedFeature(pairs, (pair) => pair.bond.turnoverRate),
    bondVolumeRatio: sortedFeature(pairs, (pair) => pair.bond.volumeRatio),
    stockTurnover: sortedFeature(pairs, (pair) => pair.stock.turnoverRate),
    absoluteBondChange: sortedFeature(pairs, (pair) => Math.abs(pair.bond.changePct)),
    premium: sortedFeature(pairs, (pair) => pair.bond.conversionPremiumRate),
  };

  return pairs.map((pair) => {
    const volatility = percentile(pair.volatilityScore, distributions.volatility);
    const bondVolatility = percentile(pair.bondAmplitude, distributions.bondAmplitude);
    const bondIntradayVolatility = percentile(
      pair.bondIntradayAmplitude,
      distributions.bondIntradayAmplitude,
    );
    const stockIntradayVolatility = percentile(
      pair.stockIntradayAmplitude,
      distributions.stockIntradayAmplitude,
    );
    const amount = percentile(
      Math.log10(Math.max(pair.bond.amount, 1)),
      distributions.bondAmount,
    );
    const turnover = percentile(pair.bond.turnoverRate, distributions.bondTurnover);
    const volumeRatio = percentile(pair.bond.volumeRatio, distributions.bondVolumeRatio);
    const stockTurnover = percentile(pair.stock.turnoverRate, distributions.stockTurnover);
    const absoluteMove = percentile(
      Math.abs(pair.bond.changePct),
      distributions.absoluteBondChange,
    );
    const premiumQuality =
      100 - percentile(pair.bond.conversionPremiumRate, distributions.premium);
    const returnPersistence =
      clamp(Math.abs(pair.bond.changePct) / Math.max(pair.bondAmplitude, 0.1)) * 100;
    const meanReversion =
      (1 -
        clamp(
          Math.abs(pair.bond.changePct) /
            Math.max(pair.bondIntradayAmplitude, 0.1),
        )) *
      100;
    const eligibility = evaluateTrendEligibility(pair);
    const stockMove = Math.max(pair.stock.changePct, 0);
    const captureRatio = Math.max(pair.bond.changePct, 0) / Math.max(stockMove, 0.8);
    const captureScore = clamp(captureRatio / 0.8) * 100;
    const sameDirection =
      Math.abs(pair.bond.changePct) < 0.08 ||
      Math.abs(pair.stock.changePct) < 0.08 ||
      Math.sign(pair.bond.changePct) === Math.sign(pair.stock.changePct);
    const trackingDenominator =
      Math.abs(pair.bond.changePct) + Math.abs(pair.stock.changePct) + 1;
    const trackingProximity = clamp(
      1 -
        Math.abs(pair.bond.changePct - pair.stock.changePct) /
          trackingDenominator,
    );
    const snapshotTracking = trackingProximity * (sameDirection ? 100 : 20);
    const volatilityFactor = volatility * 0.75 + bondVolatility * 0.25;
    const activityFactor =
      turnover * 0.4 + amount * 0.25 + volumeRatio * 0.2 + stockTurnover * 0.15;
    const stockDisplacement = clamp(stockMove / 5) * 100;
    const trendFactor =
      stockDisplacement * 0.35 +
      eligibility.stockRangePosition * 0.25 +
      eligibility.bondRangePosition * 0.15 +
      returnPersistence * 0.15 +
      (pair.stock.price >= pair.stock.open ? 100 : 0) * 0.1;
    const linkageFactor =
      snapshotTracking * 0.45 + captureScore * 0.3 + premiumQuality * 0.25;
    const premiumPenalty = Math.max(
      0,
      Math.min(10, (pair.bond.conversionPremiumRate - 80) * 0.12),
    );
    const pricePenalty = Math.max(0, Math.min(6, (pair.bond.price - 450) / 40));
    const preliminaryScore =
      volatilityFactor * 0.25 +
      activityFactor * 0.25 +
      trendFactor * 0.3 +
      linkageFactor * 0.2 -
      premiumPenalty -
      pricePenalty;
    const oscillationFactor =
      bondIntradayVolatility * 0.35 +
      turnover * 0.25 +
      amount * 0.15 +
      meanReversion * 0.15 +
      stockIntradayVolatility * 0.1;
    return {
      ...pair,
      eligibility,
      factors: {
        volatility: round(volatilityFactor, 2),
        activity: round(activityFactor, 2),
        trend: round(trendFactor, 2),
        linkage: round(linkageFactor, 2),
        premiumQuality: round(premiumQuality, 2),
        captureRatio: round(captureRatio, 3),
        returnPersistence: round(returnPersistence, 2),
        meanReversion: round(meanReversion, 2),
        oscillation: round(oscillationFactor, 2),
        stockRangePosition: eligibility.stockRangePosition,
        bondRangePosition: eligibility.bondRangePosition,
        style: eligibility.passed ? "向上联动" : "观察候选",
        preliminaryScore: round(preliminaryScore, 2),
      },
    };
  });
}

function normalizeBond(row) {
  const marketId = asNumber(row.f13);
  const stockMarketId = asNumber(row.f233);
  return {
    code: String(row.f12 ?? ""),
    marketId,
    secid: marketId === null ? null : `${marketId}.${row.f12}`,
    name: String(row.f14 ?? row.f12 ?? "--"),
    price: asNumber(row.f2),
    changePct: asNumber(row.f3),
    volume: asNumber(row.f5),
    amount: asNumber(row.f6),
    turnoverRate: asNumber(row.f8),
    volumeRatio: asNumber(row.f10),
    high: asNumber(row.f15),
    low: asNumber(row.f16),
    open: asNumber(row.f17),
    previousClose: asNumber(row.f18),
    listingDate: row.f26 ? String(row.f26) : null,
    pureBondValue: asNumber(row.f227),
    stockCode: String(row.f232 ?? ""),
    stockMarketId,
    stockSecid:
      stockMarketId === null || !row.f232 ? null : `${stockMarketId}.${row.f232}`,
    stockName: String(row.f234 ?? row.f232 ?? "--"),
    conversionPrice: asNumber(row.f235),
    conversionValue: asNumber(row.f236),
    conversionPremiumRate: asNumber(row.f237),
    pureBondPremiumRate: asNumber(row.f238),
  };
}

function normalizeStock(row) {
  const marketId = asNumber(row.f13);
  return {
    code: String(row.f12 ?? ""),
    marketId,
    secid: marketId === null ? null : `${marketId}.${row.f12}`,
    name: String(row.f14 ?? row.f12 ?? "--"),
    price: asNumber(row.f2),
    changePct: asNumber(row.f3),
    volume: asNumber(row.f5),
    amount: asNumber(row.f6),
    turnoverRate: asNumber(row.f8),
    volumeRatio: asNumber(row.f10),
    high: asNumber(row.f15),
    low: asNumber(row.f16),
    open: asNumber(row.f17),
    previousClose: asNumber(row.f18),
  };
}

function isCompleteQuote(quote) {
  return (
    quote &&
    quote.price > 0 &&
    quote.previousClose > 0 &&
    quote.high > 0 &&
    quote.low > 0 &&
    quote.high >= quote.low
  );
}

async function fetchTrend(secid, label) {
  const data = await fetchEastmoney(
    "/api/qt/stock/trends2/get",
    {
      secid,
      fields1: "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
      iscr: 0,
      iscca: 0,
      ut: "f057cbcbce2a86e2866ab8877db1d059",
      ndays: 1,
    },
    label,
  );
  const points = (data.trends ?? [])
    .map((record) => {
      const fields = String(record).split(",");
      return {
        time: fields[0],
        close: asNumber(fields[2]),
      };
    })
    .filter((point) => point.time && point.close > 0);
  return { points };
}

function fallbackSnapshotSync(bondChange, stockChange) {
  const denominator = Math.abs(bondChange) + Math.abs(stockChange) + 1;
  const proximity = clamp(1 - Math.abs(bondChange - stockChange) / denominator);
  const sameDirection =
    Math.abs(bondChange) < 0.05 ||
    Math.abs(stockChange) < 0.05 ||
    Math.sign(bondChange) === Math.sign(stockChange);
  return Math.round(100 * proximity * (sameDirection ? 1 : 0.2));
}

function downsample(points, maximum = 72) {
  if (points.length <= maximum) return points;
  const stride = Math.ceil(points.length / maximum);
  const sampled = points.filter((_, index) => index % stride === 0);
  const last = points.at(-1);
  if (sampled.at(-1)?.time !== last?.time) sampled.push(last);
  return sampled;
}

function bestLaggedCorrelation(bondReturns, stockReturns, maxLag = 2) {
  let best = { correlation: null, lagMinutes: 0 };
  const lags = Array.from({ length: maxLag * 2 + 1 }, (_, index) => index - maxLag)
    .sort((left, right) => Math.abs(left) - Math.abs(right));
  for (const lag of lags) {
    const shift = Math.abs(lag);
    const bond = lag >= 0
      ? bondReturns.slice(shift)
      : bondReturns.slice(0, -shift || undefined);
    const stock = lag >= 0
      ? stockReturns.slice(0, -shift || undefined)
      : stockReturns.slice(shift);
    const correlation = pearsonCorrelation(bond, stock);
    if (
      correlation !== null &&
      (best.correlation === null || correlation > best.correlation)
    ) {
      best = { correlation, lagMinutes: lag };
    }
  }
  return best;
}

function rollingConsistency(bondReturns, stockReturns) {
  const correlations = [10, 20, 30]
    .filter((window) => bondReturns.length >= window)
    .map((window) =>
      bestLaggedCorrelation(
        bondReturns.slice(-window),
        stockReturns.slice(-window),
      ).correlation,
    )
    .filter(Number.isFinite)
    .map((correlation) => Math.max(0, correlation));
  return correlations.length
    ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length
    : 0;
}

export function compareMinutePaths(bondTrend, stockTrend, fallback) {
  const stockByTime = new Map(
    stockTrend.points.map((point) => [point.time, point.close]),
  );
  const rawAligned = bondTrend.points
    .filter((point) => stockByTime.has(point.time))
    .map((point) => {
      return {
        time: point.time,
        bondClose: point.close,
        stockClose: stockByTime.get(point.time),
      };
    })
    .filter(
      (point) =>
        Number.isFinite(point.bondClose) && Number.isFinite(point.stockClose),
    );
  const baselineIndex = rawAligned.findIndex(
    (point) => point.time.slice(11, 16) === "09:30",
  );
  const baseline = rawAligned[baselineIndex];
  const aligned = baseline
    ? rawAligned.slice(baselineIndex).map((point) => ({
        time: point.time,
        bondReturn: ((point.bondClose / baseline.bondClose) - 1) * 100,
        stockReturn: ((point.stockClose / baseline.stockClose) - 1) * 100,
      }))
    : [];
  const latest = aligned.at(-1);
  const increments = baseline
    ? rawAligned.slice(baselineIndex + 1).map((point, index) => {
        const previous = rawAligned[baselineIndex + index];
        return {
          bondReturn: ((point.bondClose / previous.bondClose) - 1) * 100,
          stockReturn: ((point.stockClose / previous.stockClose) - 1) * 100,
        };
      })
    : [];
  const bondIncrements = increments.map((point) => point.bondReturn);
  const stockIncrements = increments.map((point) => point.stockReturn);
  const active = increments.filter(
    (point) => Math.abs(point.bondReturn) + Math.abs(point.stockReturn) >= 0.08,
  );
  const confidence = determineSyncConfidence(aligned.length, active.length);
  const timeline = downsample(aligned).map((point) => ({
    time: point.time.slice(11, 16),
    bondReturn: round(point.bondReturn, 3),
    stockReturn: round(point.stockReturn, 3),
  }));

  if (aligned.length < 5) {
    return {
      syncMode: "snapshot-proxy",
      tradeDate: rawAligned.at(-1)?.time?.slice(0, 10) ?? null,
      baselineTime: baseline?.time.slice(11, 16) ?? null,
      sampleCount: aligned.length,
      pathCorrelation: null,
      directionAgreement: null,
      syncRate: fallbackSnapshotSync(
        latest?.bondReturn ?? fallback.bondChange,
        latest?.stockReturn ?? fallback.stockChange,
      ),
      latestBondReturn: round(latest?.bondReturn),
      latestStockReturn: round(latest?.stockReturn),
      activeSampleCount: active.length,
      rollingConsistency: null,
      zeroLagCorrelation: null,
      leadLagMinutes: null,
      confidenceLevel: confidence.level,
      confidenceLabel: confidence.label,
      confidenceWeight: confidence.scoreWeight,
      timeline,
    };
  }

  const zeroLagCorrelation = pearsonCorrelation(bondIncrements, stockIncrements);
  const lagged = bestLaggedCorrelation(bondIncrements, stockIncrements);
  const directionAgreement = active.length
    ? active.filter(
        (point) =>
          Math.sign(point.bondReturn) === Math.sign(point.stockReturn) ||
          Math.abs(point.bondReturn) < 0.04 ||
          Math.abs(point.stockReturn) < 0.04,
      ).length / active.length
    : 0;
  const consistency = rollingConsistency(bondIncrements, stockIncrements);
  return {
    syncMode: "minute-path",
    tradeDate: aligned.at(-1)?.time?.slice(0, 10) ?? null,
    baselineTime: baseline.time.slice(11, 16),
    sampleCount: aligned.length,
    pathCorrelation: round(lagged.correlation, 4),
    zeroLagCorrelation: round(zeroLagCorrelation, 4),
    leadLagMinutes: lagged.lagMinutes,
    directionAgreement: round(directionAgreement, 4),
    activeSampleCount: active.length,
    rollingConsistency: round(consistency, 4),
    syncRate: calculateSync(
      lagged.correlation,
      directionAgreement,
      consistency,
    ),
    latestBondReturn: round(latest.bondReturn),
    latestStockReturn: round(latest.stockReturn),
    confidenceLevel: confidence.level,
    confidenceLabel: confidence.label,
    confidenceWeight: confidence.scoreWeight,
    timeline,
  };
}

function syncLabel(syncRate, bondChange, stockChange) {
  if (
    Math.abs(bondChange) >= 0.3 &&
    Math.abs(stockChange) >= 0.3 &&
    Math.sign(bondChange) !== Math.sign(stockChange)
  ) {
    return "反向背离";
  }
  if (syncRate >= 75) return "高度同步";
  if (syncRate >= 55) return "同步";
  if (syncRate >= 35) return "弱同步";
  return "背离";
}

async function enrichCandidate(candidate) {
  const fallback = {
    bondChange: candidate.bond.changePct,
    stockChange: candidate.stock.changePct,
  };
  let sync;
  let warning = null;
  try {
    const [bondTrend, stockTrend] = await Promise.all([
      fetchTrend(candidate.bond.secid, `${candidate.bond.name} minute path`),
      fetchTrend(candidate.stock.secid, `${candidate.stock.name} minute path`),
    ]);
    sync = compareMinutePaths(bondTrend, stockTrend, fallback);
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
    sync = {
      syncMode: "snapshot-proxy",
      tradeDate: null,
      baselineTime: null,
      sampleCount: 0,
      pathCorrelation: null,
      directionAgreement: null,
      syncRate: fallbackSnapshotSync(
        candidate.bond.changePct,
        candidate.stock.changePct,
      ),
      latestBondReturn: null,
      latestStockReturn: null,
      activeSampleCount: 0,
      rollingConsistency: null,
      zeroLagCorrelation: null,
      leadLagMinutes: null,
      confidenceLevel: "insufficient",
      confidenceLabel: "样本不足",
      confidenceWeight: 0,
      timeline: [],
    };
  }
  const bondSyncReturn = sync.latestBondReturn ?? candidate.bond.changePct;
  const stockSyncReturn = sync.latestStockReturn ?? candidate.stock.changePct;
  const divergencePct = round(
    bondSyncReturn - stockSyncReturn,
    2,
  );
  return {
    ...candidate,
    sync: {
      ...sync,
      label: syncLabel(
        sync.syncRate,
        bondSyncReturn,
        stockSyncReturn,
      ),
      divergencePct,
      relativeStrength:
        Math.abs(divergencePct) < 0.5
          ? "强弱接近"
          : divergencePct > 0
            ? "转债偏强"
            : "正股偏强",
      warning,
    },
  };
}

function publicQuote(quote, quoteAmplitude, intradayAmplitude) {
  return {
    code: quote.code,
    name: quote.name,
    price: round(quote.price, 3),
    previousClose: round(quote.previousClose, 3),
    open: round(quote.open, 3),
    high: round(quote.high, 3),
    low: round(quote.low, 3),
    changePct: round(quote.changePct, 2),
    amplitude: round(quoteAmplitude, 2),
    intradayAmplitude: round(intradayAmplitude, 2),
    amount: round(quote.amount, 0),
    turnoverRate: round(quote.turnoverRate, 2),
    volumeRatio: round(quote.volumeRatio, 2),
  };
}

export async function buildBondRadarCandidateUniverse() {
  const universe = await fetchBondUniverse();
  const bonds = universe.rows.map(normalizeBond).filter((bond) => bond.stockSecid);
  const stockRows = await fetchStockQuotes(bonds.map((bond) => bond.stockSecid));
  const stocks = new Map(
    stockRows.map(normalizeStock).map((stock) => [stock.secid, stock]),
  );
  const completePairs = bonds
    .map((bond) => ({ bond, stock: stocks.get(bond.stockSecid) }))
    .filter(({ bond, stock }) => isCompleteQuote(bond) && isCompleteQuote(stock))
    .map(({ bond, stock }) => {
      const bondIntradayAmplitude = amplitude(
        bond.high,
        bond.low,
        bond.previousClose,
      );
      const stockIntradayAmplitude = amplitude(
        stock.high,
        stock.low,
        stock.previousClose,
      );
      const bondAmplitude = effectiveMovement(
        bond.high,
        bond.low,
        bond.previousClose,
      );
      const stockAmplitude = effectiveMovement(
        stock.high,
        stock.low,
        stock.previousClose,
      );
      return {
        bond,
        stock,
        bondAmplitude,
        stockAmplitude,
        bondIntradayAmplitude,
        stockIntradayAmplitude,
        volatilityScore: calculateVolatilityScore(
          bondAmplitude,
          stockAmplitude,
        ),
      };
    });
  const scoredPairs = scoreProfessionalCandidates(completePairs);
  const liquidPairs = scoredPairs.filter(
    ({ bond, stock }) =>
      bond.amount >= BOND_AMOUNT_FLOOR &&
      stock.amount >= STOCK_AMOUNT_FLOOR &&
      !/ST|退/i.test(stock.name),
  );
  const eligiblePairs = liquidPairs.filter(({ eligibility }) => eligibility.passed);
  return {
    universe,
    bonds,
    completePairs: scoredPairs,
    liquidPairs,
    eligiblePairs,
  };
}

export async function buildBondRadarSnapshot() {
  const { universe, bonds, completePairs, liquidPairs, eligiblePairs } =
    await buildBondRadarCandidateUniverse();
  const quantitative = [...eligiblePairs].sort(
    (left, right) =>
      right.factors.preliminaryScore - left.factors.preliminaryScore,
  );
  const enriched = await mapLimit(
    quantitative.slice(0, SYNC_ENRICHMENT_POOL_SIZE),
    3,
    enrichCandidate,
  );
  const rescored = enriched
    .map((candidate) => ({
      ...candidate,
      professionalScore: round(
        candidate.factors.preliminaryScore *
          (1 - 0.18 * candidate.sync.confidenceWeight) +
          candidate.sync.syncRate * 0.18 * candidate.sync.confidenceWeight,
        2,
      ),
    }))
    .sort((left, right) => right.professionalScore - left.professionalScore)
    .slice(0, 10);
  const ranked = rescored.map((candidate, index) => ({
    rank: index + 1,
    professionalScore: candidate.professionalScore,
    volatilityScore: candidate.volatilityScore,
    eligibility: candidate.eligibility,
    factors: candidate.factors,
    bond: {
      ...publicQuote(
        candidate.bond,
        candidate.bondAmplitude,
        candidate.bondIntradayAmplitude,
      ),
      conversionPrice: round(candidate.bond.conversionPrice, 3),
      conversionValue: round(candidate.bond.conversionValue, 3),
      conversionPremiumRate: round(candidate.bond.conversionPremiumRate, 2),
      pureBondValue: round(candidate.bond.pureBondValue, 3),
    },
    stock: publicQuote(
      candidate.stock,
      candidate.stockAmplitude,
      candidate.stockIntradayAmplitude,
    ),
    sync: candidate.sync,
  }));

  const minuteTimes = ranked
    .flatMap((item) => item.sync.timeline.map((point) => point.time))
    .filter(Boolean)
    .sort();
  const generatedAt = new Date();
  const chinaDate = formatChinaTime(generatedAt).slice(0, 10);
  const tradeDate = rescored
    .map((item) => item.sync.tradeDate)
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    version: 5,
    generatedAt: generatedAt.toISOString(),
    generatedAtChina: formatChinaTime(generatedAt),
    tradeDate: tradeDate || chinaDate,
    latestMinute: minuteTimes.at(-1) ?? null,
    marketPhase:
      tradeDate && tradeDate !== chinaDate
        ? "休市或无新行情"
        : marketPhaseAt(generatedAt),
    source: {
      provider: "东方财富公开行情",
      access: "公开延时行情",
      baseline: "当日 9:30 第一根有效1分钟K线收盘价",
      notice: "公开行情可能延迟、限流或调整，不替代交易所或券商行情。",
    },
    methodology: {
      ranking:
        "专业评分 = 日内向上结构30% + 有效波动25% + 活跃度25% + 联动弹性20%；有效波动包含相对前收的跳空位移",
      sync:
        "同步率 = ±2分钟增量收益相关性×50% + 活跃分钟同向占比×30% + 10/20/30分钟滚动一致性×20%；9:30基准仅用于图表和盘中收益差",
      liquidity: `默认剔除转债成交额低于${BOND_AMOUNT_FLOOR / 10_000}万元、正股成交额低于${STOCK_AMOUNT_FLOOR / 10_000}万元或正股带ST/退市风险标识的组合`,
      shortlist:
        `先统一要求正股有效波动不低于${MIN_STOCK_EFFECTIVE_MOVEMENT}%、股债同处向上结构且转债捕获比不低于${MIN_BOND_CAPTURE_RATIO}，再对前${SYNC_ENRICHMENT_POOL_SIZE}名计算分钟同步率并纯模型选出最多10组`,
    },
    universe: {
      providerTotal: universe.total,
      mapped: bonds.length,
      complete: completePairs.length,
      liquid: liquidPairs.length,
      eligible: eligiblePairs.length,
      usedLiquidityFallback: false,
    },
    items: ranked,
  };
}

async function writeSnapshot(snapshot) {
  const publicDirectory = path.join(PROJECT_ROOT, "public", "data");
  const archiveDirectory = path.join(PROJECT_ROOT, "data", "bond-radar");
  await Promise.all([
    mkdir(publicDirectory, { recursive: true }),
    mkdir(archiveDirectory, { recursive: true }),
  ]);
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  const writeAtomically = async (target) => {
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, target);
  };
  await writeAtomically(path.join(archiveDirectory, `${snapshot.tradeDate}.json`));
  await writeAtomically(path.join(publicDirectory, "bond-radar.json"));
}

async function main() {
  const explainIndex = process.argv.indexOf("--explain");
  if (explainIndex >= 0) {
    const names = String(process.argv[explainIndex + 1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const { liquidPairs, eligiblePairs } = await buildBondRadarCandidateUniverse();
    const professional = [...liquidPairs].sort(
      (left, right) =>
        right.factors.preliminaryScore - left.factors.preliminaryScore,
    );
    const volatility = [...liquidPairs].sort(
      (left, right) => right.volatilityScore - left.volatilityScore,
    );
    const oscillation = [...liquidPairs].sort(
      (left, right) => right.factors.oscillation - left.factors.oscillation,
    );
    const professionalRanks = new Map(
      professional.map((pair, index) => [pair.bond.code, index + 1]),
    );
    const volatilityRanks = new Map(
      volatility.map((pair, index) => [pair.bond.code, index + 1]),
    );
    const oscillationRanks = new Map(
      oscillation.map((pair, index) => [pair.bond.code, index + 1]),
    );
    const explain = professional
      .filter(
        (pair) =>
          !names.length ||
          names.includes(pair.bond.name) ||
          names.includes(pair.bond.code),
      )
      .map((pair) => ({
        bond: pair.bond.name,
        code: pair.bond.code,
        stock: pair.stock.name,
        professionalRank: professionalRanks.get(pair.bond.code),
        volatilityRank: volatilityRanks.get(pair.bond.code),
        oscillationRank: oscillationRanks.get(pair.bond.code),
        preliminaryScore: pair.factors.preliminaryScore,
        volatilityScore: pair.volatilityScore,
        bondAmplitude: round(pair.bondAmplitude, 2),
        stockAmplitude: round(pair.stockAmplitude, 2),
        bondIntradayAmplitude: round(pair.bondIntradayAmplitude, 2),
        stockIntradayAmplitude: round(pair.stockIntradayAmplitude, 2),
        bondChangePct: round(pair.bond.changePct, 2),
        stockChangePct: round(pair.stock.changePct, 2),
        bondAmount: pair.bond.amount,
        bondTurnoverRate: pair.bond.turnoverRate,
        bondVolumeRatio: pair.bond.volumeRatio,
        conversionPremiumRate: pair.bond.conversionPremiumRate,
        eligibility: pair.eligibility,
        factors: pair.factors,
      }));
    process.stdout.write(
      `${JSON.stringify(
        {
          explain,
          eligibleCount: eligiblePairs.length,
          professionalTop20: professional
            .filter((pair) => pair.eligibility.passed)
            .slice(0, 20)
            .map((pair, index) => ({
            rank: index + 1,
            bond: pair.bond.name,
            score: pair.factors.preliminaryScore,
            volatilityRank: volatilityRanks.get(pair.bond.code),
            trend: pair.factors.trend,
          })),
          oscillationTop20: oscillation.slice(0, 20).map((pair, index) => ({
            rank: index + 1,
            bond: pair.bond.name,
            score: pair.factors.oscillation,
            professionalRank: professionalRanks.get(pair.bond.code),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const middayPublish = process.env.BOND_RADAR_PUBLISH_MODE === "midday";
  const expectedTradeDate = formatChinaTime().slice(0, 10);
  if (middayPublish) {
    const existingSnapshots = [
      path.join(PROJECT_ROOT, "dist", "client", "data", "bond-radar.json"),
      path.join(PROJECT_ROOT, "public", "data", "bond-radar.json"),
    ];
    for (const snapshotPath of existingSnapshots) {
      try {
        const existing = JSON.parse(await readFile(snapshotPath, "utf8"));
        if (validateMiddaySnapshot(existing, expectedTradeDate).published) {
          process.stdout.write(
            `${JSON.stringify({ published: false, reason: "今日午盘快照已发布", tradeDate: expectedTradeDate }, null, 2)}\n`,
          );
          return;
        }
      } catch {
        // Try the next snapshot, then rebuild when none is publishable.
      }
    }
  }

  const snapshot = await buildBondRadarSnapshot();
  if (middayPublish) {
    const validation = validateMiddaySnapshot(snapshot, expectedTradeDate);
    if (!validation.published) {
      process.stdout.write(
        `${JSON.stringify({ ...validation, tradeDate: snapshot.tradeDate }, null, 2)}\n`,
      );
      return;
    }
  }
  await writeSnapshot(snapshot);
  const summary = {
    published: true,
    tradeDate: snapshot.tradeDate,
    generatedAtChina: snapshot.generatedAtChina,
    providerTotal: snapshot.universe.providerTotal,
    completePairs: snapshot.universe.complete,
    liquidPairs: snapshot.universe.liquid,
    leaders: snapshot.items.map((item) => ({
      rank: item.rank,
      pair: `${item.bond.name}/${item.stock.name}`,
      volatilityScore: item.volatilityScore,
      professionalScore: item.professionalScore,
      syncRate: item.sync.syncRate,
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
