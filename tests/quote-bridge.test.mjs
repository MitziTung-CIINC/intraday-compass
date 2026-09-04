import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { assessReplaySession, replayDate } from "../tools/history-session.mjs";

function shanghaiNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function shanghaiDay(offset = 0) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
}

function snapshot({
  code,
  name,
  price,
  previousClose,
  industry = "-",
  change = 0,
  precision = 2,
}) {
  return {
    data: {
      f43: Math.round(price * 10 ** precision),
      f47: 1000,
      f48: 12_345_600,
      f57: code,
      f58: name,
      f59: precision,
      f60: Math.round(previousClose * 10 ** precision),
      f86: Math.floor(Date.now() / 1000),
      f127: industry,
      f170: Math.round(change * 100),
    },
  };
}

function trendPayload(name, previousClose, time, close) {
  return {
    data: {
      name,
      preClose: previousClose,
      trends: [
        `${time},${close - 1},${close},${close + 1},${close - 2},2400,3600000,${close - 0.2}`,
      ],
    },
  };
}

function historicalTrendPayload(name, earlierClose, replayCloses, currentClose) {
  const earlier = shanghaiDay(-2);
  const replay = shanghaiDay(-1);
  const current = shanghaiDay();
  const row = (date, time, close) =>
    `${date} ${time},${close},${close},${close},${close},100,${close * 10000},${close}`;
  return {
    data: {
      name,
      preClose: replayCloses.at(-1),
      trends: [
        row(earlier, "15:00", earlierClose),
        ...replayCloses.map((close, index) =>
          row(replay, index === 0 ? "09:30" : "15:00", close),
        ),
        row(current, "09:30", currentClose),
      ],
    },
  };
}

function singleSessionHistoricalTrendPayload(name, previousClose, replayCloses) {
  const replay = shanghaiDay(-1);
  const row = (time, close) =>
    `${replay} ${time},${close},${close},${close},${close},100,${close * 10000},${close}`;
  return {
    data: {
      name,
      preClose: previousClose,
      trends: replayCloses.map((close, index) =>
        row(index === 0 ? "09:30" : "15:00", close),
      ),
    },
  };
}

function dailyPayload(basePrice) {
  return {
    data: {
      klines: Array.from({ length: 25 }, (_, index) => {
        const date = new Date(Date.now() - (25 - index) * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const close = basePrice + index * basePrice * 0.001;
        return `${date},${close * 0.997},${close},${close * 1.004},${close * 0.994},${100000 + index * 100},${close * 100000}`;
      }),
    },
  };
}

function sendJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

test("replay date selection never substitutes yesterday for today", () => {
  const series = { bars: [{ time: "2026-09-03T15:00:00+08:00" }] };
  assert.throws(() => replayDate(series, "today", "2026-09-04"), /不会替换/);
  assert.equal(replayDate(series, "previous", "2026-09-04"), "2026-09-03");
  assert.throws(() => replayDate(series, "other", "2026-09-04"), /仅支持/);
});

test("replay coverage excludes unfinished minutes and identifies gaps without padding", () => {
  const date = "2026-09-04";
  const rows = Array.from({ length: 241 }, (_, i) => {
    const minute = i <= 120 ? 570 + i : 780 + i - 120;
    const time = `${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`;
    return { time, open: 10, close: 10, high: 10, low: 10, volume: 0 };
  });
  const full = assessReplaySession(rows, date, Date.parse(`${date}T15:02:00+08:00`));
  assert.equal(full.coverage.complete, true);
  assert.equal(full.coverage.barCount, 241);
  const partial = assessReplaySession(rows, date, Date.parse(`${date}T09:35:35+08:00`));
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.bars.at(-1).time.slice(11, 16), "09:34");
  assert.equal(partial.coverage.missingMinutes, 0);
  const missing = assessReplaySession(rows.filter((_, i) => i !== 5), date, Date.parse(`${date}T15:02:00+08:00`));
  assert.equal(missing.coverage.complete, false);
  assert.equal(missing.coverage.missingMinutes, 1);
  assert.equal(missing.bars.length, 240);
  assert.throws(() => assessReplaySession([...rows, rows[1]], date, Date.parse(`${date}T15:02:00+08:00`)), /重复/);
  assert.throws(() => assessReplaySession(rows, "2026-09-03"), /日期不一致/);
});

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function bridgeEnvironment(bridgePort, upstreamPort, extra = {}) {
  return {
    ...process.env,
    T0_QUOTE_BRIDGE_PORT: String(bridgePort),
    EASTMONEY_QUOTE_URL: `http://127.0.0.1:${upstreamPort}/quote?secid={secid}`,
    EASTMONEY_TRENDS_URL: `http://127.0.0.1:${upstreamPort}/trends?secid={secid}`,
    EASTMONEY_KLINE_URL: `http://127.0.0.1:${upstreamPort}/kline?secid={secid}`,
    EASTMONEY_BOARD_LIST_URL: `http://127.0.0.1:${upstreamPort}/boards?page={page}`,
    EASTMONEY_CONTEXT_REFRESH_MS: "60000",
    ...extra,
  };
}

