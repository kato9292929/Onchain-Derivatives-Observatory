// ODO 共通型定義。OFN/PCM/採点が共有する。

export type CarryTag = "harvestable" | "fundable";
export type VenueKind = "onchain" | "cex";

/** OFN: 1会場×1資産の日次funding/basis観測 */
export interface FundingObservation {
  venue: string;
  venueKind: VenueKind;
  symbol: string;
  /** 1区間あたりfunding(小数。例: 0.000125 = 0.0125%) */
  fundingRate: number;
  /** 会場の付与間隔(時間) */
  fundingIntervalHours: number;
  /** APY換算 funding(小数) */
  fundingApy: number;
  /** mark価格(perp) */
  markPrice: number | null;
  /** spot指数価格 */
  spotPrice: number | null;
  /** ベーシス(perp): (mark/spot - 1) 年率化はしない瞬間値。年率はbasisApy */
  basis: number | null;
  /** ベーシス年率(dated先物がある場合は満期日数で年率化) */
  basisApy: number | null;
  /** 建玉(USD想定) */
  openInterestUsd: number | null;
  /** デルタニュートラル net carry(年率, 小数)。funding収穫 − 想定コスト */
  netCarryApy: number | null;
  tag: CarryTag;
}

/** OFN日次収集の1ファイル */
export interface OfnDaily {
  date: string; // YYYY-MM-DD (UTC)
  generatedAt: string; // ISO8601
  observations: FundingObservation[];
  source: "live" | "fixture";
}

/** バスケット別ゲージ(借り需要、当日水準) */
export interface DemandGauge {
  basket: string;
  count: number;
  medianFundingApy: number | null;
  winsorizedMeanFundingApy: number | null;
  varianceFundingApy: number | null; // 市場ストレス指標
}

/** キャリー収穫指数(累積) */
export interface CarryHarvestIndexPoint {
  date: string;
  basket: string;
  dailyReturn: number; // r_t
  index: number; // Index_t
  contributors: number; // harvestable資産数
}

/** PCM: 会場×資産×戦略×限月の捕捉率観測 */
export interface PremiumCaptureObservation {
  venue: string;
  symbol: string;
  strategy: string;
  instrument: string; // 例: BTC-20260626-100000-C
  strike: number;
  expiry: string; // ISO8601
  optionType: "call" | "put";
  spot: number;
  iv: number; // 観測IV(小数)
  ivSource: string; // 出所開示(必須)
  riskFreeRate: number;
  riskFreeRateSource: string;
  fairPremium: number; // Black-Scholes理論プレミアム(USD)
  receivedPremium: number; // 売り手実受取(USD)
  captureRate: number; // 実受取 / フェア値
  takeRate: number; // 1 - captureRate
  lowLiquidity: boolean; // 薄商いタグ
  openInterestUsd: number | null;
  volumeUsd: number | null;
}

export interface PcmDaily {
  date: string;
  generatedAt: string;
  observations: PremiumCaptureObservation[];
  source: "live" | "fixture";
}

/** 採点: 週次宣言 */
export interface Declaration {
  id: string;
  module: "OFN" | "PCM";
  /** 宣言した日(dated) */
  declaredAt: string;
  /** 評価対象週(YYYY-Www) */
  week: string;
  /** 方向 or 水準の主張 */
  claim: string;
  /** 機械照合用の構造化主張 */
  predicate: {
    metric: string; // 例: "majors.netCarryApy", "venue_strategy.captureRate.rank1"
    op: "gt" | "lt" | "gte" | "lte" | "eq" | "direction_down" | "direction_up";
    value: number | string;
  };
  agentId: string | null; // ERC-8004 紐づけ(登録後に設定)
}

/** 採点: 照合結果 */
export interface GradeResult {
  declarationId: string;
  week: string;
  gradedAt: string;
  realizedValue: number | string | null;
  hit: boolean | null;
  /** 較正用: 主張を確率として出していた場合のbrier成分(0..1) */
  brier: number | null;
  /** 水準誤差(該当時) */
  error: number | null;
  note: string;
  agentId: string | null;
}
