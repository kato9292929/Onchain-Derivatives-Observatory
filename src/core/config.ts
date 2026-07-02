// 設定ファイルローダー。定数は config/*.json に外出ししている。

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

/**
 * ディレクトリ解決。サーバレス(Vercel)ではバンドル後に __dirname が変わり、
 * リポジトリ相対パスが外れることがある。env上書き → リポジトリ相対(存在すれば) → cwd 相対 の順で解決。
 * (Vercelでは vercel.json の includeFiles で config/**・data/** を関数へ同梱し、cwd=プロジェクトルートで拾う。)
 */
function resolveDir(envVar: string, name: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return resolve(fromEnv);
  const repoRel = resolve(ROOT, name);
  if (existsSync(repoRel)) return repoRel;
  return resolve(process.cwd(), name);
}

export const CONFIG_DIR = resolveDir("ODO_CONFIG_DIR", "config");
export const DATA_DIR = resolveDir("ODO_DATA_DIR", "data");
export const FIXTURE_DIR = resolveDir("ODO_FIXTURE_DIR", "fixtures");
export const REPO_ROOT = ROOT;

function load<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(CONFIG_DIR, name), "utf8")) as T;
}

export interface VenueMeta {
  kind: "onchain";
  label: string;
  fundingIntervalHours: number;
  status: string;
  notes?: string;
}
export interface VenuesConfig {
  venues: Record<string, VenueMeta>;
}

export interface AssetsConfig {
  baskets: Record<string, { label: string; symbols: string[] }>;
  assets: Record<string, { tag: "harvestable" | "fundable"; hasSpot: boolean; basket: string }>;
  carry: {
    takerFeeAnnualizedBps: number;
    roundTripFeeBps: number;
    borrowApyDefault: number;
    notionalCapUsd: number;
  };
  indices: { carryHarvestBaseValue: number; winsorizePct: number };
}

export interface PcmConfig {
  riskFreeRate: number;
  riskFreeRateSource: string;
  lowLiquidity: { minOpenInterestUsd: number; minDailyVolumeUsd: number };
  venues: Record<string, { label: string; status: string; ivSource: string; notes?: string }>;
  strategies: string[];
}

export const venuesConfig = (): VenuesConfig => load<VenuesConfig>("venues.json");
export const assetsConfig = (): AssetsConfig => load<AssetsConfig>("assets.json");
export const pcmConfig = (): PcmConfig => load<PcmConfig>("pcm.json");

/** UTC 日付 YYYY-MM-DD。テスト可能なように now を注入できる。 */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** ISO週 YYYY-Www */
export function isoWeek(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
