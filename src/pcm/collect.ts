// PCM日次収集: 会場×資産×戦略のオプションを採取し、捕捉率を計算して data/pcm/<date>.json に保存。

import { pcmConfig, utcDate } from "../core/config.js";
import { writeDaily } from "../core/storage.js";
import { log } from "../core/logger.js";
import type { PcmDaily } from "../core/types.js";
import { collectDerive } from "./sources/derive.js";
import { computeCapture } from "./capture.js";

export interface PcmCollectOpts {
  date?: string;
  offline?: boolean;
  venues?: string[];
  symbols?: string[];
}

export async function collectPcm(opts: PcmCollectOpts = {}): Promise<PcmDaily> {
  const date = opts.date ?? utcDate();
  const offline = opts.offline ?? false;
  const symbols = opts.symbols ?? ["BTC"];
  const cfg = pcmConfig();
  const venues = opts.venues ?? Object.keys(cfg.venues).filter((k) => cfg.venues[k]?.status === "implemented");
  const nowIso = new Date().toISOString();

  const observations = [];
  for (const venue of venues) {
    if (venue === "derive") {
      const raw = await collectDerive(symbols, offline);
      observations.push(...raw.map((r) => computeCapture(r, nowIso)));
    } else {
      log.warn("pcm venue not implemented yet, skipping", { venue });
    }
  }

  const daily: PcmDaily = {
    date,
    generatedAt: nowIso,
    observations,
    source: offline ? "fixture" : "live",
  };
  const path = writeDaily("pcm", date, daily);
  log.info("pcm collected", { date, venues, observations: observations.length, path });
  return daily;
}
