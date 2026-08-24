import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateNineTurn,
  evaluateSignal,
  recommendTrancheQuantity,
} from "../app/t0Model.ts";

function minuteTime(index) {
  const total = 9 * 60 + 45 + index;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function makeTicks(prices, volumes = []) {
  return prices.map((price, index) => {
    const previous = prices[Math.max(0, index - 1)];
    return {
      time: minuteTime(index),
      price,
      open: previous,
      high: Math.max(price, previous) + 0.02,
      low: Math.min(price, previous) - 0.02,
      volume: volumes[index] ?? 1000,
      sectorChange: index * 0.002,
      indexChange: index * 0.001,
      indexLevel: 3600 + index * 0.1,
    };
  });
}

function dailyBars(direction = "up") {
  return Array.from({ length: 25 }, (_, index) => {
    const close = direction === "up" ? 9.5 + index * 0.025 : 10.5 - index * 0.025;
    return {
      date: `202607${String(index + 1).padStart(2, "0")}`,
      open: close - (direction === "up" ? 0.01 : -0.01),
      high: close + 0.08,
      low: close - 0.08,
      close,
      volume: 100000 + index * 1000,
    };
  });
}

function validContext(overrides = {}) {
  return {
    dataValid: true,
    indexSeriesValid: true,
    sectorSeriesValid: true,
    dailySeriesValid: true,
    holdingShares: 10000,
    sellableShares: 6000,
    turnaround: "t1",
    instrumentKind: "stock",
    dailyBars: dailyBars("up"),
    now: "2026-08-18T10:30:00+08:00",
    ...overrides,
  };
}

test("nine-turn compares with four bars ago, caps at nine, and resets on interruption", () => {
  const completed = calculateNineTurn([1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(completed.up, 9);
  assert.equal(completed.upCompleted, true);
  const interrupted = calculateNineTurn([
    1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0.5,
  ]);
  assert.equal(interrupted.up, 0);
  assert.equal(interrupted.down, 1);
});

test("a missing sector series is auxiliary and no longer blocks the data gate", () => {
  const prices = Array.from({ length: 70 }, (_, index) => 10 + index * 0.004);
  const reading = evaluateSignal(
    makeTicks(prices),
    "blocked",
    "neutral",
    validContext({ sectorSeriesValid: false }),
  );
  assert.equal(
    reading.hardGates.find((gate) => gate.key === "data")?.passed,
    true,
  );
  assert.match(
    reading.hardGates.find((gate) => gate.key === "data")?.reason ?? "",
    /板块仅作辅助显示/,
  );
});

test("the first high-volume selloff is not treated as a B-point volume confirmation", () => {
  const prices = [
    ...Array.from({ length: 20 }, (_, index) => 10 + index * 0.002),
    10.02,
    9.96,
    9.88,
    9.8,
    9.72,
  ];
  const volumes = prices.map((_, index) => (index >= 20 ? 2600 : 800));
  const reading = evaluateSignal(
    makeTicks(prices, volumes),
    "blocked",
    "neutral",
    validContext(),
  );
  assert.equal(reading.volumePhase, "fallingInitial");
  assert.equal(reading.bComponents.volume, 0);
});

test("one-minute volume noise does not override the completed five-minute wave", () => {
  const prices = [
    10.4, 10.4, 10.4, 10.4, 10.4,
    10.36, 10.32, 10.28, 10.24, 10.2,
    10.17, 10.14, 10.11, 10.08, 10.05,
    10.13,
  ];
  const volumes = [
    800, 800, 800, 800, 800,
    1000, 1000, 1000, 1000, 1000,
    600, 600, 600, 600, 600,
    5000,
  ];
  const reading = evaluateSignal(
    makeTicks(prices, volumes),
    "blocked",
    "neutral",
    validContext(),
  );
  assert.equal(reading.volumePhase, "fallingDrift");
  assert.equal(reading.volumeRatio, 0.6);
  assert.equal(reading.bComponents.volume, 20);
});

test("a rising five-minute wave shrinking below 0.70 emits an S observation before spread confirmation", () => {
  const prices = [
    10, 10, 10, 10, 10,
    10.04, 10.08, 10.12, 10.16, 10.2,
    10.23, 10.26, 10.28, 10.3, 10.32,
    10.33,
  ];
  const volumes = [
    800, 800, 800, 800, 800,
    1000, 1000, 1000, 1000, 1000,
    600, 600, 600, 600, 600,
    5000,
  ];
  const reading = evaluateSignal(
    makeTicks(prices, volumes),
    "blocked",
    "neutral",
    validContext({
      dailyBars: dailyBars("down"),
      sectorSeriesValid: false,
      estimatedRoundTripCostPct: 5,
      expectedSlippagePct: 0,
    }),
  );
  assert.equal(reading.volumePhase, "risingExhaustion");
  assert.equal(reading.volumeRatio, 0.6);
  assert.equal(reading.hardGatePassed, false);
  assert.equal(reading.state, "watchS");
  assert.equal(reading.nextAction, "S");
});

test("a falling five-minute wave shrinking below 0.70 emits a B observation", () => {
  const prices = [
    10.4, 10.4, 10.4, 10.4, 10.4,
    10.36, 10.32, 10.28, 10.24, 10.2,
    10.17, 10.14, 10.11, 10.08, 10.05,
    10.04,
  ];
  const volumes = [
    800, 800, 800, 800, 800,
    1000, 1000, 1000, 1000, 1000,
    600, 600, 600, 600, 600,
    5000,
  ];
  const reading = evaluateSignal(
    makeTicks(prices, volumes),
    "blocked",
    "neutral",
    validContext({
      estimatedRoundTripCostPct: 5,
      expectedSlippagePct: 0,
    }),
  );
  assert.equal(reading.volumePhase, "fallingDrift");
  assert.equal(reading.volumeRatio, 0.6);
  assert.equal(reading.state, "watchB");
  assert.equal(reading.nextAction, "B");
});

test("the five-minute shrink threshold can be tightened from 0.70 to 0.50", () => {
  const prices = [
    10, 10, 10, 10, 10,
    10.04, 10.08, 10.12, 10.16, 10.2,
    10.23, 10.26, 10.28, 10.3, 10.32,
    10.33,
  ];
  const volumes = [
    800, 800, 800, 800, 800,
    1000, 1000, 1000, 1000, 1000,
    600, 600, 600, 600, 600,
    5000,
  ];
  const relaxed = evaluateSignal(
    makeTicks(prices, volumes),
    "blocked",
    "neutral",
    validContext({ dailyBars: dailyBars("down") }),
  );
  const strict = evaluateSignal(
    makeTicks(prices, volumes),
    "blocked",
    "neutral",
    validContext({
      dailyBars: dailyBars("down"),
      volumeShrinkThreshold: 0.5,
    }),
  );
  assert.equal(relaxed.volumePhase, "risingExhaustion");
  assert.equal(strict.volumePhase, "balanced");
});

test("14:45 closeout requires valid data and restores the exact open-cycle quantity", () => {
  const prices = Array.from({ length: 70 }, (_, index) => 10 + Math.sin(index / 5) * 0.08);
  const ticks = makeTicks(prices);
  const closeout = evaluateSignal(
    ticks,
    "tracking",
    "boughtForT",
    validContext({ now: "2026-08-18T14:50:00+08:00" }),
  );
  assert.equal(closeout.forcedClose, true);
  assert.equal(closeout.nextAction, "S");
  assert.equal(closeout.state, "confirmS");
  assert.equal(recommendTrancheQuantity(6000, closeout, "boughtForT", 1700), 1700);

  const invalid = evaluateSignal(
    ticks,
    "tracking",
    "boughtForT",
    validContext({
      now: "2026-08-18T14:50:00+08:00",
      dataValid: false,
    }),
  );
  assert.equal(invalid.forcedClose, true);
  assert.notEqual(invalid.state, "confirmS");
});

test("neutral-cycle sizing uses 25 percent normally and 50 percent only for strong wide spreads", () => {
  const base = {
    hardGatePassed: true,
    nextAction: "B",
    maturity: 76,
    expectedSpreadPct: 0.5,
    requiredSpreadPct: 0.2,
  };
  assert.equal(recommendTrancheQuantity(10000, base, "neutral", 0), 2500);
  assert.equal(
    recommendTrancheQuantity(
      10000,
      { ...base, maturity: 88, expectedSpreadPct: 0.6 },
      "neutral",
      0,
    ),
    5000,
  );
  assert.equal(
    recommendTrancheQuantity(
      10000,
      { ...base, hardGatePassed: false },
      "neutral",
      0,
    ),
    0,
  );
});
