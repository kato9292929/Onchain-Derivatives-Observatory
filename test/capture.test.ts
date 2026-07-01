import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCapture, captureLeaderboard } from "../src/pcm/capture.ts";
import type { RawOption } from "../src/pcm/sources/derive.ts";

function raw(over: Partial<RawOption>): RawOption {
  return {
    venue: "derive",
    symbol: "BTC",
    strategy: "covered_call",
    instrument: "BTC-20260926-65000-C",
    strike: 65000,
    expiry: "2026-09-26T08:00:00Z",
    optionType: "call",
    spot: 61000,
    iv: 0.55,
    ivSource: "derive get_ticker:option_pricing.iv",
    receivedPremium: 4900,
    receiptSource: "last_trade",
    openInterestUsd: 5_000_000,
    volumeUsd: 200_000,
    ...over,
  };
}

test("computeCapture: captureRate = received / fair, takeRate = 1 - capture", () => {
  const o = computeCapture(raw({}), "2026-06-30T00:00:00Z");
  assert.ok(o.fairPremium > 0);
  assert.ok(Math.abs(o.captureRate - o.receivedPremium / o.fairPremium) < 1e-9);
  assert.ok(Math.abs(o.takeRate - (1 - o.captureRate)) < 1e-9);
  assert.equal(o.receiptSource, "last_trade");
});

test("computeCapture: OI/volume 欠損(null)は 0 埋めせず lowLiquidity=true", () => {
  const o = computeCapture(raw({ openInterestUsd: null, volumeUsd: null }), "2026-06-30T00:00:00Z");
  assert.equal(o.openInterestUsd, null);
  assert.equal(o.volumeUsd, null);
  assert.equal(o.lowLiquidity, true);
});

test("captureLeaderboard: last_trade と board_bid を混ぜない", () => {
  const now = "2026-06-30T00:00:00Z";
  const obs = [
    computeCapture(raw({ receiptSource: "last_trade", instrument: "A" }), now),
    computeCapture(raw({ receiptSource: "board_bid", instrument: "B" }), now),
  ];
  const lb = captureLeaderboard(obs);
  assert.equal(lb.lastTrade.length, 1);
  assert.equal(lb.boardBidApprox.length, 1);
  assert.equal(lb.lastTrade[0]!.instrument, "A");
  assert.equal(lb.boardBidApprox[0]!.instrument, "B");
});
