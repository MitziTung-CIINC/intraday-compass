#!/usr/bin/env node

import http from "node:http";

const HOST = process.env.T0_QUOTE_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.T0_QUOTE_BRIDGE_PORT || 8765);
const CACHE_TTL_MS = 600;
const REQUEST_TIMEOUT_MS = 3000;
const quoteCache = new Map();
const lastCumulativeVolume = new Map();

function numberAt(fields, index) {
  const value = Number(fields[index]);
  return Number.isFinite(value) ? value : null;
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

function toTencentSymbol(code, market) {
  return `${market.toLowerCase()}${code}`;
}

function parseTencentTimestamp(value, fallback) {
  const text = String(value || "");
  if (!/^\d{14}$/.test(text)) return fallback;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`;
}

function parsePayload(text) {
  const records = new Map();
  for (const match of text.matchAll(/v_([^=]+)="([^"]*)";/g)) {
    records.set(match[1], match[2].split("~"));
  }
  return records;
}

function normalizeVolume(fields) {
  const raw = numberAt(fields, 6);
  if (raw === null) return 0;
  const price = numberAt(fields, 3);
  const turnoverRate = numberAt(fields, 38);
  const circulatingValueYi = numberAt(fields, 44);
  if (price && turnoverRate && circulatingValueYi) {
    const expected = ((circulatingValueYi * 100_000_000) / price) * (turnoverRate / 100);
    return Math.abs(raw - expected) <= Math.abs(raw * 100 - expected) ? raw : raw * 100;
  }
  return raw * 100;
}

function parseAmount(fields) {
  const precise = String(fields[35] || "").split("/");
  if (precise.length >= 3 && Number.isFinite(Number(precise[2]))) {
    return Number(precise[2]);
  }
  const tenThousands = numberAt(fields, 37);
  return tenThousands === null ? 0 : tenThousands * 10_000;
}

async function fetchQuote(code, market) {
  const stockSymbol = toTencentSymbol(code, market);
  const startedAt = performance.now();
  const response = await fetch(
    `https://qt.gtimg.cn/q=${stockSymbol},sh000001`,
    {
      headers: {
        Referer: "https://finance.qq.com/",
        "User-Agent": "Mozilla/5.0 intraday-compass/1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`Tencent quote HTTP ${response.status}`);
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const records = parsePayload(text);
  const fields = records.get(stockSymbol);
  if (!fields || fields.length < 45) {
    throw new Error(`Tencent quote returned no data for ${code}`);
  }

  const indexFields = records.get("sh000001");
  const cumulativeVolume = normalizeVolume(fields);
  const previousVolume = lastCumulativeVolume.get(code);
  const incrementalVolume = previousVolume === undefined
    ? 0
    : Math.max(0, cumulativeVolume - previousVolume);
  lastCumulativeVolume.set(code, cumulativeVolume);

  const receivedAt = new Date().toISOString();
  const sourceTime = parseTencentTimestamp(fields[30], receivedAt);
  const indexChange = indexFields ? numberAt(indexFields, 32) : null;
  return {
    ok: true,
    data: {
      symbol: code,
      market,
      name: fields[1] || code,
      price: numberAt(fields, 3) || 0,
      previousClose: numberAt(fields, 4) || 0,
      volume: incrementalVolume,
      cumulativeVolume,
      amount: parseAmount(fields),
      time: sourceTime,
      source: "tencent",
      indexName: indexFields?.[1] || "上证指数",
      indexChange,
      indexLevel: indexFields ? numberAt(indexFields, 3) : null,
      sectorChange: indexChange,
      sectorSource: "market-neutral-proxy",
    },
    meta: {
      provider: "tencent-public-quote",
      quoteSource: "tencent",
      sourceTime,
      receivedAt,
      fetchLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      realtimeLicense: "not-verified",
      sectorBoundary: "No stable intraday industry field; index change is used as a neutral signal-model proxy.",
    },
  };
}

async function getQuote(code, market) {
  const key = `${market}:${code}`;
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.payload;
  const payload = await fetchQuote(code, market);
  quoteCache.set(key, { savedAt: Date.now(), payload });
  return payload;
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": allowedOrigin(request),
    });
    response.end();
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname === "/health") {
    sendJson(request, response, 200, {
      ok: true,
      service: "intraday-compass realtime quote bridge",
      provider: "tencent-public-quote",
      mode: "single-symbol-low-latency",
      recommendedPollMs: 1000,
    });
    return;
  }
  if (url.pathname !== "/quote") {
    sendJson(request, response, 404, { ok: false, error: "not found" });
    return;
  }

  try {
    const code = normalizeCode(url.searchParams.get("symbol"));
    const market = inferMarket(code, url.searchParams.get("market"));
    sendJson(request, response, 200, await getQuote(code, market));
  } catch (error) {
    sendJson(request, response, 502, {
      ok: false,
      error: error instanceof Error ? error.message : "quote request failed",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Quote bridge listening on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
