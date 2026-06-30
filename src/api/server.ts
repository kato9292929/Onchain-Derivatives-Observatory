// ODO REST API。全データエンドポイントを x402 ゲートで課金。/health と /catalog は無償。

import express from "express";
import type { Request, Response } from "express";
import { x402Gate, loadGateConfig, selectVerifier } from "../core/x402.js";
import { log } from "../core/logger.js";
import { getIdentity } from "../scoring/identity.js";
import { scoreboard } from "../scoring/grade.js";
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

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  const gateCfg = loadGateConfig();
  const { mode } = selectVerifier();

  // 無償: ヘルスとカタログ(課金しない)
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, x402Mode: mode, agentId: getIdentity().agentId });
  });

  app.get("/catalog", (_req: Request, res: Response) => {
    res.json({
      name: "ODO — Onchain Derivatives Observatory",
      payment: { protocol: "x402", network: "base", asset: "USDC", priceUsdc: gateCfg.priceUsdc, payTo: gateCfg.payTo },
      identity: getIdentity(),
      scoreboard: scoreboard(),
      endpoints: [
        "/funding/nowcast/current",
        "/funding/nowcast/history",
        "/funding/asset/{symbol}",
        "/funding/venues/{symbol}",
        "/funding/carry/leaderboard",
        "/funding/carry/index/{basket}",
        "/premium/capture/current",
        "/premium/capture/history",
        "/premium/capture/leaderboard",
      ],
    });
  });

  // 有償: x402ゲート配下
  const paid = express.Router();
  paid.use(x402Gate(gateCfg));

  paid.get("/funding/nowcast/current", (_req, res) => res.json(fundingNowcastCurrent()));
  paid.get("/funding/nowcast/history", (_req, res) => res.json(fundingNowcastHistory()));
  paid.get("/funding/asset/:symbol", (req, res) => res.json(fundingAsset(req.params.symbol)));
  paid.get("/funding/venues/:symbol", (req, res) => res.json(fundingVenues(req.params.symbol)));
  paid.get("/funding/carry/leaderboard", (_req, res) => res.json(carryLeaderboardQ()));
  paid.get("/funding/carry/index/:basket", (req, res) => res.json(carryIndexHistory(req.params.basket)));
  paid.get("/premium/capture/current", (_req, res) => res.json(premiumCaptureCurrent()));
  paid.get("/premium/capture/history", (_req, res) => res.json(premiumCaptureHistory()));
  paid.get("/premium/capture/leaderboard", (_req, res) => res.json(premiumCaptureLeaderboardQ()));

  app.use(paid);
  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const app = buildApp();
  app.listen(port, () => {
    const { mode } = selectVerifier();
    log.info("ODO API online", { port, x402Mode: mode });
    if (mode === "null")
      log.warn("x402 fail-closed: facilitator未設定。有償エンドポイントは支払い提示でも拒否される。X402_FACILITATOR_URL を設定すること。");
    if (mode === "mock") log.warn("x402 MOCK mode: 本番では使用しないこと。");
  });
}
