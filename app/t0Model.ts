export type SignalState =
  | "blocked"
  | "watchB"
  | "confirmB"
  | "tracking"
  | "watchS"
  | "confirmS";

export type CyclePhase = "neutral" | "boughtForT" | "soldBase";
export type TMode = "positive" | "reverse" | "range" | "avoid";
export type InstrumentKind = "stock" | "etf" | "bond";
export type VolumePhase =
  | "risingEffective"
  | "risingExhaustion"
  | "fallingInitial"
  | "fallingDrift"
  | "fallingFlush"
  | "bottomingReversal"
  | "balanced";

export type Tick = {
  time: string;
  price: number;
  open?: number;
  high?: number;
  low?: number;
  volume: number;
  amount?: number;
  sectorChange: number;
  indexChange: number;
  indexLevel?: number;
};

export type DailyBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ModelContext = {
  dataValid?: boolean;
  indexSeriesValid?: boolean;
  sectorSeriesValid?: boolean;
  dailySeriesValid?: boolean;
  holdingShares?: number;
  sellableShares?: number;
  turnaround?: "t0" | "t1";
  instrumentKind?: InstrumentKind;
  dailyBars?: DailyBar[];
  now?: number | string;
  estimatedRoundTripCostPct?: number;
  expectedSlippagePct?: number;
  forceCloseMinutes?: number;
  volumeShrinkThreshold?: number;
};

export type MacdReading = {
  dif: number;
  dea: number;
  histogram: number;
  previousHistogram: number;
  bullishCross: boolean;
  bearishCross: boolean;
  bullishTurn: boolean;
  bearishTurn: boolean;
};

export type ScoreComponents = {
  position: number;
  threeLook: number;
  vwap: number;
  volume: number;
  resonance: number;
};

export type HardGate = {
  key: "data" | "inventory" | "direction" | "spread" | "time";
  label: string;
  passed: boolean;
  reason: string;
};

export type NineTurnReading = {
  up: number;
  down: number;
  upCompleted: boolean;
  downCompleted: boolean;
};

export type NineTurnSet = {
  oneMinute: NineTurnReading;
  fiveMinute: NineTurnReading;
  fifteenMinute: NineTurnReading;
};

export type SignalReading = {
  state: SignalState;
  bScore: number;
  sScore: number;
  bComponents: ScoreComponents;
  sComponents: ScoreComponents;
  hardGates: HardGate[];
  hardGatePassed: boolean;
  maturity: number;
  vwap: number;
  vwapSlope: number;
  recentSlope: number;
  macd: MacdReading;
  tMode: TMode;
  rangePosition: number;
  multiDayRangePosition: number;
  volumeRatio: number;
  volumePhase: VolumePhase;
  volumeShrinkThreshold: number;
  volumeWaveDirection: "up" | "down" | "flat";
  stockTrend: number;
  sectorTrend: number;
  indexTrend: number;
  nineTurn: NineTurnSet;
  expectedSpreadPct: number;
  requiredSpreadPct: number;
  forcedClose: boolean;
  nextAction: "B" | "S" | "WAIT";
  reasons: string[];
  invalidation: string;
};

export const T_MODE_META: Record<
  TMode,
  { label: string; sequence: string; description: string }
> = {
  positive: {
    label: "正T",
    sequence: "先B后S",
    description: "多日结构向上，只在回踩企稳后低吸，随后卖出原底仓",
  },
  reverse: {
    label: "反T",
    sequence: "先S后B",
    description: "多日结构向下，只在反弹衰竭后先卖，随后低位买回",
  },
  range: {
    label: "箱体T",
    sequence: "下沿B / 上沿S",
    description: "多日结构横盘，中轴以下偏B、中轴以上偏S，中轴附近等待",
  },
  avoid: {
    label: "暂停做T",
    sequence: "仅观察",
    description: "单边快速下跌、数据不完整或方向不清，不用日内波动对抗趋势",
  },
};

