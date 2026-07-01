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
  /** 実受取の出所: 実約定(last_trade)か板bid近似(board_bid)か。集計で混ぜないための区別。 */
  receiptSource: "last_trade" | "board_bid";
  openInterestUsd: number | null;
  volumeUsd: number | null;
}

const DERIVE_API = process.env.DERIVE_API_URL || "https://api.lyra.finance";
const MIN_DAYS = 3; // 0-DTE のノイズを避け、最も近い 3日以上先の限月を採る
const ATM_BAND = 0.15; // near-ATM: spot ±15% のストライク帯から選ぶ
const MAX_CANDIDATES = 8; // near-ATM 候補の ticker 取得上限(1日1回のcronで妥当)
const LAST_TRADE_WINDOW_SEC = 24 * 3600; // 実約定として採用する時間窓(24時間以内)

function fromFixture(symbols: string[]): RawOption[] {
  const raw = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "pcm", "derive.json"), "utf8")) as RawOption[];
  // fixture は実約定ではない例示データ。実測と混ざらないよう board_bid(近似)として扱う。
  return raw
    .filter((r) => symbols.includes(r.symbol))
    .map((r) => ({ ...r, receiptSource: r.receiptSource ?? "board_bid" }));
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
  index_price?: string;
  mark_price?: string;
  best_bid_price?: string;
  best_bid_amount?: string;
  option_pricing?: { iv?: string; i?: string };
  option_details?: { strike: string; expiry: number; option_type: string };
  // stats は公式生成モデルでは open_interest / contract_volume(full)。slim版は oi / c。両対応。
  stats?: { open_interest?: string; contract_volume?: string; oi?: string; c?: string };
  // full ticker には別途トップレベルの open_interest 辞書がある: Dict[str, List[{current_open_interest}]]
  open_interest?: Record<string, Array<{ current_open_interest?: string }>>;
}
interface DeriveTrade {
  trade_price: string;
  trade_amount: string;
  timestamp: number;
}

