"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  evaluateSignal,
  T_MODE_META,
  type CyclePhase,
  type SignalState,
  type TMode,
  type Tick,
} from "../t0Model";

type BacktestCycle = {
  id: number;
  mode: "positive" | "reverse";
  signalTime: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  grossSpread: number;
  netSpread: number;
  contribution: number;
  adverse: number;
  holdingBars: number;
  won: boolean;
};

type BacktestReport = {
  cycles: BacktestCycle[];
  wins: number;
  winRate: number;
  averageNetSpread: number;
  cumulativeContribution: number;
  maxDrawdown: number;
  averageHoldingBars: number;
  bSignals: number;
  sSignals: number;
  incompleteCycles: number;
  modeCounts: Record<TMode, number>;
  equity: number[];
  waveFilter: {
    enabled: boolean;
    coveredRows: number;
    blockedOpens: number;
    cTarget: number;
  };
};

type PendingFill = {
  side: "B" | "S";
  signalTime: string;
};

type WaveFilterConfig = {
  enabled: boolean;
  aHigh: number;
  aLow: number;
  bHigh: number;
  extension: number;
  cTarget: number;
};

type OpenCycle = {
  side: "B" | "S";
  signalTime: string;
  entryTime: string;
  entryPrice: number;
  startIndex: number;
  adversePrice: number;
};

const SAMPLE_DATES = [
  "2026-07-20",
  "2026-07-21",
  "2026-07-22",
  "2026-07-23",
  "2026-07-24",
];

function minuteLabel(index: number) {
  const total =
    index < 120 ? 9 * 60 + 30 + index : 13 * 60 + (index - 120);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

function deterministicNoise(index: number, day: number) {
  const value = Math.sin((index + 1) * (17.13 + day * 3.7)) * 43758.5453;
  return value - Math.floor(value) - 0.5;
}

function makeSampleRows() {
  const rows: Tick[] = [];
  SAMPLE_DATES.forEach((date, dayIndex) => {
    const direction = dayIndex < 2 ? 1 : dayIndex < 4 ? -1 : 0;
    const base = 32 + dayIndex * 0.45;
    for (let minute = 0; minute < 240; minute += 1) {
      const wave = Math.sin(((minute - 13) / 50) * Math.PI * 2) * 0.0055;
      const trend = direction * minute * 0.00013;
      const noise = deterministicNoise(minute, dayIndex) * 0.0005;
      const price = base * (1 + trend + wave + noise);
      const cyclePosition = minute % 50;
      const nearTurn =
        Math.abs(cyclePosition - 13) <= 2 ||
        Math.abs(cyclePosition - 38) <= 2;
      const volume =
        7200 +
        Math.round(Math.abs(noise) * 6_000_000) +
        (nearTurn ? 7600 : 0);
      const sectorWave = Math.sin(((minute - 10) / 70) * Math.PI * 2) * 0.12;
      const sectorChange =
        direction === 0
          ? sectorWave
          : direction * (0.16 + minute * 0.0048) + sectorWave;
      const indexChange =
        direction === 0
          ? sectorWave * 0.45
          : direction * (0.07 + minute * 0.0021);
      rows.push({
        time: `${date} ${minuteLabel(minute)}`,
        price,
        volume,
        sectorChange,
        indexChange,
        indexLevel: 4000 * (1 + indexChange / 100),
      });
    }
  });
  return rows;
}

function sessionKey(time: string) {
  const match = time.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "single-session";
}

function minuteOfDay(time: string) {
  const match = time.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function canEvaluate(time: string) {
  const minute = minuteOfDay(time);
  if (minute === null) return true;
  return (
    (minute >= 9 * 60 + 45 && minute < 11 * 60 + 30) ||
    (minute >= 13 * 60 && minute < 14 * 60 + 57)
  );
}

function parseDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value.trim());
  return cells;
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replaceAll(" ", "").replaceAll("_", "");
}

