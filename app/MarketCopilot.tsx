"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  evaluateSignal,
  recommendTrancheQuantity,
  T_MODE_META,
  VOLUME_PHASE_LABEL,
  type CyclePhase,
  type DailyBar,
  type ModelContext,
  type SignalReading,
  type SignalState,
  type Tick,
} from "./t0Model";
import {
  buildStopWatchState,
  DEFAULT_STOPWATCH_CONFIG,
  pushStopWatchState,
  readStopWatchSelection,
  testStopWatchConnection,
  type StopWatchConfig,
} from "./stopwatchSync";

type FeedMode = "demo" | "rest" | "websocket";
type ConnectionState = "connected" | "connecting" | "paused" | "error";

type Holding = {
  code: string;
  name: string;
  market: "SH" | "SZ" | "BJ";
  sector: string;
  shares: number;
  sellable: number;
  cost: number;
  price: number;
  previousClose: number;
  turnaround: "t0" | "t1";
};

type HoldingDraft = {
  code: string;
  name: string;
  sector: string;
  shares: string;
  sellable: string;
  cost: string;
  turnaround: "t0" | "t1";
};

type ActualTrade = {
  id: string;
  timestamp: number;
  time: string;
  code: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
};

type CompletedTCycle = {
  id: string;
  mode: "positive" | "reverse";
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  fees: number;
  contribution: number;
  closedAt: number;
};

type FeedConfig = {
  mode: FeedMode;
  providerName: string;
  delayType: "realtime" | "delayed" | "unknown";
  maxAgeSeconds: number;
  url: string;
  interval: number;
  pricePath: string;
  previousClosePath: string;
  volumePath: string;
  timePath: string;
  sectorPath: string;
  indexPath: string;
  indexLevelPath: string;
  subscribeMessage: string;
};

const PUBLIC_TRADE_LEDGER_KEY = "t0-public-actual-trades-v1";

function usesBrowserTradeLedger() {
  if (typeof window === "undefined") return false;
  return !["localhost", "127.0.0.1", "::1"].includes(
    window.location.hostname,
  );
}

type WaveGuideConfig = {
  enabled: boolean;
  aHigh: number;
  aLow: number;
  bHigh: number;
  extension: number;
  cTarget: number;
};

type EmptyGuide = {
  tone: "neutral" | "watch" | "defensive" | "support" | "invalid";
  title: string;
  action: string;
  confirmations: string[];
  missing: string[];
};

type MarketStatus = {
  label: string;
  detail: string;
  allowQuotes: boolean;
  allowSignals: boolean;
  kind: "unknown" | "closed" | "auction" | "break" | "continuous";
};

type MarketDataContext = {
  instrumentKind: "stock" | "etf" | "bond";
  indexName?: string;
  indexCode?: string;
  indexSource?: string;
  indexSourceTime?: string;
  indexSeriesValid: boolean;
  sectorName?: string;
  sectorCode?: string;
  sectorSource?: string;
  sectorSourceTime?: string;
  sectorSeriesValid: boolean;
  dailySeriesValid: boolean;
  error?: string | null;
};

type SignalAlert = {
  state: "confirmB" | "confirmS";
  holdingName: string;
  code: string;
  price: number;
  occurredAt: number;
};

type NotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "insecure";

const EMPTY_MARKET_CONTEXT: MarketDataContext = {
  instrumentKind: "stock",
  indexSeriesValid: false,
  sectorSeriesValid: false,
  dailySeriesValid: false,
};

const DEFAULT_HOLDINGS: Holding[] = [
  {
    code: "600519",
    name: "示例：贵州茅台",
    market: "SH",
    sector: "示例持仓，可在“管理持仓”中替换",
    shares: 0,
    sellable: 0,
    cost: 0,
    price: 0,
    previousClose: 0,
    turnaround: "t1",
  },
];

const EMPTY_HOLDING_DRAFT: HoldingDraft = {
  code: "",
  name: "",
  sector: "",
  shares: "0",
  sellable: "0",
  cost: "0",
  turnaround: "t1",
};

const DEFAULT_CONFIG: FeedConfig = {
  mode: "rest",
  providerName: "免费公开行情（东方财富）",
  delayType: "realtime",
  maxAgeSeconds: 15,
  url: "/quote?symbol={symbol}&market={market}",
  interval: 1000,
  pricePath: "data.price",
  previousClosePath: "data.previousClose",
  volumePath: "data.volume",
  timePath: "data.time",
  sectorPath: "data.sectorChange",
  indexPath: "data.indexChange",
  indexLevelPath: "data.indexLevel",
  subscribeMessage: '{"action":"subscribe","symbol":"{market}{symbol}"}',
};

const DEFAULT_WAVE_GUIDE: WaveGuideConfig = {
  enabled: false,
  aHigh: 4258.86,
  aLow: 3927,
  bHigh: 4175,
  extension: 1.318,
  cTarget: 3810,
};

const SSE_CLOSED_DATES_2026 = new Set([
  "2026-01-01",
  "2026-01-02",
  "2026-01-03",
  "2026-02-15",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-21",
  "2026-02-22",
  "2026-02-23",
  "2026-04-04",
  "2026-04-05",
  "2026-04-06",
  "2026-05-01",
  "2026-05-02",
  "2026-05-03",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-06-20",
  "2026-06-21",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
]);

const SIGNAL_META: Record<
  SignalState,
  { label: string; tone: string; short: string }
> = {
  blocked: {
    label: "等待条件",
    tone: "neutral",
    short: "环境或确认条件不足，保持观察",
  },
  watchB: {
    label: "B点观察",
    tone: "amber",
    short: "5分钟下跌波段缩量，等待确认",
  },
  confirmB: {
    label: "B点确认",
    tone: "buy",
    short: "B点条件成立，仅作人工真实操作参考",
  },
  tracking: {
    label: "持仓跟踪",
    tone: "blue",
    short: "信号已确认，等待退出结构",
  },
  watchS: {
    label: "S点观察",
    tone: "amber",
    short: "5分钟上涨波段缩量，等待确认",
  },
  confirmS: {
    label: "S点确认",
    tone: "sell",
    short: "S点条件成立，仅作人工真实操作参考",
  },
};

function playSignalTone(
  context: AudioContext,
  state: "confirmB" | "confirmS",
) {
  const frequencies = state === "confirmB" ? [620, 820] : [820, 520];
  const startedAt = context.currentTime + 0.02;

  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = startedAt + index * 0.2;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.16, noteStart + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.16);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + 0.18);
  });
}

function playAlertEnabledTone(context: AudioContext) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const startedAt = context.currentTime + 0.02;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(680, startedAt);
  gain.gain.setValueAtTime(0.0001, startedAt);
  gain.gain.exponentialRampToValueAtTime(0.1, startedAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.12);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startedAt);
  oscillator.stop(startedAt + 0.14);
}

function readPath(input: unknown, path: string): unknown {
  if (!path.trim()) return undefined;
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object") {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, input);
}

function formatShanghaiTimestamp(epoch: number) {
  if (!epoch) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(epoch);
}

function parseSourceTimestamp(value: unknown, receivedAt: number) {
  if (value === null || value === undefined || value === "") {
    return {
      full: formatShanghaiTimestamp(receivedAt),
      minute: new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(receivedAt),
    };
  }

  const numeric = typeof value === "number" ? value : Number(value);
  const candidate =
    Number.isFinite(numeric) && numeric > 1_000_000_000
      ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
      : new Date(String(value));
  if (!Number.isNaN(candidate.getTime())) {
    return {
      full: formatShanghaiTimestamp(candidate.getTime()),
      minute: new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(candidate),
    };
  }

  const raw = String(value);
  return {
    full: raw,
    minute: raw.match(/\b\d{2}:\d{2}\b/)?.[0] ?? raw.slice(0, 5),
  };
}

function getShanghaiParts(epoch: number) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(epoch)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function getMarketStatus(epoch: number): MarketStatus {
  if (!epoch) {
    return {
      label: "正在校验",
      detail: "等待上海时间与交易日历",
      allowQuotes: false,
      allowSignals: false,
      kind: "unknown",
    };
  }

  const shanghai = getShanghaiParts(epoch);
  if (shanghai.year !== 2026) {
    return {
      label: "日历未覆盖",
      detail: "当前仅内置交易所公布的2026年休市日历",
      allowQuotes: false,
      allowSignals: false,
      kind: "unknown",
    };
  }
  if (shanghai.weekday === "Sat" || shanghai.weekday === "Sun") {
    return {
      label: "周末休市",
      detail: shanghai.dateKey,
      allowQuotes: false,
      allowSignals: false,
      kind: "closed",
    };
  }
  if (SSE_CLOSED_DATES_2026.has(shanghai.dateKey)) {
    return {
      label: "法定休市",
      detail: shanghai.dateKey,
      allowQuotes: false,
      allowSignals: false,
      kind: "closed",
    };
  }

  const minute = shanghai.minutes;
  if (minute >= 9 * 60 + 15 && minute < 9 * 60 + 25) {
    return {
      label: "开盘集合竞价",
      detail: "09:15-09:25，仅接收行情",
      allowQuotes: true,
      allowSignals: false,
      kind: "auction",
    };
  }
  if (minute >= 9 * 60 + 30 && minute < 9 * 60 + 45) {
    return {
      label: "开盘观察期",
      detail: "09:45前只接收行情，过滤开盘噪声",
      allowQuotes: true,
      allowSignals: false,
      kind: "auction",
    };
  }
  if (
    (minute >= 9 * 60 + 45 && minute < 11 * 60 + 30) ||
    (minute >= 13 * 60 && minute < 14 * 60 + 57)
  ) {
    return {
      label: "连续竞价",
      detail: "真实行情与信号监测有效",
      allowQuotes: true,
      allowSignals: true,
      kind: "continuous",
    };
  }
  if (minute >= 14 * 60 + 57 && minute < 15 * 60) {
    return {
      label: "收盘集合竞价",
      detail: "14:57-15:00",
      allowQuotes: true,
      allowSignals: true,
      kind: "auction",
    };
  }
  if (
    (minute >= 9 * 60 + 25 && minute < 9 * 60 + 30) ||
    (minute >= 11 * 60 + 30 && minute < 13 * 60)
  ) {
    return {
      label: minute < 10 * 60 ? "竞价间歇" : "午间休市",
      detail: "冻结图表与信号",
      allowQuotes: false,
      allowSignals: false,
      kind: "break",
    };
  }
  return {
    label: minute < 9 * 60 + 15 ? "尚未开市" : "已收盘",
    detail: "冻结图表与信号",
    allowQuotes: false,
    allowSignals: false,
    kind: "closed",
  };
}

function minuteLabel(index: number) {
  const minute = index % 240;
  const total = minute < 120 ? 9 * 60 + 30 + minute : 13 * 60 + minute - 120;
  const hour = Math.floor(total / 60);
  return `${String(hour).padStart(2, "0")}:${String(total % 60).padStart(
    2,
    "0",
  )}`;
}

function seededNoise(index: number, seed: number) {
  const value = Math.sin((index + 1) * (12.9898 + seed) * 78.233) * 43758.5453;
  return (value - Math.floor(value) - 0.5) * 0.0013;
}

function demoDrift(index: number) {
  const phase = index % 150;
  if (phase < 34) return -0.00072;
  if (phase < 48) return -0.00012;
  if (phase < 88) return 0.00084;
  if (phase < 105) return 0.00014;
  if (phase < 130) return -0.00058;
  return 0.00018;
}