function num(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** 建玉(契約数)を寛容に読む。stats(full/slim)→トップレベル辞書の順。取れなければ null(0で埋めない)。 */
function readOpenInterest(tk: DeriveTicker): number | null {
  const s = num(tk.stats?.open_interest) ?? num(tk.stats?.oi);
  if (s !== null) return s;
  const dict = tk.open_interest;
  if (dict && typeof dict === "object") {
    let sum = 0;
    let seen = false;
    for (const arr of Object.values(dict)) {
      for (const e of arr ?? []) {
        const v = num(e?.current_open_interest);
        if (v !== null) {
          sum += v;
          seen = true;
        }
      }
    }
    if (seen) return sum;
  }
  return null;
}

/** 24h出来高(契約数)を寛容に読む。stats(full/slim)。取れなければ null。 */
function readVolume(tk: DeriveTicker): number | null {
  return num(tk.stats?.contract_volume) ?? num(tk.stats?.c);
}

function readIv(tk: DeriveTicker): number | null {
  return num(tk.option_pricing?.iv) ?? num(tk.option_pricing?.i);
}

function normOptionType(s: string | undefined, instrumentName: string): "call" | "put" {
  const v = (s ?? "").toLowerCase();
  if (v.startsWith("c")) return "call";
  if (v.startsWith("p")) return "put";
  return instrumentName.trim().toUpperCase().endsWith("-P") ? "put" : "call";
}

/** covered_call 候補: 対象限月の near-ATM(spot±ATM_BAND)なコールを、ATM距離の近い順に上限本数返す。 */
function selectCoveredCallCandidates(
  instruments: DeriveInstrument[],
  spot: number,
  expirySec: number,
): DeriveInstrument[] {
  const lo = spot * (1 - ATM_BAND);
  const hi = spot * (1 + ATM_BAND);
  return instruments
    .filter(
      (i) =>
        i.is_active &&
        i.option_details &&
        i.option_details.expiry === expirySec &&
        normOptionType(i.option_details.option_type, i.instrument_name) === "call" &&
        Number(i.option_details.strike) >= lo &&
        Number(i.option_details.strike) <= hi,
    )
    .sort((a, b) => Math.abs(Number(a.option_details!.strike) - spot) - Math.abs(Number(b.option_details!.strike) - spot))
    .slice(0, MAX_CANDIDATES);
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

/** timestamp を ms に正規化(sec/ms 両対応)。 */
function toMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}

async function collectOneSymbol(symbol: string, nowMs: number): Promise<RawOption | null> {
  // spot は perp ティッカーの index_price から取得(名前付きフィールドで曖昧さ無し)。
  const perp = await rpc<DeriveTicker>("public/get_ticker", { instrument_name: `${symbol}-PERP` });
  const spot = num(perp.index_price);
  if (spot === null || spot <= 0) throw new Error(`bad spot for ${symbol}: ${perp.index_price}`);

  const instruments = await rpc<DeriveInstrument[]>("public/get_instruments", {
    currency: symbol,
    instrument_type: "option",
    expired: false,
  });
  const expirySec = selectExpiry(instruments, Math.floor(nowMs / 1000));
  if (expirySec === null) throw new Error(`no future option expiry for ${symbol}`);
  const candidates = selectCoveredCallCandidates(instruments, spot, expirySec);
  if (candidates.length === 0) throw new Error(`no near-ATM covered_call candidate for ${symbol} @${expirySec}`);

  // near-ATM 候補の ticker を取得し、流動性(出来高→建玉→板bid有無)優先で1つ選ぶ。
  const priced: Array<{ inst: DeriveInstrument; tk: DeriveTicker; vol: number | null; oi: number | null; bid: number | null }> =
    [];
  for (const inst of candidates) {
    try {
      const tk = await rpc<DeriveTicker>("public/get_ticker", { instrument_name: inst.instrument_name });
      if (readIv(tk) === null) continue; // IVが無い建玉はフェア値を出せないので除外
      priced.push({ inst, tk, vol: readVolume(tk), oi: readOpenInterest(tk), bid: num(tk.best_bid_price) });
    } catch (e) {
      log.warn("derive get_ticker failed for candidate", { instrument: inst.instrument_name, err: String(e) });
    }
  }
  if (priced.length === 0) throw new Error(`no priced candidate with iv for ${symbol}`);
  priced.sort((a, b) => {
    // 出来高 desc → 建玉 desc → 板bid有り優先 → ATM距離 asc
    const av = a.vol ?? -1, bv = b.vol ?? -1;
    if (av !== bv) return bv - av;
    const ao = a.oi ?? -1, bo = b.oi ?? -1;
    if (ao !== bo) return bo - ao;
    const ab = a.bid && a.bid > 0 ? 1 : 0, bb = b.bid && b.bid > 0 ? 1 : 0;
    if (ab !== bb) return bb - ab;
    return Math.abs(Number(a.inst.option_details!.strike) - spot) - Math.abs(Number(b.inst.option_details!.strike) - spot);
  });
  const chosen = priced[0]!;
  const { inst, tk } = chosen;
  const iv = readIv(tk)!;
  const od = tk.option_details ?? inst.option_details!;
  const strike = Number(od.strike);
  const optionType = normOptionType(od.option_type, inst.instrument_name);
  const tickerSpot = num(tk.index_price) ?? spot;

  // 実受取: 時間窓内(LAST_TRADE_WINDOW_SEC)の直近約定 trade_price を優先。無い場合のみ板 best_bid_price。
  let received: number | null = null;
  let receiptSource: "last_trade" | "board_bid" | null = null;
  try {
    const th = await rpc<{ trades: DeriveTrade[] }>("public/get_trade_history", {
      instrument_name: inst.instrument_name,
      page_size: 20,
    });
    const recent = (th.trades ?? [])
      .filter((t) => num(t.trade_price) !== null && nowMs - toMs(t.timestamp) <= LAST_TRADE_WINDOW_SEC * 1000)
      .sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp));
    if (recent.length > 0) {
      received = num(recent[0]!.trade_price);
      receiptSource = "last_trade";
    }
  } catch (e) {
    log.warn("derive trade_history failed, will try board bid", { instrument: inst.instrument_name, err: String(e) });
  }
  if (received === null) {
    const bid = num(tk.best_bid_price);
    if (bid !== null && bid > 0) {
      received = bid;
      receiptSource = "board_bid";
    }
  }
  if (received === null || receiptSource === null)
    throw new Error(`no received premium (no in-window trade, no bid) for ${inst.instrument_name}`);

  const oi = readOpenInterest(tk);
  const vol = readVolume(tk);

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
    ivSource: "derive get_ticker:option_pricing.iv",
    receivedPremium: received,
    receiptSource,
    // 契約数 × spot で USD ノーショナル換算。取れなければ null(0で埋めない)。
    openInterestUsd: oi !== null ? oi * tickerSpot : null,
    volumeUsd: vol !== null ? vol * tickerSpot : null,
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
