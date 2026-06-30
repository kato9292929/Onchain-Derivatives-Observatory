// OFN指数計算。2種類を必ず分けて出す:
//  (1) 借り需要ゲージ: 当日水準(level)。中央値・ウィンザライズ平均・分散。
//  (2) キャリー収穫指数: 累積(基準日=100)。harvestableのみ・ノーショナル上限を考慮。

import { assetsConfig } from "../core/config.js";
import { median, winsorizedMean, variance, mean } from "../core/normalize.js";
import { readAllDaily } from "../core/storage.js";
import type { OfnDaily, DemandGauge, CarryHarvestIndexPoint } from "../core/types.js";

/** 指定日(なければ最新)の借り需要ゲージをバスケット別に算出。会場はオンチェーン主体で集約。 */
export function demandGauge(daily: OfnDaily, opts: { onchainOnly?: boolean } = {}): DemandGauge[] {
  const a = assetsConfig();
  const winsor = a.indices.winsorizePct;
  const onchainOnly = opts.onchainOnly ?? true;
  const out: DemandGauge[] = [];
  for (const [key, basket] of Object.entries(a.baskets)) {
    const apys = daily.observations
      .filter((o) => basket.symbols.includes(o.symbol))
      .filter((o) => (onchainOnly ? o.venueKind === "onchain" : true))
      .map((o) => o.fundingApy);
    out.push({
      basket: key,
      count: apys.length,
      medianFundingApy: median(apys),
      winsorizedMeanFundingApy: winsorizedMean(apys, winsor),
      varianceFundingApy: variance(apys),
    });
  }
  return out;
}

/**
 * キャリー収穫指数(累積)。
 *  r_t = 等加重の各harvestable資産net carryの日次換算リターン。
 *  Index_t = Index_{t-1} × (1 + r_t)、基準日=100。
 * net carry は年率なので日次に割る(/365)。ノーショナル上限は会場OIで按分(超過分の利回り寄与を抑える)。
 */
export function carryHarvestIndex(basketKey: string): CarryHarvestIndexPoint[] {
  const a = assetsConfig();
  const basket = a.baskets[basketKey];
  if (!basket) return [];
  const cap = a.carry.notionalCapUsd;
  const history = readAllDaily<OfnDaily>("ofn");
  const points: CarryHarvestIndexPoint[] = [];
  let idx = a.indices.carryHarvestBaseValue;

  for (const day of history) {
    // harvestable かつ basket かつ オンチェーン会場のみ。会場重複時は資産ごとに最大OIの会場を採る。
    const byAsset = new Map<string, { netCarryApy: number }>();
    for (const o of day.observations) {
      if (o.tag !== "harvestable" || !basket.symbols.includes(o.symbol) || o.venueKind !== "onchain") continue;
      if (o.netCarryApy === null) continue;
      // ノーショナル上限: OIがcap未満なら取り切れる、超過分は寄与を 1 にクランプ(過大表示防止)
      const scale = o.openInterestUsd ? Math.min(1, cap / Math.max(o.openInterestUsd, 1)) : 1;
      const effective = o.netCarryApy * scale;
      const prev = byAsset.get(o.symbol);
      if (!prev || effective > prev.netCarryApy) byAsset.set(o.symbol, { netCarryApy: effective });
    }
    const dailies = [...byAsset.values()].map((x) => x.netCarryApy / 365);
    const r = mean(dailies) ?? 0;
    idx = idx * (1 + r);
    points.push({
      date: day.date,
      basket: basketKey,
      dailyReturn: r,
      index: idx,
      contributors: byAsset.size,
    });
  }
  return points;
}

/** harvestable な net carry のリーダーボード(最新日)。 */
export function carryLeaderboard(daily: OfnDaily): Array<{
  symbol: string;
  venue: string;
  netCarryApy: number;
  fundingApy: number;
  openInterestUsd: number | null;
}> {
  return daily.observations
    .filter((o) => o.tag === "harvestable" && o.netCarryApy !== null)
    .map((o) => ({
      symbol: o.symbol,
      venue: o.venue,
      netCarryApy: o.netCarryApy!,
      fundingApy: o.fundingApy,
      openInterestUsd: o.openInterestUsd,
    }))
    .sort((x, y) => y.netCarryApy - x.netCarryApy);
}

/**
 * 同一資産の会場横断funding(オンチェーン会場どうしの比較)。
 * CEX乖離の意味づけは持たない。オンチェーン会場が複数ある場合に、会場間のfunding APYの
 * ばらつき(最大−最小)を歪み/裁定シグナルとして出す。現状ライブはHyperliquidのみのため、
 * 会場が1つだと crossVenueSpreadApy は null(比較対象が無い)になる。
 */
export function venuesForSymbol(daily: OfnDaily, symbol: string) {
  // OFNはオンチェーン会場のみ。安全のため明示的にonchainへ絞る。
  const rows = daily.observations.filter((o) => o.symbol === symbol && o.venueKind === "onchain");
  const apys = rows.map((o) => o.fundingApy);
  const spread = apys.length >= 2 ? Math.max(...apys) - Math.min(...apys) : null;
  return {
    symbol,
    venues: rows.map((o) => ({ venue: o.venue, kind: o.venueKind, fundingApy: o.fundingApy })),
    onchainMeanApy: mean(apys),
    venueCount: rows.length,
    crossVenueSpreadApy: spread,
  };
}
