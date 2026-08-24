import { execFile } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const EASTMONEY_QUOTE =
  "https://push2his.eastmoney.com/api/qt/stock/get?invt=2&fltt=1&secid={secid}&fields=f43,f57,f58,f60,f86,f127";
const EASTMONEY_TRENDS =
  "https://push2his.eastmoney.com/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays={days}&iscr=0&secid={secid}";
const EASTMONEY_BOARD_LIST =
  "https://push2delay.eastmoney.com/api/qt/clist/get?pn={page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14";
const execFileAsync = promisify(execFile);

function replaceTemplate(template, values) {
  return Object.entries(values).reduce(
    (value, [key, replacement]) => value.replace(`{${key}}`, replacement),
    template,
  );
}

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          Connection: "close",
          Referer: "https://quote.eastmoney.com/",
          "User-Agent": "Mozilla/5.0 intraday-compass-backtest/1.0",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  try {
    const parsed = new URL(url);
    const addresses = await resolve4(parsed.hostname);
    for (const address of addresses) {
      try {
        const executable = process.platform === "win32" ? "curl.exe" : "curl";
        const { stdout } = await execFileAsync(
          executable,
          [
            "--http1.1",
            "--resolve",
            `${parsed.hostname}:443:${address}`,
            "--silent",
            "--show-error",
            url,
          ],
          { maxBuffer: 8 * 1024 * 1024 },
        );
        return JSON.parse(stdout);
      } catch {
        // Try the next authoritative DNS address.
      }
    }
  } catch {
    // Preserve the original fetch error below.
  }
  const detail = lastError?.cause?.message || lastError?.message || String(lastError);
  throw new Error(`行情请求失败 ${url}: ${detail}`, { cause: lastError });
}

function normalizeCode(value) {
  const code = String(value || "").replace(/\D/g, "");
  if (code.length !== 6) throw new Error("请输入 6 位 A 股代码");
  return code;
}

function inferMarket(code) {
  if (/^(92|43|81|82|83|87|88)/.test(code)) return "BJ";
  if (/^[569]/.test(code)) return "SH";
  return "SZ";
}

function secid(code, market) {
  return `${market === "SH" ? 1 : 0}.${code}`;
}

function indexDescriptor(market) {
  if (market === "SZ") return { name: "深证成指", secid: "0.399001" };
  if (market === "BJ") return { name: "北证50", secid: "0.899050" };
  return { name: "上证指数", secid: "1.000001" };
}

function normalizeTrends(payload) {
  return (payload?.data?.trends || [])
    .map((row) => {
      const fields = String(row).split(",");
      return {
        time: fields[0],
        open: Number(fields[1]),
        close: Number(fields[2]),
        high: Number(fields[3]),
        low: Number(fields[4]),
        volume: (Number(fields[5]) || 0) * 100,
        amount: Number(fields[6]) || 0,
      };
    })
    .filter(
      (row) =>
        row.time &&
        [row.open, row.close, row.high, row.low].every(Number.isFinite),
    );
}

async function loadEvaluateSignal() {
  const assetDirectory = path.join(PROJECT_ROOT, "dist", "client", "assets");
  const asset = (await readdir(assetDirectory)).find((name) =>
    /^t0Model-.*\.js$/.test(name),
  );
  if (!asset) throw new Error("请先运行 pnpm build 生成回测模型资产");
  const model = await import(pathToFileURL(path.join(assetDirectory, asset)));
  if (typeof model.r !== "function") {
    throw new Error("构建资产未导出 evaluateSignal");
  }
  return model.r;
}

async function resolveBoard(industryName) {
  for (let page = 1; page <= 5; page += 1) {
    const payload = await fetchJson(
      replaceTemplate(EASTMONEY_BOARD_LIST, { page: String(page) }),
    );
    const match = (payload?.data?.diff || []).find(
      (item) => String(item?.f14 || "").trim() === industryName,
    );
    if (match?.f12) {
      return { name: industryName, code: String(match.f12), secid: `90.${match.f12}` };
    }
  }
  throw new Error(`未找到行业板块：${industryName}`);
}

async function fetchSeries(descriptor, days) {
  const url = replaceTemplate(EASTMONEY_TRENDS, {
    days: String(days),
    secid: descriptor.secid,
  });
  const payload = await fetchJson(url);
  const rows = normalizeTrends(payload);
  if (!rows.length) throw new Error(`${descriptor.name} 未返回分钟数据`);
  return { ...descriptor, rows, sourceUrl: url };
}

function dayBaselines(rows) {
  const values = new Map();
  for (const row of rows) {
    const date = row.time.slice(0, 10);
    if (!values.has(date)) values.set(date, row.close);
  }
  return values;
}

