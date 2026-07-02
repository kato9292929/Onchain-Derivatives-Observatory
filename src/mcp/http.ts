// MCP を HTTP(Streamable HTTP)で公開する。ステートレスモードで動かすため Vercel のサーバレス
// (リクエストごとに関数が起動しセッションを保持しない)にそのまま載る。
// SDK 1.29 の StreamableHTTPServerTransport は sessionIdGenerator:undefined でステートレス動作する。
//
// 同じ観測データを MCP ツールとして出す「二面配信」の HTTP 面。REST が一次の課金窓口。

import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./server.js";
import { log } from "../core/logger.js";

/** 1リクエスト完結のステートレス MCP ハンドラ。POST=JSON-RPC。GET/DELETE はステートレスでは非対応(405)。 */
export async function handleMcpHttp(req: Request, res: Response): Promise<void> {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, (req as Request & { body?: unknown }).body);
  } catch (err) {
    log.error("mcp http error", { err: String(err) });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  }
}
