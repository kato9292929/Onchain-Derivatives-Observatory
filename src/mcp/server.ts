// ODO MCPサーバー。REST と同じデータをツールとして出す(カタログと同じ二面配信)。
// stdio トランスポート。課金面(x402)は REST が一次窓口。MCPは同一データの配信面。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fundingNowcastCurrent,
  fundingNowcastHistory,
  fundingAsset,
  fundingVenues,
  carryLeaderboardQ,
  carryIndexHistory,
  premiumCaptureCurrent,
  premiumCaptureHistory,
  premiumCaptureLeaderboardQ,
} from "../core/queries.js";

function jsonTool(fn: (...a: never[]) => unknown) {
  return async (args?: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(fn(args as never), null, 2) }],
  });
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "odo", version: "0.1.0" });

  server.tool("funding_nowcast_current", "最新の借り需要ゲージ(Majors/Long-tail別)", jsonTool(fundingNowcastCurrent));
  server.tool("funding_nowcast_history", "借り需要ゲージの時系列", jsonTool(fundingNowcastHistory));
  server.tool("funding_carry_leaderboard", "harvestableなnet carryのランキング+キャリー収穫指数", jsonTool(carryLeaderboardQ));
  server.tool("premium_capture_current", "会場・戦略別の最新捕捉率", jsonTool(premiumCaptureCurrent));
  server.tool("premium_capture_history", "捕捉率の時系列", jsonTool(premiumCaptureHistory));
  server.tool("premium_capture_leaderboard", "捕捉率の高い会場・戦略のランキング", jsonTool(premiumCaptureLeaderboardQ));

  server.tool(
    "funding_asset",
    "資産別のfunding・basis・carry詳細(fundable/harvestableタグ付き)",
    { symbol: z.string() },
    async ({ symbol }) => ({ content: [{ type: "text", text: JSON.stringify(fundingAsset(symbol), null, 2) }] }),
  );
  server.tool(
    "funding_venues",
    "同一資産の会場横断funding(オンチェーン会場どうしの比較)",
    { symbol: z.string() },
    async ({ symbol }) => ({ content: [{ type: "text", text: JSON.stringify(fundingVenues(symbol), null, 2) }] }),
  );
  server.tool(
    "funding_carry_index",
    "キャリー収穫指数(累積, 基準日=100)の時系列",
    { basket: z.string() },
    async ({ basket }) => ({ content: [{ type: "text", text: JSON.stringify(carryIndexHistory(basket), null, 2) }] }),
  );

  return server;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(JSON.stringify({ level: "info", msg: "ODO MCP server online (stdio)" }) + "\n");
}
