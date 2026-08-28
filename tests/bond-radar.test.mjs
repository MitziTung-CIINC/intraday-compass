import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateSync,
  calculateVolatilityScore,
  compareMinutePaths,
  effectiveMovement,
  effectiveRangePosition,
  evaluateTrendEligibility,
  pearsonCorrelation,
  validateMiddaySnapshot,
} from "../tools/update-bond-radar.mjs";

test("minute paths report perfect positive and negative correlations", () => {
  assert.equal(pearsonCorrelation([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(pearsonCorrelation([1, 2, 3], [6, 4, 2]), -1);
});

test("sync score rewards positive path correlation and direction agreement", () => {
  assert.equal(calculateSync(1, 1), 100);
  assert.equal(calculateSync(-1, 0), 0);
  assert.equal(calculateSync(0.5, 0.5), 50);
});

test("minute paths normalize both securities from the common 09:30 close", () => {
  const points = Array.from({ length: 20 }, (_, index) => ({
    time: `2026-08-28 09:${String(30 + index).padStart(2, "0")}`,
    close: 100 + index,
  }));
  const result = compareMinutePaths(
    { points },
    {
      points: points.map((point, index) => ({ ...point, close: 200 + index * 2 })),
    },
    { bondChange: 99, stockChange: -99 },
  );

  assert.equal(result.syncMode, "minute-path");
  assert.equal(result.baselineTime, "09:30");
  assert.deepEqual(result.timeline[0], {
    time: "09:30",
    bondReturn: 0,
    stockReturn: 0,
  });
  assert.equal(result.latestBondReturn, 19);
  assert.equal(result.latestStockReturn, 19);
  assert.equal(result.syncRate, 100);
});

test("volatility score uses the documented 55/45 weighting", () => {
  assert.equal(calculateVolatilityScore(10, 4), 7.3);
});

test("effective movement includes an overnight gap from previous close", () => {
  assert.equal(effectiveMovement(110, 105, 100), 10);
  assert.equal(effectiveMovement(99, 92, 100), 8);
});

test("effective range position uses previous close as part of the tradable range", () => {
  assert.equal(effectiveRangePosition(109, 110, 103, 100), 90);
  assert.equal(effectiveRangePosition(92, 99, 90, 100), 20);
});

test("trend gate treats all pairs equally and rejects non-upward linkage", () => {
  const pair = {
    bondAmplitude: 8,
    stockAmplitude: 10,
    bond: {
      price: 106,
      previousClose: 100,
      open: 101,
      high: 108,
      low: 100,
      changePct: 6,
    },
    stock: {
      price: 109,
      previousClose: 100,
      open: 102,
      high: 110,
      low: 100,
      changePct: 9,
    },
  };
  assert.equal(evaluateTrendEligibility(pair).passed, true);

  const fallingStock = {
    ...pair,
    stock: {
      ...pair.stock,
      price: 98.7,
      open: 100,
      high: 101,
      low: 97.8,
      changePct: -1.3,
    },
    stockAmplitude: 3.2,
  };
  const result = evaluateTrendEligibility(fallingStock);
  assert.equal(result.passed, false);
  assert.ok(result.failedReasons.includes("转债与正股未形成日内向上结构"));
});

test("midday publication requires today's complete 11:30 minute paths", () => {
  const snapshot = {
    tradeDate: "2026-08-27",
    latestMinute: "11:30",
    items: [
      {
        professionalScore: 88,
        bond: { code: "110001" },
        stock: { code: "600001" },
        sync: {
          syncMode: "minute-path",
          tradeDate: "2026-08-27",
          baselineTime: "09:30",
          sampleCount: 121,
          syncRate: 82,
        },
      },
    ],
  };

  assert.equal(validateMiddaySnapshot(snapshot, "2026-08-27").published, true);
  assert.equal(validateMiddaySnapshot(snapshot, "2026-08-28").published, false);
  assert.throws(
    () => validateMiddaySnapshot({ ...snapshot, latestMinute: "11:29" }, "2026-08-27"),
    /11:30/,
  );
});