export const VOLUME_PHASE_LABEL: Record<VolumePhase, string> = {
  risingEffective: "5分钟上涨承量 · 继续观察",
  risingExhaustion: "5分钟上涨缩量 · S候选",
  fallingInitial: "5分钟首段下跌 · 不接第一波",
  fallingDrift: "5分钟下跌缩量 · B候选",
  fallingFlush: "尾段放量赶底 · 等止跌K线",
  bottomingReversal: "放量止跌阳线 · 承接确认",
  balanced: "量价平衡 · 等待方向",
};

const ZERO_COMPONENTS: ScoreComponents = {
  position: 0,
  threeLook: 0,
  vwap: 0,
  volume: 0,
  resonance: 0,
};

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumComponents(components: ScoreComponents) {
  return clamp(
    components.position +
      components.threeLook +
      components.vwap +
      components.volume +
      components.resonance,
  );
}

function pctChange(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0)
    return 0;
  return (current / previous - 1) * 100;
}

function emaSeries(values: number[], period: number) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(
      values[index] * multiplier + output[index - 1] * (1 - multiplier),
    );
  }
  return output;
}

function calculateMacd(ticks: Tick[]): MacdReading {
  const prices = ticks.map((tick) => tick.price);
  if (prices.length < 3) {
    return {
      dif: 0,
      dea: 0,
      histogram: 0,
      previousHistogram: 0,
      bullishCross: false,
      bearishCross: false,
      bullishTurn: false,
      bearishTurn: false,
    };
  }
  const ema12 = emaSeries(prices, 12);
  const ema26 = emaSeries(prices, 26);
  const difSeries = prices.map((_, index) => ema12[index] - ema26[index]);
  const deaSeries = emaSeries(difSeries, 9);
  const histogramSeries = difSeries.map(
    (dif, index) => (dif - deaSeries[index]) * 2,
  );
  const last = prices.length - 1;
  const previous = last - 1;
  const beforePrevious = Math.max(0, last - 2);
  const histogram = histogramSeries[last];
  const previousHistogram = histogramSeries[previous];
  return {
    dif: difSeries[last],
    dea: deaSeries[last],
    histogram,
    previousHistogram,
    bullishCross:
      difSeries[previous] <= deaSeries[previous] &&
      difSeries[last] > deaSeries[last],
    bearishCross:
      difSeries[previous] >= deaSeries[previous] &&
      difSeries[last] < deaSeries[last],
    bullishTurn:
      histogram > previousHistogram &&
      previousHistogram <= histogramSeries[beforePrevious],
    bearishTurn:
      histogram < previousHistogram &&
      previousHistogram >= histogramSeries[beforePrevious],
  };
}

function minuteOfDay(value: string) {
  const iso = Date.parse(value);
  if (Number.isFinite(iso) && value.includes("T")) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(new Date(iso))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return Number(parts.hour) * 60 + Number(parts.minute);
  }
  const match = value.match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function aggregateCloses(ticks: Tick[], period: number) {
  const buckets = new Map<number, number>();
  ticks.forEach((tick, index) => {
    const minute = minuteOfDay(tick.time);
    const key =
      minute === null ? Math.floor(index / period) : Math.floor(minute / period);
    buckets.set(key, tick.price);
  });
  return [...buckets.entries()]
    .toSorted((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);
}

type FiveMinuteBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  samples: number;
};

function aggregateFiveMinuteBars(ticks: Tick[]) {
  const buckets = new Map<number, FiveMinuteBar>();
  ticks.forEach((tick, index) => {
    const minute = minuteOfDay(tick.time);
    const key = minute === null ? Math.floor(index / 5) : Math.floor(minute / 5);
    const current = buckets.get(key);
    const open = tick.open ?? tick.price;
    const high = tick.high ?? tick.price;
    const low = tick.low ?? tick.price;
    if (!current) {
      buckets.set(key, {
        open,
        high,
        low,
        close: tick.price,
        volume: Math.max(0, tick.volume),
        samples: 1,
      });
      return;
    }
    current.high = Math.max(current.high, high);
    current.low = Math.min(current.low, low);
    current.close = tick.price;
    current.volume += Math.max(0, tick.volume);
    current.samples += 1;
  });
  return [...buckets.entries()]
    .toSorted((left, right) => left[0] - right[0])
    .map((entry) => entry[1])
    .filter((bar) => bar.samples >= 5);
}

