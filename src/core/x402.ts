// x402 売り手側ゲート(per-call課金)。
//
// 設計方針(指示書の絶対制約に対応):
//  - ODOは「売り手」。エンドポイントを HTTP 402 でゲートし USDC を per-call で受ける側のみ実装する。
//  - AAの「支払いクライアント(買い手側)の初期化コード」は一切持ち込まない(InvestXのCRASH loop要因)。
//  - 非カストディ: 本体は秘密鍵もRPCも持たない。署名検証/決済は facilitator(外部)に委譲する。
//  - fail-closed: facilitator未設定で支払いが提示された場合、検証できないので拒否する。
//
// x402標準: 未払いリクエストには 402 と payment requirements(accepts)を返す。
// 支払いは X-PAYMENT ヘッダ(base64 JSON)で提示され、facilitator の /verify・/settle で確定する。

import type { Request, Response, NextFunction } from "express";
import { httpJson } from "./http.js";
import { log } from "./logger.js";

/** Base mainnet USDC */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_DECIMALS = 6;

export interface PaymentRequirements {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string; // atomic units (USDC=6桁)
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

export interface VerifyResult {
  isValid: boolean;
  payer?: string;
  reason?: string;
}
export interface SettleResult {
  success: boolean;
  txHash?: string;
  reason?: string;
}

export interface Verifier {
  verify(paymentB64: string, req: PaymentRequirements): Promise<VerifyResult>;
  settle(paymentB64: string, req: PaymentRequirements): Promise<SettleResult>;
}

/** facilitator(外部)に検証・決済を委譲。本番経路。 */
export class FacilitatorVerifier implements Verifier {
  constructor(private baseUrl: string) {}
  async verify(paymentB64: string, req: PaymentRequirements): Promise<VerifyResult> {
    try {
      const payload = JSON.parse(Buffer.from(paymentB64, "base64").toString("utf8"));
      const r = await httpJson<{ isValid: boolean; payer?: string; invalidReason?: string }>(
        `${this.baseUrl}/verify`,
        { method: "POST", body: { x402Version: 1, paymentPayload: payload, paymentRequirements: req } },
      );
      return { isValid: !!r.isValid, payer: r.payer, reason: r.invalidReason };
    } catch (err) {
      return { isValid: false, reason: `facilitator verify error: ${String(err)}` };
    }
  }
  async settle(paymentB64: string, req: PaymentRequirements): Promise<SettleResult> {
    try {
      const payload = JSON.parse(Buffer.from(paymentB64, "base64").toString("utf8"));
      const r = await httpJson<{ success: boolean; transaction?: string; errorReason?: string }>(
        `${this.baseUrl}/settle`,
        { method: "POST", body: { x402Version: 1, paymentPayload: payload, paymentRequirements: req } },
      );
      return { success: !!r.success, txHash: r.transaction, reason: r.errorReason };
    } catch (err) {
      return { success: false, reason: `facilitator settle error: ${String(err)}` };
    }
  }
}

/** 開発専用モック。X402_MODE=mock のときだけ使う。検証は常に通す(本番では絶対に使わない)。 */
export class MockVerifier implements Verifier {
  async verify(paymentB64: string): Promise<VerifyResult> {
    log.warn("x402 MOCK verifier in use — accepting any X-PAYMENT (dev only)");
    return { isValid: paymentB64.length > 0, payer: "0xMOCK" };
  }
  async settle(): Promise<SettleResult> {
    return { success: true, txHash: "0xMOCK_TX" };
  }
}

/** fail-closed: facilitator未設定。支払いが来ても検証手段が無いので常に拒否。 */
export class NullVerifier implements Verifier {
  async verify(): Promise<VerifyResult> {
    return { isValid: false, reason: "no facilitator configured (X402_FACILITATOR_URL unset): fail-closed" };
  }
  async settle(): Promise<SettleResult> {
    return { success: false, reason: "no facilitator configured: fail-closed" };
  }
}

export function selectVerifier(): { verifier: Verifier; mode: string } {
  const mode = process.env.X402_MODE || (process.env.X402_FACILITATOR_URL ? "facilitator" : "null");
  if (mode === "mock") return { verifier: new MockVerifier(), mode };
  if (process.env.X402_FACILITATOR_URL)
    return { verifier: new FacilitatorVerifier(process.env.X402_FACILITATOR_URL), mode: "facilitator" };
  return { verifier: new NullVerifier(), mode: "null" };
}

export interface GateConfig {
  payTo: string;
  priceUsdc: number; // per-call 価格(USDC, 例 0.01)
  verifier: Verifier;
  settle: boolean;
}

export function loadGateConfig(): GateConfig {
  const { verifier } = selectVerifier();
  return {
    payTo: process.env.X402_PAY_TO || "0x0000000000000000000000000000000000000000",
    priceUsdc: Number(process.env.X402_PRICE_USDC ?? "0.01"),
    verifier,
    settle: (process.env.X402_SETTLE ?? "true") === "true",
  };
}

function toAtomic(usdc: number): string {
  return BigInt(Math.round(usdc * 10 ** USDC_DECIMALS)).toString();
}

function buildRequirements(req: Request, cfg: GateConfig): PaymentRequirements {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = req.headers.host || "localhost";
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: toAtomic(cfg.priceUsdc),
    resource: `${proto}://${host}${req.originalUrl}`,
    description: `ODO per-call access to ${req.path}`,
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    asset: USDC_BASE,
    extra: { name: "USDC", version: "2" },
  };
}

/**
 * Express ミドルウェア。x402ゲート。
 * 無償(X-PAYMENTなし)→ 402 + accepts。支払いあり→ facilitatorで検証、必要なら決済。
 */
export function x402Gate(cfg: GateConfig) {
  return async function gate(req: Request, res: Response, next: NextFunction) {
    const requirements = buildRequirements(req, cfg);
    const payment = req.headers["x-payment"] as string | undefined;

    if (!payment) {
      log.info("x402 402 (no payment)", { path: req.path });
      res.status(402).json({
        x402Version: 1,
        error: "X-PAYMENT header is required",
        accepts: [requirements],
      });
      return;
    }

    const v = await cfg.verifier.verify(payment, requirements);
    if (!v.isValid) {
      log.info("x402 402 (invalid payment)", { path: req.path, reason: v.reason });
      res.status(402).json({
        x402Version: 1,
        error: v.reason || "invalid payment",
        accepts: [requirements],
      });
      return;
    }

    if (cfg.settle) {
      const s = await cfg.verifier.settle(payment, requirements);
      if (!s.success) {
        log.warn("x402 settle failed", { path: req.path, reason: s.reason });
        res.status(402).json({ x402Version: 1, error: s.reason || "settlement failed", accepts: [requirements] });
        return;
      }
      res.setHeader(
        "X-PAYMENT-RESPONSE",
        Buffer.from(JSON.stringify({ success: true, txHash: s.txHash, payer: v.payer })).toString("base64"),
      );
    }

    (req as Request & { x402Payer?: string }).x402Payer = v.payer;
    next();
  };
}