async function waitForBridge(bridgePort) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return response.json();
    } catch {
      // Process startup is asynchronous.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("quote bridge did not become healthy");
}

async function waitForValidatedQuote(bridgePort, code, market) {
  const url = `http://127.0.0.1:${bridgePort}/quote?symbol=${code}&market=${market}`;
  let quote;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    quote = await (await fetch(url)).json();
    if (quote.meta?.validation?.status !== "pending") return quote;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return quote;
}

test("uses Eastmoney official snapshot, minute, industry and daily data", async (context) => {
  const bridgePort = 18000 + (process.pid % 400);
  const upstreamPort = bridgePort + 1000;
  const time = shanghaiNow();
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${upstreamPort}`);
    if (url.pathname === "/quote") {
      const secid = url.searchParams.get("secid");
      sendJson(
        response,
        secid === "1.600519"
          ? snapshot({
              code: "600519",
              name: "贵州茅台",
              price: 1501,
              previousClose: 1490,
              industry: "白酒Ⅱ",
              change: 0.74,
            })
          : snapshot({
              code: "000001",
              name: "上证指数",
              price: 3600,
              previousClose: 3595,
              change: 0.14,
            }),
      );
      return;
    }
    if (url.pathname === "/trends") {
      const secid = url.searchParams.get("secid");
      if (secid === "1.600519") {
        sendJson(response, trendPayload("贵州茅台", 1490, time, 1500));
      } else if (secid === "90.BK1277") {
        sendJson(response, trendPayload("白酒Ⅱ", 5180, time, 5210));
      } else {
        sendJson(response, trendPayload("上证指数", 3595, time, 3600));
      }
      return;
    }
    if (url.pathname === "/kline") {
      sendJson(response, dailyPayload(1460));
      return;
    }
    if (url.pathname === "/boards") {
      sendJson(response, {
        data: {
          diff:
            url.searchParams.get("page") === "1"
              ? [{ f12: "BK1277", f14: "白酒Ⅱ" }]
              : [],
        },
      });
      return;
    }
    assert.fail(`unexpected upstream path ${url.pathname}`);
  });
  await listen(upstream, upstreamPort);
  context.after(() => upstream.close());

  const child = spawn(process.execPath, ["tools/realtime_quote_bridge.mjs"], {
    env: bridgeEnvironment(bridgePort, upstreamPort),
    stdio: "ignore",
  });
  context.after(() => child.kill());

  const health = await waitForBridge(bridgePort);
  assert.equal(health.provider, "eastmoney-official-market-data");
  assert.equal(health.latestPriceProvider, "eastmoney-official-snapshot");
  assert.equal(health.minuteProvider, "eastmoney-official-trends2");
  assert.equal(health.apiKeyRequired, false);

  const quote = await waitForValidatedQuote(bridgePort, "600519", "SH");
  assert.equal(quote.ok, true, JSON.stringify(quote));
  assert.equal(quote.data.price, 1501);
  assert.equal(quote.data.previousClose, 1490);
  assert.equal(quote.data.minuteBars.length, 1);
  assert.equal(quote.data.minuteBars[0].close, 1500);
  assert.ok(Number.isFinite(quote.data.minuteBars[0].sectorChange));
  assert.ok(Number.isFinite(quote.data.minuteBars[0].indexChange));
  assert.equal(quote.data.dailyBars.length, 25);
  assert.equal(quote.data.context.sectorName, "白酒Ⅱ");
  assert.equal(quote.data.context.sectorSeriesValid, true);
  assert.equal(quote.meta.quoteSource, "eastmoney-official-snapshot");
  assert.equal(quote.meta.minuteSource, "eastmoney-official-trends2");
  assert.equal(quote.meta.validation.passed, true);
  assert.ok(quote.meta.validation.priceDivergencePct < 1);
});

test("an unavailable sector series is reported but does not freeze official quote validation", async (context) => {
  const bridgePort = 18500 + (process.pid % 200);
  const upstreamPort = bridgePort + 1000;
  const time = shanghaiNow();
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${upstreamPort}`);
    if (url.pathname === "/quote") {
      const secid = url.searchParams.get("secid");
      sendJson(
        response,
        secid === "1.600000"
          ? snapshot({
              code: "600000",
              name: "浦发银行",
              price: 10.01,
              previousClose: 10,
              industry: "未映射行业",
              change: 0.1,
            })
          : snapshot({
              code: "000001",
              name: "上证指数",
              price: 3600,
              previousClose: 3595,
              change: 0.14,
            }),
      );
      return;
    }
    if (url.pathname === "/trends") {
      const secid = url.searchParams.get("secid");
      sendJson(
        response,
        secid === "1.600000"
          ? trendPayload("浦发银行", 10, time, 10.01)
          : trendPayload("上证指数", 3595, time, 3600),
      );
      return;
    }
    if (url.pathname === "/kline") {
      sendJson(response, dailyPayload(9.8));
      return;
    }
    if (url.pathname === "/boards") {
      sendJson(response, { data: { diff: [] } });
      return;
    }
    assert.fail(`unexpected upstream path ${url.pathname}`);
  });
  await listen(upstream, upstreamPort);
  context.after(() => upstream.close());

  const child = spawn(process.execPath, ["tools/realtime_quote_bridge.mjs"], {
    env: bridgeEnvironment(bridgePort, upstreamPort),
    stdio: "ignore",
  });
  context.after(() => child.kill());

  await waitForBridge(bridgePort);
  const quote = await waitForValidatedQuote(bridgePort, "600000", "SH");
  assert.equal(quote.ok, true, JSON.stringify(quote));
  assert.equal(quote.data.context.indexSeriesValid, true);
  assert.equal(quote.data.context.dailySeriesValid, true);
  assert.equal(quote.data.context.sectorSeriesValid, false);
  assert.equal(quote.meta.validation.passed, true);
  assert.match(quote.meta.sectorBoundary, /不阻断B\/S/);
});