export function calculateNineTurn(closes: number[]): NineTurnReading {
  let up = 0;
  let down = 0;
  for (let index = 4; index < closes.length; index += 1) {
    if (closes[index] > closes[index - 4]) {
      up = Math.min(9, up + 1);
      down = 0;
    } else if (closes[index] < closes[index - 4]) {
      down = Math.min(9, down + 1);
      up = 0;
    } else {
      up = 0;
      down = 0;
    }
  }
  return {
    up,
    down,
    upCompleted: up >= 9,
    downCompleted: down >= 9,
  };
}

function calculateNineTurnSet(ticks: Tick[]): NineTurnSet {
  return {
    oneMinute: calculateNineTurn(aggregateCloses(ticks, 1)),
    fiveMinute: calculateNineTurn(aggregateCloses(ticks, 5)),
    fifteenMinute: calculateNineTurn(aggregateCloses(ticks, 15)),
  };
}

function currentShanghaiMinutes(now: ModelContext["now"]) {
  if (now === undefined) return null;
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function deriveDailyStructure(ticks: Tick[], dailyBars: DailyBar[] | undefined) {
  const validDaily = (dailyBars ?? [])
    .filter(
      (bar) =>
        [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) &&
        bar.close > 0,
    )
    .toSorted((left, right) => left.date.localeCompare(right.date));
  if (validDaily.length >= 10) {
    const window = validDaily.slice(-20);
    const closes = window.map((bar) => bar.close);
    const lows = window.map((bar) => bar.low);
    const highs = window.map((bar) => bar.high);
    const latest = closes.at(-1)!;
    const ma5 = average(closes.slice(-5));
    const ma10 = average(closes.slice(-10));
    const ma20 = average(closes);
    const trend = pctChange(latest, closes.at(-10)!);
    const boxLow = Math.min(...lows);
    const boxHigh = Math.max(...highs);
    const position = clamp(
      ((latest - boxLow) / Math.max(boxHigh - boxLow, 0.001)) * 100,
    );
    const trueRanges = window.slice(1).map((bar, index) => {
      const previousClose = window[index].close;
      return Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previousClose),
        Math.abs(bar.low - previousClose),
      );
    });
    const atrPct = Math.abs(
      pctChange(latest + average(trueRanges.slice(-14)), latest),
    );
    return {
      available: true,
      trend,
      position,
      boxLow,
      boxHigh,
      atrPct,
      bullish: ma5 > ma10 && ma10 >= ma20 * 0.995 && trend > 0.35,
      bearish: ma5 < ma10 && ma10 <= ma20 * 1.005 && trend < -0.35,
    };
  }
  const window = ticks.slice(-120);
  const prices = window.map((tick) => tick.price);
  const boxLow = prices.length ? Math.min(...prices) : 0;
  const boxHigh = prices.length ? Math.max(...prices) : 0;
  const latest = prices.at(-1) ?? 0;
  const trend = prices.length > 1 ? pctChange(latest, prices[0]) : 0;
  return {
    available: false,
    trend,
    position: prices.length
      ? clamp(((latest - boxLow) / Math.max(boxHigh - boxLow, 0.001)) * 100)
      : 50,
    boxLow,
    boxHigh,
    atrPct: Math.max(0.5, Math.abs(trend) / 2),
    bullish: trend > 0.45,
    bearish: trend < -0.45,
  };
}

