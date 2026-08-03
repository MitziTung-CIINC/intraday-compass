export type SignalState =
  | "blocked"
  | "watchB"
  | "confirmB"
  | "tracking"
  | "watchS"
  | "confirmS";

export type CyclePhase = "neutral" | "boughtForT" | "soldBase";
export type TMode = "positive" | "reverse" | "range" | "avoid";

export type Tick = {
  time: string;
  price: number;
  volume: number;
  sectorChange: number;
  indexChange: number;
  indexLevel?: number;
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

export type SignalReading = {
  state: SignalState;
  bScore: number;
  sScore: number;
  vwap: number;
  recentSlope: number;
  macd: MacdReading;
  tMode: TMode;
  rangePosition: number;
  volumeRatio: number;
  stockTrend: number;
  sectorTrend: number;
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
    description: "个股与板块偏强，等回落确认后再低吸",
  },
  reverse: {
    label: "反T",
    sequence: "先S后B",
    description: "个股与板块偏弱，等反弹衰竭后先减底仓",
  },
  range: {
    label: "箱体T",
    sequence: "下沿B / 上沿S",
    description: "趋势不明，只在箱体边缘等待确认",
  },
  avoid: {
    label: "暂停做T",
    sequence: "仅观察",
    description: "指数或板块风险过高，不用日内波动对抗趋势",
  },
};

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