function parseCsv(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 17) {
    throw new Error("至少需要表头和16行分时数据");
  }
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = parseDelimitedLine(lines[0], delimiter).map(normalizeHeader);
  const aliases = {
    time: ["time", "datetime", "timestamp", "时间", "日期时间"],
    price: ["price", "close", "last", "现价", "价格", "收盘价"],
    volume: ["volume", "vol", "成交量"],
    sector: ["sectorchange", "sector", "板块涨跌", "行业涨跌"],
    index: ["indexchange", "index", "指数涨跌", "大盘涨跌"],
    indexLevel: ["indexlevel", "indexprice", "指数点位", "大盘点位"],
  };
  const findIndex = (keys: string[]) =>
    headers.findIndex((header) => keys.map(normalizeHeader).includes(header));
  const indexes = {
    time: findIndex(aliases.time),
    price: findIndex(aliases.price),
    volume: findIndex(aliases.volume),
    sector: findIndex(aliases.sector),
    index: findIndex(aliases.index),
    indexLevel: findIndex(aliases.indexLevel),
  };
  if (indexes.time < 0 || indexes.price < 0) {
    throw new Error("CSV必须包含 time 和 price 两列");
  }

  const rows = lines.slice(1).flatMap((line) => {
    const cells = parseDelimitedLine(line, delimiter);
    const price = Number(cells[indexes.price]);
    if (!Number.isFinite(price) || price <= 0) return [];
    return [
      {
        time: cells[indexes.time] || "--:--",
        price,
        volume:
          indexes.volume >= 0 && Number.isFinite(Number(cells[indexes.volume]))
            ? Math.max(1, Number(cells[indexes.volume]))
            : 1,
        sectorChange:
          indexes.sector >= 0 &&
          Number.isFinite(Number(cells[indexes.sector]))
            ? Number(cells[indexes.sector])
            : 0,
        indexChange:
          indexes.index >= 0 && Number.isFinite(Number(cells[indexes.index]))
            ? Number(cells[indexes.index])
            : 0,
        indexLevel:
          indexes.indexLevel >= 0 &&
          Number.isFinite(Number(cells[indexes.indexLevel]))
            ? Number(cells[indexes.indexLevel])
            : undefined,
      },
    ];
  });
  if (rows.length < 16) throw new Error("没有解析到足够的有效价格行");
  return rows.slice(0, 20_000);
}

function runBacktest(
  rows: Tick[],
  costBps: number,
  allocationPercent: number,
  waveConfig: WaveFilterConfig,
): BacktestReport {
  const cycles: BacktestCycle[] = [];
  const modeCounts: Record<TMode, number> = {
    positive: 0,
    reverse: 0,
    range: 0,
    avoid: 0,
  };
  let sessionRows: Tick[] = [];
  let currentSession = "";
  let previousState: SignalState = "blocked";
  let phase: CyclePhase = "neutral";
  let pending: PendingFill | null = null;
  let openCycle: OpenCycle | null = null;
  let incompleteCycles = 0;
  let bSignals = 0;
  let sSignals = 0;
  let waveCoveredRows = 0;
  let waveBlockedOpens = 0;
  const cTarget = Number.isFinite(waveConfig.cTarget)
    ? waveConfig.cTarget
    : 3810;

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
      } else if (
        (openCycle.side === "B" && pending.side === "S") ||
        (openCycle.side === "S" && pending.side === "B")
      ) {
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
    const transitioned = reading.state !== previousState;
    const hasIndexLevel = Number.isFinite(row.indexLevel);
    if (waveConfig.enabled && hasIndexLevel) waveCoveredRows += 1;
    const isOpeningPositive =
      phase === "neutral" &&
      reading.tMode === "positive" &&
      reading.state === "confirmB";
    const isOpeningReverse =
      phase === "neutral" &&
      reading.tMode === "reverse" &&
      reading.state === "confirmS";
    const blockOpening =
      waveConfig.enabled &&
      hasIndexLevel &&
      ((isOpeningPositive && row.indexLevel! < waveConfig.aLow) ||
        (isOpeningReverse && row.indexLevel! <= cTarget * 1.005));

    if (transitioned && blockOpening) {
      waveBlockedOpens += 1;
      previousState = "blocked";
      return;
    }
    if (transitioned && reading.state === "confirmB") {
      bSignals += 1;
      pending = {
        side: "B",
        signalTime: row.time,
      };
    }
    if (transitioned && reading.state === "confirmS") {
      sSignals += 1;
      pending = {
        side: "S",
        signalTime: row.time,
      };
    }
    previousState = reading.state;
  });
  if (openCycle || pending) incompleteCycles += 1;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equity = [0];
  cycles.forEach((cycle) => {
    cumulative += cycle.contribution;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
    equity.push(cumulative);
  });
  const wins = cycles.filter((cycle) => cycle.won).length;
  return {
    cycles,
    wins,
    winRate: cycles.length ? (wins / cycles.length) * 100 : 0,
    averageNetSpread: cycles.length
      ? cycles.reduce((sum, cycle) => sum + cycle.netSpread, 0) / cycles.length
      : 0,
    cumulativeContribution: cumulative,
    maxDrawdown,
    averageHoldingBars: cycles.length
      ? cycles.reduce((sum, cycle) => sum + cycle.holdingBars, 0) / cycles.length
      : 0,
    bSignals,
    sSignals,
    incompleteCycles,
    modeCounts,
    equity,
    waveFilter: {
      enabled: waveConfig.enabled,
      coveredRows: waveCoveredRows,
      blockedOpens: waveBlockedOpens,
      cTarget,
    },
  };
}