test("tracks an ETF with free Eastmoney quote, minute and daily data", async (context) => {
  const bridgePort = 19000 + (process.pid % 300);
  const upstreamPort = bridgePort + 1000;
  const time = shanghaiNow();
  const upstream = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${upstreamPort}`);
    if (url.pathname === "/quote") {
      const secid = url.searchParams.get("secid");
      sendJson(
        response,
        secid === "1.510300"
          ? snapshot({
              code: "510300",
              name: "沪深300ETF",
              price: 4.2,
              previousClose: 4.18,
              change: 0.48,
              precision: 3,
            })
          : snapshot({
              code: "000001",
              name: "上证指数",
              price: 3600,
              previousClose: 3595,
              change: 0.14,
            }),
      );
      return;
    }
    if (url.pathname === "/trends") {
      const secid = url.searchParams.get("secid");
      if (secid === "1.510300") {
        sendJson(response, trendPayload("沪深300ETF", 4.18, time, 4.2));
      } else {
        sendJson(response, trendPayload("上证指数", 3595, time, 3600));
      }
      return;
    }
    if (url.pathname === "/kline") {
      sendJson(response, dailyPayload(4.05));
      return;
    }
    if (url.pathname === "/boards") {
      sendJson(response, { data: { diff: [] } });
      return;
    }
    assert.fail(`unexpected upstream path ${url.pathname}`);
  });
  await listen(upstream, upstreamPort);
  context.after(() => upstream.close());

  const child = spawn(process.execPath, ["tools/realtime_quote_bridge.mjs"], {
    env: bridgeEnvironment(bridgePort, upstreamPort),
    stdio: "ignore",
  });
  context.after(() => child.kill());

  await waitForBridge(bridgePort);
  const quote = await waitForValidatedQuote(bridgePort, "510300", "SH");
  assert.equal(quote.ok, true, JSON.stringify(quote));
  assert.equal(quote.meta.validation.passed, true);
  assert.equal(quote.data.context.instrumentKind, "etf");
  assert.equal(quote.data.context.sectorName, null);
  assert.equal(quote.data.context.sectorSource, null);
  assert.equal(quote.data.context.sectorSeriesValid, false);
  assert.match(quote.data.context.sectorError, /免费公开接口/);
  assert.equal(quote.data.dailyBars.length, 25);
  assert.equal(quote.meta.dailyApi, "eastmoney-official-kline");
  assert.equal(quote.meta.quoteSource, "eastmoney-official-snapshot");
});

test("history endpoint returns only the previous trading session from real minute rows", async (context) => {
  const bridgePort = 19500 + (process.pid % 200);
  const upstreamPort = bridgePort + 1000;
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${upstreamPort}`);
    if (url.pathname === "/quote") {
      const secid = url.searchParams.get("secid");
      sendJson(
        response,
        secid === "1.600519"
          ? snapshot({
              code: "600519",
              name: "贵州茅台",
              price: 1504,
              previousClose: 1502,
              industry: "白酒Ⅱ",
            })
          : snapshot({
              code: "000001",
              name: "上证指数",
              price: 3602,
              previousClose: 3600,
            }),
      );
      return;
    }
    if (url.pathname === "/trends") {
      assert.equal(url.searchParams.get("ndays"), "5");
      const secid = url.searchParams.get("secid");
      if (secid === "1.600519") {
        sendJson(
          response,
          singleSessionHistoricalTrendPayload("贵州茅台", 1490, [1495, 1502]),
        );
      } else if (secid === "90.BK1277") {
        sendJson(response, historicalTrendPayload("白酒Ⅱ", 5100, [5120, 5140], 5150));
      } else {
        sendJson(response, historicalTrendPayload("上证指数", 3580, [3590, 3600], 3602));
      }
      return;
    }
    if (url.pathname === "/kline") {
      sendJson(response, { data: { klines: [] } });
      return;
    }
    if (url.pathname === "/boards") {
      sendJson(response, {
        data: {
          diff:
            url.searchParams.get("page") === "1"
              ? [{ f12: "BK1277", f14: "白酒Ⅱ" }]
              : [],
        },
      });
      return;
    }
    assert.fail(`unexpected upstream path ${url.pathname}`);
  });
  await listen(upstream, upstreamPort);
  context.after(() => upstream.close());

  const child = spawn(process.execPath, ["tools/realtime_quote_bridge.mjs"], {
    env: bridgeEnvironment(bridgePort, upstreamPort),
    stdio: "ignore",
  });
  context.after(() => child.kill());
  await waitForBridge(bridgePort);

  const history = await (
    await fetch(
      `http://127.0.0.1:${bridgePort}/history?symbol=600519&market=SH`,
    )
  ).json();
  assert.equal(history.ok, true, JSON.stringify(history));
  assert.equal(history.meta.realHistorical, true);
  assert.equal(history.data.tradeDate, shanghaiDay(-1));
  assert.equal(history.data.previousClose, 1490);
  assert.deepEqual(
    history.data.minuteBars.map((bar) => bar.close),
    [1495, 1502],
  );
  assert.ok(history.data.minuteBars.every((bar) => Number.isFinite(bar.indexChange)));
  assert.ok(history.data.minuteBars.every((bar) => Number.isFinite(bar.sectorChange)));
  assert.deepEqual(history.data.dailyBars, []);
  assert.equal(history.data.context.dailySeriesValid, false);
  assert.match(history.data.context.dailyError, /公开日 K 不可用/);
});

