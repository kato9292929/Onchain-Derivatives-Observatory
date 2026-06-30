// CLI: end-to-end 実証(オフライン fixture)。1資産1会場で OFN(ゲージ+キャリー指数)と
// PCM(捕捉率)の両方を通し、配信クエリと採点まで動かす。完了条件の最小e2eを1コマンドで確認する。

import { collectOfn } from "../ofn/collect.js";
import { collectPcm } from "../pcm/collect.js";
import { seedWeeklyDeclarations } from "../scoring/declare.js";
import { gradeWeek, scoreboard } from "../scoring/grade.js";
import { fundingNowcastCurrent, carryLeaderboardQ, premiumCaptureLeaderboardQ, carryIndexHistory } from "../core/queries.js";
import { log } from "../core/logger.js";

async function main() {
  log.info("=== ODO e2e (offline fixtures) ===");

  // 1) OFN: オンチェーン会場(Hyperliquid)で Majors を採取
  const ofn = await collectOfn({ offline: true, venues: ["hyperliquid"] });
  log.info("OFN collected", { observations: ofn.observations.length });

  // 2) PCM: Derive BTC を採取
  const pcm = await collectPcm({ offline: true, venues: ["derive"], symbols: ["BTC"] });
  log.info("PCM collected", { observations: pcm.observations.length });

  // 3) 配信クエリ
  log.info("funding/nowcast/current", fundingNowcastCurrent() as Record<string, unknown>);
  log.info("funding/carry/leaderboard", carryLeaderboardQ() as Record<string, unknown>);
  log.info("funding/carry/index/majors (last)", {
    last: carryIndexHistory("majors").points.slice(-1)[0],
  });
  log.info("premium/capture/leaderboard", premiumCaptureLeaderboardQ() as Record<string, unknown>);

  // 4) 採点(週次宣言→照合)
  seedWeeklyDeclarations();
  const grades = gradeWeek();
  log.info("grades", { grades });
  log.info("scoreboard", { ...scoreboard() });

  log.info("=== e2e OK ===");
}

main().catch((e) => {
  log.error("e2e failed", { err: String(e), stack: (e as Error)?.stack });
  process.exit(1);
});
