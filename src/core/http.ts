// タイムアウト + 指数バックオフ付き fetch。Node 22 のグローバル fetch を使う(axios非依存=405回避)。

import { log } from "./logger.js";

export interface HttpOpts {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

/** 非2xx を、レスポンスbody付きで表面化するエラー。診断で「どのフィールドが不正か」を捨てないため。 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} ${statusText} for ${url}${body ? `: ${body}` : ""}`);
    this.name = "HttpError";
  }
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
      if (!res.ok) {
        // 非2xx: body を読み取ってエラーに載せる(捨てない)。secret はここには無い(認証は headers 側)。
        const text = await res.text().catch(() => "");
        throw new HttpError(res.status, res.statusText, url, text);
      }
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // 4xx(クライアントエラー)はリトライで直らないので即座に表面化する。
      const status = err instanceof HttpError ? err.status : 0;
      const is4xx = status >= 400 && status < 500;
      if (attempt < retries && !is4xx) {
        const wait = 2 ** attempt * 500;
        // 注: url と err のみlog。headers(Authorization/JWT)は絶対にlogしない。
        log.warn("http retry", { url, attempt, waitMs: wait, err: String(err) });
        await new Promise((r) => setTimeout(r, wait));
      } else {
        break;
      }
    }
  }
  throw lastErr;
}
