// CLI: 採点。`score declare` で週次宣言の雛形を生成、`score grade` で照合採点。

import { seedWeeklyDeclarations } from "../scoring/declare.js";
import { gradeWeek, scoreboard } from "../scoring/grade.js";
import { log } from "../core/logger.js";

const cmd = process.argv[2];

if (cmd === "declare") {
  const made = seedWeeklyDeclarations();
  log.info("declarations seeded", { count: made.length, ids: made.map((d) => d.id) });
} else if (cmd === "grade") {
  const results = gradeWeek();
  log.info("graded", { count: results.length });
  for (const r of results) log.info("grade", { id: r.declarationId, hit: r.hit, realized: r.realizedValue, agentId: r.agentId });
  log.info("scoreboard", { ...scoreboard() });
} else {
  log.error("usage: score <declare|grade>");
  process.exit(1);
}