function alignRows(stock, sector, index) {
  const sectorMap = new Map(sector.rows.map((row) => [row.time, row]));
  const indexMap = new Map(index.rows.map((row) => [row.time, row]));
  const sectorBase = dayBaselines(sector.rows);
  const indexBase = dayBaselines(index.rows);
  return stock.rows.flatMap((row) => {
    const sectorRow = sectorMap.get(row.time);
    const indexRow = indexMap.get(row.time);
    if (!sectorRow || !indexRow) return [];
    const date = row.time.slice(0, 10);
    const sectorStart = sectorBase.get(date);
    const indexStart = indexBase.get(date);
    if (!sectorStart || !indexStart) return [];
    return [
      {
        time: row.time,
        price: row.close,
        open: row.open,
        high: row.high,
        low: row.low,
        volume: Math.max(1, row.volume),
        amount: row.amount,
        sectorChange: (sectorRow.close / sectorStart - 1) * 100,
        indexChange: (indexRow.close / indexStart - 1) * 100,
        indexLevel: indexRow.close,
      },
    ];
  });
}

function sessionKey(time) {
  return time.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "single-session";
}

function minuteOfDay(time) {
  const match = time.match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function canEvaluate(time) {
  const minute = minuteOfDay(time);
  return (
    minute === null ||
    (minute >= 585 && minute < 690) ||
    (minute >= 780 && minute < 897)
  );
}

function runBacktest(rows, evaluateSignal, costBps, allocationPercent) {
  const cycles = [];
  const modeCounts = { positive: 0, reverse: 0, range: 0, avoid: 0 };
  let sessionRows = [];
  let currentSession = "";
  let previousState = "blocked";
  let phase = "neutral";
  let pending = null;
  let openCycle = null;
  let incompleteCycles = 0;
  let bSignals = 0;
  let sSignals = 0;

  rows.forEach((row, rowIndex) => {
    const nextSession = sessionKey(row.time);
    if (currentSession && nextSession !== currentSession) {
      if (openCycle || pending) incompleteCycles += 1;
      sessionRows = [];
      previousState = "blocked";
      phase = "neutral";
      pending = null;
      openCycle = null;
    }
    currentSession = nextSession;

    if (pending) {
      if (!openCycle) {
        openCycle = {
          side: pending.side,
          signalTime: pending.signalTime,
          entryTime: row.time,
          entryPrice: row.price,
          startIndex: rowIndex,
          adversePrice: row.price,
        };
        phase = pending.side === "B" ? "boughtForT" : "soldBase";
      } else if (openCycle.side !== pending.side) {
        const positive = openCycle.side === "B";
        const grossSpread = positive
          ? ((row.price - openCycle.entryPrice) / openCycle.entryPrice) * 100
          : ((openCycle.entryPrice - row.price) / openCycle.entryPrice) * 100;
        const netSpread = grossSpread - costBps / 100;
        const adverse = positive
          ? ((openCycle.adversePrice - openCycle.entryPrice) /
              openCycle.entryPrice) *
            100
          : ((openCycle.entryPrice - openCycle.adversePrice) /
              openCycle.entryPrice) *
            100;
        cycles.push({
          id: cycles.length + 1,
          mode: positive ? "positive" : "reverse",
          signalTime: openCycle.signalTime,
          entryTime: openCycle.entryTime,
          exitTime: row.time,
          entryPrice: openCycle.entryPrice,
          exitPrice: row.price,
          grossSpread,
          netSpread,
          contribution: netSpread * (allocationPercent / 100),
          adverse,
          holdingBars: rowIndex - openCycle.startIndex,
          won: netSpread > 0,
        });
        openCycle = null;
        phase = "neutral";
      }
      pending = null;
      previousState = "blocked";
    }

    if (openCycle) {
      openCycle.adversePrice =
        openCycle.side === "B"
          ? Math.min(openCycle.adversePrice, row.price)
          : Math.max(openCycle.adversePrice, row.price);
    }

    sessionRows.push(row);
    if (sessionRows.length < 16 || !canEvaluate(row.time) || pending) return;
    const reading = evaluateSignal(sessionRows, previousState, phase);
    modeCounts[reading.tMode] += 1;
    if (reading.state !== previousState && reading.state === "confirmB") {
      bSignals += 1;
      pending = { side: "B", signalTime: row.time };
    }
    if (reading.state !== previousState && reading.state === "confirmS") {
      sSignals += 1;
      pending = { side: "S", signalTime: row.time };
    }
    previousState = reading.state;
  });
  if (openCycle || pending) incompleteCycles += 1;

  let cumulativeContribution = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equity = [0];
  for (const cycle of cycles) {
    cumulativeContribution += cycle.contribution;
    peak = Math.max(peak, cumulativeContribution);
    maxDrawdown = Math.min(maxDrawdown, cumulativeContribution - peak);
    equity.push(cumulativeContribution);
  }
  const wins = cycles.filter((cycle) => cycle.won).length;
  return {
    cycles,
    wins,
    losses: cycles.length - wins,
    winRate: cycles.length ? (wins / cycles.length) * 100 : 0,
    averageNetSpread: cycles.length
      ? cycles.reduce((sum, cycle) => sum + cycle.netSpread, 0) / cycles.length
      : 0,
    cumulativeContribution,
    maxDrawdown,
    averageHoldingBars: cycles.length
      ? cycles.reduce((sum, cycle) => sum + cycle.holdingBars, 0) /
        cycles.length
      : 0,
    bSignals,
    sSignals,
    incompleteCycles,
    modeCounts,
    equity,
  };
}

function parseArgs(argv) {
  const values = {
    code: normalizeCode(argv[2]),
    days: 5,
    costBps: 15,
    allocationPercent: 33,
  };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--days") values.days = Number(argv[++index]);
    if (argv[index] === "--cost-bps") values.costBps = Number(argv[++index]);
    if (argv[index] === "--allocation") {
      values.allocationPercent = Number(argv[++index]);
    }
  }
  values.days = Math.max(1, Math.min(5, Math.floor(values.days)));
  values.costBps = Math.max(0, values.costBps);
  values.allocationPercent = Math.max(
    1,
    Math.min(100, values.allocationPercent),
  );
  return values;
}

