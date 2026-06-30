// Derive(旧Lyra)オプションソース。PCMの最初の実装対象。
//
// 調査結論(一次資料:公式 PyPI パッケージ derive-client 0.3.14 / Derive OpenAPI 生成モデル):
//   ベースURL: https://api.lyra.finance(testnetは https://api-demo.lyra.finance)。RPC風のPOST。
//   - public/get_instruments {currency, instrument_type:"option", expired:false}
//       → result: Instrument[](各 option_details{strike, expiry(秒), option_type} を持つ)
//   - public/get_ticker {instrument_name}
//       → result: { index_price(=spot指数), mark_price, best_bid_price, best_bid_amount,
//                    option_pricing{ iv, bid_iv, ask_iv, ... }, option_details{strike,expiry,option_type},
//                    stats{ open_interest, contract_volume, num_trades } }
//   - public/get_trade_history {instrument_name, page_size}
//       → result.trades[]: { trade_price, trade_amount, direction, index_price, timestamp, ... }
//
// よって PCM に必要な2要素は公開APIで取得可能:
//   (1) フェア値用IV    = get_ticker.option_pricing.iv(spotは get_ticker.index_price)
//   (2) 実受取プレミアム = get_trade_history の直近 trade_price。約定が無ければ板の best_bid_price
//                          (売り手が即時に板へ当てて受け取れる価格)。出所を receivedSource として開示。
//
// 注意:
//   - public/get_ticker は Dec 1, 2025 で deprecated(代替 public/get_tickers)。本実装はフィールド名が
//     明示的な get_ticker を一次経路に採用し、廃止時は fixture フォールバック(理由付き)に倒す。slim形式の
//     get_tickers への移行は別タスク。
//   - サンドボックスからは egress 制限で api.lyra.finance に到達できない。ライブ検証はランナー上で運用者が
//     workflow_dispatch で行う。ランナーIPがジオブロック(451/403)される可能性があり、その場合も合成せず
//     fixture へ理由付きフォールバックする。

import { httpJson } from "../../core/http.js";
import { logSource, log } from "../../core/logger.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURE_DIR } from "../../core/config.js";

export interface RawOption {
  venue: string;
  symbol: string; // BTC
  strategy: string; // covered_call 等
  instrument: string; // 例 BTC-20260926-65000-C
  strike: number;
  expiry: string; // ISO8601
  optionType: "call" | "put";
  spot: number;
  iv: number; // 観測IV(小数)
  ivSource: string; // 出所開示
  receivedPremium: number; // 売り手実受取(USD, 原資産1単位あたり)
  openInterestUsd: number | null;
  volumeUsd: number | null;
}

const DERIVE_API = process.env.DERIVE_API_URL || "https://api.lyra.finance";
const MIN_DAYS = 3; // 0-DTE のノイズを避け、最も近い 3日以上先の限月を採る

function fromFixture(symbols: string[]): RawOption[] {
  const raw = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "pcm", "derive.json"), "utf8")) as RawOption[];
  return raw.filter((r) => symbols.includes(r.symbol));
}

// --- Derive RPC ヘルパー(POST、エンベロープ {id, result} を剥がす) ---
async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await httpJson<{ result: T; error?: { message?: string } }>(`${DERIVE_API}/${method}`, {
    method: "POST",
    body: params,
    timeoutMs: 15000,
  });
  if ((res as { error?: unknown }).error) throw new Error(`derive ${method} error: ${JSON.stringify(res.error)}`);
  return res.result;
}

interface DeriveInstrument {
  instrument_name: string;
  is_active: boolean;
  option_details?: { strike: string; expiry: number; option_type: string };
}
interface DeriveTicker {
  index_price: string;
  mark_price: string;
  best_bid_price: string;
  best_bid_amount: string;
  option_pricing?: { iv: string };
  option_details?: { strike: string; expiry: number; option_type: string };
  stats?: { open_interest?: string; contract_volume?: string };
}
interface DeriveTrade {
  trade_price: string;
  trade_amount: string;
  timestamp: number;
}

function normOptionType(s: string | undefined, instrumentName: string): "call" | "put" {
  const v = (s ?? "").toLowerCase();
  if (v.startsWith("c")) return "call";
  if (v.startsWith("p")) return "put";
  return instrumentName.trim().toUpperCase().endsWith("-P") ? "put" : "call";
}

/** covered_call 用に、spot を少し上回る(OTM)コールを対象限月から1つ選ぶ。 */
function selectCoveredCall(
  instruments: DeriveInstrument[],
  spot: number,
  expirySec: number,
): DeriveInstrument | null {
  const target = spot * 1.05;
  const calls = instruments.filter(
    (i) =>
      i.is_active &&
      i.option_details &&
      i.option_details.expiry === expirySec &&
      normOptionType(i.option_details.option_type, i.instrument_name) === "call",
  );
  if (calls.length === 0) return null;
  calls.sort(
    (a, b) =>
      Math.abs(Number(a.option_details!.strike) - target) - Math.abs(Number(b.option_details!.strike) - target),
  );
  return calls[0] ?? null;
}

