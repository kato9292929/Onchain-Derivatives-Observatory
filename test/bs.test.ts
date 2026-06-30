import { test } from "node:test";
import assert from "node:assert/strict";
import { blackScholes, normCdf } from "../src/pcm/bs.ts";

test("normCdf symmetric around 0", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
});

test("call put parity: C - P = S - K e^{-rT}", () => {
  const base = { spot: 100, strike: 100, rate: 0.05, iv: 0.4, timeYears: 1 } as const;
  const c = blackScholes({ ...base, type: "call" });
  const p = blackScholes({ ...base, type: "put" });
  const lhs = c - p;
  const rhs = base.spot - base.strike * Math.exp(-base.rate * base.timeYears);
  assert.ok(Math.abs(lhs - rhs) < 1e-2, `parity off: ${lhs} vs ${rhs}`);
});

test("intrinsic when timeYears=0", () => {
  assert.equal(blackScholes({ spot: 120, strike: 100, rate: 0.05, iv: 0.5, timeYears: 0, type: "call" }), 20);
  assert.equal(blackScholes({ spot: 80, strike: 100, rate: 0.05, iv: 0.5, timeYears: 0, type: "put" }), 20);
});
