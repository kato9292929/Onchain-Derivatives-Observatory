// Hyperliquid perp funding/basis ソース。
// 公開 info エンドポイント: POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"}
//  → [ {universe:[{name,...}]}, [ {funding, openInterest, markPx, oraclePx, dayNtlVlm, ...}, ... ] ]
// funding は1時間ごとの rate(文字列)。oraclePx を spot指数、markPx を mark とみなす。

import { httpJson } from "../../core/http.js";
import { logSource } from "../../core/logger.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURE_DIR } from "../../core/config.js";

export interface RawVenueFunding {
  venue: string;
  symbol: string;
  fundingRate: number;
  fundingIntervalHours: number;
  markPrice: number | null;
  spotPrice: number | null;
  openInterestUsd: number | null;
}

const HL_URL = "https://api.hyperliquid.xyz/info";

interface HlMeta {
  universe: { name: string }[];
}
interface HlCtx {
  funding: string;
  openInterest: string;
  markPx: string;
  oraclePx: string;
  dayNtlVlm: string;
}

function fromFixture(symbols: string[]): RawVenueFunding[] {
  const raw = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "ofn", "hyperliquid.json"), "utf8")) as RawVenueFunding[];
  return raw.filter((r) => symbols.includes(r.symbol));
}

export async function collectHyperliquid(symbols: string[], offline = false): Promise<RawVenueFunding[]> {
  if (offline) {
    logSource("OFN", "hyperliquid", "fixture", { reason: "offline flag" });
    return fromFixture(symbols);
  }
  try {
    const data = await httpJson<[HlMeta, HlCtx[]]>(HL_URL, {
      method: "POST",
      body: { type: "metaAndAssetCtxs" },
      timeoutMs: 15000,
    });
    const [meta, ctxs] = data;
    const out: RawVenueFunding[] = [];
    for (let i = 0; i < meta.universe.length; i++) {
      const name = meta.universe[i]?.name;
      const ctx = ctxs[i];
      if (!name || !ctx || !symbols.includes(name)) continue;
      const mark = Number(ctx.markPx);
      const oracle = Number(ctx.oraclePx);
      out.push({
        venue: "hyperliquid",
        symbol: name,
        fundingRate: Number(ctx.funding),
        fundingIntervalHours: 1,
        markPrice: Number.isFinite(mark) ? mark : null,
        spotPrice: Number.isFinite(oracle) ? oracle : null,
        openInterestUsd:
          Number.isFinite(Number(ctx.openInterest)) && Number.isFinite(oracle)
            ? Number(ctx.openInterest) * oracle
            : null,
      });
    }
    if (out.length === 0) throw new Error("no matching symbols in hyperliquid universe");
    logSource("OFN", "hyperliquid", "live", { count: out.length });
    return out;
  } catch (err) {
    logSource("OFN", "hyperliquid", "fixture", { reason: String(err) });
    return fromFixture(symbols);
  }
}