function classifyVolumePhase(ticks: Tick[], shrinkThreshold: number) {
  const bars = aggregateFiveMinuteBars(ticks).slice(-8);
  if (bars.length < 3) {
    return {
      phase: "balanced" as const,
      ratio: 1,
      direction: "flat" as const,
    };
  }

  const lastIndex = bars.length - 1;
  const latest = bars[lastIndex];
  const previous = bars[lastIndex - 1];
  const latestMove = pctChange(latest.close, previous.close);
  const direction =
    latestMove > 0.025 ? ("up" as const) : latestMove < -0.025 ? ("down" as const) : null;
  if (!direction) {
    return {
      phase: "balanced" as const,
      ratio: 1,
      direction: "flat" as const,
    };
  }

  // The teacher's rule uses the first directional 5-minute bar as volume = 1.
  // Walk back only within the current same-direction wave; opening volume from
  // an unrelated wave must not become the all-day baseline.
  let firstMoveIndex = lastIndex;
  while (firstMoveIndex > 1) {
    const priorMove = pctChange(
      bars[firstMoveIndex - 1].close,
      bars[firstMoveIndex - 2].close,
    );
    if (
      (direction === "up" && priorMove <= 0.025) ||
      (direction === "down" && priorMove >= -0.025)
    )
      break;
    firstMoveIndex -= 1;
  }

  // A first wave and a later wave are both required before comparing volume.
  if (firstMoveIndex === lastIndex) {
    return {
      phase: direction === "down" ? ("fallingInitial" as const) : ("balanced" as const),
      ratio: 1,
      direction,
    };
  }

  const baseline = bars[firstMoveIndex];
  const ratio = latest.volume / Math.max(baseline.volume, 1);
  const waveBars = bars.slice(firstMoveIndex, lastIndex);
  const extended =
    direction === "up"
      ? latest.high >= Math.max(...waveBars.map((bar) => bar.high))
      : latest.low <= Math.min(...waveBars.map((bar) => bar.low));

  if (direction === "up" && extended) {
    return {
      phase:
        ratio <= shrinkThreshold
          ? ("risingExhaustion" as const)
          : ratio >= 0.9
            ? ("risingEffective" as const)
            : ("balanced" as const),
      ratio,
      direction,
    };
  }
  if (direction === "down" && extended) {
    return {
      phase:
        ratio <= shrinkThreshold
          ? ("fallingDrift" as const)
          : ("fallingInitial" as const),
      ratio,
      direction,
    };
  }
  return { phase: "balanced" as const, ratio, direction };
}

function positionScore(position: number, side: "B" | "S") {
  if (side === "B") {
    if (position <= 18) return 25;
    if (position <= 32) return 21;
    if (position <= 45) return 14;
    if (position <= 55) return 7;
    return 0;
  }
  if (position >= 82) return 25;
  if (position >= 68) return 21;
  if (position >= 55) return 14;
  if (position >= 45) return 7;
  return 0;
}

function threeLookScore(
  side: "B" | "S",
  stockTrend: number,
  indexTrend: number,
  latest: Tick,
) {
  const direction = side === "B" ? 1 : -1;
  let score = 0;
  if (latest.indexChange * direction > -0.75) score += 8;
  if (indexTrend * direction > -0.25) score += 5;
  if (stockTrend * direction > indexTrend * direction - 0.4) score += 4;
  if (Math.abs(stockTrend - indexTrend) > 0.12) score += 3;
  return clamp(score, 0, 20);
}

function vwapScore(
  side: "B" | "S",
  latestPrice: number,
  vwap: number,
  vwapSlope: number,
  recentSlope: number,
) {
  const deviation = pctChange(latestPrice, vwap);
  if (side === "B") {
    let score = deviation <= 0 ? 8 : deviation <= 0.25 ? 5 : 0;
    if (deviation >= -1.5 && deviation <= 0.2) score += 5;
    if (recentSlope > -0.05) score += 4;
    if (vwapSlope >= -0.08) score += 3;
    return clamp(score, 0, 20);
  }
  let score = deviation >= 0 ? 8 : deviation >= -0.25 ? 5 : 0;
  if (deviation >= 0.35) score += 5;
  if (recentSlope < 0.05) score += 4;
  if (vwapSlope <= 0.08) score += 3;
  return clamp(score, 0, 20);
}

function volumeScore(side: "B" | "S", phase: VolumePhase) {
  const b: Record<VolumePhase, number> = {
    bottomingReversal: 20,
    fallingFlush: 5,
    fallingDrift: 20,
    fallingInitial: 0,
    risingEffective: 12,
    risingExhaustion: 5,
    balanced: 9,
  };
  const s: Record<VolumePhase, number> = {
    bottomingReversal: 0,
    fallingFlush: 12,
    fallingDrift: 13,
    fallingInitial: 18,
    risingEffective: 4,
    risingExhaustion: 20,
    balanced: 9,
  };
  return side === "B" ? b[phase] : s[phase];
}

