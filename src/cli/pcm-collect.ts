// CLI: PCM日次収集。--offline で fixture、--symbols=BTC、--venues=derive。

import { collectPcm } from "../pcm/collect.js";
import { log } from "../core/logger.js";

function flag(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=")[1] : undefined;
}
const offline = process.argv.includes("--offline") || process.env.ODO_OFFLINE === "1";
const symbols = flag("symbols")?.split(",");
const venues = flag("venues")?.split(",");

collectPcm({ offline, symbols, venues })
  .then((d) => log.info("pcm:collect done", { date: d.date, n: d.observations.length, source: d.source }))
  .catch((e) => {
    log.error("pcm:collect failed", { err: String(e) });
    process.exit(1);
  });