async function main() {
  const settings = parseArgs(process.argv);
  const market = inferMarket(settings.code);
  const stockSecid = secid(settings.code, market);
  const quoteUrl = replaceTemplate(EASTMONEY_QUOTE, { secid: stockSecid });
  const quote = await fetchJson(quoteUrl);
  const name = String(quote?.data?.f58 || settings.code);
  const industryName = String(quote?.data?.f127 || "").trim();
  if (!industryName || industryName === "-") {
    throw new Error("东方财富快照未返回行业名称");
  }
  const board = await resolveBoard(industryName);
  const marketIndex = indexDescriptor(market);
  const stock = await fetchSeries(
    { name, secid: stockSecid },
    settings.days,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  const sector = await fetchSeries(board, settings.days);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const index = await fetchSeries(marketIndex, settings.days);
  const rows = alignRows(stock, sector, index);
  if (rows.length < 16) throw new Error("对齐后分钟数据不足");
  const evaluateSignal = await loadEvaluateSignal();
  const result = runBacktest(
    rows,
    evaluateSignal,
    settings.costBps,
    settings.allocationPercent,
  );
  const tradingDays = [...new Set(rows.map((row) => row.time.slice(0, 10)))];
  const shortDate = (value) => value.slice(5).replace("-", "/");
  const watchPayload = {
    code: settings.code,
    name,
    start_date: shortDate(tradingDays[0]),
    end_date: shortDate(tradingDays.at(-1)),
    trading_days: tradingDays.length,
    rows: rows.length,
    cost_bps: settings.costBps,
    allocation_percent: settings.allocationPercent,
    cycles: result.cycles.length,
    wins: result.wins,
    losses: result.losses,
    b_signals: result.bSignals,
    s_signals: result.sSignals,
    incomplete_cycles: result.incompleteCycles,
    win_rate: result.winRate,
    average_net_spread: result.averageNetSpread,
    cumulative_contribution: result.cumulativeContribution,
    max_drawdown: result.maxDrawdown,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    source: "东方财富官方公开行情接口",
    security: { code: settings.code, market, name, industry: board.name },
    period: {
      start: rows[0].time,
      end: rows.at(-1).time,
      tradingDays,
      rows: rows.length,
    },
    assumptions: {
      execution: "信号在当前分钟收盘后生成，按下一分钟行情成交",
      costBps: settings.costBps,
      allocationPercent: settings.allocationPercent,
      lookahead: false,
      waveFilter: false,
    },
    result,
    watchPayload,
    sources: {
      quote: quoteUrl,
      stockMinutes: stock.sourceUrl,
      sectorMinutes: sector.sourceUrl,
      indexMinutes: index.sourceUrl,
    },
  };
  const outputDirectory = path.join(
    PROJECT_ROOT,
    "data",
    "backtests",
    settings.code,
  );
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `${tradingDays[0]}_${tradingDays.at(-1)}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const watchOutputPath = outputPath.replace(/\.json$/, ".watch.json");
  await writeFile(
    watchOutputPath,
    `${JSON.stringify(watchPayload, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        outputPath,
        watchOutputPath,
        security: report.security,
        period: report.period,
        assumptions: report.assumptions,
        summary: {
          cycles: result.cycles.length,
          wins: result.wins,
          losses: result.losses,
          winRate: result.winRate,
          averageNetSpread: result.averageNetSpread,
          cumulativeContribution: result.cumulativeContribution,
          maxDrawdown: result.maxDrawdown,
          averageHoldingBars: result.averageHoldingBars,
          bSignals: result.bSignals,
          sSignals: result.sSignals,
          incompleteCycles: result.incompleteCycles,
          modeCounts: result.modeCounts,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