export function evaluateSignal(
  ticks: Tick[],
  previousState: SignalState,
  cyclePhase: CyclePhase,
): SignalReading {
  if (ticks.length < 16) {
    const macd = calculateMacd(ticks);
    return {
      state: "blocked",
      bScore: 0,
      sScore: 0,
      vwap: ticks.at(-1)?.price ?? 0,
      recentSlope: 0,
      macd,
      tMode: "avoid",
      rangePosition: 0.5,
      volumeRatio: 0,
      stockTrend: 0,
      sectorTrend: 0,
      nextAction: "WAIT",
      reasons: ["等待至少16个分时样本"],
      invalidation: "数据不足",
    };
  }

  const latest = ticks.at(-1)!;
  const recent = ticks.slice(-5);
  const prior = ticks.slice(-10, -5);
  const totalVolume = ticks.reduce((sum, tick) => sum + tick.volume, 0);
  const vwap =
    ticks.reduce((sum, tick) => sum + tick.price * tick.volume, 0) /
    Math.max(totalVolume, 1);
  const recentSlope =
    (recent.at(-1)!.price / recent[0].price - 1) * 100;
  const priorSlope = (prior.at(-1)!.price / prior[0].price - 1) * 100;
  const sma5 = average(recent.map((tick) => tick.price));
  const trendWindow = ticks.slice(-40);
  const boxLow = Math.min(...trendWindow.map((tick) => tick.price));
  const boxHigh = Math.max(...trendWindow.map((tick) => tick.price));
  const rangePosition = clamp(
    ((latest.price - boxLow) / Math.max(boxHigh - boxLow, 0.001)) * 100,
    0,
    100,
  );
  const stockTrend =
    (latest.price / Math.max(trendWindow[0].price, 0.001) - 1) * 100;
  const sectorTrend = latest.sectorChange - trendWindow[0].sectorChange;
  const volumeBaseline = average(
    ticks.slice(-15, -3).map((tick) => tick.volume),
  );
  const volumeRatio =
    average(ticks.slice(-3).map((tick) => tick.volume)) /
    Math.max(volumeBaseline, 1);
  const deceleratingDown = priorSlope < -0.08 && recentSlope > priorSlope * 0.45;
  const deceleratingUp = priorSlope > 0.08 && recentSlope < priorSlope * 0.45;
  const marketRisk = latest.indexChange < -1.25 || latest.sectorChange < -1.65;
  const positiveTrend =
    stockTrend > 0.18 &&
    sectorTrend > 0.08 &&
    latest.sectorChange >= latest.indexChange - 0.15;
  const negativeTrend =
    stockTrend < -0.18 &&
    sectorTrend < -0.08 &&
    latest.sectorChange <= latest.indexChange + 0.15;
  const tMode: TMode = marketRisk
    ? "avoid"
    : positiveTrend
      ? "positive"
      : negativeTrend
        ? "reverse"
        : "range";
  const macd = calculateMacd(ticks);
  const macdConfirmB =
    macd.bullishCross ||
    macd.bullishTurn ||
    (macd.histogram > 0 && macd.histogram > macd.previousHistogram);
  const macdConfirmS =
    macd.bearishCross ||
    macd.bearishTurn ||
    (macd.histogram < 0 && macd.histogram < macd.previousHistogram);

  let bScore = 0;
  if (latest.price < vwap) bScore += 8;
  if (priorSlope < -0.08) bScore += 8;
  if (deceleratingDown) bScore += 12;
  if (rangePosition <= 35) bScore += 18;
  else if (rangePosition <= 50) bScore += 10;
  if (latest.price > sma5) bScore += 10;
  if (latest.sectorChange > latest.indexChange - 0.2) bScore += 12;
  if (volumeRatio >= 1.1) bScore += 10;
  if (macd.bullishCross) bScore += 22;
  else if (macd.bullishTurn) bScore += 16;
  else if (macd.histogram > macd.previousHistogram) bScore += 8;

  let sScore = 0;
  if (latest.price > vwap) sScore += 8;
  if (priorSlope > 0.08) sScore += 8;
  if (deceleratingUp) sScore += 12;
  if (rangePosition >= 65) sScore += 18;
  else if (rangePosition >= 50) sScore += 10;
  if (latest.price < sma5) sScore += 10;
  if (latest.sectorChange < latest.indexChange + 0.2) sScore += 12;
  if (volumeRatio >= 1.1) sScore += 10;
  if (macd.bearishCross) sScore += 22;
  else if (macd.bearishTurn) sScore += 16;
  else if (macd.histogram < macd.previousHistogram) sScore += 8;

  bScore = clamp(bScore);
  sScore = clamp(sScore);

  let state: SignalState = "blocked";
  const bConfirmed =
    bScore >= 76 &&
    recentSlope > 0 &&
    macdConfirmB &&
    rangePosition <= 52;
  const sConfirmed =
    sScore >= 76 &&
    recentSlope < 0 &&
    macdConfirmS &&
    rangePosition >= 48;
  const bWatchThreshold = previousState === "watchB" ? 52 : 58;
  const sWatchThreshold = previousState === "watchS" ? 52 : 58;
  let nextAction: SignalReading["nextAction"] =
    cyclePhase === "boughtForT"
      ? "S"
      : cyclePhase === "soldBase"
        ? "B"
        : tMode === "positive"
          ? "B"
          : tMode === "reverse"
            ? "S"
            : tMode === "range"
              ? rangePosition <= 50
                ? "B"
                : "S"
              : "WAIT";

  if (tMode !== "avoid") {
    if (nextAction === "B") {
      if (bConfirmed) state = "confirmB";
      else if (bScore >= bWatchThreshold) state = "watchB";
      else if (cyclePhase === "soldBase") state = "tracking";
    } else if (nextAction === "S") {
      if (sConfirmed) state = "confirmS";
      else if (sScore >= sWatchThreshold) state = "watchS";
      else if (cyclePhase === "boughtForT") state = "tracking";
    }
  }

  const reasons: string[] = [];
  if (marketRisk) {
    reasons.push("指数或行业仍处于快速下行，暂停做T");
    nextAction = "WAIT";
  } else {
    reasons.push(
      `${T_MODE_META[tMode].label}：个股趋势${stockTrend >= 0 ? "+" : ""}${stockTrend.toFixed(2)}%，板块趋势${sectorTrend >= 0 ? "+" : ""}${sectorTrend.toFixed(2)}%`,
    );
  }
  reasons.push(`当前位于近40个样本箱体的${rangePosition.toFixed(0)}%位置`);
  reasons.push(
    volumeRatio >= 1.1
      ? `近3个样本量能放大至基准的${volumeRatio.toFixed(2)}倍`
      : `量能仅为基准的${volumeRatio.toFixed(2)}倍，等待放量确认`,
  );
  if (macd.bullishCross) reasons.push("MACD分时DIF上穿DEA，形成金叉确认");
  else if (macd.bearishCross) reasons.push("MACD分时DIF下穿DEA，形成死叉确认");
  else if (macd.bullishTurn) reasons.push("MACD柱由收缩转为扩张，下行动能改善");
  else if (macd.bearishTurn) reasons.push("MACD柱由扩张转为收缩，上行动能转弱");
  else if (macd.histogram > macd.previousHistogram)
    reasons.push("MACD柱继续抬升，但尚未形成交叉");
  else reasons.push("MACD柱继续回落，尚未形成反转");
  if (cyclePhase === "boughtForT")
    reasons.push("已记录模拟低吸，下一步只等S点");
  if (cyclePhase === "soldBase")
    reasons.push("已记录模拟减仓，下一步只等B点买回");

  return {
    state,
    bScore,
    sScore,
    vwap,
    recentSlope,
    macd,
    tMode,
    rangePosition,
    volumeRatio,
    stockTrend,
    sectorTrend,
    nextAction,
    reasons: reasons.slice(0, 5),
    invalidation:
      state === "confirmB" || state === "tracking"
        ? `跌破箱体下沿 ${boxLow.toFixed(2)}`
        : state === "confirmS"
          ? `重新站上箱体上沿 ${boxHigh.toFixed(2)}`
          : "等待结构确认",
  };
}
