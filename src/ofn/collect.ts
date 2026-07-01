// OFN日次収集: 各会場のfunding/basisを採取し正規化、net carryとtagを付けて data/ofn/<date>.json に保存。

import { assetsConfig, venuesConfig, utcDate } from "../core/config.js";
import { fundingToApy, perpBasis, netCarryApy } from "../core/normalize.js";
import { writeDaily } from "../core/storage.js";
import { log } from "../core/logger.js";
import type { FundingObservation, OfnDaily, CarryTag } from "../core/types.js";
import { collectHyperliquid, type RawVenueFunding } from "./sources/hyperliquid.js";

export interface CollectOpts {
  date?: string;
  offline?: boolean;
  /** 採取対象会場(未指定なら implemented な会場すべて) */
  venues?: string[];
  /** 採取対象シンボル(未指定なら baskets 全体) */
  symbols?: string[];
}

function allBasketSymbols(): string[] {
  const a = assetsConfig();
  return Object.values(a.baskets).flatMap((b) => b.symbols);
}

function finalize(raw: RawVenueFunding[]): FundingObservation[] {
  const a = assetsConfig();
  const v = venuesConfig();
  return raw.map((r): FundingObservation => {
    const fundingApy = fundingToApy(r.fundingRate, r.fundingIntervalHours);
    const basis = r.markPrice && r.spotPrice ? perpBasis(r.markPrice, r.spotPrice) : null;
    const assetMeta = a.assets[r.symbol];
    const tag: CarryTag = assetMeta?.tag ?? "fundable";
    const venueKind = v.venues[r.venue]?.kind ?? "onchain";
    // net carry は harvestable のみ意味を持つ。fundable は null。
    const netCarry =
      tag === "harvestable"
        ? netCarryApy({
            fundingApy,
            roundTripFeeBps: a.carry.roundTripFeeBps,
            borrowApy: a.carry.borrowApyDefault,
          })
        : null;
    return {
      venue: r.venue,
      venueKind,
      symbol: r.symbol,
      fundingRate: r.fundingRate,
      fundingRateRaw: r.fundingRateRaw,
      fundingIntervalHours: r.fundingIntervalHours,
      fundingApy,
      markPrice: r.markPrice,
      spotPrice: r.spotPrice,
      basis,
      basisApy: null, // perp瞬間ベーシスは年率化しない。dated先物導入時に basisApy を埋める。
      openInterestUsd: r.openInterestUsd,
      netCarryApy: netCarry,
      tag,
    };
  });
}

export async function collectOfn(opts: CollectOpts = {}): Promise<OfnDaily> {
  const date = opts.date ?? utcDate();
  const offline = opts.offline ?? false;
  const symbols = opts.symbols ?? allBasketSymbols();
  const vcfg = venuesConfig().venues;
  const venues = opts.venues ?? Object.keys(vcfg).filter((k) => vcfg[k]?.status === "implemented");

  const raw: RawVenueFunding[] = [];
  for (const venue of venues) {
    if (venue === "hyperliquid") raw.push(...(await collectHyperliquid(symbols, offline)));
    else log.warn("venue not implemented yet, skipping", { venue });
  }

  const observations = finalize(raw);
  const daily: OfnDaily = {
    date,
    generatedAt: new Date().toISOString(),
    observations,
    source: offline ? "fixture" : "live",
  };
  const path = writeDaily("ofn", date, daily);
  log.info("ofn collected", { date, venues, observations: observations.length, path });
  return daily;
}