test("today replay works through the local /quote alias, rejects stale days and excludes future daily bars", async (context) => {
  const bridgePort = 22000 + (process.pid % 200);
  const upstreamPort = bridgePort + 1000;
  let stale = false;
  const date = shanghaiDay();
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${upstreamPort}`);
    const instrument = url.searchParams.get("secid") === "0.000938";
    if (url.pathname === "/quote") {
      return sendJson(response, snapshot({ code: instrument ? "000938" : "399001", name: instrument ? "紫光股份" : "深证成指", price: 35, previousClose: 38 }));
    }
    if (url.pathname === "/trends") {
      assert.equal(url.searchParams.get("ndays"), "1");
      const day = stale ? shanghaiDay(-1) : date;
      return sendJson(response, { data: { name: instrument ? "紫光股份" : "深证成指", preClose: 38,
        trends: ["09:30", "09:31", "09:32"].map((minute) => `${day} ${minute},35,35,35,35,100,350000,35`) } });
    }
    if (url.pathname === "/kline") {
      const daily = dailyPayload(30);
      daily.data.klines.push(`${date},999,999,999,999,999,999`);
      return sendJson(response, daily);
    }
    if (url.pathname === "/boards") return sendJson(response, { data: { diff: [] } });
    assert.fail(`unexpected upstream path ${url.pathname}`);
  });
  await listen(upstream, upstreamPort);
  context.after(() => upstream.close());
  const child = spawn(process.execPath, ["tools/realtime_quote_bridge.mjs"], { env: bridgeEnvironment(bridgePort, upstreamPort), stdio: "ignore" });
  context.after(() => child.kill());
  await waitForBridge(bridgePort);
  const url = `http://127.0.0.1:${bridgePort}/quote?symbol=000938&market=SZ&session=today`;
  const response = await fetch(url);
  const history = await response.json();
  if (Date.now() < Date.parse(`${date}T09:32:00+08:00`)) {
    assert.equal(response.status, 502);
    assert.match(history.error, /不足2根/);
  } else {
    assert.equal(response.status, 200, JSON.stringify(history));
    assert.equal(history.meta.session, "today");
    assert.equal(history.meta.realHistorical, true);
    assert.equal(history.data.tradeDate, date);
    assert.equal(history.data.previousClose, 38);
    assert.equal(history.data.coverage.complete, false);
    assert.ok(history.data.minuteBars.every((bar) => bar.time.startsWith(date)));
    assert.ok(history.data.dailyBars.every((bar) => bar.date < date.replaceAll("-", "")));
    assert.ok(history.data.dailyBars.every((bar) => bar.close !== 999));
  }
  stale = true;
  const rejected = await (await fetch(url)).json();
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /不会替换/);
  assert.equal((await fetch(url.replace("session=today", "session=invalid"))).status, 400);
});
