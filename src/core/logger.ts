// 構造化ログ。ログがクリーンであることが完了条件なので、レベルとJSON出力を一本化する。

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const line = { level, msg, ...(meta ?? {}) };
  const out = JSON.stringify(line);
  if (level === "error") process.stderr.write(out + "\n");
  else process.stdout.write(out + "\n");
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};

/**
 * 会場ごとに「ライブ取得できたか/fixtureに落ちたか」を1行で明示する。
 * 値の捏造はしない。事実(mode=live|fixture と理由)をそのまま出す。
 * 例: [OFN] source venue=binance mode=fixture reason=...
 */
export function logSource(
  mod: "OFN" | "PCM",
  venue: string,
  mode: "live" | "fixture",
  extra: Record<string, unknown> = {},
): void {
  emit("info", `[${mod}] source venue=${venue} mode=${mode}`, { module: mod, venue, mode, ...extra });
}