function makeInitialTicks(holding: Holding): Tick[] {
  const seed = Number(holding.code.slice(-2)) / 10;
  const ticks: Tick[] = [];
  const previousClose =
    holding.previousClose > 0
      ? holding.previousClose
      : holding.cost > 0
        ? holding.cost
        : 10;
  let price = previousClose;

  for (let index = 0; index < 64; index += 1) {
    const change = demoDrift(index + 12) + seededNoise(index, seed);
    price = Math.max(0.01, price * (1 + change));
    ticks.push({
      time: minuteLabel(index),
      price,
      volume: 8000 + Math.round(Math.abs(change) * 9500000),
      sectorChange: ((price / previousClose - 1) * 100) * 0.72,
      indexChange: ((price / previousClose - 1) * 100) * 0.38,
      indexLevel:
        4000 *
        (1 +
          (((price / previousClose - 1) * 100) * 0.38) / 100),
    });
  }
  return ticks;
}

function oneThirdQuantity(sellable: number) {
  if (sellable <= 0) return 0;
  if (sellable < 300) return Math.floor(sellable / 100) * 100;
  return Math.max(100, Math.floor(sellable / 3 / 100) * 100);
}

function inferMarketFromCode(code: string): Holding["market"] {
  if (/^(92|43|81|82|83|87|88)/.test(code)) return "BJ";
  if (/^[569]/.test(code)) return "SH";
  return "SZ";
}

function summarizeTradingCycles(trades: ActualTrade[], code: string) {
  const ordered = trades
    .filter((trade) => trade.code === code)
    .toSorted((left, right) => left.timestamp - right.timestamp);
  const openLots: Array<{
    side: ActualTrade["side"];
    remaining: number;
    price: number;
    feePerShare: number;
    openedAt: number;
  }> = [];
  const cycles: CompletedTCycle[] = [];

  for (const trade of ordered) {
    let remaining = trade.quantity;
    const closingFeePerShare =
      trade.quantity > 0 ? trade.fee / trade.quantity : 0;

    while (
      remaining > 0 &&
      openLots.length > 0 &&
      openLots[0].side !== trade.side
    ) {
      const open = openLots[0];
      const matchedQuantity = Math.min(remaining, open.remaining);
      const buyPrice = trade.side === "buy" ? trade.price : open.price;
      const sellPrice = trade.side === "sell" ? trade.price : open.price;
      const fees =
        (open.feePerShare + closingFeePerShare) * matchedQuantity;
      const contribution =
        (sellPrice - buyPrice) * matchedQuantity - fees;

      cycles.push({
        id: `${open.openedAt}-${trade.timestamp}-${cycles.length}`,
        mode: open.side === "buy" ? "positive" : "reverse",
        quantity: matchedQuantity,
        buyPrice,
        sellPrice,
        fees,
        contribution,
        closedAt: trade.timestamp,
      });

      open.remaining -= matchedQuantity;
      remaining -= matchedQuantity;
      if (open.remaining <= 0) openLots.shift();
    }

    if (remaining > 0) {
      openLots.push({
        side: trade.side,
        remaining,
        price: trade.price,
        feePerShare: closingFeePerShare,
        openedAt: trade.timestamp,
      });
    }
  }

  const wins = cycles.filter((cycle) => cycle.contribution > 0).length;
  const contribution = cycles.reduce(
    (sum, cycle) => sum + cycle.contribution,
    0,
  );

  return {
    cycles,
    wins,
    successRate: cycles.length > 0 ? (wins / cycles.length) * 100 : 0,
    contribution,
    pendingQuantity: openLots.reduce(
      (sum, lot) => sum + lot.remaining,
      0,
    ),
    pendingSide: openLots.at(0)?.side ?? null,
  };
}

function evaluateEmptyGuide(
  latestTick: Tick | undefined,
  signal: SignalReading,
  cyclePhase: CyclePhase,
  config: WaveGuideConfig,
  active: boolean,
): EmptyGuide {
  if (!active) {
    return {
      tone: "neutral",
      title: "空仓指引已冻结",
      action: "等待有效交易时段与新行情，不使用静态或陈旧点位",
      confirmations: [],
      missing: ["行情监测当前未处于有效运行状态"],
    };
  }
  const indexLevel = latestTick?.indexLevel;
  if (!config.enabled) {
    return {
      tone: "neutral",
      title: "波浪过滤未启用",
      action: "沿用分时、板块与MACD判断",
      confirmations: [],
      missing: ["启用波浪过滤后才评估空仓观察点"],
    };
  }
  if (!Number.isFinite(indexLevel)) {
    return {
      tone: "neutral",
      title: "等待指数点位",
      action: "行情接口需提供 indexLevel，当前不生成空仓指引",
      confirmations: [],
      missing: ["缺少逐条上证指数点位"],
    };
  }

  const level = indexLevel as number;
  const cTarget = Number.isFinite(config.cTarget) ? config.cTarget : 3810;
  const stockWeak =
    signal.stockTrend < -0.18 &&
    signal.macd.histogram < 0 &&
    latestTick!.price < signal.vwap;
  const sectorWeak = signal.sectorTrend < -0.12;
  const upperFailure =
    signal.rangePosition >= 68 &&
    (signal.macd.bearishTurn || signal.macd.bearishCross);
  const confirmations = [
    ...(stockWeak ? ["个股跌破均价且MACD/趋势转弱"] : []),
    ...(sectorWeak ? ["行业板块同步转弱"] : []),
    ...(upperFailure ? ["个股箱体上沿出现MACD转空"] : []),
  ];

  if (level > config.bHigh * 1.006) {
    return {
      tone: "invalid",
      title: "原C浪推演暂时失效",
      action: "不依据该图给出空仓点，等待重新确认浪型",
      confirmations: [`指数 ${level.toFixed(2)} 已站上B浪高点缓冲区`],
      missing: [],
    };
  }
  if (level <= cTarget * 1.01) {
    return {
      tone: "support",
      title: "接近C浪情景目标区",
      action: "停止追空；已有仓位只按个股破位规则处理",
      confirmations: [
        `指数进入约 ${cTarget.toFixed(0)} 点目标区`,
        ...confirmations,
      ],
      missing: ["目标区可能出现急反弹，不能把波浪公式当作确定底部"],
    };
  }
  if (level < config.aLow) {
    const defensiveConfirmed = stockWeak && sectorWeak;
    return {
      tone: defensiveConfirmed ? "defensive" : "watch",
      title: defensiveConfirmed ? "防守空仓确认" : "跌破A低，等待个股确认",
      action: defensiveConfirmed
        ? cyclePhase === "neutral"
          ? "进入空仓观察状态，暂停新开正T"
          : "优先结束未闭合的真实T周期，再进入空仓观察"
        : "不因指数单点跌破直接清仓",
      confirmations: [`指数跌破A浪低点 ${config.aLow}`, ...confirmations],
      missing: [
        ...(!stockWeak ? ["个股尚未同时跌破均价并MACD转弱"] : []),
        ...(!sectorWeak ? ["行业板块尚未同步转弱"] : []),
      ],
    };
  }

  const nearBHigh =
    level >= config.bHigh * 0.994 && level <= config.bHigh * 1.006;
  if (nearBHigh) {
    const failureConfirmed = upperFailure && sectorWeak;
    return {
      tone: failureConfirmed ? "defensive" : "watch",
      title: failureConfirmed ? "B浪冲高失败空仓观察" : "进入B浪压力观察区",
      action: failureConfirmed
        ? "若个股确认S点，可把计划仓位降至空仓观察"
        : "等待个股上沿转弱，不预判清仓",
      confirmations: [`指数接近B浪高点 ${config.bHigh}`, ...confirmations],
      missing: [
        ...(!upperFailure ? ["个股尚未在箱体上沿出现MACD转空"] : []),
        ...(!sectorWeak ? ["行业板块尚未同步转弱"] : []),
      ],
    };
  }

  return {
    tone: "neutral",
    title: "未到空仓观察点",
    action: "继续沿用当前正T/反T状态机",
    confirmations,
    missing: ["指数未进入B浪压力区，也未跌破A浪低点"],
  };
}

function IntradayChart({
  ticks,
  previousClose,
  signal,
}: {
  ticks: Tick[];
  previousClose: number;
  signal: SignalReading;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ticks.length) return;
    let animationFrame = 0;

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(bounds.width));
      const height = Math.max(1, Math.floor(bounds.height));
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const padding = { top: 22, right: 54, bottom: 34, left: 14 };
      const chartHeight = height - padding.top - padding.bottom - 54;
      const chartWidth = width - padding.left - padding.right;
      const prices = ticks.map((tick) => tick.price);
      const rawMin = Math.min(...prices, previousClose, signal.vwap);
      const rawMax = Math.max(...prices, previousClose, signal.vwap);
      const space = Math.max((rawMax - rawMin) * 0.16, rawMax * 0.002);
      const min = rawMin - space;
      const max = rawMax + space;
      const x = (index: number) =>
        padding.left + (index / Math.max(ticks.length - 1, 1)) * chartWidth;
      const y = (price: number) =>
        padding.top + ((max - price) / Math.max(max - min, 0.001)) * chartHeight;

      context.font =
        '11px ui-monospace, "SFMono-Regular", Consolas, monospace';
      context.lineWidth = 1;
      for (let row = 0; row < 5; row += 1) {
        const price = max - ((max - min) * row) / 4;
        const py = y(price);
        context.strokeStyle = "#e6e9ee";
        context.beginPath();
        context.moveTo(padding.left, py);
        context.lineTo(width - padding.right, py);
        context.stroke();
        context.fillStyle = "#7a8490";
        context.fillText(price.toFixed(2), width - padding.right + 8, py + 4);
      }

      context.setLineDash([5, 5]);
      context.strokeStyle = "#9aa3ad";
      context.beginPath();
      context.moveTo(padding.left, y(previousClose));
      context.lineTo(width - padding.right, y(previousClose));
      context.stroke();
      context.strokeStyle = "#d59b23";
      context.beginPath();
      context.moveTo(padding.left, y(signal.vwap));
      context.lineTo(width - padding.right, y(signal.vwap));
      context.stroke();
      context.setLineDash([]);

      const maxVolume = Math.max(...ticks.map((tick) => tick.volume), 1);
      const volumeTop = padding.top + chartHeight + 14;
      ticks.forEach((tick, index) => {
        const barHeight = (tick.volume / maxVolume) * 34;
        context.fillStyle =
          index > 0 && tick.price >= ticks[index - 1].price
            ? "rgba(217, 57, 74, 0.28)"
            : "rgba(22, 138, 91, 0.28)";
        context.fillRect(
          x(index),
          volumeTop + 34 - barHeight,
          Math.max(1, chartWidth / ticks.length - 1),
          barHeight,
        );
      });

      const up = ticks.at(-1)!.price >= previousClose;
      context.strokeStyle = up ? "#d9394a" : "#168a5b";
      context.lineWidth = 2;
      context.beginPath();
      ticks.forEach((tick, index) => {
        if (index === 0) context.moveTo(x(index), y(tick.price));
        else context.lineTo(x(index), y(tick.price));
      });
      context.stroke();

      const last = ticks.at(-1)!;
      context.fillStyle = up ? "#d9394a" : "#168a5b";
      context.beginPath();
      context.arc(x(ticks.length - 1), y(last.price), 3.5, 0, Math.PI * 2);
      context.fill();

      context.fillStyle = "#7a8490";
      context.fillText(ticks[0].time, padding.left, height - 8);
      const lastLabel = context.measureText(last.time).width;
      context.fillText(last.time, width - padding.right - lastLabel, height - 8);
    };

    const scheduleDraw = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(draw);
    };

    scheduleDraw();
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [previousClose, signal.vwap, ticks]);

  return <canvas ref={canvasRef} aria-label="实时分时走势图" />;
}

