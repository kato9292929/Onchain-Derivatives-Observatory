// REST と MCP が共有するクエリ層。data/ の日付きJSONを読み、配信用の形に整える。

import { listDates, readDaily, readAllDaily } from "./storage.js";
import type { OfnDaily, PcmDaily, DemandGauge } from "./types.js";
import { demandGauge, carryHarvestIndex, carryLeaderboard, venuesForSymbol } from "../ofn/index.js";
import { captureLeaderboard } from "../pcm/capture.js";

function latestOfn(): OfnDaily | null {
  const dates = listDates("ofn");
  const last = dates[dates.length - 1];
  return last ? readDaily<OfnDaily>("ofn", last) : null;
}
function latestPcm(): PcmDaily | null {
  const dates = listDates("pcm");
  const last = dates[dates.length - 1];
  return last ? readDaily<PcmDaily>("pcm", last) : null;
}

export function fundingNowcastCurrent() {
  const d = latestOfn();
  if (!d) return { error: "no OFN data yet" };
  return { date: d.date, source: d.source, gauges: demandGauge(d) };
}

export function fundingNowcastHistory() {
  const all = readAllDaily<OfnDaily>("ofn");
  const series: Record<string, Array<{ date: string } & Omit<DemandGauge, "basket">>> = {};
  for (const d of all) {
    for (const g of demandGauge(d)) {
      (series[g.basket] ??= []).push({
        date: d.date,
        count: g.count,
        medianFundingApy: g.medianFundingApy,
        winsorizedMeanFundingApy: g.winsorizedMeanFundingApy,
        varianceFundingApy: g.varianceFundingApy,
      });
    }
  }
  return { series };
}

export function fundingAsset(symbol: string) {
  const d = latestOfn();
  if (!d) return { error: "no OFN data yet" };
  const rows = d.observations.filter((o) => o.symbol === symbol.toUpperCase());
  if (rows.length === 0) return { error: `symbol not found: ${symbol}` };
  return { date: d.date, symbol: symbol.toUpperCase(), observations: rows };
}

export function fundingVenues(symbol: string) {
  const d = latestOfn();
  if (!d) return { error: "no OFN data yet" };
  return { date: d.date, ...venuesForSymbol(d, symbol.toUpperCase()) };
}

export function carryLeaderboardQ() {
  const d = latestOfn();
  if (!d) return { error: "no OFN data yet" };
  const majorsIdx = carryHarvestIndex("majors");
  return {
    date: d.date,
    leaderboard: carryLeaderboard(d),
    carryHarvestIndex: {
      majors: majorsIdx[majorsIdx.length - 1] ?? null,
    },
  };
}

export function carryIndexHistory(basket: string) {
  return { basket, points: carryHarvestIndex(basket) };
}

export function premiumCaptureCurrent() {
  const d = latestPcm();
  if (!d) return { error: "no PCM data yet" };
  return { date: d.date, source: d.source, observations: d.observations };
}

export function premiumCaptureHistory() {
  const all = readAllDaily<PcmDaily>("pcm");
  return {
    series: all.map((d) => ({
      date: d.date,
      observations: d.observations.map((o) => ({
        venue: o.venue,
        strategy: o.strategy,
        instrument: o.instrument,
        captureRate: o.captureRate,
        receiptSource: o.receiptSource,
        lowLiquidity: o.lowLiquidity,
      })),
    })),
  };
}

export function premiumCaptureLeaderboardQ() {
  const d = latestPcm();
  if (!d) return { error: "no PCM data yet" };
  return { date: d.date, leaderboard: captureLeaderboard(d.observations) };
}
