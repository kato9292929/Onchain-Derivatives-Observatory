// 週次照合・採点。同じ日次観測から計算した実現値と宣言を機械照合する。
// 方向: ヒット率 + 較正(brier)。水準: 実現値との誤差。結果は全件 agentId に紐づけて記録する。

import { isoWeek } from "../core/config.js";
import { readAllDaily, readNamed, writeNamed } from "../core/storage.js";
import { assetsConfig } from "../core/config.js";
import { mean } from "../core/normalize.js";
import { venuesForSymbol } from "../ofn/index.js";
import { captureLeaderboard } from "../pcm/capture.js";
import { listDeclarations } from "./declare.js";
import { currentAgentId } from "./identity.js";
import type { GradeResult, OfnDaily, PcmDaily, Declaration } from "../core/types.js";

function weekOf(dateStr: string): string {
  return isoWeek(new Date(`${dateStr}T00:00:00Z`));
}

function ofnDailiesForWeek(week: string): OfnDaily[] {
  return readAllDaily<OfnDaily>("ofn").filter((d) => weekOf(d.date) === week);
}
function pcmDailiesForWeek(week: string): PcmDaily[] {
  return readAllDaily<PcmDaily>("pcm").filter((d) => weekOf(d.date) === week);
}

/** metric を実現値に解決する。number か string を返す(解決不能は null)。 */
function resolveMetric(metric: string, week: string): number | string | null {
  const ofn = ofnDailiesForWeek(week);
  const pcm = pcmDailiesForWeek(week);

  if (metric === "majors.netCarryApy") {
    const majors = assetsConfig().baskets.majors?.symbols ?? [];
    const perDay = ofn.map((d) => {
      const xs = d.observations
        .filter((o) => majors.includes(o.symbol) && o.tag === "harvestable" && o.netCarryApy !== null)
        .map((o) => o.netCarryApy!);
      return mean(xs);
    }).filter((x): x is number => x !== null);
    return mean(perDay);
  }

  // オンチェーン会場どうしの funding ばらつき(歪み)の週内変化。負なら縮小。
  // 会場が1つだけの期間は比較対象が無く null(解決不能)。CEX乖離の意味づけは持たない。
  const spread = metric.match(/^(\w+)\.venueSpread$/);
  if (spread && ofn.length > 0) {
    const sym = spread[1]!;
    const first = venuesForSymbol(ofn[0]!, sym).crossVenueSpreadApy;
    const last = venuesForSymbol(ofn[ofn.length - 1]!, sym).crossVenueSpreadApy;
    if (first === null || last === null) return null;
    return last - first;
  }

  if (metric === "pcm.captureRate.rank1") {
    const all = pcm.flatMap((d) => d.observations);
    if (all.length === 0) return null;
    const lb = captureLeaderboard(all);
    // 実測(last_trade)を優先。無ければ近似(board_bid)。実測と近似は混ぜない。
    const pool = (lb.lastTrade.length > 0 ? lb.lastTrade : lb.boardBidApprox).filter((r) => !r.lowLiquidity);
    if (pool.length === 0) return null;
    return `${pool[0]!.venue}/${pool[0]!.strategy}`;
  }

  return null;
}

function evaluate(decl: Declaration, realized: number | string | null): { hit: boolean | null; error: number | null } {
  if (realized === null) return { hit: null, error: null };
  const { op, value } = decl.predicate;
  if (typeof realized === "number" && typeof value === "number") {
    const error = realized - value;
    switch (op) {
      case "gt": return { hit: realized > value, error };
      case "lt": return { hit: realized < value, error };
      case "gte": return { hit: realized >= value, error };
      case "lte": return { hit: realized <= value, error };
      case "eq": return { hit: realized === value, error };
      case "direction_down": return { hit: realized < 0, error };
      case "direction_up": return { hit: realized > 0, error };
    }
  }
  if (op === "eq") return { hit: String(realized) === String(value), error: null };
  return { hit: null, error: null };
}

export function gradeWeek(week?: string, now: Date = new Date()): GradeResult[] {
  const wk = week ?? isoWeek(now);
  const decls = listDeclarations(wk);
  const results: GradeResult[] = [];
  for (const d of decls) {
    const realized = resolveMetric(d.predicate.metric, wk);
    const { hit, error } = evaluate(d, realized);
    // 較正: 決定論的宣言は p=1 とみなす退化brier(将来の確率宣言では明示確率を使う)。
    const brier = hit === null ? null : hit ? 0 : 1;
    results.push({
      declarationId: d.id,
      week: wk,
      gradedAt: now.toISOString(),
      realizedValue: realized,
      hit,
      brier,
      error,
      note: realized === null ? "実現値を解決できず(データ不足)" : "OK",
      agentId: d.agentId ?? currentAgentId(),
    });
  }
  // 累積保存(週ごとに上書きせず追記、同週の既存は置換)
  const prior = (readNamed<GradeResult[]>("scoring", "grades") ?? []).filter((g) => g.week !== wk);
  writeNamed("scoring", "grades", [...prior, ...results]);
  return results;
}

/** ヒット率と平均brier(較正)を週横断で集計。 */
export function scoreboard(): { total: number; graded: number; hitRate: number | null; avgBrier: number | null } {
  const grades = readNamed<GradeResult[]>("scoring", "grades") ?? [];
  const graded = grades.filter((g) => g.hit !== null);
  const hits = graded.filter((g) => g.hit === true).length;
  const briers = graded.map((g) => g.brier!).filter((b) => b !== null);
  return {
    total: grades.length,
    graded: graded.length,
    hitRate: graded.length ? hits / graded.length : null,
    avgBrier: briers.length ? mean(briers) : null,
  };
}