function ScoreBar({
  label,
  score,
  tone,
}: {
  label: string;
  score: number;
  tone: "buy" | "sell";
}) {
  return (
    <div className="score-row">
      <div className="score-label">
        <span>{label}</span>
        <strong>{score}</strong>
      </div>
      <div className="score-track" aria-label={`${label} ${score}分`}>
        <span
          className={`score-fill ${tone}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

export default function MarketCopilot() {
  const [holdings, setHoldings] = useState<Holding[]>(DEFAULT_HOLDINGS);
  const [selectedCode, setSelectedCode] = useState(DEFAULT_HOLDINGS[0].code);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [dailyBars, setDailyBars] = useState<DailyBar[]>([]);
  const [marketDataContext, setMarketDataContext] =
    useState<MarketDataContext>(EMPTY_MARKET_CONTEXT);
  const [signalState, setSignalState] = useState<SignalState>("blocked");
  const [cyclePhase, setCyclePhase] = useState<CyclePhase>("neutral");
  const [cycleQuantity, setCycleQuantity] = useState(0);
  const [connection, setConnection] =
    useState<ConnectionState>("paused");
  const [paused, setPaused] = useState(false);
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [config, setConfig] = useState<FeedConfig>(DEFAULT_CONFIG);
  const [waveGuide, setWaveGuide] =
    useState<WaveGuideConfig>(DEFAULT_WAVE_GUIDE);
  const [token, setToken] = useState("");
  const [stopWatchConfig, setStopWatchConfig] = useState<StopWatchConfig>(
    DEFAULT_STOPWATCH_CONFIG,
  );
  const [stopWatchApiKey, setStopWatchApiKey] = useState("");
  const [stopWatchStatus, setStopWatchStatus] = useState("尚未连接");
  const [configOpen, setConfigOpen] = useState(false);
  const [holdingsOpen, setHoldingsOpen] = useState(false);
  const [holdingDraft, setHoldingDraft] =
    useState<HoldingDraft>(EMPTY_HOLDING_DRAFT);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [holdingFormError, setHoldingFormError] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [paperQuantity, setPaperQuantity] = useState(() =>
    oneThirdQuantity(DEFAULT_HOLDINGS[0].sellable),
  );
  const [trades, setTrades] = useState<ActualTrade[]>([]);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionState>("default");
  const [signalAlert, setSignalAlert] = useState<SignalAlert | null>(null);
  const [eventRiskLocked, setEventRiskLocked] = useState(false);
  const [feedMessage, setFeedMessage] = useState("正在连接东方财富官方行情桥");
  const [executionPrice, setExecutionPrice] = useState(
    DEFAULT_HOLDINGS[0].price,
  );
  const [tradeFee, setTradeFee] = useState(0);
  const [clockNow, setClockNow] = useState(0);
  const [lastReceivedAt, setLastReceivedAt] = useState<number | null>(null);
  const [lastSourceTime, setLastSourceTime] = useState<string | null>(null);
  const [dataValidation, setDataValidation] = useState<{
    passed: boolean;
    status: string;
    reason: string;
  } | null>(null);
  const signalRef = useRef<SignalState>("blocked");
  const cyclePhaseRef = useRef<CyclePhase>("neutral");
  const cycleQuantityRef = useRef(0);
  const tickIndexRef = useRef(64);
  const realFeedStartedRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);

  const selected =
    holdings.find((holding) => holding.code === selectedCode) ?? holdings[0];
  const latestTick = ticks.at(-1);
  const currentPrice =
    config.mode === "demo"
      ? latestTick?.price ?? selected.price
      : selected.price;
  const change =
    selected.previousClose > 0
      ? ((currentPrice / selected.previousClose - 1) * 100) || 0
      : 0;
  const marketStatus = useMemo(() => getMarketStatus(clockNow), [clockNow]);
  const isRealFeed = config.mode !== "demo";
  const stale =
    isRealFeed &&
    marketStatus.allowQuotes &&
    lastReceivedAt !== null &&
    clockNow - lastReceivedAt > config.maxAgeSeconds * 1000;
  const monitoringActive =
    !eventRiskLocked &&
    (config.mode === "demo"
      ? demoPlaying
      : !paused &&
        marketStatus.allowSignals &&
        connection === "connected" &&
        !stale &&
        dataValidation?.passed === true);
  const modelContext = useMemo<ModelContext>(
    () => ({
      dataValid: config.mode === "demo" || dataValidation?.passed === true,
      indexSeriesValid:
        config.mode === "demo" || marketDataContext.indexSeriesValid,
      sectorSeriesValid:
        config.mode === "demo" || marketDataContext.sectorSeriesValid,
      dailySeriesValid:
        config.mode === "demo" || marketDataContext.dailySeriesValid,
      holdingShares: selected.shares,
      sellableShares: selected.sellable,
      turnaround: selected.turnaround,
      instrumentKind: marketDataContext.instrumentKind,
      dailyBars: config.mode === "demo" ? undefined : dailyBars,
      now: config.mode === "demo" ? undefined : clockNow,
      estimatedRoundTripCostPct: 0.08,
      expectedSlippagePct: 0.06,
    }),
    [
      clockNow,
      config.mode,
      dailyBars,
      dataValidation?.passed,
      marketDataContext,
      selected.sellable,
      selected.shares,
      selected.turnaround,
    ],
  );
  const baseSignal = useMemo(
    () => evaluateSignal(ticks, signalState, cyclePhase, modelContext),
    [cyclePhase, modelContext, signalState, ticks],
  );
  const blockedReason =
    eventRiskLocked
      ? "消息面风险锁定已开启"
      : config.mode === "demo"
        ? "历史演练未启动，样例曲线保持静止"
        : !marketStatus.allowSignals
          ? `${marketStatus.label}：${marketStatus.detail}`
        : dataValidation === null
          ? "等待东方财富官方最新价、分钟K线和市场上下文校验"
        : !dataValidation.passed
          ? `官方行情校验未通过：${dataValidation.reason}`
        : paused
        ? "监测已手动暂停"
        : stale
            ? `行情超过${config.maxAgeSeconds}秒未更新，已判定陈旧`
            : `${marketStatus.label}：${marketStatus.detail}`;

  const signal = useMemo(
    () =>
      monitoringActive
        ? baseSignal
        : {
            ...baseSignal,
            state: "blocked" as SignalState,
            bScore: 0,
            sScore: 0,
            recentSlope: 0,
            reasons: [blockedReason, "冻结B/S判断，不使用静态或陈旧报价"],
            invalidation: "等待有效行情时段",
          },
    [baseSignal, blockedReason, monitoringActive],
  );
  const emptyGuide = useMemo(
    () =>
      evaluateEmptyGuide(
        latestTick,
        signal,
        cyclePhase,
        waveGuide,
        monitoringActive,
      ),
    [cyclePhase, latestTick, monitoringActive, signal, waveGuide],
  );

  const playAlertSound = useCallback(
    (state: "confirmB" | "confirmS") => {
      const context = audioContextRef.current;
      if (!context) return;
      const play = () => playSignalTone(context, state);
      if (context.state === "suspended") {
        void context.resume().then(play).catch(() => undefined);
      } else {
        play();
      }
    },
    [],
  );

  const notify = useCallback(
    (state: SignalState, holding: Holding) => {
      if (
        !alertsEnabled ||
        (state !== "confirmB" && state !== "confirmS")
      ) return;
      const meta = SIGNAL_META[state];
      setSignalAlert({
        state,
        holdingName: holding.name.replace(/^示例：/, ""),
        code: holding.code,
        price: holding.price,
        occurredAt: Date.now(),
      });
      playAlertSound(state);
      if ("Notification" in window && Notification.permission === "granted") {
        const notification = new Notification(`${holding.name} · ${meta.label}`, {
          body: `${meta.short}。网页不执行任何交易。`,
        });
        notification.onclick = () => window.focus();
      }
      if ("vibrate" in navigator) {
        navigator.vibrate(
          state === "confirmB" ? [100, 80, 100] : [380],
        );
      }
    },
    [alertsEnabled, playAlertSound],
  );

  useEffect(() => {
    const first = window.setTimeout(() => setClockNow(Date.now()), 0);
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!window.isSecureContext) {
      setNotificationPermission("insecure");
    } else if ("Notification" in window) {
      setNotificationPermission(Notification.permission);
    } else {
      setNotificationPermission("unsupported");
    }
    return () => {
      const context = audioContextRef.current;
      if (context && context.state !== "closed") void context.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedHoldings = window.localStorage.getItem("t0-holdings");
      const savedConfig = window.localStorage.getItem("t0-feed-config-v3");
      const savedWaveGuide = window.localStorage.getItem("t0-wave-guide");
      const savedToken = window.sessionStorage.getItem("t0-session-token");
      const savedStopWatch = window.localStorage.getItem("t0-stopwatch-config");
      const savedStopWatchApiKey = window.sessionStorage.getItem(
        "t0-stopwatch-api-key",
      );
      try {
        if (savedHoldings) {
          const parsed = JSON.parse(savedHoldings) as Holding[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            setHoldings(parsed);
            setSelectedCode(parsed[0].code);
          } else {
            setHoldingsOpen(true);
          }
        } else {
          setHoldingsOpen(true);
        }
        if (savedConfig) {
          const parsed = JSON.parse(savedConfig) as Partial<FeedConfig>;
          const isBundledBridge =
            parsed.url === DEFAULT_CONFIG.url &&
            ["腾讯", "Tushare", "东方财富官方"].some((name) =>
              parsed.providerName?.includes(name),
            );
          setConfig(
            isBundledBridge
              ? DEFAULT_CONFIG
              : { ...DEFAULT_CONFIG, ...parsed },
          );
        }
        if (savedWaveGuide)
          setWaveGuide({
            ...DEFAULT_WAVE_GUIDE,
            ...JSON.parse(savedWaveGuide),
          });
        if (savedStopWatch) {
          setStopWatchConfig({
            ...DEFAULT_STOPWATCH_CONFIG,
            ...JSON.parse(savedStopWatch),
          });
        }
      } catch {
        setHoldingsOpen(true);
        setFeedMessage("本机旧配置无法读取，请重新设置持仓");
      }
      if (savedToken) setToken(savedToken);
      if (savedStopWatchApiKey) setStopWatchApiKey(savedStopWatchApiKey);
      setStorageReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem("t0-holdings", JSON.stringify(holdings));
  }, [holdings, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem("t0-feed-config-v3", JSON.stringify(config));
    window.sessionStorage.setItem("t0-session-token", token);
  }, [config, storageReady, token]);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem("t0-wave-guide", JSON.stringify(waveGuide));
  }, [storageReady, waveGuide]);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem(
      "t0-stopwatch-config",
      JSON.stringify(stopWatchConfig),
    );
    window.sessionStorage.setItem(
      "t0-stopwatch-api-key",
      stopWatchApiKey,
    );
  }, [storageReady, stopWatchApiKey, stopWatchConfig]);

  useEffect(() => {
    let active = true;
    const loadTrades = async () => {
      if (usesBrowserTradeLedger()) {
        try {
          const savedTrades = window.localStorage.getItem(
            PUBLIC_TRADE_LEDGER_KEY,
          );
          const parsed = savedTrades
            ? (JSON.parse(savedTrades) as ActualTrade[])
            : [];
          if (active) setTrades(Array.isArray(parsed) ? parsed : []);
        } catch {
          if (active) {
            setTrades([]);
            setFeedMessage("浏览器中的操作台账无法读取，已使用新的独立台账");
          }
        }
        return;
      }
      try {
        const response = await fetch("/api/trades", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { trades?: ActualTrade[] };
        if (active) setTrades(payload.trades ?? []);
      } catch (error) {
        if (active) {
          setFeedMessage(
            `真实成交归档读取失败：${
              error instanceof Error ? error.message : "未知错误"
            }`,
          );
        }
      }
    };
    void loadTrades();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || !usesBrowserTradeLedger()) return;
    window.localStorage.setItem(
      PUBLIC_TRADE_LEDGER_KEY,
      JSON.stringify(trades),
    );
  }, [storageReady, trades]);

  useEffect(() => {
    if (!monitoringActive) {
      signalRef.current = "blocked";
      return;
    }
    const reading = evaluateSignal(
      ticks,
      signalRef.current,
      cyclePhaseRef.current,
      modelContext,
    );
    if (reading.state !== signalRef.current) {
      signalRef.current = reading.state;
      setSignalState(reading.state);
      notify(reading.state, selected);
    }
  }, [modelContext, monitoringActive, notify, selected, ticks]);

  const appendTick = useCallback((tick: Tick) => {
    setTicks((current) => {
      if (!realFeedStartedRef.current) {
        realFeedStartedRef.current = true;
        return [tick];
      }
      return [...current.slice(-179), tick];
    });
  }, []);

  const activateHolding = useCallback(
    (next: Holding) => {
      setSelectedCode(next.code);
      setTicks(config.mode === "demo" ? makeInitialTicks(next) : []);
      setDailyBars([]);
      setMarketDataContext({
        ...EMPTY_MARKET_CONTEXT,
        instrumentKind: /^(15|16|18|50|51|52|56|58)/.test(next.code)
          ? "etf"
          : "stock",
      });
      setDataValidation(null);
      setPaperQuantity(oneThirdQuantity(next.sellable) || 100);
      setExecutionPrice(next.price);
      tickIndexRef.current = 64;
      signalRef.current = "blocked";
      cyclePhaseRef.current = "neutral";
      cycleQuantityRef.current = 0;
      setSignalState("blocked");
      setCyclePhase("neutral");
      setCycleQuantity(0);
      setEventRiskLocked(false);
      setLastReceivedAt(null);
      setLastSourceTime(null);
      setDataValidation(null);
      realFeedStartedRef.current = false;
      setConnection(config.mode === "demo" ? "paused" : "connecting");
    },
    [config.mode],
  );

  const selectHolding = useCallback(
    (code: string) => {
      const next = holdings.find((holding) => holding.code === code);
      if (!next) return;
      activateHolding(next);
    },
    [activateHolding, holdings],
  );

  const stopWatchPayload = useMemo(
    () =>
      buildStopWatchState({
        holdings,
        selectedCode: selected.code,
        ticks,
        signal,
        realtime: monitoringActive && !stale,
      }),
    [holdings, monitoringActive, selected.code, signal, stale, ticks],
  );

  useEffect(() => {
    if (
      !storageReady ||
      !stopWatchConfig.enabled ||
      !stopWatchApiKey ||
      stopWatchPayload.holdings.length === 0
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setStopWatchStatus("正在同步");
      void pushStopWatchState(
        stopWatchConfig,
        stopWatchApiKey,
        stopWatchPayload,
      )
        .then(() => {
          if (!cancelled) setStopWatchStatus("已同步实时行情");
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setStopWatchStatus(
              error instanceof Error ? error.message : "同步失败",
            );
          }
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    stopWatchApiKey,
    stopWatchConfig,
    stopWatchPayload,
    storageReady,
  ]);

  useEffect(() => {
    if (!stopWatchConfig.enabled || !stopWatchApiKey) return;
    let cancelled = false;
    const pollSelection = async () => {
      try {
        const deviceSelection = await readStopWatchSelection(
          stopWatchConfig,
          stopWatchApiKey,
        );
        if (
          !cancelled &&
          deviceSelection.selected_code &&
          deviceSelection.selected_code !== selected.code
        ) {
          selectHolding(deviceSelection.selected_code);
        }
      } catch {
        // State pushing owns the visible connection error; selection polling is best effort.
      }
    };
    void pollSelection();
    const timer = window.setInterval(pollSelection, 1800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    selectHolding,
    selected.code,
    stopWatchApiKey,
    stopWatchConfig,
  ]);

  useEffect(() => {
    if (config.mode === "demo") {
      if (!demoPlaying) {
        const statusTimer = window.setTimeout(() => {
          setConnection("paused");
          setFeedMessage("历史演练已暂停 · 图中不是实时行情");
        }, 0);
        return () => window.clearTimeout(statusTimer);
      }
      const statusTimer = window.setTimeout(() => {
        setConnection("connected");
        setFeedMessage("历史演练播放中 · 约1.2秒推进1分钟 · 非真实行情");
      }, 0);
      const timer = window.setInterval(() => {
        const index = tickIndexRef.current;
        const seed = Number(selected.code.slice(-2)) / 10;
        const move = demoDrift(index + 12) + seededNoise(index, seed);
        const receivedAt = Date.now();
        tickIndexRef.current += 1;
        setLastReceivedAt(receivedAt);
        setLastSourceTime(`历史演练 ${minuteLabel(index)}`);
        setTicks((current) => {
          const previous = current.at(-1)?.price ?? selected.price;
          const price = Math.max(0.01, previous * (1 + move));
          return [
            ...current.slice(-179),
            {
              time: minuteLabel(index),
              price,
              volume: 8000 + Math.round(Math.abs(move) * 9500000),
              sectorChange:
                ((price / selected.previousClose - 1) * 100) * 0.72,
              indexChange:
                ((price / selected.previousClose - 1) * 100) * 0.38,
              indexLevel:
                4000 *
                (1 +
                  (((price / selected.previousClose - 1) * 100) * 0.38) /
                    100),
            },
          ];
        });
      }, 1200);
      return () => {
        window.clearTimeout(statusTimer);
        window.clearInterval(timer);
      };
    }

    if (paused) {
      const statusTimer = window.setTimeout(() => {
        setConnection("paused");
        setFeedMessage("真实行情监测已手动暂停");
      }, 0);
      return () => window.clearTimeout(statusTimer);
    }

    if (!config.providerName.trim() || !config.url.trim()) {
      const statusTimer = window.setTimeout(() => {
        setConnection("error");
        setFeedMessage("请填写行情提供方名称和接口地址");
      }, 0);
      return () => window.clearTimeout(statusTimer);
    }

    if (config.mode === "rest") {
      let active = true;
      let polling = false;
      const poll = async () => {
        if (polling) return;
        polling = true;
        try {
          const url = config.url
            .replaceAll("{symbol}", selected.code)
            .replaceAll("{market}", selected.market);
          const headers: HeadersInit = token
            ? { Authorization: `Bearer ${token}` }
            : {};
          const response = await fetch(url, { headers, cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          const price = Number(readPath(payload, config.pricePath));
          if (!Number.isFinite(price)) throw new Error("价格字段无法解析");
          const fetchLatencyMs = Number(
            readPath(payload, "meta.fetchLatencyMs"),
          );
          const validation = readPath(payload, "meta.validation") as
            | { passed?: boolean; status?: string; reason?: string }
            | undefined;
          const previousClose = Number(
            readPath(payload, config.previousClosePath),
          );
          const receivedAt = Date.now();
          const sourceTimestamp = parseSourceTimestamp(
            readPath(payload, config.timePath),
            receivedAt,
          );
          const minuteBars = readPath(payload, "data.minuteBars");
          const payloadDailyBars = readPath(payload, "data.dailyBars");
          const payloadContext = readPath(payload, "data.context") as
            | Partial<MarketDataContext>
            | undefined;
          if (active && Array.isArray(minuteBars) && minuteBars.length > 0) {
            setTicks(
              minuteBars.slice(-180).map((bar) => {
                const minute = bar as Record<string, unknown>;
                const barTime = parseSourceTimestamp(
                  minute.time,
                  receivedAt,
                );
                const indexLevel = Number(minute.indexLevel);
                return {
                  price: Number(minute.close),
                  open: Number(minute.open),
                  high: Number(minute.high),
                  low: Number(minute.low),
                  volume: Number(minute.volume) || 1,
                  amount: Number(minute.amount) || 0,
                  time: barTime.minute,
                  sectorChange: Number(minute.sectorChange),
                  indexChange: Number(minute.indexChange),
                  indexLevel: Number.isFinite(indexLevel) ? indexLevel : undefined,
                };
              }),
            );
            realFeedStartedRef.current = true;
          } else if (active) {
            appendTick({
              price,
              volume: Number(readPath(payload, config.volumePath)) || 1,
              time: sourceTimestamp.minute,
              sectorChange: Number(readPath(payload, config.sectorPath)) || 0,
              indexChange: Number(readPath(payload, config.indexPath)) || 0,
              indexLevel:
                Number(readPath(payload, config.indexLevelPath)) || undefined,
            });
          }
          if (active) {
            setDailyBars(
              Array.isArray(payloadDailyBars)
                ? payloadDailyBars
                    .map((bar) => {
                      const daily = bar as Record<string, unknown>;
                      return {
                        date: String(daily.date || daily.trade_date || ""),
                        open: Number(daily.open),
                        high: Number(daily.high),
                        low: Number(daily.low),
                        close: Number(daily.close),
                        volume: Number(daily.volume ?? daily.vol) || 0,
                      };
                    })
                    .filter(
                      (bar) =>
                        /^\d{8}$/.test(bar.date) &&
                        [bar.open, bar.high, bar.low, bar.close].every(
                          Number.isFinite,
                        ),
                    )
                : [],
            );
            setMarketDataContext({
              instrumentKind:
                payloadContext?.instrumentKind === "etf" ||
                payloadContext?.instrumentKind === "bond"
                  ? payloadContext.instrumentKind
                  : "stock",
              indexName: payloadContext?.indexName,
              indexCode: payloadContext?.indexCode,
              indexSource: payloadContext?.indexSource,
              indexSourceTime: payloadContext?.indexSourceTime,
              indexSeriesValid: payloadContext?.indexSeriesValid === true,
              sectorName: payloadContext?.sectorName,
              sectorCode: payloadContext?.sectorCode,
              sectorSource: payloadContext?.sectorSource,
              sectorSourceTime: payloadContext?.sectorSourceTime,
              sectorSeriesValid: payloadContext?.sectorSeriesValid === true,
              dailySeriesValid: payloadContext?.dailySeriesValid === true,
              error: payloadContext?.error,
            });
            setDataValidation(
              validation
                ? {
                    passed: validation.passed === true,
                    status: validation.status || "unknown",
                    reason: validation.reason || "官方行情校验状态未知",
                  }
                : {
                    passed: false,
                    status: "unavailable",
                    reason: "行情源未返回官方行情校验结果",
                  },
            );
            setHoldings((current) =>
              current.map((holding) =>
                holding.code === selected.code
                  ? {
                      ...holding,
                      price,
                      previousClose:
                        Number.isFinite(previousClose) && previousClose > 0
                          ? previousClose
                          : holding.previousClose,
                    }
                  : holding,
              ),
            );
            setLastReceivedAt(receivedAt);
            setLastSourceTime(sourceTimestamp.full);
            setConnection(
              marketStatus.allowQuotes ? "connected" : "paused",
            );
            setFeedMessage(
              marketStatus.allowQuotes
                ? `${config.providerName} · 最新价 ${config.interval / 1000}秒轮询${
                    Number.isFinite(fetchLatencyMs)
                      ? ` · 源站 ${Math.round(fetchLatencyMs)}ms`
                      : ""
                  } · ${validation?.passed ? "官方行情校验通过" : validation?.reason || "等待官方行情校验"}`
                : `${marketStatus.label} · 已读取最近真实行情快照，B/S判断冻结`,
            );
          }
        } catch (error) {
          if (active) {
            setConnection("error");
            setFeedMessage(
              error instanceof Error ? error.message : "行情连接失败",
            );
          }
        } finally {
          polling = false;
        }
      };
      void poll();
      const timer = marketStatus.allowQuotes
        ? window.setInterval(poll, Math.max(config.interval, 1000))
        : null;
      return () => {
        active = false;
        if (timer !== null) window.clearInterval(timer);
      };
    }

    if (!marketStatus.allowQuotes) {
      const statusTimer = window.setTimeout(() => {
        setConnection("paused");
        setFeedMessage(`${marketStatus.label} · 不连接WebSocket行情`);
      }, 0);
      return () => window.clearTimeout(statusTimer);
    }

    const url = config.url
      .replaceAll("{symbol}", selected.code)
      .replaceAll("{market}", selected.market);
    const socket = new WebSocket(url);
    socket.onopen = () => {
      setConnection("connected");
      setFeedMessage(`${config.providerName} · WebSocket推送`);
      if (config.subscribeMessage.trim()) {
        socket.send(
          config.subscribeMessage
            .replaceAll("{symbol}", selected.code)
            .replaceAll("{market}", selected.market)
            .replaceAll("{token}", token),
        );
      }
    };
    socket.onerror = () => {
      setConnection("error");
      setFeedMessage("WebSocket连接失败");
    };
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const price = Number(readPath(payload, config.pricePath));
        if (!Number.isFinite(price)) return;
        const receivedAt = Date.now();
        const sourceTimestamp = parseSourceTimestamp(
          readPath(payload, config.timePath),
          receivedAt,
        );
        appendTick({
          price,
          volume: Number(readPath(payload, config.volumePath)) || 1,
          time: sourceTimestamp.minute,
          sectorChange: Number(readPath(payload, config.sectorPath)) || 0,
          indexChange: Number(readPath(payload, config.indexPath)) || 0,
          indexLevel:
            Number(readPath(payload, config.indexLevelPath)) || undefined,
        });
        setLastReceivedAt(receivedAt);
        setLastSourceTime(sourceTimestamp.full);
      } catch {
        setFeedMessage("收到无法解析的行情消息");
      }
    };
    return () => socket.close();
  }, [
    appendTick,
    config,
    demoPlaying,
    marketStatus.allowQuotes,
    marketStatus.label,
    paused,
    selected.code,
    selected.market,
    selected.previousClose,
    selected.price,
    token,
  ]);

  const requestNotifications = async () => {
    if (alertsEnabled) {
      setAlertsEnabled(false);
      setSignalAlert(null);
      setFeedMessage("B/S成熟提醒已关闭");
      return;
    }

    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (AudioContextConstructor) {
      const context =
        audioContextRef.current ?? new AudioContextConstructor();
      audioContextRef.current = context;
      if (context.state === "suspended") await context.resume();
      playAlertEnabledTone(context);
    }

    let permission: NotificationPermissionState = "unsupported";
    if (!window.isSecureContext) {
      permission = "insecure";
    } else if ("Notification" in window) {
      permission =
        Notification.permission === "default"
          ? await Notification.requestPermission()
          : Notification.permission;
    }
    setNotificationPermission(permission);
    setAlertsEnabled(true);
    setFeedMessage(
      permission === "granted"
        ? "B/S弹窗、声音和系统通知已开启"
        : permission === "denied"
          ? "B/S弹窗和声音已开启；系统通知被浏览器拒绝"
          : permission === "insecure"
            ? "B/S弹窗和声音已开启；系统通知需要HTTPS"
            : "B/S弹窗和声音已开启；当前浏览器不支持系统通知",
    );
  };

  const recordActualTrade = async (side: "buy" | "sell") => {
    const quantity = Math.max(0, Math.floor(Number(paperQuantity)));
    const price = Number(executionPrice);
    const fee = Math.max(0, Number(tradeFee) || 0);
    if (quantity <= 0) {
      setFeedMessage("请输入真实成交数量");
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      setFeedMessage("请输入真实成交价格");
      return;
    }
    if (side === "sell" && quantity > selected.shares) {
      setFeedMessage(`实际卖出不能超过当前持仓 ${selected.shares} 股`);
      return;
    }
    if (side === "sell" && quantity > selected.sellable) {
      setFeedMessage(`实际卖出不能超过今日可卖 ${selected.sellable} 股`);
      return;
    }

    const timestamp = Date.now();
    const actualTrade: ActualTrade = {
      id: `${timestamp}-${selected.code}-${side}`,
      timestamp,
      time: new Date(timestamp).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
      code: selected.code,
      side,
      quantity,
      price,
      fee,
    };
    if (!usesBrowserTradeLedger()) {
      try {
        const response = await fetch("/api/trades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(actualTrade),
        });
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string };
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
      } catch (error) {
        setFeedMessage(
          `真实成交未记录：${
            error instanceof Error ? error.message : "本地归档不可用"
          }`,
        );
        return;
      }
    }

    setHoldings((current) =>
      current.map((holding) => {
        if (holding.code !== selected.code) return holding;
        if (side === "buy") {
          const shares = holding.shares + quantity;
          return {
            ...holding,
            shares,
            sellable:
              holding.turnaround === "t0"
                ? holding.sellable + quantity
                : holding.sellable,
            cost:
              (holding.cost * holding.shares + price * quantity + fee) /
              shares,
          };
        }
        const shares = holding.shares - quantity;
        return {
          ...holding,
          shares,
          sellable: Math.max(0, holding.sellable - quantity),
          cost:
            shares > 0
              ? Math.max(
                  0,
                  (holding.cost * holding.shares - price * quantity + fee) /
                    shares,
                )
              : 0,
        };
      }),
    );

    setTrades((current) => [actualTrade, ...current]);

    const currentSide =
      cyclePhaseRef.current === "boughtForT"
        ? "buy"
        : cyclePhaseRef.current === "soldBase"
          ? "sell"
          : null;
    if (currentSide === null || currentSide === side) {
      const nextPhase: CyclePhase =
        side === "buy" ? "boughtForT" : "soldBase";
      const nextQuantity =
        currentSide === side ? cycleQuantityRef.current + quantity : quantity;
      cyclePhaseRef.current = nextPhase;
      cycleQuantityRef.current = nextQuantity;
      setCyclePhase(nextPhase);
      setCycleQuantity(nextQuantity);
    } else if (quantity === cycleQuantityRef.current) {
      cyclePhaseRef.current = "neutral";
      cycleQuantityRef.current = 0;
      setCyclePhase("neutral");
      setCycleQuantity(0);
    } else if (quantity < cycleQuantityRef.current) {
      const remaining = cycleQuantityRef.current - quantity;
      cycleQuantityRef.current = remaining;
      setCycleQuantity(remaining);
    } else {
      const nextPhase: CyclePhase =
        side === "buy" ? "boughtForT" : "soldBase";
      const remaining = quantity - cycleQuantityRef.current;
      cyclePhaseRef.current = nextPhase;
      cycleQuantityRef.current = remaining;
      setCyclePhase(nextPhase);
      setCycleQuantity(remaining);
    }

    setExecutionPrice(currentPrice);
    setTradeFee(0);
    setFeedMessage(
      `已记录真实${side === "buy" ? "买入" : "卖出"} ${quantity} 股，成交价 ¥${price.toFixed(2)}；未发送任何委托`,
    );
  };

  const updateLedger = (
    field: "shares" | "sellable" | "cost",
    value: number,
  ) => {
    setHoldings((current) =>
      current.map((holding) =>
        holding.code === selected.code
          ? {
              ...holding,
              [field]:
                field === "cost"
                  ? Math.max(0, value)
                  : Math.max(0, Math.floor(value / 100) * 100),
            }
          : holding,
      ),
    );
  };

  const openNewHolding = () => {
    setEditingCode(null);
    setHoldingDraft(EMPTY_HOLDING_DRAFT);
    setHoldingFormError("");
    setHoldingsOpen(true);
  };

  const openEditHolding = (holding: Holding) => {
    setEditingCode(holding.code);
    setHoldingDraft({
      code: holding.code,
      name: holding.name,
      sector: holding.sector,
      shares: String(holding.shares),
      sellable: String(holding.sellable),
      cost: String(holding.cost),
      turnaround: holding.turnaround === "t0" ? "t0" : "t1",
    });
    setHoldingFormError("");
  };

  const saveHolding = () => {
    const code = holdingDraft.code.replace(/\D/g, "");
    const name = holdingDraft.name.trim();
    const shares = Math.max(0, Math.floor(Number(holdingDraft.shares)));
    const sellable = Math.max(0, Math.floor(Number(holdingDraft.sellable)));
    const cost = Math.max(0, Number(holdingDraft.cost));

    if (!/^\d{6}$/.test(code)) {
      setHoldingFormError("请输入6位A股或场内ETF代码，例如 600519、510300");
      return;
    }
    if (!name) {
      setHoldingFormError("请输入股票名称，便于在监测列表中识别");
      return;
    }
    if (![shares, sellable, cost].every(Number.isFinite)) {
      setHoldingFormError("持仓、可卖数量和成本必须是有效数字");
      return;
    }
    if (sellable > shares) {
      setHoldingFormError("今日可卖数量不能超过当前持仓");
      return;
    }
    if (
      holdings.some(
        (holding) => holding.code === code && holding.code !== editingCode,
      )
    ) {
      setHoldingFormError("该代码已经在监测列表中");
      return;
    }

    const existing = editingCode
      ? holdings.find((holding) => holding.code === editingCode)
      : undefined;
    const nextHolding: Holding = {
      code,
      name,
      market: inferMarketFromCode(code),
      sector: holdingDraft.sector.trim() || "未填写行业",
      shares,
      sellable,
      cost,
      price: existing?.code === code ? existing.price : 0,
      previousClose: existing?.code === code ? existing.previousClose : 0,
      turnaround: holdingDraft.turnaround,
    };

    setHoldings((current) =>
      editingCode
        ? current.map((holding) =>
            holding.code === editingCode ? nextHolding : holding,
          )
        : [...current, nextHolding],
    );
    activateHolding(nextHolding);
    setEditingCode(nextHolding.code);
    setHoldingDraft({
      code: nextHolding.code,
      name: nextHolding.name,
      sector: nextHolding.sector,
      shares: String(nextHolding.shares),
      sellable: String(nextHolding.sellable),
      cost: String(nextHolding.cost),
      turnaround: nextHolding.turnaround,
    });
    setHoldingFormError("");
    setFeedMessage(`已开始追踪 ${nextHolding.name}（${nextHolding.code}）`);
  };

  const removeHolding = (holding: Holding) => {
    if (holdings.length <= 1) {
      setHoldingFormError("至少保留一只股票；请先添加新股票再删除此项");
      return;
    }
    if (!window.confirm(`从监测列表移除 ${holding.name}（${holding.code}）？`))
      return;
    const remaining = holdings.filter((item) => item.code !== holding.code);
    setHoldings(remaining);
    if (selected.code === holding.code) activateHolding(remaining[0]);
    if (editingCode === holding.code) {
      setEditingCode(null);
      setHoldingDraft(EMPTY_HOLDING_DRAFT);
    }
    setHoldingFormError("");
  };

  const meta = SIGNAL_META[signal.state];
  const tModeMeta = T_MODE_META[signal.tMode];
  const selectedTrades = useMemo(
    () => trades.filter((trade) => trade.code === selected.code),
    [selected.code, trades],
  );
  const tradeSummary = useMemo(
    () => summarizeTradingCycles(selectedTrades, selected.code),
    [selected.code, selectedTrades],
  );
  const recommendedQuantity =
    recommendTrancheQuantity(
      selected.sellable,
      signal,
      cyclePhase,
      cycleQuantity,
    );
  const realizedCostReductionPerShare =
    selected.shares > 0
      ? tradeSummary.contribution / selected.shares
      : 0;
  const phaseLabel =
    cyclePhase === "boughtForT"
      ? "已记录真实买入，等待对应卖出闭环"
      : cyclePhase === "soldBase"
        ? "已记录真实卖出，等待对应买回闭环"
        : `下一步等待${signal.nextAction === "WAIT" ? "有效环境" : `${signal.nextAction}点`}`;
  const displayedConnection: ConnectionState =
    config.mode === "demo"
      ? demoPlaying
        ? connection
        : "paused"
      : stale || (dataValidation !== null && !dataValidation.passed)
        ? "error"
        : paused || !marketStatus.allowQuotes
          ? "paused"
          : connection;
  const connectionLabel =
    config.mode === "demo"
      ? demoPlaying
        ? "历史演练中"
        : "演练未启动"
      : stale
        ? "行情已陈旧"
        : dataValidation !== null && !dataValidation.passed
          ? "官方行情校验冻结"
        : displayedConnection === "connected"
          ? "行情已连接"
          : displayedConnection === "paused"
            ? marketStatus.label
            : displayedConnection === "error"
              ? "连接异常"
              : "正在连接";
  const sourceName =
    config.mode === "demo"
      ? "本地历史演练"
      : config.providerName.trim() || "未配置行情源";
  const delayLabel =
    config.mode === "demo"
      ? "非真实行情"
      : config.delayType === "realtime"
        ? "已声明实时"
        : config.delayType === "delayed"
          ? "延时行情"
          : "时效未知";
  const marketValue = selected.shares * currentPrice;
  const pnl = selected.shares * (currentPrice - selected.cost);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">T</div>
          <div>
            <strong>分时罗盘</strong>
            <span>只读行情实验台</span>
          </div>
        </div>
        <div className="topbar-actions">
          <Link className="button secondary button-link agent-entry" href="/bond-radar">
            转债同步雷达
          </Link>
          <Link className="button secondary button-link agent-entry" href="/agent">
            成功率Agent
          </Link>
          <div className={`connection ${displayedConnection}`}>
            <span className="connection-dot" />
            {connectionLabel}
          </div>
          <button
            className="button secondary"
            onClick={() => {
              if (config.mode === "demo") {
                setDemoPlaying((current) => !current);
              } else {
                setPaused((current) => !current);
              }
            }}
          >
            {config.mode === "demo"
              ? demoPlaying
                ? "暂停演练"
                : "开始历史演练"
              : paused
                ? "继续监测"
                : "暂停监测"}
          </button>
          <button className="button primary" onClick={() => setConfigOpen(true)}>
            行情配置
          </button>
        </div>
      </header>

      <div className="privacy-strip">
        <strong>只读模式</strong>
        <span>不连接证券账户，不读取资金，不具备下单能力</span>
        <span className="feed-message">{feedMessage}</span>
      </div>
      <div className="provenance-strip">
        <span className={`session-chip ${marketStatus.kind}`}>
          {marketStatus.label}
        </span>
        <span>
          来源 <strong>{sourceName}</strong>
        </span>
        <span>{delayLabel}</span>
        <span>
          源时间 <strong>{lastSourceTime ?? "--"}</strong>
        </span>
        <span>
          本机接收{" "}
          <strong>
            {lastReceivedAt ? formatShanghaiTimestamp(lastReceivedAt) : "--"}
          </strong>
        </span>
        <a
          href="https://www.sse.com.cn/disclosure/dealinstruc/closed/"
          target="_blank"
          rel="noreferrer"
        >
          交易日历依据
        </a>
        {stale && <span className="stale-warning">超过时效阈值，信号冻结</span>}
        {config.mode !== "demo" && dataValidation && !dataValidation.passed && (
          <span className="stale-warning">
            官方行情校验冻结：{dataValidation.reason}
          </span>
        )}
      </div>

      <section className="workspace">
        <aside className="watchlist panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">手工持仓</span>
              <h2>监测列表</h2>
            </div>
            <div className="watchlist-actions">
              <span className="count">{holdings.length}</span>
              <button className="watchlist-manage" onClick={openNewHolding}>
                管理持仓
              </button>
            </div>
          </div>
          <div className="holding-list">
            {holdings.map((holding) => {
              const active = holding.code === selected.code;
              const displayPrice = active ? currentPrice : holding.price;
              const displayChange =
                holding.previousClose > 0
                  ? ((displayPrice / holding.previousClose - 1) * 100) || 0
                  : 0;
              return (
                <button
                  className={`holding-row ${active ? "active" : ""}`}
                  key={holding.code}
                  onClick={() => selectHolding(holding.code)}
                >
                  <div>
                    <strong>{holding.name}</strong>
                    <span>
                      {holding.market} {holding.code} · {holding.turnaround === "t0" ? "T+0" : "T+1"}
                    </span>
                  </div>
                  <div className="holding-price">
                    <strong>
                      {displayPrice > 0 ? displayPrice.toFixed(2) : "--"}
                    </strong>
                    <span className={displayChange >= 0 ? "up" : "down"}>
                      {displayChange >= 0 ? "+" : ""}
                      {displayChange.toFixed(2)}%
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="watchlist-note">
            <span>数据边界</span>
            网页仅轮询当前选中的标的。持仓配置只保存在这台设备；股票使用申万一级行业分钟序列，ETF使用跟踪指数分钟序列，任一上下文缺失都会冻结B/S判断。
          </div>
        </aside>

        <section className="chart-panel panel">
          <div className="instrument-header">
            <div>
              <div className="instrument-title">
                <h1>{selected.name}</h1>
                <span>
                  {selected.market}.{selected.code}
                </span>
              </div>
              <div className="sector">{selected.sector}</div>
            </div>
            <div className="quote-block">
              <strong className={change >= 0 ? "up" : "down"}>
                {currentPrice > 0 ? currentPrice.toFixed(2) : "--"}
              </strong>
              <span className={change >= 0 ? "up" : "down"}>
                {selected.previousClose > 0 ? (
                  <>
                    {change >= 0 ? "+" : ""}
                    {(currentPrice - selected.previousClose).toFixed(2)} ·{" "}
                    {change >= 0 ? "+" : ""}
                    {change.toFixed(2)}%
                  </>
                ) : (
                  "等待首个真实报价"
                )}
              </span>
            </div>
          </div>

          <div className="market-pulse">
            <div>
              <span>
                {marketDataContext.instrumentKind === "etf"
                  ? "跟踪指数"
                  : "行业强度"}
                {marketDataContext.sectorName
                  ? ` · ${marketDataContext.sectorName}`
                  : ""}
              </span>
              <strong
                className={
                  (latestTick?.sectorChange ?? 0) >= 0 ? "up" : "down"
                }
              >
                {(latestTick?.sectorChange ?? 0).toFixed(2)}%
              </strong>
            </div>
            <div>
              <span>
                大盘强度
                {Number.isFinite(latestTick?.indexLevel)
                  ? ` · ${latestTick?.indexLevel?.toFixed(2)}`
                  : ""}
              </span>
              <strong
                className={(latestTick?.indexChange ?? 0) >= 0 ? "up" : "down"}
              >
                {(latestTick?.indexChange ?? 0).toFixed(2)}%
              </strong>
            </div>
            <div>
              <span>日内均价</span>
              <strong>{signal.vwap.toFixed(2)}</strong>
            </div>
            <div>
              <span>5分钟动量</span>
              <strong className={signal.recentSlope >= 0 ? "up" : "down"}>
                {signal.recentSlope >= 0 ? "+" : ""}
                {signal.recentSlope.toFixed(2)}%
              </strong>
            </div>
            <div>
              <span>MACD辅助 (12,26,9)</span>
              <strong
                className={signal.macd.histogram >= 0 ? "up" : "down"}
                title={`DIF ${signal.macd.dif.toFixed(4)} / DEA ${signal.macd.dea.toFixed(4)}`}
              >
                {signal.macd.histogram >= 0 ? "+" : ""}
                {signal.macd.histogram.toFixed(4)}
              </strong>
            </div>
          </div>

          <div className="chart-wrap">
            <IntradayChart
              ticks={ticks}
              previousClose={selected.previousClose}
              signal={signal}
            />
            <div className="chart-legend">
              <span>
                <i className="legend-line price" />
                分时
              </span>
              <span>
                <i className="legend-line average" />
                均价
              </span>
              <span>
                <i className="legend-line close" />
                昨收
              </span>
            </div>
            <div className={`chart-source-note ${config.mode}`}>
              {config.mode === "demo"
                ? "历史演练 · 非真实行情"
                : `${sourceName} · ${delayLabel}`}
            </div>
          </div>
        </section>

        <aside className="signal-panel panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">状态机</span>
              <h2>当前判断</h2>
            </div>
            <span className="time-stamp">{latestTick?.time ?? "--:--"}</span>
          </div>

          <div className={`state-card ${meta.tone}`}>
            <span>分时状态</span>
            <strong>{meta.label}</strong>
            <p>{meta.short}</p>
          </div>

          <div className={`strategy-card ${signal.tMode}`}>
            <div className="strategy-head">
              <div>
                <span>课程规则模式</span>
                <strong>
                  {tModeMeta.label} · {tModeMeta.sequence}
                </strong>
              </div>
              <b>{phaseLabel}</b>
            </div>
            <p>{tModeMeta.description}</p>
            <div className="strategy-metrics">
              <span>
                箱体位置 <strong>{signal.rangePosition.toFixed(0)}%</strong>
              </span>
              <span>
                多日位置 <strong>{signal.multiDayRangePosition.toFixed(0)}%</strong>
              </span>
              <span>
                5分钟量能 <strong>{VOLUME_PHASE_LABEL[signal.volumePhase]}</strong>
              </span>
              <span>
                波段量比 <strong>{signal.volumeRatio.toFixed(2)}x</strong>
              </span>
              <span>
                个股趋势{" "}
                <strong>
                  {signal.stockTrend >= 0 ? "+" : ""}
                  {signal.stockTrend.toFixed(2)}%
                </strong>
              </span>
              <span>
                板块趋势{" "}
                <strong>
                  {signal.sectorTrend >= 0 ? "+" : ""}
                  {signal.sectorTrend.toFixed(2)}%
                </strong>
              </span>
              <span>
                建议批次 <strong>{recommendedQuantity}股</strong>
              </span>
              <span>
                预计差价 <strong>{signal.expectedSpreadPct.toFixed(2)}%</strong>
              </span>
              <span>
                硬门槛 <strong>{signal.hardGates.filter((gate) => gate.passed).length}/5</strong>
              </span>
            </div>
          </div>

          <div className="scores">
            <ScoreBar label="B点成熟度" score={signal.bScore} tone="buy" />
            <ScoreBar label="S点成熟度" score={signal.sScore} tone="sell" />
          </div>

          <div className="evidence">
            <h3>判断依据</h3>
            <ul>
              {signal.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>

          <div className="invalidation">
            <span>失效条件</span>
            <strong>{signal.invalidation}</strong>
          </div>

          <div className={`empty-guide ${emptyGuide.tone}`}>
            <div className="empty-guide-head">
              <span>大盘波浪 · 个股空仓指引</span>
              <strong>{emptyGuide.title}</strong>
            </div>
            <p>{emptyGuide.action}</p>
            {emptyGuide.confirmations.length > 0 && (
              <div className="empty-guide-list confirmed">
                {emptyGuide.confirmations.map((item) => (
                  <span key={item}>已确认 · {item}</span>
                ))}
              </div>
            )}
            {emptyGuide.missing.length > 0 && (
              <div className="empty-guide-list missing">
                {emptyGuide.missing.map((item) => (
                  <span key={item}>待确认 · {item}</span>
                ))}
              </div>
            )}
          </div>

          <label className={`risk-lock ${eventRiskLocked ? "active" : ""}`}>
            <input
              type="checkbox"
              checked={eventRiskLocked}
              onChange={(event) => {
                const locked = event.target.checked;
                setEventRiskLocked(locked);
                if (locked) {
                  signalRef.current = "blocked";
                  cyclePhaseRef.current = "neutral";
                  cycleQuantityRef.current = 0;
                  setCyclePhase("neutral");
                  setCycleQuantity(0);
                  setSignalState("blocked");
                }
              }}
            />
            <span>
              <strong>消息面风险锁定</strong>
              重大利空、停复牌或突发事件时手动开启
            </span>
          </label>

          <button
            className="button notify"
            aria-pressed={alertsEnabled}
            onClick={requestNotifications}
          >
            {alertsEnabled ? "关闭B/S成熟提醒" : "开启B/S弹窗与声音"}
          </button>
          <p className="microcopy" role="status">
            {alertsEnabled
              ? notificationPermission === "granted"
                ? "网页弹窗、提示音和系统通知均已开启。"
                : "网页弹窗和提示音已开启；系统通知尚未授权。"
              : "仅在B/S确认成熟时提醒，观察信号不会打扰。"}
          </p>
          <div className="alert-permission-summary">
            <strong>浏览器权限说明</strong>
            <span>网页弹窗无需权限；提示音需先点击上方按钮解锁播放。</span>
            <span>系统通知需使用 HTTPS，并在浏览器询问时选择“允许”。</span>
            <span>无需麦克风、摄像头、位置或券商账户权限。</span>
          </div>
        </aside>
      </section>

      <section className="ledger panel">
        <div className="ledger-head">
          <div>
            <span className="eyebrow">本机保存 · 手工确认真实成交</span>
            <h2>真实持仓与做T账本</h2>
          </div>
          <div className="ledger-summary">
            <span>
              市值{" "}
              <strong>
                ¥
                {marketValue.toLocaleString("zh-CN", {
                  maximumFractionDigits: 0,
                })}
              </strong>
            </span>
            <span>
              浮动盈亏{" "}
              <strong className={pnl >= 0 ? "up" : "down"}>
                ¥
                {pnl.toLocaleString("zh-CN", {
                  maximumFractionDigits: 0,
                })}
              </strong>
            </span>
          </div>
        </div>

        <div className="ledger-grid">
          <label>
            <span>持仓股数</span>
            <input
              type="number"
              step="100"
              value={selected.shares}
              onChange={(event) =>
                updateLedger("shares", Number(event.target.value))
              }
            />
          </label>
          <label>
            <span>今日可卖</span>
            <input
              type="number"
              step="100"
              value={selected.sellable}
              onChange={(event) =>
                updateLedger("sellable", Number(event.target.value))
              }
            />
          </label>
          <label>
            <span>持仓成本</span>
            <input
              type="number"
              step="0.001"
              value={selected.cost}
              onChange={(event) =>
                updateLedger("cost", Number(event.target.value))
              }
            />
          </label>
          <label>
            <span>真实成交数量 · 策略参考 {recommendedQuantity}股</span>
            <input
              type="number"
              step="100"
              min="1"
              value={paperQuantity}
              onChange={(event) => setPaperQuantity(Number(event.target.value))}
            />
          </label>
          <label>
            <span>真实成交价</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={executionPrice}
              onChange={(event) =>
                setExecutionPrice(Number(event.target.value))
              }
            />
            <button
              className="text-button fill-price"
              type="button"
              onClick={() => setExecutionPrice(currentPrice)}
            >
              填入当前行情价 ¥{currentPrice.toFixed(2)}
            </button>
          </label>
          <label>
            <span>本次佣金及费用</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={tradeFee}
              onChange={(event) => setTradeFee(Number(event.target.value))}
            />
          </label>
          <div className="paper-actions">
            <button
              className="button paper-buy"
              onClick={() => recordActualTrade("buy")}
            >
              记录真实买入
            </button>
            <button
              className="button paper-sell"
              onClick={() => recordActualTrade("sell")}
            >
              记录真实卖出
            </button>
          </div>
        </div>

        <div className="t-performance">
          <article>
            <span>完整做T周期</span>
            <strong>{tradeSummary.cycles.length}</strong>
            <small>
              成功 {tradeSummary.wins} / 失败{" "}
              {tradeSummary.cycles.length - tradeSummary.wins}
            </small>
          </article>
          <article>
            <span>降低成本成功率</span>
            <strong>
              {tradeSummary.cycles.length > 0
                ? `${tradeSummary.successRate.toFixed(1)}%`
                : "--"}
            </strong>
            <small>仅统计已闭合买卖周期</small>
          </article>
          <article>
            <span>累计降本贡献</span>
            <strong
              className={
                tradeSummary.contribution >= 0 ? "up" : "down"
              }
            >
              {tradeSummary.contribution >= 0 ? "+" : ""}¥
              {tradeSummary.contribution.toFixed(2)}
            </strong>
            <small>已扣除录入的佣金及费用</small>
          </article>
          <article>
            <span>折算每股成本影响</span>
            <strong
              className={
                realizedCostReductionPerShare >= 0 ? "up" : "down"
              }
            >
              {realizedCostReductionPerShare >= 0 ? "-" : "+"}¥
              {Math.abs(realizedCostReductionPerShare).toFixed(4)}
            </strong>
            <small>
              {tradeSummary.pendingQuantity > 0
                ? `待闭合 ${
                    tradeSummary.pendingSide === "buy" ? "买入" : "卖出"
                  } ${tradeSummary.pendingQuantity}股`
                : "当前无未闭合动作"}
            </small>
          </article>
        </div>

        <div className="trade-log">
          <div className="trade-log-head">
            <h3>真实成交记录</h3>
            <span className="archive-badge">本地数据库 · 追加保存</span>
          </div>
          {selectedTrades.length === 0 ? (
            <div className="empty-log">
              尚无真实成交记录。请按券商成交回报填写价格、数量和费用；保存后将纳入跨日做T统计。
            </div>
          ) : (
            <div className="trade-items">
              {selectedTrades.slice(0, 12).map((trade) => (
                <div className="trade-item" key={trade.id}>
                  <span>{trade.time}</span>
                  <strong className={trade.side === "buy" ? "up" : "down"}>
                    真实{trade.side === "buy" ? "买入" : "卖出"}
                  </strong>
                  <span>{trade.quantity}股</span>
                  <span>¥{trade.price.toFixed(2)}</span>
                  <span>费用 ¥{trade.fee.toFixed(2)}</span>
                  <span>{trade.code}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {signalAlert && (
        <div
          className="modal-backdrop signal-alert-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setSignalAlert(null);
          }}
        >
          <section
            className={`signal-alert-dialog ${
              signalAlert.state === "confirmB" ? "buy" : "sell"
            }`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="signal-alert-title"
            aria-describedby="signal-alert-description"
          >
            <div className="signal-alert-heading">
              <span className="signal-alert-mark">
                {signalAlert.state === "confirmB" ? "B" : "S"}
              </span>
              <div>
                <span className="eyebrow">条件成熟提醒</span>
                <h2 id="signal-alert-title">
                  {signalAlert.holdingName} · {SIGNAL_META[signalAlert.state].label}
                </h2>
              </div>
            </div>
            <p id="signal-alert-description">
              {SIGNAL_META[signalAlert.state].short}。请先复核行情源时间、硬门槛、可卖数量与预计差价，再自行决定是否操作。
            </p>
            <div className="signal-alert-facts">
              <span>
                证券代码 <strong>{signalAlert.code}</strong>
              </span>
              <span>
                触发价格 <strong>¥{signalAlert.price.toFixed(2)}</strong>
              </span>
              <span>
                北京时间 <strong>{formatShanghaiTimestamp(signalAlert.occurredAt)}</strong>
              </span>
            </div>
            <button
              className="button primary"
              autoFocus
              onClick={() => setSignalAlert(null)}
            >
              我知道了，返回复核
            </button>
            <small>只读决策辅助，不连接券商账户，不会自动下单。</small>
          </section>
        </div>
      )}

      {holdingsOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setHoldingsOpen(false);
          }}
        >
          <section
            className="config-modal holdings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="holdings-title"
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow">设备本地保存</span>
                <h2 id="holdings-title">管理监测股票</h2>
              </div>
              <button
                className="close-button"
                aria-label="关闭持仓管理"
                onClick={() => setHoldingsOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="holding-manager-layout">
              <div className="holding-manager-list">
                <div className="holding-manager-title">
                  <strong>监测列表</strong>
                  <button className="text-button" onClick={openNewHolding}>
                    + 添加股票
                  </button>
                </div>
                {holdings.map((holding) => (
                  <div
                    className={`holding-manager-item ${
                      editingCode === holding.code ? "active" : ""
                    }`}
                    key={holding.code}
                  >
                    <button onClick={() => openEditHolding(holding)}>
                      <strong>{holding.name}</strong>
                      <span>
                        {holding.market} {holding.code} · {holding.shares}股 · {holding.turnaround === "t0" ? "T+0" : "T+1"}
                      </span>
                    </button>
                    <button
                      className="remove-holding"
                      aria-label={`移除${holding.name}`}
                      onClick={() => removeHolding(holding)}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>

              <form
                className="holding-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveHolding();
                }}
              >
                <div className="holding-editor-heading">
                  <strong>{editingCode ? "编辑股票" : "添加股票"}</strong>
                  <span>支持沪深北A股和6位场内ETF代码</span>
                </div>
                <label>
                  <span>股票名称</span>
                  <input
                    autoFocus
                    type="text"
                    value={holdingDraft.name}
                    placeholder="例如：贵州茅台"
                    onChange={(event) =>
                      setHoldingDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>A股 / 场内ETF代码</span>
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    value={holdingDraft.code}
                    placeholder="例如：600519"
                    onChange={(event) =>
                      setHoldingDraft((current) => ({
                        ...current,
                        code: event.target.value.replace(/\D/g, "").slice(0, 6),
                      }))
                    }
                  />
                  <small>自动识别沪市、深市和北交所；ETF同样输入6位代码。</small>
                </label>
                <label>
                  <span>行业/备注</span>
                  <input
                    type="text"
                    value={holdingDraft.sector}
                    placeholder="可选，例如：白酒"
                    onChange={(event) =>
                      setHoldingDraft((current) => ({
                        ...current,
                        sector: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>交易回转规则</span>
                  <select
                    value={holdingDraft.turnaround}
                    onChange={(event) =>
                      setHoldingDraft((current) => ({
                        ...current,
                        turnaround: event.target.value as "t0" | "t1",
                      }))
                    }
                  >
                    <option value="t1">T+1 · A股及境内股票ETF通常选择</option>
                    <option value="t0">T+0 · 仅限确认支持当日回转的ETF</option>
                  </select>
                  <small>请以券商页面和基金交易规则为准，工具不会只凭代码猜测。</small>
                </label>
                <div className="holding-number-grid">
                  <label>
                    <span>持仓股数</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={holdingDraft.shares}
                      onChange={(event) =>
                        setHoldingDraft((current) => ({
                          ...current,
                          shares: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>今日可卖</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={holdingDraft.sellable}
                      onChange={(event) =>
                        setHoldingDraft((current) => ({
                          ...current,
                          sellable: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>持仓成本</span>
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={holdingDraft.cost}
                      onChange={(event) =>
                        setHoldingDraft((current) => ({
                          ...current,
                          cost: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                {holdingFormError && (
                  <p className="holding-form-error">{holdingFormError}</p>
                )}
                <button className="button primary" type="submit">
                  {editingCode ? "保存并追踪" : "添加并追踪"}
                </button>
                <p className="holding-privacy-note">
                  这些信息仅保存在当前浏览器，不会上传到 GitHub，也不会连接券商账户。
                </p>
              </form>
            </div>
          </section>
        </div>
      )}

      {configOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setConfigOpen(false);
          }}
        >
          <section
            className="config-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="config-title"
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow">只读数据源</span>
                <h2 id="config-title">行情接口配置</h2>
              </div>
              <button
                className="close-button"
                aria-label="关闭行情配置"
                onClick={() => setConfigOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="segmented">
              {(
                [
                  ["demo", "历史演练"],
                  ["rest", "REST轮询"],
                  ["websocket", "WebSocket"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className={config.mode === mode ? "active" : ""}
                  onClick={() => {
                    setDemoPlaying(false);
                    setLastReceivedAt(null);
                    setLastSourceTime(null);
                    realFeedStartedRef.current = false;
                    setTicks(
                      mode === "demo" ? makeInitialTicks(selected) : [],
                    );
                    setConfig((current) => ({ ...current, mode }));
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {config.mode === "demo" ? (
              <div className="demo-description">
                <strong>仅供验证界面和状态机，不代表当前行情</strong>
                <p>
                  样例分时默认静止，保存后需手动点击“开始历史演练”才会推进。休市日也不会把它标记为实时数据。
                </p>
              </div>
            ) : (
              <>
                <div className="source-guidance">
                  当前默认接入项目自带的东方财富免费公开行情桥，不需要 API Key。普通桌面或手机端 L2 会员不等于 API
                  权限；只有服务商明确授权的 API、SDK 或行情网关才可以接入。完整 B/S 模型建议通过本地适配器返回分钟
                  K、日 K、指数/板块序列和校验结果，付费密钥不要写入前端或 GitHub。
                  <a
                    href="https://github.com/MitziTung-CIINC/intraday-compass/blob/main/docs/l2-market-data-integration.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看 L2 接入教程
                  </a>
                  <a
                    href="https://www.sseinfo.com/services/assortment/level2/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看上证所 Level-2 说明
                  </a>
                </div>
                <div className="config-form">
                <label>
                  <span>行情提供方名称</span>
                  <input
                    type="text"
                    value={config.providerName}
                    placeholder="例如：我的持牌 L2 行情适配器"
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        providerName: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>行情时效声明</span>
                  <select
                    value={config.delayType}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        delayType: event.target.value as FeedConfig["delayType"],
                      }))
                    }
                  >
                    <option value="unknown">未知，默认不作实时声明</option>
                    <option value="realtime">接口授权为实时行情</option>
                    <option value="delayed">延时行情</option>
                  </select>
                </label>
                <label className="wide">
                  <span>接口地址</span>
                  <input
                    type="text"
                    value={config.url}
                    placeholder={
                      config.mode === "rest"
                        ? "https://api.example.com/quote?symbol={symbol}"
                        : "wss://stream.example.com/quotes"
                    }
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        url: event.target.value,
                      }))
                    }
                  />
                  <small>
                    支持 {"{symbol}"} 和 {"{market}"} 占位符。接口需允许浏览器跨域访问。
                  </small>
                </label>
                {config.mode === "rest" && (
                  <label>
                    <span>轮询间隔（毫秒）</span>
                    <input
                      type="number"
                      min="1000"
                      step="1000"
                      value={config.interval}
                      onChange={(event) =>
                        setConfig((current) => ({
                          ...current,
                          interval: Math.max(1000, Number(event.target.value)),
                        }))
                      }
                    />
                  </label>
                )}
                <label>
                  <span>陈旧阈值（秒）</span>
                  <input
                    type="number"
                    min="3"
                    step="1"
                    value={config.maxAgeSeconds}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        maxAgeSeconds: Math.max(3, Number(event.target.value)),
                      }))
                    }
                  />
                  <small>超过该时间没有新包，B/S判断自动冻结。</small>
                </label>
                <label>
                  <span>临时访问令牌</span>
                  <input
                    type="password"
                    value={token}
                    placeholder="可选，仅保存在当前浏览器会话"
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <small>
                    REST使用Bearer请求头；WebSocket可在订阅消息中使用 {"{token}"}。
                  </small>
                </label>
                <label>
                  <span>价格字段路径</span>
                  <input
                    type="text"
                    value={config.pricePath}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        pricePath: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>昨收字段路径</span>
                  <input
                    type="text"
                    value={config.previousClosePath}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        previousClosePath: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>成交量字段路径</span>
                  <input
                    type="text"
                    value={config.volumePath}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        volumePath: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>时间字段路径</span>
                  <input
                    type="text"
                    value={config.timePath}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        timePath: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>行业涨跌字段</span>
                  <input
                    type="text"
                    value={config.sectorPath}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        sectorPath: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>指数涨跌字段</span>
                  <input
                    type="text"
                    value={config.indexPath}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        indexPath: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>指数点位字段</span>
                  <input
                    type="text"
                    value={config.indexLevelPath}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        indexLevelPath: event.target.value,
                      }))
                    }
                  />
                  <small>空仓指引需要逐条上证指数点位，例如 3945.20。</small>
                </label>
                {config.mode === "websocket" && (
                  <label className="wide">
                    <span>订阅消息</span>
                    <textarea
                      rows={3}
                      value={config.subscribeMessage}
                      onChange={(event) =>
                        setConfig((current) => ({
                          ...current,
                          subscribeMessage: event.target.value,
                        }))
                      }
                    />
                  </label>
                )}
                </div>
              </>
            )}

            <div className="stopwatch-config-section">
              <div className="stopwatch-config-heading">
                <div>
                  <span className="eyebrow">随身决策终端</span>
                  <h3>StopWatch 硬件同步</h3>
                </div>
                <span
                  className={`stopwatch-status ${
                    stopWatchStatus.includes("已同步") ? "connected" : ""
                  }`}
                >
                  {stopWatchStatus}
                </span>
              </div>
              <label className="wave-toggle">
                <span>
                  <strong>同步持仓、实时 K 线与 B/S 成熟提醒</strong>
                  <small>手表切换标的后，电脑端会自动跟随并加载该股行情</small>
                </span>
                <input
                  type="checkbox"
                  checked={stopWatchConfig.enabled}
                  onChange={(event) =>
                    setStopWatchConfig((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
              </label>
              <div className="stopwatch-fields">
                <label>
                  <span>设备地址</span>
                  <input
                    type="url"
                    value={stopWatchConfig.deviceUrl}
                    placeholder="http://intraday-compass.local"
                    onChange={(event) =>
                      setStopWatchConfig((current) => ({
                        ...current,
                        deviceUrl: event.target.value,
                      }))
                    }
                  />
                  <small>也可填写手表屏幕显示的局域网 IP。</small>
                </label>
                <label>
                  <span>设备 API Key</span>
                  <input
                    type="password"
                    value={stopWatchApiKey}
                    placeholder="仅保存在当前浏览器会话"
                    onChange={(event) => setStopWatchApiKey(event.target.value)}
                  />
                  <small>测试固件默认值见硬件项目 README，正式使用请更换。</small>
                </label>
              </div>
              <div className="stopwatch-actions">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setStopWatchStatus("正在检测");
                    void testStopWatchConnection(stopWatchConfig)
                      .then(() => setStopWatchStatus("设备在线"))
                      .catch((error: unknown) =>
                        setStopWatchStatus(
                          error instanceof Error ? error.message : "连接失败",
                        ),
                      );
                  }}
                >
                  检测设备
                </button>
                <p>首次联网可连接手表的 Compass 热点并访问 192.168.4.1。</p>
              </div>
            </div>

            <div className="wave-config-section">
              <label className="wave-toggle">
                <span>
                  <strong>启用大盘波浪过滤</strong>
                  <small>用户提供的本轮上证指数情景，点位可随时调整</small>
                </span>
                <input
                  type="checkbox"
                  checked={waveGuide.enabled}
                  onChange={(event) =>
                    setWaveGuide((current) => ({
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
                      value={waveGuide[key]}
                      onChange={(event) =>
                        setWaveGuide((current) => ({
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
                  {(Number.isFinite(waveGuide.cTarget)
                    ? waveGuide.cTarget
                    : 3810
                  ).toFixed(2)}
                </strong>
                点；但按“A浪跌幅 × 扩展系数”计算为{" "}
                <strong>
                  {(
                    waveGuide.aLow -
                    Math.max(0, waveGuide.aHigh - waveGuide.aLow) *
                      waveGuide.extension
                  ).toFixed(2)}
                </strong>
                点，两者不一致。系统按显式C目标做风险分层，不把公式当作确定预测。
              </p>
            </div>

            <div className="modal-footer">
              <p>
                仅接受你配置的只读行情源。提供方名称是溯源标签，不代表网页已验证其交易所授权。
              </p>
              <button
                className="button primary"
                onClick={() => {
                  setPaused(false);
                  setDemoPlaying(false);
                  setConnection(
                    config.mode === "demo" ? "paused" : "connecting",
                  );
                  setConfigOpen(false);
                }}
              >
                保存配置
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
