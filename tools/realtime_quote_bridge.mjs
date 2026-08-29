#!/usr/bin/env node

import { readFileSync } from "node:fs";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildBondRadarSnapshot } from "./update-bond-radar.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

function loadLocalEnvironment() {
  try {
    const content = readFileSync(`${PROJECT_ROOT}.env.local`, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Unable to read .env.local: ${error.message}`);
    }
  }
}

loadLocalEnvironment();

const HOST = process.env.T0_QUOTE_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.T0_QUOTE_BRIDGE_PORT || 8765);
const CACHE_TTL_MS = Number(process.env.T0_LATEST_CACHE_MS || 600);
const REQUEST_TIMEOUT_MS = Number(process.env.T0_LATEST_TIMEOUT_MS || 3500);
const CONTEXT_REFRESH_MS = Number(
  process.env.EASTMONEY_CONTEXT_REFRESH_MS || 5000,
);
const DAILY_REFRESH_MS = Number(
  process.env.EASTMONEY_DAILY_REFRESH_MS || 6 * 60 * 60 * 1000,
);
const MAPPING_REFRESH_MS = Number(
  process.env.EASTMONEY_MAPPING_REFRESH_MS || 24 * 60 * 60 * 1000,
);
const MINUTE_MAX_AGE_MS = Number(
  process.env.EASTMONEY_MINUTE_MAX_AGE_MS || 90000,
);
const LATEST_MAX_AGE_MS = Number(process.env.T0_LATEST_MAX_AGE_MS || 15000);
const PRICE_TOLERANCE_PCT = Number(
  process.env.EASTMONEY_PRICE_TOLERANCE_PCT || 1,
);
const BOND_RADAR_REFRESH_MS = Number(
  process.env.BOND_RADAR_REFRESH_MS || 15_000,
);
const EASTMONEY_QUOTE_URL =
  process.env.EASTMONEY_QUOTE_URL ||
  "https://push2his.eastmoney.com/api/qt/stock/get?invt=2&fltt=1&secid={secid}&fields=f43,f44,f45,f46,f47,f48,f50,f57,f58,f59,f60,f86,f127,f128,f129,f169,f170";
const EASTMONEY_TRENDS_URL =
  process.env.EASTMONEY_TRENDS_URL ||
  "https://push2his.eastmoney.com/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays={ndays}&iscr=0&secid={secid}";
const EASTMONEY_KLINE_URL =
  process.env.EASTMONEY_KLINE_URL ||
  "https://push2his.eastmoney.com/api/qt/stock/kline/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&lmt=60&end=20500000&iscca=1&secid={secid}";
const EASTMONEY_BOARD_LIST_URL =
  process.env.EASTMONEY_BOARD_LIST_URL ||
  "https://push2delay.eastmoney.com/api/qt/clist/get?pn={page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14";

const quoteCache = new Map();
const contextCache = new Map();
const dailyCache = new Map();
const comparisonCache = new Map();
const lastCumulativeVolume = new Map();
let boardMapCache = null;
let bondRadarCache = null;
let bondRadarBuild = null;

async function getBondRadarSnapshot() {
  if (
    bondRadarCache &&
    Date.now() - bondRadarCache.savedAt < BOND_RADAR_REFRESH_MS
  ) {
    return bondRadarCache.snapshot;
  }
  if (!bondRadarBuild) {
    bondRadarBuild = buildBondRadarSnapshot()
      .then((snapshot) => {
        bondRadarCache = { savedAt: Date.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        bondRadarBuild = null;
      });
  }
  return bondRadarBuild;
}

function normalizeCode(raw) {
  const code = String(raw || "").replace(/\D/g, "");
  if (code.length !== 6) {
    throw new Error("symbol must be a six-digit A-share or exchange-traded ETF code");
  }
  return code;
}

function inferMarket(code, requestedMarket = "") {
  const market = String(requestedMarket).toUpperCase();
  if (["SH", "SZ", "BJ"].includes(market)) return market;
  if (/^(92|43|81|82|83|87|88)/.test(code)) return "BJ";
  if (/^[569]/.test(code)) return "SH";
  return "SZ";
}

function isExchangeTradedFund(code) {
  return /^(15|16|18|50|51|52|56|58)/.test(code);
}

function toEastmoneySecId(code, market) {
  return `${market === "SH" ? 1 : 0}.${code}`;
}

function marketIndexDescriptor(market) {
  if (market === "SZ") {
    return { code: "399001.SZ", secid: "0.399001", name: "深证成指" };
  }
  if (market === "BJ") {
    return { code: "899050.BJ", secid: "0.899050", name: "北证50" };
  }
  return { code: "000001.SH", secid: "1.000001", name: "上证指数" };
}

function replaceTemplate(template, values) {
  return Object.entries(values).reduce(
    (url, [key, value]) => url.replaceAll(`{${key}}`, encodeURIComponent(value)),
    template,
  );
}

async function fetchJson(url, options = {}) {
  let lastError;
  const parsed = new URL(url);
  const officialHosts = [
    "push2his.eastmoney.com",
    "push2delay.eastmoney.com",
    "push2.eastmoney.com",
  ];
  const candidateUrls = officialHosts.includes(parsed.hostname)
    ? [
        url,
        ...officialHosts
          .filter((host) => host !== parsed.hostname)
          .map((host) => {
            const candidate = new URL(url);
            candidate.hostname = host;
            return candidate.toString();
          }),
      ]
    : [url, url];
  for (const candidateUrl of candidateUrls) {
    try {
      const response = await fetch(candidateUrl, {
        ...options,
        headers: {
          Referer: "https://quote.eastmoney.com/",
          "User-Agent": "Mozilla/5.0 intraday-compass/1.0",
          ...options.headers,
        },
        signal: AbortSignal.timeout(
          Number(options.timeoutMs || REQUEST_TIMEOUT_MS),
        ),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  if (officialHosts.includes(parsed.hostname) && !options.method) {
    try {
      const timeoutSeconds = Math.max(
        2,
        Math.ceil(Number(options.timeoutMs || REQUEST_TIMEOUT_MS) / 1000),
      );
      const { stdout } = await execFileAsync(
        "curl.exe",
        [
          "--silent",
          "--show-error",
          "--fail",
          "--compressed",
          "--max-time",
          String(timeoutSeconds),
          "--header",
          "Referer: https://quote.eastmoney.com/",
          "--header",
          "User-Agent: Mozilla/5.0 intraday-compass/1.0",
          url,
        ],
        { maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      );
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
    }
  }
  const target = new URL(url);
  const causeCode = lastError?.cause?.code ? ` (${lastError.cause.code})` : "";
  throw new Error(
    `${target.hostname}${target.pathname} 请求失败：${lastError?.message || "未知网络错误"}${causeCode}`,
    { cause: lastError },
  );
}

function scaled(value, divisor = 100) {
  if (value === "-" || value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number / divisor : null;
}

function numeric(value) {
  if (value === "-" || value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return (current / previous - 1) * 100;
}

function parseShanghaiTimestamp(value, fallback = null) {
  if (Number.isFinite(Number(value)) && Number(value) > 1_000_000_000) {
    return new Date(Number(value) * 1000).toISOString();
  }
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return `${text.replace(" ", "T")}${text.length === 16 ? ":00" : ""}+08:00`;
  }
  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`;
  }
  return fallback;
}

function compactDate(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

async function fetchSnapshot(secid) {
  const startedAt = performance.now();
  const payload = await fetchJson(
    replaceTemplate(EASTMONEY_QUOTE_URL, { secid }),
  );
  if (!payload?.data) throw new Error(`东方财富快照未返回 ${secid}`);
  return {
    data: payload.data,
    fetchLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

async function fetchLatestQuote(code, market) {
  const indexDescriptor = marketIndexDescriptor(market);
  const startedAt = performance.now();
  const [instrument, index] = await Promise.all([
    fetchSnapshot(toEastmoneySecId(code, market)),
    fetchSnapshot(indexDescriptor.secid),
  ]);
  const data = instrument.data;
  const pricePrecision = numeric(data.f59) ?? 2;
  const priceDivisor = 10 ** pricePrecision;
  const indexPrecision = numeric(index.data.f59) ?? 2;
  const indexDivisor = 10 ** indexPrecision;
  const price = scaled(data.f43, priceDivisor);
  const previousClose = scaled(data.f60, priceDivisor);
  if (!Number.isFinite(price) || !Number.isFinite(previousClose)) {
    throw new Error(`东方财富快照缺少 ${code} 的最新价或昨收`);
  }
  const cumulativeVolume = (numeric(data.f47) || 0) * 100;
  const volumeKey = `${market}:${code}`;
  const previousVolume = lastCumulativeVolume.get(volumeKey);
  const incrementalVolume =
    previousVolume === undefined
      ? 0
      : Math.max(0, cumulativeVolume - previousVolume);
  lastCumulativeVolume.set(volumeKey, cumulativeVolume);
  const receivedAt = new Date().toISOString();
  const sourceTime = parseShanghaiTimestamp(data.f86, receivedAt);
  return {
    symbol: code,
    market,
    name: String(data.f58 || code),
    price,
    previousClose,
    volume: incrementalVolume,
    cumulativeVolume,
    amount: numeric(data.f48) || 0,
    time: sourceTime,
    source: "eastmoney",
    industryName:
      data.f127 && data.f127 !== "-" ? String(data.f127).trim() : null,
    indexName: String(index.data.f58 || indexDescriptor.name),
    indexChange:
      scaled(index.data.f170) ??
      percentChange(
        scaled(index.data.f43, indexDivisor),
        scaled(index.data.f60, indexDivisor),
      ),
    indexLevel: scaled(index.data.f43, indexDivisor),
    pricePrecision,
    receivedAt,
    fetchLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function normalizeTrendRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const fields = String(row).split(",");
      return {
        time: parseShanghaiTimestamp(fields[0]),
        open: Number(fields[1]),
        close: Number(fields[2]),
        high: Number(fields[3]),
        low: Number(fields[4]),
        volume: (Number(fields[5]) || 0) * 100,
        amount: Number(fields[6]) || 0,
        average: Number(fields[7]) || null,
      };
    })
    .filter(
      (bar) =>
        bar.time &&
        [bar.open, bar.close, bar.high, bar.low].every(Number.isFinite),
    )
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

async function fetchTrends(descriptor, days = 1) {
  const startedAt = performance.now();
  const url = new URL(
    replaceTemplate(EASTMONEY_TRENDS_URL, {
      secid: descriptor.secid,
      ndays: String(days),
    }),
  );
  url.searchParams.set("ndays", String(days));
  const payload = await fetchJson(
    url.toString(),
  );
  const bars = normalizeTrendRows(payload?.data?.trends);
  const previousClose = numeric(payload?.data?.preClose);
  if (!bars.length || !Number.isFinite(previousClose) || previousClose <= 0) {
    throw new Error(`东方财富分时未返回 ${descriptor.name} 的完整序列`);
  }
  return {
    ...descriptor,
    name: String(payload.data.name || descriptor.name),
    previousClose,
    bars,
    sourceTime: bars.at(-1).time,
    fetchLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function selectTradingSession(series, date) {
  const bars = series.bars.filter((bar) => bar.time.startsWith(date));
  const previousClose = series.bars
    .filter((bar) => bar.time.slice(0, 10) < date)
    .at(-1)?.close;
  if (!bars.length || !Number.isFinite(previousClose) || previousClose <= 0) {
    throw new Error(`${series.name} 的 ${date} 分钟行情不完整`);
  }
  return {
    ...series,
    bars,
    previousClose,
    sourceTime: bars.at(-1).time,
  };
}

async function fetchBoardMap() {
  if (
    boardMapCache &&
    Date.now() - boardMapCache.savedAt < MAPPING_REFRESH_MS
  ) {
    return boardMapCache.map;
  }
  const pages = [];
  for (let page = 1; page <= 5; page += 1) {
    pages.push(
      await fetchJson(
        replaceTemplate(EASTMONEY_BOARD_LIST_URL, { page: String(page) }),
      ),
    );
  }
  const map = new Map();
  for (const payload of pages) {
    for (const item of payload?.data?.diff || []) {
      if (item?.f12 && item?.f14) map.set(String(item.f14).trim(), item.f12);
    }
  }
  if (!map.size) throw new Error("东方财富行业板块列表为空");
  boardMapCache = { savedAt: Date.now(), map };
  return map;
}

async function resolveComparisonDescriptor(latestQuote) {
  const key = `${latestQuote.market}:${latestQuote.symbol}`;
  const cached = comparisonCache.get(key);
  if (cached && Date.now() - cached.savedAt < MAPPING_REFRESH_MS) {
    return cached.payload;
  }
  if (isExchangeTradedFund(latestQuote.symbol)) {
    comparisonCache.set(key, { savedAt: Date.now(), payload: null });
    return null;
  }
  if (!latestQuote.industryName) {
    throw new Error("东方财富快照未返回个股行业名称");
  }
  const boardMap = await fetchBoardMap();
  const boardCode = boardMap.get(latestQuote.industryName);
  if (!boardCode) {
    throw new Error(`东方财富行业列表未匹配 ${latestQuote.industryName}`);
  }
  const descriptor = {
    kind: "industry",
    code: boardCode,
    secid: `90.${boardCode}`,
    name: latestQuote.industryName,
    source: "eastmoney-official-industry-board",
    fetchLatencyMs: null,
  };
  comparisonCache.set(key, { savedAt: Date.now(), payload: descriptor });
  return descriptor;
}

function normalizeDailyRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const fields = String(row).split(",");
      return {
        date: compactDate(fields[0]),
        open: Number(fields[1]),
        close: Number(fields[2]),
        high: Number(fields[3]),
        low: Number(fields[4]),
        volume: (Number(fields[5]) || 0) * 100,
        amount: Number(fields[6]) || 0,
      };
    })
    .filter(
      (bar) =>
        /^\d{8}$/.test(bar.date) &&
        [bar.open, bar.close, bar.high, bar.low].every(Number.isFinite),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
}

async function getDailyBars(code, market) {
  const key = `${market}:${code}`;
  const cached = dailyCache.get(key);
  if (cached && Date.now() - cached.savedAt < DAILY_REFRESH_MS) {
    return cached.payload;
  }
  const startedAt = performance.now();
  let bars = [];
  let officialError = null;
  try {
    const payload = await fetchJson(
      replaceTemplate(EASTMONEY_KLINE_URL, {
        secid: toEastmoneySecId(code, market),
      }),
    );
    bars = normalizeDailyRows(payload?.data?.klines);
  } catch (error) {
    officialError = error;
  }
  if (bars.length < 20) {
    const officialReason = officialError?.message || `仅返回 ${bars.length} 根`;
    throw new Error(`东方财富公开日 K 不可用（${officialReason}）`);
  }
  const result = {
    bars,
    fetchLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    source: "eastmoney-official-kline",
  };
  dailyCache.set(key, { savedAt: Date.now(), payload: result });
  return result;
}

function valueAtOrBefore(series, time, pointer) {
  const target = Date.parse(time);
  while (
    pointer.index + 1 < series.length &&
    Date.parse(series[pointer.index + 1].time) <= target
  ) {
    pointer.index += 1;
  }
  const bar = series[pointer.index];
  return bar && Date.parse(bar.time) <= target ? bar : null;
}

function enrichMinuteBars(instrument, index, comparison) {
  const indexPointer = { index: 0 };
  const comparisonPointer = { index: 0 };
  return instrument.bars.map((bar) => {
    const indexBar = valueAtOrBefore(index.bars, bar.time, indexPointer);
    const comparisonBar = comparison
      ? valueAtOrBefore(comparison.bars, bar.time, comparisonPointer)
      : null;
    return {
      ...bar,
      indexChange: indexBar
        ? percentChange(indexBar.close, index.previousClose)
        : null,
      indexLevel: indexBar?.close ?? null,
      sectorChange: comparisonBar
        ? percentChange(comparisonBar.close, comparison.previousClose)
        : null,
      sectorLevel: comparisonBar?.close ?? null,
    };
  });
}

async function refreshContext(latestQuote, state) {
  try {
    const indexDescriptor = marketIndexDescriptor(latestQuote.market);
    const instrumentDescriptor = {
      code: `${latestQuote.symbol}.${latestQuote.market}`,
      secid: toEastmoneySecId(latestQuote.symbol, latestQuote.market),
      name: latestQuote.name,
      source: "eastmoney-official-trends2",
    };
    // Eastmoney may reset concurrent HTTP/1.1 sockets. Context refresh runs in
    // the background, so sequential requests are both safer and invisible to
    // the one-second latest-price loop.
    const instrument = await fetchTrends(instrumentDescriptor);
    const index = await fetchTrends({
      ...indexDescriptor,
      source: "eastmoney-official-trends2",
    });
    const daily = await getDailyBars(latestQuote.symbol, latestQuote.market);
    let comparison = null;
    let comparisonDescriptor = null;
    let comparisonError = null;
    try {
      comparisonDescriptor = await resolveComparisonDescriptor(latestQuote);
      if (comparisonDescriptor) {
        comparison = await fetchTrends(comparisonDescriptor);
      } else if (isExchangeTradedFund(latestQuote.symbol)) {
        comparisonError =
          "免费公开接口未提供可靠的 ETF 跟踪指数映射；该辅助项已降级";
      }
    } catch (error) {
      comparisonError =
        error instanceof Error ? error.message : "行业/跟踪指数分钟线不可用";
    }
    const bars = enrichMinuteBars(instrument, index, comparison);
    const context = {
      instrumentKind: isExchangeTradedFund(latestQuote.symbol) ? "etf" : "stock",
      indexName: index.name,
      indexCode: index.code,
      indexSource: index.source,
      indexSourceTime: index.sourceTime,
      indexSeriesValid: bars.some((bar) => Number.isFinite(bar.indexChange)),
      sectorName: comparison?.name || comparisonDescriptor?.name || null,
      sectorCode: comparison?.code || comparisonDescriptor?.code || null,
      sectorSource: comparison?.source || comparisonDescriptor?.source || null,
      sectorSourceTime: comparison?.sourceTime || null,
      sectorSeriesValid: bars.some((bar) => Number.isFinite(bar.sectorChange)),
      sectorError: comparisonError,
      dailySeriesValid: daily.bars.length >= 20,
      error: null,
    };
    state.payload = {
      bars,
      dailyBars: daily.bars,
      dailySource: daily.source,
      context,
      sourceTime: instrument.sourceTime,
      fetchedAt: new Date().toISOString(),
      fetchLatencyMs:
        instrument.fetchLatencyMs +
        index.fetchLatencyMs +
        (comparison?.fetchLatencyMs || 0) +
        daily.fetchLatencyMs,
      error: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "东方财富市场上下文请求失败";
    state.payload = {
      bars: state.payload?.bars || [],
      dailyBars: state.payload?.dailyBars || [],
      dailySource: state.payload?.dailySource || null,
      context: {
        ...(state.payload?.context || {
          instrumentKind: isExchangeTradedFund(latestQuote.symbol) ? "etf" : "stock",
          indexSeriesValid: false,
          sectorSeriesValid: false,
          dailySeriesValid: false,
        }),
        error: reason,
      },
      sourceTime: state.payload?.sourceTime || null,
      fetchedAt: new Date().toISOString(),
      fetchLatencyMs: null,
      error: reason,
    };
  } finally {
    state.savedAt = Date.now();
    state.refreshing = null;
  }
}

function getContextSnapshot(latestQuote) {
  const key = `${latestQuote.market}:${latestQuote.symbol}`;
  let state = contextCache.get(key);
  if (!state) {
    state = { payload: null, savedAt: 0, refreshing: null };
    contextCache.set(key, state);
  }
  if (!state.refreshing && Date.now() - state.savedAt >= CONTEXT_REFRESH_MS) {
    state.refreshing = refreshContext(latestQuote, state);
  }
  return (
    state.payload || {
      bars: [],
      dailyBars: [],
      dailySource: null,
      context: {
        instrumentKind: isExchangeTradedFund(latestQuote.symbol) ? "etf" : "stock",
        indexSeriesValid: false,
        sectorSeriesValid: false,
        dailySeriesValid: false,
        error: "东方财富官方行情首次校验中",
      },
      sourceTime: null,
      fetchedAt: null,
      fetchLatencyMs: null,
      error: "东方财富官方分钟 K 线首次校验中",
      pending: true,
    }
  );
}

function buildValidation(latestQuote, snapshot) {
  const latestBar = snapshot.bars.at(-1);
  const minuteEpoch = snapshot.sourceTime ? Date.parse(snapshot.sourceTime) : NaN;
  const minuteAgeMs = Number.isFinite(minuteEpoch)
    ? Math.max(0, Date.now() - minuteEpoch)
    : null;
  const latestEpoch = Date.parse(latestQuote.time);
  const latestAgeMs = Number.isFinite(latestEpoch)
    ? Math.max(0, Date.now() - latestEpoch)
    : null;
  const priceDivergencePct =
    latestBar && latestQuote.price > 0
      ? Math.abs((latestQuote.price / latestBar.close - 1) * 100)
      : null;

  let status = "passed";
  let reason = "东方财富官方快照、个股/指数分钟 K 线和多日结构校验通过";
  if (snapshot.pending) {
    status = "pending";
    reason = snapshot.error;
  } else if (snapshot.error) {
    status = "unavailable";
    reason = snapshot.error;
  } else if (snapshot.context?.error) {
    status = "unavailable";
    reason = `市场上下文不可用：${snapshot.context.error}`;
  } else if (
    !snapshot.context?.indexSeriesValid ||
    !snapshot.context?.dailySeriesValid
  ) {
    status = "failed";
    reason = "指数分钟或多日日 K 不完整";
  } else if (!latestBar || minuteAgeMs === null) {
    status = "failed";
    reason = "东方财富未返回可校验的分钟 K 线";
  } else if (minuteAgeMs > MINUTE_MAX_AGE_MS) {
    status = "failed";
    reason = `东方财富分钟 K 线已超过${Math.round(MINUTE_MAX_AGE_MS / 1000)}秒`;
  } else if (latestAgeMs === null || latestAgeMs > LATEST_MAX_AGE_MS) {
    status = "failed";
    reason = `东方财富最新价已超过${Math.round(LATEST_MAX_AGE_MS / 1000)}秒`;
  } else if (
    priceDivergencePct === null ||
    priceDivergencePct > PRICE_TOLERANCE_PCT
  ) {
    status = "failed";
    reason = `东方财富快照与分钟收盘价偏差超过${PRICE_TOLERANCE_PCT}%`;
  }

  return {
    required: true,
    passed: status === "passed",
    status,
    reason,
    minuteSourceTime: snapshot.sourceTime,
    minuteFetchedAt: snapshot.fetchedAt,
    minuteAgeMs,
    latestAgeMs,
    priceDivergencePct,
    maxMinuteAgeMs: MINUTE_MAX_AGE_MS,
    maxLatestAgeMs: LATEST_MAX_AGE_MS,
    maxPriceDivergencePct: PRICE_TOLERANCE_PCT,
    context: snapshot.context,
  };
}

async function getLatestQuote(code, market) {
  const key = `${market}:${code}`;
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.payload;
  const payload = await fetchLatestQuote(code, market);
  quoteCache.set(key, { savedAt: Date.now(), payload });
  return payload;
}

async function getMarketQuote(code, market) {
  const latestQuote = await getLatestQuote(code, market);
  const snapshot = getContextSnapshot(latestQuote);
  const validation = buildValidation(latestQuote, snapshot);
  const latestMinute = snapshot.bars.at(-1);
  return {
    ok: true,
    data: {
      ...latestQuote,
      indexChange: Number.isFinite(latestMinute?.indexChange)
        ? latestMinute.indexChange
        : latestQuote.indexChange,
      indexLevel: Number.isFinite(latestMinute?.indexLevel)
        ? latestMinute.indexLevel
        : latestQuote.indexLevel,
      sectorChange: Number.isFinite(latestMinute?.sectorChange)
        ? latestMinute.sectorChange
        : null,
      sectorLevel: Number.isFinite(latestMinute?.sectorLevel)
        ? latestMinute.sectorLevel
        : null,
      sectorSource: snapshot.context?.sectorSource || null,
      minuteBars: snapshot.bars,
      dailyBars: snapshot.dailyBars,
      context: snapshot.context,
    },
    meta: {
      provider: "eastmoney-official-market-data",
      quoteSource: "eastmoney-official-snapshot",
      minuteSource: "eastmoney-official-trends2",
      minuteApi: "stock-trends2",
      dailyApi: snapshot.dailySource || "stock-kline-101",
      sourceTime: latestQuote.time,
      receivedAt: latestQuote.receivedAt,
      fetchLatencyMs: latestQuote.fetchLatencyMs,
      contextFetchLatencyMs: snapshot.fetchLatencyMs,
      realtimeLicense: "official-public-endpoint-not-exchange-direct",
      validation,
      sectorBoundary: snapshot.context?.sectorSeriesValid
        ? "行业/跟踪指数分钟序列仅作辅助显示，不参与B/S硬门槛。"
        : "行业/跟踪指数分钟序列不可用；按老师指引不阻断B/S，页面会明确降级显示。",
    },
  };
}

async function getPreviousTradingSession(code, market) {
  const latestQuote = await getLatestQuote(code, market);
  const instrumentDescriptor = {
    code: `${code}.${market}`,
    secid: toEastmoneySecId(code, market),
    name: latestQuote.name,
    source: "eastmoney-official-trends2",
  };
  const indexDescriptor = {
    ...marketIndexDescriptor(market),
    source: "eastmoney-official-trends2",
  };
  const instrumentSeries = await fetchTrends(instrumentDescriptor, 5);
  const indexSeries = await fetchTrends(indexDescriptor, 5);
  const dates = [...new Set(indexSeries.bars.map((bar) => bar.time.slice(0, 10)))];
  const tradeDate = dates.filter((date) => date < shanghaiDate()).at(-1);
  if (!tradeDate) throw new Error("东方财富未返回前一交易日分钟行情");

  const instrument = selectTradingSession(instrumentSeries, tradeDate);
  const index = selectTradingSession(indexSeries, tradeDate);
  let comparison = null;
  let comparisonDescriptor = null;
  let comparisonError = null;
  try {
    comparisonDescriptor = await resolveComparisonDescriptor(latestQuote);
    if (comparisonDescriptor) {
      comparison = selectTradingSession(
        await fetchTrends(comparisonDescriptor, 5),
        tradeDate,
      );
    } else if (isExchangeTradedFund(code)) {
      comparisonError = "免费公开接口未提供可靠的 ETF 跟踪指数映射";
    }
  } catch (error) {
    comparisonError = error instanceof Error ? error.message : "行业分钟线不可用";
  }
  const daily = await getDailyBars(code, market);
  const bars = enrichMinuteBars(instrument, index, comparison);
  return {
    ok: true,
    data: {
      symbol: code,
      market,
      name: latestQuote.name,
      price: bars.at(-1).close,
      previousClose: instrument.previousClose,
      time: bars.at(-1).time,
      tradeDate,
      minuteBars: bars,
      dailyBars: daily.bars,
      context: {
        instrumentKind: isExchangeTradedFund(code) ? "etf" : "stock",
        indexName: index.name,
        indexCode: index.code,
        indexSource: index.source,
        indexSourceTime: index.sourceTime,
        indexSeriesValid: bars.some((bar) => Number.isFinite(bar.indexChange)),
        sectorName: comparison?.name || comparisonDescriptor?.name || null,
        sectorCode: comparison?.code || comparisonDescriptor?.code || null,
        sectorSource: comparison?.source || comparisonDescriptor?.source || null,
        sectorSourceTime: comparison?.sourceTime || null,
        sectorSeriesValid: bars.some((bar) => Number.isFinite(bar.sectorChange)),
        sectorError: comparisonError,
        dailySeriesValid: daily.bars.length >= 20,
        error: null,
      },
    },
    meta: {
      provider: "eastmoney-official-market-data",
      quoteSource: "eastmoney-official-historical-minute",
      minuteSource: "eastmoney-official-trends2",
      tradeDate,
      realHistorical: true,
    },
  };
}

function allowedOrigin(request) {
  const origin = request.headers.origin || "";
  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
    ? origin
    : "http://localhost:4173";
}

function sendJson(request, response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Access-Control-Allow-Origin": allowedOrigin(request),
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": allowedOrigin(request),
    });
    response.end();
    return;
  }

  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || `${HOST}:${PORT}`}`,
  );
  if (url.pathname === "/health") {
    sendJson(request, response, 200, {
      ok: true,
      service: "intraday-compass Eastmoney official market-data bridge",
      provider: "eastmoney-official-market-data",
      latestPriceProvider: "eastmoney-official-snapshot",
      minuteProvider: "eastmoney-official-trends2",
      dailyProvider: "eastmoney-official-kline",
      contextProviders: [
        "eastmoney-official-market-index",
        "eastmoney-official-industry-board",
      ],
      apiKeyRequired: false,
      mode: "official-price-with-official-minute-validation",
      recommendedPollMs: 1000,
      bondRadarRefreshMs: BOND_RADAR_REFRESH_MS,
      contextRefreshMs: CONTEXT_REFRESH_MS,
      dailyRefreshMs: DAILY_REFRESH_MS,
      mappingRefreshMs: MAPPING_REFRESH_MS,
      validationThresholds: {
        maxMinuteAgeMs: MINUTE_MAX_AGE_MS,
        maxLatestAgeMs: LATEST_MAX_AGE_MS,
        maxPriceDivergencePct: PRICE_TOLERANCE_PCT,
      },
    });
    return;
  }
  if (url.pathname === "/bond-radar") {
    if (request.method !== "POST") {
      sendJson(request, response, 405, {
        ok: false,
        error: "method not allowed",
      });
      return;
    }
    try {
      sendJson(request, response, 200, await getBondRadarSnapshot());
    } catch (error) {
      sendJson(request, response, 502, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "bond radar refresh failed",
      });
    }
    return;
  }
  if (!["/quote", "/history"].includes(url.pathname)) {
    sendJson(request, response, 404, { ok: false, error: "not found" });
    return;
  }

  try {
    const code = normalizeCode(url.searchParams.get("symbol"));
    const market = inferMarket(code, url.searchParams.get("market"));
    sendJson(
      request,
      response,
      200,
      url.pathname === "/history"
        ? await getPreviousTradingSession(code, market)
        : await getMarketQuote(code, market),
    );
  } catch (error) {
    sendJson(request, response, 502, {
      ok: false,
      error: error instanceof Error ? error.message : "quote request failed",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Eastmoney quote bridge listening on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
