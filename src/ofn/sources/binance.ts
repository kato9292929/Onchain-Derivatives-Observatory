// Binance USDT-perp funding 基準線(CEX)。オンチェーン–CEX乖離の基準として採る。
// 公開: GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT
//   → { markPrice, indexPrice, lastFundingRate, ... }  funding は8時間ごと。

import { httpJson } from "../../core/http.js";
import { logSource } from "../../core/logger.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURE_DIR } from "../../core/config.js";
import type { RawVenueFunding } from "./hyperliquid.js";

const BINANCE_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";

interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
}

function fromFixture(symbols: string[]): RawVenueFunding[] {
  const raw = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "ofn", "binance.json"), "utf8")) as RawVenueFunding[];
  return raw.filter((r) => symbols.includes(r.symbol));
}

export async function collectBinance(symbols: string[], offline = false): Promise<RawVenueFunding[]> {
  if (offline) {
    logSource("OFN", "binance", "fixture", { reason: "offline flag" });
    return fromFixture(symbols);
  }
  const out: RawVenueFunding[] = [];
  try {
    for (const sym of symbols) {
      const pair = `${sym}USDT`;
      const d = await httpJson<PremiumIndex>(`${BINANCE_URL}?symbol=${pair}`, { timeoutMs: 12000 });
      out.push({
        venue: "binance",
        symbol: sym,
        fundingRate: Number(d.lastFundingRate),
        fundingIntervalHours: 8,
        markPrice: Number(d.markPrice),
        spotPrice: Number(d.indexPrice),
        openInterestUsd: null,
      });
    }
    logSource("OFN", "binance", "live", { count: out.length });
    return out;
  } catch (err) {
    logSource("OFN", "binance", "fixture", { reason: String(err) });
    return fromFixture(symbols);
  }
}