function EquityChart({ values }: { values: number[] }) {
  const width = 720;
  const height = 180;
  const padding = 16;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = Math.max(max - min, 0.01);
  const points = values
    .map((value, index) => {
      const x =
        padding +
        (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
      const y =
        padding + ((max - value) / range) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const zeroY =
    padding + ((max - 0) / range) * (height - padding * 2);
  return (
    <svg
      className="equity-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="累计策略贡献曲线"
    >
      <line x1="0" x2={width} y1={zeroY} y2={zeroY} />
      <polyline points={points} />
    </svg>
  );
}

function reportVerdict(report: BacktestReport) {
  if (!report.cycles.length) {
    return {
      title: "尚无完整周期",
      tone: "neutral",
      body: "当前数据没有形成完整的B/S配对。不要把零交易误判为高胜率。",
    };
  }
  if (report.cycles.length < 20) {
    return {
      title: "样本不足",
      tone: "amber",
      body: `只有${report.cycles.length}个完整周期，结果容易被少数行情主导，建议至少覆盖20个周期和不同市场环境。`,
    };
  }
  if (report.winRate >= 65 && report.cumulativeContribution > 0) {
    return {
      title: "具备继续测试价值",
      tone: "positive",
      body: "胜率与扣费后贡献同时为正，但仍需加入更多股票、下跌日和高波动日做样本外验证。",
    };
  }
  return {
    title: "暂未形成稳定优势",
    tone: "negative",
    body: "扣除成本后优势不足。优先检查信号过密、反T回补和板块字段质量，不建议直接放宽确认阈值。",
  };
}

export default function BacktestAgent() {
  const initialRows = useMemo(() => makeSampleRows(), []);
  const initialWaveConfig: WaveFilterConfig = {
    enabled: false,
    aHigh: 4258.86,
    aLow: 3927,
    bHigh: 4175,
    extension: 1.318,
    cTarget: 3810,
  };
  const [rows, setRows] = useState<Tick[]>(initialRows);
  const [sourceName, setSourceName] = useState("内置5日合成样例");
  const [csvText, setCsvText] = useState("");
  const [costBps, setCostBps] = useState(15);
  const [allocationPercent, setAllocationPercent] = useState(33);
  const [waveConfig, setWaveConfig] =
    useState<WaveFilterConfig>(initialWaveConfig);
  const [status, setStatus] = useState(
    "样例包含强势、弱势与箱体日，仅用于检查评测流程。",
  );
  const [report, setReport] = useState<BacktestReport>(() =>
    runBacktest(initialRows, 15, 33, initialWaveConfig),
  );
  const verdict = reportVerdict(report);

  const importText = (text: string, name: string) => {
    try {
      const parsed = parseCsv(text);
      setRows(parsed);
      setSourceName(name);
      setStatus(`已解析 ${parsed.length} 行，等待运行Agent。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "CSV解析失败");
    }
  };

  const loadSample = () => {
    const sample = makeSampleRows();
    setRows(sample);
    setSourceName("内置5日合成样例");
    setStatus("已恢复内置样例。");
    setReport(runBacktest(sample, costBps, allocationPercent, waveConfig));
  };

  const runAgent = () => {
    const next = runBacktest(
      rows,
      costBps,
      allocationPercent,
      waveConfig,
    );
    setReport(next);
    setStatus(
      `已逐分钟评测 ${rows.length} 行，形成 ${next.cycles.length} 个完整周期。`,
    );
  };

  return (
    <main className="agent-shell">
      <header className="agent-topbar">
        <div className="brand">
          <div className="brand-mark agent-mark">A</div>
          <div>
            <strong>成功率评测 Agent</strong>
            <span>同模型 · 逐分钟 · 无未来数据</span>
          </div>
        </div>
        <div className="agent-actions">
          <span className="local-badge">本地离线</span>
          <Link className="button secondary button-link" href="/">
            返回分时罗盘
          </Link>
          <button className="button primary" onClick={runAgent}>
            运行评测
          </button>
        </div>
      </header>

      <div className="agent-boundary">
        <strong>评测边界</strong>
        信号在当前分钟收盘后生成，统一按下一条行情成交；不连接账户，不执行交易。
      </div>

      <section className="agent-workspace">
        <aside className="agent-controls panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">数据与假设</span>
              <h2>评测设置</h2>
            </div>
          </div>

          <div className="agent-control-body">
            <div className="dataset-summary">
              <span>当前数据</span>
              <strong>{sourceName}</strong>
              <b>{rows.length.toLocaleString("zh-CN")} 行</b>
            </div>

            <label className="file-control">
              <span>导入CSV文件</span>
              <input
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  importText(await file.text(), file.name);
                }}
              />
            </label>

            <label>
              <span>或粘贴CSV</span>
              <textarea
                rows={7}
                value={csvText}
                placeholder={
                  "time,price,volume,sectorChange,indexChange\n2026-07-20 09:30,32.10,12000,0.35,0.12"
                }
                onChange={(event) => setCsvText(event.target.value)}
              />
            </label>
            <div className="import-actions">
              <button
                className="button secondary"
                onClick={() => importText(csvText, "粘贴的CSV")}
              >
                解析粘贴内容
              </button>
              <button className="text-button" onClick={loadSample}>
                恢复内置样例
              </button>
            </div>

            <div className="agent-settings">
              <label>
                <span>往返成本（基点）</span>
                <input
                  type="number"
                  min="0"
                  max="200"
                  value={costBps}
                  onChange={(event) =>
                    setCostBps(Math.max(0, Number(event.target.value)))
                  }
                />
              </label>
              <label>
                <span>单次底仓占比（%）</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={allocationPercent}
                  onChange={(event) =>
                    setAllocationPercent(
                      Math.min(100, Math.max(1, Number(event.target.value))),
                    )
                  }
                />
              </label>
            </div>

            <div className="wave-filter">
              <label className="wave-toggle">
                <span>
                  <strong>大盘波浪过滤</strong>
                  <small>可选情景，不作为独立买卖信号</small>
                </span>
                <input
                  type="checkbox"
                  checked={waveConfig.enabled}
                  onChange={(event) =>
                    setWaveConfig((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
              </label>
              <div className="wave-fields">
                {(
                  [
                    ["aHigh", "A浪高点"],
                    ["aLow", "A浪低点"],
                    ["bHigh", "B浪高点"],
                    ["extension", "C浪系数"],
                    ["cTarget", "C浪目标"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input
                      type="number"
                      min="0"
                      step={key === "extension" ? "0.001" : "0.01"}
                      value={waveConfig[key]}
                      onChange={(event) =>
                        setWaveConfig((current) => ({
                          ...current,
                          [key]: Math.max(0, Number(event.target.value)),
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <p>
                图示C浪目标采用{" "}
                <strong>
                  {(Number.isFinite(waveConfig.cTarget)
                    ? waveConfig.cTarget
                    : 3810
                  ).toFixed(2)}
                </strong>
                ；按A浪扩展公式则为{" "}
                <strong>
                  {(
                    waveConfig.aLow -
                    Math.max(0, waveConfig.aHigh - waveConfig.aLow) *
                      waveConfig.extension
                  ).toFixed(2)}
                </strong>
                ，两者不一致。过滤规则按显式C目标执行：跌破A低时暂停新开正T，接近C目标时不追开反T。
              </p>
            </div>

            <button className="button primary agent-run" onClick={runAgent}>
              运行逐分钟Agent
            </button>
            <p className="agent-status">{status}</p>

            <div className="csv-contract">
              <strong>字段口径</strong>
              <span>
                必填：time、price。可选：volume、sectorChange、indexChange、
                indexLevel。
              </span>
              <span>
                板块与指数涨跌均使用百分数，例如 0.35 表示 +0.35%；波浪过滤需要逐行指数点位
                indexLevel。
              </span>
            </div>
          </div>
        </aside>

        <section className="agent-results">
          <div className="agent-metrics">
            <article>
              <span>完整周期</span>
              <strong>{report.cycles.length}</strong>
              <small>未完成 {report.incompleteCycles}</small>
            </article>
            <article>
              <span>扣费后胜率</span>
              <strong>{report.winRate.toFixed(1)}%</strong>
              <small>
                {report.wins}胜 / {report.cycles.length - report.wins}负
              </small>
            </article>
            <article>
              <span>平均净价差</span>
              <strong
                className={report.averageNetSpread >= 0 ? "up" : "down"}
              >
                {report.averageNetSpread >= 0 ? "+" : ""}
                {report.averageNetSpread.toFixed(3)}%
              </strong>
              <small>已扣 {costBps}bp</small>
            </article>
            <article>
              <span>累计策略贡献</span>
              <strong
                className={
                  report.cumulativeContribution >= 0 ? "up" : "down"
                }
              >
                {report.cumulativeContribution >= 0 ? "+" : ""}
                {report.cumulativeContribution.toFixed(3)}%
              </strong>
              <small>按 {allocationPercent}% 底仓计算</small>
            </article>
            <article>
              <span>周期最大回撤</span>
              <strong className="down">{report.maxDrawdown.toFixed(3)}%</strong>
              <small>按已完成周期</small>
            </article>
            <article>
              <span>平均持有</span>
              <strong>{report.averageHoldingBars.toFixed(1)}</strong>
              <small>条行情</small>
            </article>
          </div>

          <div className="agent-analysis-grid">
            <article className="panel equity-panel">
              <div className="agent-card-head">
                <div>
                  <span className="eyebrow">按周期累计</span>
                  <h2>策略贡献曲线</h2>
                </div>
                <span>
                  B {report.bSignals} · S {report.sSignals}
                </span>
              </div>
              <EquityChart values={report.equity} />
            </article>

            <article className={`panel verdict-panel ${verdict.tone}`}>
              <span className="eyebrow">Agent结论</span>
              <h2>{verdict.title}</h2>
              <p>{verdict.body}</p>
              <div className="mode-counts">
                {(["positive", "reverse", "range", "avoid"] as TMode[]).map(
                  (mode) => (
                    <span key={mode}>
                      {T_MODE_META[mode].label}
                      <strong>{report.modeCounts[mode]}</strong>
                    </span>
                  ),
                )}
              </div>
              <div className="wave-result">
                <span>波浪过滤</span>
                <strong>
                  {report.waveFilter.enabled ? "已启用" : "未启用"}
                </strong>
                <small>
                  有效覆盖 {report.waveFilter.coveredRows} 行 · 拦截{" "}
                  {report.waveFilter.blockedOpens} 次开仓
                </small>
              </div>
            </article>
          </div>

          <article className="panel cycle-panel">
            <div className="agent-card-head">
              <div>
                <span className="eyebrow">逐笔审计</span>
                <h2>B/S完整周期</h2>
              </div>
              <span>先信号，下一条行情成交</span>
            </div>
            <div className="cycle-table-wrap">
              <table className="cycle-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>模式</th>
                    <th>信号时间</th>
                    <th>成交区间</th>
                    <th>价格</th>
                    <th>毛价差</th>
                    <th>净价差</th>
                    <th>逆向波动</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {report.cycles.length ? (
                    report.cycles
                      .slice()
                      .reverse()
                      .slice(0, 80)
                      .map((cycle) => (
                        <tr key={cycle.id}>
                          <td>{cycle.id}</td>
                          <td>
                            {cycle.mode === "positive" ? "正T" : "反T"}
                          </td>
                          <td>{cycle.signalTime}</td>
                          <td>
                            {cycle.entryTime} → {cycle.exitTime}
                          </td>
                          <td>
                            {cycle.entryPrice.toFixed(3)} →{" "}
                            {cycle.exitPrice.toFixed(3)}
                          </td>
                          <td>{cycle.grossSpread.toFixed(3)}%</td>
                          <td className={cycle.netSpread >= 0 ? "up" : "down"}>
                            {cycle.netSpread.toFixed(3)}%
                          </td>
                          <td>{cycle.adverse.toFixed(3)}%</td>
                          <td>
                            <span
                              className={`result-chip ${
                                cycle.won ? "win" : "loss"
                              }`}
                            >
                              {cycle.won ? "成功" : "失败"}
                            </span>
                          </td>
                        </tr>
                      ))
                  ) : (
                    <tr>
                      <td colSpan={9} className="empty-table">
                        没有完整周期。检查数据长度、板块字段和信号条件。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}
