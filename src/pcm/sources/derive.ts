// Derive(旧Lyra)オプションソース。最初の実装対象。
// 公開API(調査時点): POST https://api.lyra.finance/public/get_instruments,
//   /public/get_ticker で mark IV・spot・板情報、約定は別途取得。
// ライブ取得が不可/未確定な項目があるため、取得できない場合は fixture にフォールバックする。
// 実受取(receivedPremium)は「板の約定 or RFQの落札額」。出所は ivSource とともに開示する。

import { log } from "../../core/logger.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURE_DIR } from "../../core/config.js";

export interface RawOption {
  venue: string;
  symbol: string; // BTC
  strategy: string; // covered_call 等
  instrument: string; // BTC-20260626-100000-C
  strike: number;
  expiry: string; // ISO8601
  optionType: "call" | "put";
  spot: number;
  iv: number; // 観測IV(小数)
  ivSource: string; // 出所開示
  receivedPremium: number; // 売り手実受取(USD, 原資産1単位あたり換算後)
  openInterestUsd: number | null;
  volumeUsd: number | null;
}

function fromFixture(symbols: string[]): RawOption[] {
  const raw = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "pcm", "derive.json"), "utf8")) as RawOption[];
  return raw.filter((r) => symbols.includes(r.symbol));
}

export async function collectDerive(symbols: string[], offline = false): Promise<RawOption[]> {
  if (offline) {
    log.info("derive: offline fixture mode");
    return fromFixture(symbols);
  }
  // NOTE: ライブのオプション約定・mark IV 取得は会場API仕様確定後に実装する(設計段階)。
  // 現状は安全側に倒し、ライブ取得に失敗したら fixture を返す。
  try {
    // 設計: get_instruments → 対象限月/ストライク選定 → get_ticker で IV/spot/板 → 約定で receivedPremium。
    throw new Error("derive live adapter not yet wired (design stage); using fixture");
  } catch (err) {
    log.warn("derive live unavailable, falling back to fixture", { err: String(err) });
    return fromFixture(symbols);
  }
}
