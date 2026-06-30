import { test } from "node:test";
import assert from "node:assert/strict";
import { fundingToApy, perpBasis, datedBasisApy, median, winsorizedMean, variance } from "../src/core/normalize.ts";

test("fundingToApy: hourly", () => {
  // 1時間ごと 0.00125% → 年率 = 0.0000125 * 8760
  assert.ok(Math.abs(fundingToApy(0.0000125, 1) - 0.0000125 * 8760) < 1e-9);
});

test("fundingToApy: 8h vs 1h annualization differs by interval count", () => {
  const a = fundingToApy(0.0001, 8);
  assert.ok(Math.abs(a - 0.0001 * (8760 / 8)) < 1e-9);
});

test("perpBasis", () => {
  assert.ok(Math.abs(perpBasis(101, 100) - 0.01) < 1e-9);
});

test("datedBasisApy", () => {
  // F/S-1 = 0.02 over 30 days → *365/30
  assert.ok(Math.abs(datedBasisApy(102, 100, 30) - 0.02 * (365 / 30)) < 1e-9);
});

test("median odd/even", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("winsorizedMean clamps outliers", () => {
  const xs = [1, 2, 3, 4, 100];
  const w = winsorizedMean(xs, 0.2)!;
  const plain = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(w < plain, "winsorized mean should be pulled below raw mean");
});

test("variance >=0", () => {
  assert.ok(variance([1, 2, 3])! > 0);
  assert.equal(variance([5]), 0);
});
