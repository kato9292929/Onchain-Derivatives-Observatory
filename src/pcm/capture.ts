// 捕捉率計算。フェア値(BS理論プレミアム)と実受取から捕捉率・取り分を出し、薄商いタグを付ける。
// 前提(IV出所・金利)は全件 observation に残す(PCMのmoat=正直さ)。

import { pcmConfig } from "../core/config.js";
import { blackScholes, yearsToExpiry } from "./bs.js";
import type { PremiumCaptureObservation } from "../core/types.js";
import type { RawOption } from "./sources/derive.js";

export function computeCapture(raw: RawOption, nowIso: string): PremiumCaptureObservation {
  const cfg = pcmConfig();
  const t = yearsToExpiry(raw.expiry, nowIso);
  const fairPremium = blackScholes({
    spot: raw.spot,
    strike: raw.strike,
    rate: cfg.riskFreeRate,
    iv: raw.iv,
    timeYears: t,
    type: raw.optionType,
  });
  const captureRate = fairPremium > 0 ? raw.receivedPremium / fairPremium : 0;
  const lowLiquidity =
    (raw.openInterestUsd ?? 0) < cfg.lowLiquidity.minOpenInterestUsd ||
    (raw.volumeUsd ?? 0) < cfg.lowLiquidity.minDailyVolumeUsd;

  return {
    venue: raw.venue,
    symbol: raw.symbol,
    strategy: raw.strategy,
    instrument: raw.instrument,
    strike: raw.strike,
    expiry: raw.expiry,
    optionType: raw.optionType,
    spot: raw.spot,
    iv: raw.iv,
    ivSource: raw.ivSource,
    riskFreeRate: cfg.riskFreeRate,
    riskFreeRateSource: cfg.riskFreeRateSource,
    fairPremium,
    receivedPremium: raw.receivedPremium,
    captureRate,
    takeRate: 1 - captureRate,
    lowLiquidity,
    openInterestUsd: raw.openInterestUsd,
    volumeUsd: raw.volumeUsd,
  };
}

/** 会場×戦略別の捕捉率リーダーボード(高い順)。薄商いは信頼度を下げて末尾寄りに。 */
export function captureLeaderboard(obs: PremiumCaptureObservation[]) {
  return [...obs]
    .map((o) => ({
      venue: o.venue,
      strategy: o.strategy,
      symbol: o.symbol,
      instrument: o.instrument,
      captureRate: o.captureRate,
      takeRate: o.takeRate,
      lowLiquidity: o.lowLiquidity,
    }))
    .sort((a, b) => {
      if (a.lowLiquidity !== b.lowLiquidity) return a.lowLiquidity ? 1 : -1;
      return b.captureRate - a.captureRate;
    });
}