/** 最も近い、MIN_DAYS 以上先の限月(unix秒)を選ぶ。なければ最も近い将来の限月。 */
function selectExpiry(instruments: DeriveInstrument[], nowSec: number): number | null {
  const expiries = [
    ...new Set(
      instruments.filter((i) => i.option_details).map((i) => i.option_details!.expiry),
    ),
  ]
    .filter((e) => e > nowSec)
    .sort((a, b) => a - b);
  if (expiries.length === 0) return null;
  const far = expiries.find((e) => e - nowSec >= MIN_DAYS * 86400);
  return far ?? expiries[0]!;
}

async function collectOneSymbol(symbol: string, nowMs: number): Promise<RawOption | null> {
  // spot は perp ティッカーの index_price から取得(名前付きフィールドで曖昧さ無し)。
  const perp = await rpc<DeriveTicker>("public/get_ticker", { instrument_name: `${symbol}-PERP` });
  const spot = Number(perp.index_price);
  if (!Number.isFinite(spot) || spot <= 0) throw new Error(`bad spot for ${symbol}: ${perp.index_price}`);

  const instruments = await rpc<DeriveInstrument[]>("public/get_instruments", {
    currency: symbol,
    instrument_type: "option",
    expired: false,
  });
  const expirySec = selectExpiry(instruments, Math.floor(nowMs / 1000));
  if (expirySec === null) throw new Error(`no future option expiry for ${symbol}`);
  const inst = selectCoveredCall(instruments, spot, expirySec);
  if (!inst) throw new Error(`no covered_call candidate for ${symbol} @${expirySec}`);

  const tk = await rpc<DeriveTicker>("public/get_ticker", { instrument_name: inst.instrument_name });
  const iv = Number(tk.option_pricing?.iv);
  if (!Number.isFinite(iv) || iv <= 0) throw new Error(`no iv for ${inst.instrument_name}`);
  const od = tk.option_details ?? inst.option_details!;
  const strike = Number(od.strike);
  const optionType = normOptionType(od.option_type, inst.instrument_name);
  const tickerSpot = Number(tk.index_price) || spot;

  // 実受取: 直近の約定 trade_price。無ければ板 best_bid_price(売り手が即時に当てて受け取れる価格)。
  let received: number | null = null;
  let receivedSource = "";
  try {
    const th = await rpc<{ trades: DeriveTrade[] }>("public/get_trade_history", {
      instrument_name: inst.instrument_name,
      page_size: 1,
    });
    const last = th.trades?.[0];
    if (last && Number.isFinite(Number(last.trade_price))) {
      received = Number(last.trade_price);
      receivedSource = "last_trade";
    }
  } catch (e) {
    log.warn("derive trade_history failed, will try board bid", { instrument: inst.instrument_name, err: String(e) });
  }
  if (received === null) {
    const bid = Number(tk.best_bid_price);
    if (Number.isFinite(bid) && bid > 0) {
      received = bid;
      receivedSource = "board_bid";
    }
  }
  if (received === null) throw new Error(`no received premium (no trade, no bid) for ${inst.instrument_name}`);

  const oi = Number(tk.stats?.open_interest);
  const vol = Number(tk.stats?.contract_volume);

  return {
    venue: "derive",
    symbol,
    strategy: "covered_call",
    instrument: inst.instrument_name,
    strike,
    expiry: new Date(od.expiry * 1000).toISOString(),
    optionType,
    spot: tickerSpot,
    iv,
    ivSource: `derive get_ticker:option_pricing.iv; received=${receivedSource}`,
    receivedPremium: received,
    openInterestUsd: Number.isFinite(oi) ? oi * tickerSpot : null,
    volumeUsd: Number.isFinite(vol) ? vol * tickerSpot : null,
  };
}

export async function collectDerive(symbols: string[], offline = false): Promise<RawOption[]> {
  if (offline) {
    logSource("PCM", "derive", "fixture", { reason: "offline flag" });
    return fromFixture(symbols);
  }
  try {
    const nowMs = Date.now();
    const out: RawOption[] = [];
    for (const sym of symbols) {
      const row = await collectOneSymbol(sym, nowMs);
      if (row) out.push(row);
    }
    if (out.length === 0) throw new Error("no derive options collected");
    logSource("PCM", "derive", "live", { count: out.length });
    return out;
  } catch (err) {
    // 到達不可(egress/ジオブロック 451・403)やパース不可。合成はせず fixture へ理由付きフォールバック。
    logSource("PCM", "derive", "fixture", { reason: String(err) });
    return fromFixture(symbols);
  }
}
