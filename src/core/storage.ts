// 時系列保存。初期はDB無し: 日付きJSONをリポジトリにコミットする方式(gitでバージョン管理)。
// 将来のDB化を想定し、読み書きはこのモジュールに閉じる。

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.js";

export type Module = "ofn" | "pcm" | "scoring";

function dir(mod: Module): string {
  const d = resolve(DATA_DIR, mod);
  mkdirSync(d, { recursive: true });
  return d;
}

export function writeDaily(mod: Module, date: string, payload: unknown): string {
  const path = resolve(dir(mod), `${date}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return path;
}

export function writeNamed(mod: Module, name: string, payload: unknown): string {
  const path = resolve(dir(mod), `${name}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return path;
}

export function readDaily<T>(mod: Module, date: string): T | null {
  const path = resolve(dir(mod), `${date}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readNamed<T>(mod: Module, name: string): T | null {
  const path = resolve(dir(mod), `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** 日付ファイル一覧(昇順)。<date>.json のみ。 */
export function listDates(mod: Module): string[] {
  const d = dir(mod);
  return readdirSync(d)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function readAllDaily<T>(mod: Module): T[] {
  return listDates(mod)
    .map((dt) => readDaily<T>(mod, dt))
    .filter((x): x is T => x !== null);
}