function resonanceScore(side: "B" | "S", nineTurn: NineTurnSet) {
  const one = side === "B" ? nineTurn.oneMinute.down : nineTurn.oneMinute.up;
  const five = side === "B" ? nineTurn.fiveMinute.down : nineTurn.fiveMinute.up;
  const oneComplete =
    side === "B"
      ? nineTurn.oneMinute.downCompleted
      : nineTurn.oneMinute.upCompleted;
  const fiveComplete =
    side === "B"
      ? nineTurn.fiveMinute.downCompleted
      : nineTurn.fiveMinute.upCompleted;
  if (oneComplete && fiveComplete) return 15;
  if (fiveComplete) return 11;
  if (oneComplete) return 8;
  if (one >= 7 && five >= 5) return 6;
  if (one >= 6 || five >= 4) return 3;
  return 0;
}

function expectedSpread(
  side: "B" | "S",
  price: number,
  vwap: number,
  rangeLow: number,
  rangeHigh: number,
) {
  const rangeTarget =
    side === "B"
      ? Math.max(vwap, rangeLow + (rangeHigh - rangeLow) * 0.62)
      : Math.min(vwap, rangeLow + (rangeHigh - rangeLow) * 0.38);
  return side === "B"
    ? Math.max(0, pctChange(rangeTarget, price))
    : Math.max(0, pctChange(price, Math.max(rangeTarget, 0.001)));
}

function blockedReading(ticks: Tick[], reason: string): SignalReading {
  const latest = ticks.at(-1);
  return {
    state: "blocked",
    bScore: 0,
    sScore: 0,
    bComponents: ZERO_COMPONENTS,
    sComponents: ZERO_COMPONENTS,
    hardGates: [
      { key: "data", label: "数据有效", passed: false, reason },
    ],
    hardGatePassed: false,
    maturity: 0,
    vwap: latest?.price ?? 0,
    vwapSlope: 0,
    recentSlope: 0,
    macd: calculateMacd(ticks),
    tMode: "avoid",
    rangePosition: 50,
    multiDayRangePosition: 50,
    volumeRatio: 0,
    volumePhase: "balanced",
    volumeShrinkThreshold: 0.7,
    volumeWaveDirection: "flat",
    stockTrend: 0,
    sectorTrend: 0,
    indexTrend: 0,
    nineTurn: calculateNineTurnSet(ticks),
    expectedSpreadPct: 0,
    requiredSpreadPct: 0,
    forcedClose: false,
    nextAction: "WAIT",
    reasons: [reason],
    invalidation: "数据不足",
  };
}

