// 正規化ロジック。funding APY換算 / ベーシス年率化 / net carry / 統計(中央値・ウィンザライズ平均・分散)。

/** funding APY換算 = (1区間funding) × (1年の区間数) */
export function fundingToApy(fundingRatePerInterval: number, intervalHours: number): number {
  const intervalsPerYear = (365 * 24) / intervalHours;
  return fundingRatePerInterval * intervalsPerYear;
}

/** perp瞬間ベーシス = mark/spot - 1 */
export function perpBasis(mark: number, spot: number): number {
  return mark / spot - 1;
}

/** dated先物ベーシス年率 = (F/S - 1) × (365 / 満期までの日数) */
export function datedBasisApy(forward: number, spot: number, daysToExpiry: number): number {
  if (daysToExpiry <= 0) return 0;
  return (forward / spot - 1) * (365 / daysToExpiry);
}

/**
 * net carry(年率) = funding収穫 − 想定コスト。
 * spotロング/perpショート。fundingが正ならshort側が受け取る前提。
 * fee は往復ノーショナル比(bps)を年率の取引頻度では持たず、ポジション設定の一回コストとして年率に均す簡略化。
 */
export function netCarryApy(params: {
  fundingApy: number;
  roundTripFeeBps: number;
  borrowApy: number;
}): number {
  const feeApy = params.roundTripFeeBps / 10000; // 設定上の年率コスト近似
  return params.fundingApy - feeApy - params.borrowApy;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 上下 pct(0..0.5) を刈り込んだ平均 */
export function winsorizedMean(xs: number[], pct: number): number | null {
  if (xs.length === 0) return null;
  if (xs.length < 3 || pct <= 0) return mean(xs);
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length * pct);
  const lo = s[k]!;
  const hi = s[s.length - 1 - k]!;
  const clamped = s.map((v) => Math.min(Math.max(v, lo), hi));
  return mean(clamped);
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function variance(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null) return null;
  if (xs.length < 2) return 0;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}
