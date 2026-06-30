// タイムアウト + 指数バックオフ付き fetch。Node 22 のグローバル fetch を使う(axios非依存=405回避)。

import { log } from "./logger.js";

export interface HttpOpts {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

export async function httpJson<T = unknown>(url: string, opts: HttpOpts = {}): Promise<T> {
  const { method = "GET", headers = {}, body, timeoutMs = 15000, retries = 3 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json", ...headers } : headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        const wait = 2 ** attempt * 500;
        log.warn("http retry", { url, attempt, waitMs: wait, err: String(err) });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}
