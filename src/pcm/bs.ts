// Black-Scholes ヨーロピアンオプション理論価格。PCMのフェア値算出に使う。
// 前提(IV出所・金利)は呼び出し側で全件開示する。

/** 標準正規分布の累積分布関数(Abramowitz-Stegun近似)。 */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface BsParams {
  spot: number;
  strike: number;
  /** 年率金利(小数) */
  rate: number;
  /** インプライドボラティリティ(年率, 小数) */
  iv: number;
  /** 満期までの年数 */
  timeYears: number;
  type: "call" | "put";
}

/** 理論プレミアム(原資産1単位あたり)。 */
export function blackScholes(p: BsParams): number {
  const { spot, strike, rate, iv, timeYears, type } = p;
  if (timeYears <= 0 || iv <= 0) {
    // 満期/ボラがゼロなら本源的価値
    const intrinsic = type === "call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    return intrinsic;
  }
  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * timeYears) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const disc = Math.exp(-rate * timeYears);
  if (type === "call") {
    return spot * normCdf(d1) - strike * disc * normCdf(d2);
  }
  return strike * disc * normCdf(-d2) - spot * normCdf(-d1);
}

/** 満期日数 → 年数 */
export function yearsToExpiry(expiryIso: string, nowIso: string): number {
  const ms = new Date(expiryIso).getTime() - new Date(nowIso).getTime();
  return Math.max(ms / (365 * 24 * 3600 * 1000), 0);
}