export function evaluateSignal(
  ticks: Tick[],
  previousState: SignalState,
  cyclePhase: CyclePhase,
  context: ModelContext = {},
): SignalReading {
  void previousState;
  if (ticks.length < 16)
    return blockedReading(ticks, "等待至少16个真实分时样本");
  const latest = ticks.at(-1)!;
  const recent = ticks.slice(-5);
  const totalVolume = ticks.reduce(
    (sum, tick) => sum + Math.max(tick.volume, 0),
    0,
  );
  const vwap =
    ticks.reduce(
      (sum, tick) => sum + tick.price * Math.max(tick.volume, 0),
      0,
    ) / Math.max(totalVolume, 1);
  let runningValue = 0;
  let runningVolume = 0;
  const cumulativeVwaps = ticks.map((tick) => {
    runningValue += tick.price * Math.max(tick.volume, 0);
    runningVolume += Math.max(tick.volume, 0);
    return runningValue / Math.max(runningVolume, 1);
  });
  const vwapSlope = pctChange(
    cumulativeVwaps.at(-1)!,
    cumulativeVwaps.at(-6) ?? cumulativeVwaps[0],
  );
  const recentSlope = pctChange(recent.at(-1)!.price, recent[0].price);
  const intradayPrices = ticks.map((tick) => tick.price);
  const rangeLow = Math.min(...ticks.map((tick) => tick.low ?? tick.price));
  const rangeHigh = Math.max(...ticks.map((tick) => tick.high ?? tick.price));
  const rangePosition = clamp(
    ((latest.price - rangeLow) / Math.max(rangeHigh - rangeLow, 0.001)) * 100,
  );
  const stockTrend = pctChange(latest.price, intradayPrices[0]);
  const sectorSeriesAvailable =
    context.sectorSeriesValid !== false &&
    ticks.every((tick) => Number.isFinite(tick.sectorChange));
  const sectorTrend = sectorSeriesAvailable
    ? latest.sectorChange - ticks[0].sectorChange
    : 0;
  const indexTrend = latest.indexChange - ticks[0].indexChange;
  const volumeShrinkThreshold = clamp(
    context.volumeShrinkThreshold ?? 0.7,
    0.5,
    0.85,
  );
  const volumeReading = classifyVolumePhase(ticks, volumeShrinkThreshold);
  const volumeRatio = volumeReading.ratio;
  const volumePhase = volumeReading.phase;
  const volumeWaveDirection = volumeReading.direction;
  const nineTurn = calculateNineTurnSet(ticks);
  const daily = deriveDailyStructure(ticks, context.dailyBars);
  const rapidMarketFall =
    latest.indexChange < -1.25 ||
    (recentSlope < -0.7 &&
      volumeWaveDirection === "down" &&
      volumeRatio >= 0.9);
  const tMode: TMode = rapidMarketFall
    ? "avoid"
    : daily.bullish
      ? "positive"
      : daily.bearish
        ? "reverse"
        : "range";
  const nowMinutes = currentShanghaiMinutes(context.now);
  const forceCloseMinutes = context.forceCloseMinutes ?? 14 * 60 + 45;
  const forcedClose =
    cyclePhase !== "neutral" &&
    nowMinutes !== null &&
    nowMinutes >= forceCloseMinutes;
  const volumeCandidate =
    volumePhase === "risingExhaustion"
      ? ("S" as const)
      : volumePhase === "fallingDrift"
        ? ("B" as const)
        : null;
  const nextAction: SignalReading["nextAction"] =
    cyclePhase === "boughtForT"
      ? "S"
      : cyclePhase === "soldBase"
        ? "B"
        : tMode === "positive"
          ? "B"
          : tMode === "reverse"
            ? "S"
            : tMode === "range"
              ? volumeCandidate === "B" && rangePosition <= 65
                ? "B"
                : volumeCandidate === "S" && rangePosition >= 35
                  ? "S"
                  : rangePosition <= 42
                ? "B"
                : rangePosition >= 58
                  ? "S"
                  : "WAIT"
              : "WAIT";
  const bComponents: ScoreComponents = {
    position: positionScore(rangePosition, "B"),
    threeLook: threeLookScore("B", stockTrend, indexTrend, latest),
    vwap: vwapScore("B", latest.price, vwap, vwapSlope, recentSlope),
    volume: volumeScore("B", volumePhase),
    resonance: resonanceScore("B", nineTurn),
  };
  const sComponents: ScoreComponents = {
    position: positionScore(rangePosition, "S"),
    threeLook: threeLookScore("S", stockTrend, indexTrend, latest),
    vwap: vwapScore("S", latest.price, vwap, vwapSlope, recentSlope),
    volume: volumeScore("S", volumePhase),
    resonance: resonanceScore("S", nineTurn),
  };
  const bScore = sumComponents(bComponents);
  const sScore = sumComponents(sComponents);
  const maturity =
    nextAction === "B" ? bScore : nextAction === "S" ? sScore : 0;
  const requiredSpreadPct = Math.max(
    0.12,
    (context.estimatedRoundTripCostPct ?? 0.08) +
      (context.expectedSlippagePct ?? 0.06),
  );
  const expectedSpreadPct =
    nextAction === "WAIT"
      ? 0
      : expectedSpread(nextAction, latest.price, vwap, rangeLow, rangeHigh);
  const dataPassed =
    context.dataValid !== false &&
    context.indexSeriesValid !== false &&
    context.dailySeriesValid !== false &&
    ticks.every(
      (tick) =>
        Number.isFinite(tick.price) &&
        Number.isFinite(tick.indexChange),
    );
  const instrumentKind = context.instrumentKind ?? "stock";
  const t0Instrument =
    context.turnaround === "t0" || instrumentKind === "bond";
  const hasHolding = (context.holdingShares ?? 1) > 0;
  const hasSellable = (context.sellableShares ?? 1) > 0;
  const hasInventory =
    cyclePhase !== "neutral" ||
    (nextAction === "S"
      ? hasSellable
      : nextAction === "B"
        ? t0Instrument || (hasHolding && hasSellable)
        : false);
  const directionPassed =
    forcedClose || (tMode !== "avoid" && nextAction !== "WAIT");
  const spreadPassed = forcedClose || expectedSpreadPct >= requiredSpreadPct;
  const timePassed =
    forcedClose ||
    nowMinutes === null ||
    (nowMinutes >= 9 * 60 + 45 && nowMinutes < forceCloseMinutes);
  const hardGates: HardGate[] = [
    {
      key: "data",
      label: "数据有效",
      passed: dataPassed,
      reason: dataPassed
        ? "个股、指数分钟序列与多日结构可用；板块仅作辅助显示"
        : "个股/指数分钟序列、多日结构或官方行情校验不完整",
    },
    {
      key: "inventory",
      label: "底仓与回转资格",
      passed: hasInventory,
      reason: hasInventory
        ? cyclePhase !== "neutral"
          ? "已有未闭合T周期，只允许完成对应反向动作"
          : t0Instrument
          ? "该品种按T+0回转处理"
          : "持有底仓且有今日可卖数量"
        : "A股股票做T需要底仓和今日可卖数量",
    },
    {
      key: "direction",
      label: "方向明确",
      passed: directionPassed,
      reason: directionPassed
        ? `${T_MODE_META[tMode].label}，下一动作只允许${nextAction}`
        : tMode === "avoid"
          ? "快速下跌或环境风险触发暂停"
          : "箱体中轴附近，方向不明确",
    },
    {
      key: "spread",
      label: "差价覆盖费用",
      passed: spreadPassed,
      reason: forcedClose
        ? "强制闭环优先，不再以利润门槛拖延"
        : `预计${expectedSpreadPct.toFixed(2)}%，最低需${requiredSpreadPct.toFixed(2)}%`,
    },
    {
      key: "time",
      label: "执行时段",
      passed: timePassed,
      reason: forcedClose
        ? "已到闭环时段，只允许完成反向动作"
        : timePassed
          ? "09:45后且未到14:45强制闭环线"
          : nowMinutes !== null && nowMinutes < 9 * 60 + 45
            ? "开盘前15分钟只观察量价，不生成确认信号"
            : "已到强制闭环时段，禁止新开T周期",
    },
  ];
  const hardGatePassed = hardGates.every((gate) => gate.passed);
  const watchGatePassed =
    dataPassed &&
    hasInventory &&
    timePassed &&
    tMode !== "avoid" &&
    nextAction !== "WAIT";
  const volumeCandidateMatches = volumeCandidate === nextAction;
  const watchThreshold = volumeCandidateMatches ? 55 : 60;
  let state: SignalState = "blocked";
  if (forcedClose && hardGatePassed) {
    state = nextAction === "B" ? "confirmB" : "confirmS";
  } else if (hardGatePassed) {
    if (maturity >= 75)
      state = nextAction === "B" ? "confirmB" : "confirmS";
    else if (maturity >= watchThreshold)
      state = nextAction === "B" ? "watchB" : "watchS";
    else if (cyclePhase !== "neutral") state = "tracking";
  } else if (watchGatePassed && maturity >= watchThreshold) {
    // Observation prompts intentionally precede execution confirmation. Fees,
    // spread or a not-yet-complete direction gate can still prevent confirmB/S.
    state = nextAction === "B" ? "watchB" : "watchS";
  } else if (cyclePhase !== "neutral" && dataPassed) {
    state = "tracking";
  }
  const reasons: string[] = [];
  const failedGates = hardGates.filter((gate) => !gate.passed);
  if (failedGates.length && !["watchB", "watchS"].includes(state)) {
    reasons.push(...failedGates.map((gate) => `${gate.label}未通过：${gate.reason}`));
  } else if (forcedClose) {
    reasons.push(
      `14:45后优先${nextAction === "B" ? "买回" : "卖出"}闭环，不把失败的T留到次日`,
    );
  } else {
    if (failedGates.length) {
      reasons.push(
        `仅为观察提示，确认仍缺：${failedGates.map((gate) => gate.label).join("、")}`,
      );
    }
    reasons.push(
      `${T_MODE_META[tMode].label} · 多日结构位置${daily.position.toFixed(0)}% · 日内位置${rangePosition.toFixed(0)}%`,
    );
    reasons.push(
      `环境：个股${stockTrend >= 0 ? "+" : ""}${stockTrend.toFixed(2)}%，指数${indexTrend >= 0 ? "+" : ""}${indexTrend.toFixed(2)}%；板块不参与拦截与评分`,
    );
    reasons.push(
      `均价线：现价相对VWAP ${pctChange(latest.price, vwap).toFixed(2)}%，均价线5分钟斜率${vwapSlope.toFixed(2)}%`,
    );
    reasons.push(
      `5分钟波段量能：${VOLUME_PHASE_LABEL[volumePhase]}，最新/首段 ${volumeRatio.toFixed(2)}（缩量阈值≤${volumeShrinkThreshold.toFixed(2)}）`,
    );
    reasons.push(
      `九转：1分钟${nextAction === "B" ? nineTurn.oneMinute.down : nineTurn.oneMinute.up}，5分钟${nextAction === "B" ? nineTurn.fiveMinute.down : nineTurn.fiveMinute.up}，15分钟只作方向参考`,
    );
  }
  const macd = calculateMacd(ticks);
  if (reasons.length < 5 && (macd.bullishCross || macd.bearishCross)) {
    reasons.push(
      `MACD仅作辅助：${macd.bullishCross ? "金叉" : "死叉"}，不参与主评分`,
    );
  }
  const volatilityBufferPct = clamp(
    Math.max(daily.atrPct * 0.55, requiredSpreadPct * 1.5),
    0.35,
    1.2,
  );
  const bInvalidation = Math.min(
    rangeLow * (1 - 0.0015),
    latest.price * (1 - volatilityBufferPct / 100),
  );
  const sInvalidation = Math.max(
    rangeHigh * (1 + 0.0015),
    latest.price * (1 + volatilityBufferPct / 100),
  );
  const invalidation = forcedClose
    ? "当日闭环优先；成交后恢复原仓位结构"
    : nextAction === "B"
      ? `结构失效：跌破 ${Math.max(0.01, bInvalidation).toFixed(2)} 或指数与个股结构同步转弱`
      : nextAction === "S"
        ? `结构失效：重新站上 ${sInvalidation.toFixed(2)} 且量价齐升`
        : "等待方向离开箱体中轴后再评估";
  return {
    state,
    bScore,
    sScore,
    bComponents,
    sComponents,
    hardGates,
    hardGatePassed,
    maturity,
    vwap,
    vwapSlope,
    recentSlope,
    macd,
    tMode,
    rangePosition,
    multiDayRangePosition: daily.position,
    volumeRatio,
    volumePhase,
    volumeShrinkThreshold,
    volumeWaveDirection,
    stockTrend,
    sectorTrend,
    indexTrend,
    nineTurn,
    expectedSpreadPct,
    requiredSpreadPct,
    forcedClose,
    nextAction,
    reasons: reasons.slice(0, 5),
    invalidation,
  };
}

function roundToLot(quantity: number, lotSize: number) {
  return Math.max(0, Math.floor(quantity / lotSize) * lotSize);
}

export function recommendTrancheQuantity(
  availableQuantity: number,
  signal: SignalReading,
  cyclePhase: CyclePhase,
  cycleQuantity: number,
  lotSize = 100,
) {
  if (cyclePhase !== "neutral") return roundToLot(cycleQuantity, lotSize);
  if (!signal.hardGatePassed || signal.nextAction === "WAIT") return 0;
  const largeSpread =
    signal.expectedSpreadPct >= signal.requiredSpreadPct * 2.2;
  const fraction = signal.maturity >= 85 && largeSpread ? 0.5 : 0.25;
  return roundToLot(availableQuantity * fraction, lotSize);
}
