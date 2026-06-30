// 週次の前向き宣言(dated)。当落の別なく全件残す。

import { isoWeek } from "../core/config.js";
import { readNamed, writeNamed } from "../core/storage.js";
import { currentAgentId } from "./identity.js";
import type { Declaration } from "../core/types.js";

function loadAll(): Declaration[] {
  return readNamed<Declaration[]>("scoring", "declarations") ?? [];
}

export function listDeclarations(week?: string): Declaration[] {
  const all = loadAll();
  return week ? all.filter((d) => d.week === week) : all;
}

export function declare(input: {
  module: "OFN" | "PCM";
  claim: string;
  predicate: Declaration["predicate"];
  week?: string;
  now?: Date;
}): Declaration {
  const all = loadAll();
  const now = input.now ?? new Date();
  const week = input.week ?? isoWeek(now);
  const decl: Declaration = {
    id: `${input.module}-${week}-${all.length + 1}`,
    module: input.module,
    declaredAt: now.toISOString(),
    week,
    claim: input.claim,
    predicate: input.predicate,
    agentId: currentAgentId(),
  };
  all.push(decl);
  writeNamed("scoring", "declarations", all);
  return decl;
}

/** 既定の週次宣言セットを生成(運用者が編集してよい雛形)。OFN/PCM各1件以上。 */
export function seedWeeklyDeclarations(now: Date = new Date()): Declaration[] {
  const week = isoWeek(now);
  if (listDeclarations(week).length > 0) return listDeclarations(week);
  const made: Declaration[] = [];
  made.push(
    declare({
      module: "OFN",
      week,
      now,
      claim: "今週のMajorsバスケットのnet carryは正(>0)である",
      predicate: { metric: "majors.netCarryApy", op: "gt", value: 0 },
    }),
  );
  made.push(
    declare({
      module: "PCM",
      week,
      now,
      claim: "今週、最も捕捉率の高い会場/戦略は derive/covered_call である",
      predicate: { metric: "pcm.captureRate.rank1", op: "eq", value: "derive/covered_call" },
    }),
  );
  return made;
}
