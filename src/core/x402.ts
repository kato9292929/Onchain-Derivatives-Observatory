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
import { createFacilitatorConfig } from "@coinbase/x402";
import { httpJson } from "./http.js";
import { log } from "./logger.js";

// CDP facilitator の verify/settle は CDP 認証(CDP_API_KEY_ID/SECRET から生成する JWT)を必須にする。
// createAuthHeaders() は verify 用・settle 用それぞれの認証ヘッダを返す(JWTは CDP の host/path に束縛)。
type CreateAuthHeaders = () => Promise<{
  verify: Record<string, string>;
  settle: Record<string, string>;
  supported?: Record<string, string>;
}>;

/** Base mainnet USDC */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_DECIMALS = 6;

// network 表記は CAIP-2(eip155:CHAIN_ID)。Base mainnet = eip155:8453。
// v2 の x402 スタック(@x402/core、AAの payload 生成、CDP facilitator)が期待する形式。
// 旧 v1 の "base" は payload 生成で `Unsupported network format: base (expected eip155:CHAIN_ID)` になり払えない。
export const NETWORK_BASE_MAINNET = "eip155:8453" as const;

// x402 プロトコルバージョン。ODOの周辺スタック(CDP facilitator=@coinbase/x402@2、AAクライアント=@x402/*@2)
// は全て v2。v1 との混在(version:1 + eip155 network)は AA の登録に一致せず払えないため、v2 に統一する。
export const X402_VERSION = 2 as const;

// v2 PaymentRequirements(@x402/core の実型に一致):
//   { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }
// v1 の maxAmountRequired/resource/description/mimeType/outputSchema は accepts から外れ、
// 金額は amount(base units 文字列)。resource は 402 エンベロープのトップレベルへ移動。
export interface PaymentRequirements {
  scheme: "exact";
  network: typeof NETWORK_BASE_MAINNET;
  asset: string;
  amount: string; // base units(USDC=6桁)。0.01 USDC = "10000"
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** v2 ResourceInfo(402 エンベロープのトップレベル resource)。 */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** v2 PaymentRequired(402 本文)。 */
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
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

/**
 * facilitator(外部)に検証・決済を委譲。本番経路。
 * CDP facilitator を使う場合は createAuthHeaders を渡し、verify/settle の POST に CDP 認証ヘッダを載せる。
 * 認証ヘッダ生成に失敗した場合は素通しせず reject(fail-closed)する。
 * verify 失敗は facilitator が「HTTP200 + isValid:false」で返す。認証エラー(401/403)は httpJson が throw し、
 * catch して isValid:false に落ちる(いずれも fail-closed)。
 */
export class FacilitatorVerifier implements Verifier {
  constructor(
    private baseUrl: string,
    private createAuthHeaders?: CreateAuthHeaders,
  ) {}

  private async authHeaders(kind: "verify" | "settle"): Promise<Record<string, string>> {
    if (!this.createAuthHeaders) return {};
    const h = await this.createAuthHeaders();
    return h[kind] ?? {};
  }

  async verify(paymentB64: string, req: PaymentRequirements): Promise<VerifyResult> {
    try {
      const payload = JSON.parse(Buffer.from(paymentB64, "base64").toString("utf8"));
      const headers = await this.authHeaders("verify");
      const r = await httpJson<{ isValid: boolean; payer?: string; invalidReason?: string }>(
        `${this.baseUrl}/verify`,
        { method: "POST", headers, body: { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: req } },
      );
      return { isValid: !!r.isValid, payer: r.payer, reason: r.invalidReason };
    } catch (err) {
      return { isValid: false, reason: `facilitator verify error: ${String(err)}` };
    }
  }
  async settle(paymentB64: string, req: PaymentRequirements): Promise<SettleResult> {
    try {
      const payload = JSON.parse(Buffer.from(paymentB64, "base64").toString("utf8"));
      const headers = await this.authHeaders("settle");
      const r = await httpJson<{ success: boolean; transaction?: string; errorReason?: string }>(
        `${this.baseUrl}/settle`,
        { method: "POST", headers, body: { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: req } },
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

/** fail-closed: 認証付きfacilitatorを構成できない。支払いが来ても検証手段が無いので常に拒否。 */
export class NullVerifier implements Verifier {
  async verify(): Promise<VerifyResult> {
    return { isValid: false, reason: "no authenticated facilitator (CDP_API_KEY_ID/SECRET unset): fail-closed" };
  }
  async settle(): Promise<SettleResult> {
    return { success: false, reason: "no authenticated facilitator: fail-closed" };
  }
}

/**
 * verifier 選定。fail-closed が最優先。
 *  - X402_MODE=mock: 開発専用モック(本番禁止)。
 *  - CDP資格情報(CDP_API_KEY_ID かつ CDP_API_KEY_SECRET)あり: CDP認証付き facilitator。
 *      base URL は CDP config.url に固定(JWTが CDP host/path に束縛されるため。X402_FACILITATOR_URL では上書きしない)。
 *  - それ以外(CDP資格情報なし): NullVerifier(fail-closed)。認証情報が無いのに「認証なしPOST」へは落とさない。
 */
export function selectVerifier(): { verifier: Verifier; mode: string } {
  if (process.env.X402_MODE === "mock") return { verifier: new MockVerifier(), mode: "mock" };

  const id = process.env.CDP_API_KEY_ID;
  const secret = process.env.CDP_API_KEY_SECRET;
  if (id && secret) {
    const cfg = createFacilitatorConfig(id, secret);
    const baseUrl = cfg.url ?? "https://api.cdp.coinbase.com/platform/v2/x402";
    return {
      verifier: new FacilitatorVerifier(baseUrl, cfg.createAuthHeaders as CreateAuthHeaders | undefined),
      mode: "facilitator-cdp",
    };
  }

  if (process.env.X402_FACILITATOR_URL) {
    // CDP資格情報が無いのに facilitator URL だけ設定されている状態。認証なしPOSTには落とさず fail-closed。
    log.warn(
      "x402: X402_FACILITATOR_URL は設定されているが CDP_API_KEY_ID/SECRET が無い。認証付きverifyができないため fail-closed(NullVerifier)にする。CDP資格情報を設定すること。",
    );
  }
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

/** v2 accepts 要素(PaymentRequirements)。金額は amount(base units)。 */
function buildRequirements(cfg: GateConfig): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK_BASE_MAINNET,
    asset: USDC_BASE,
    amount: toAtomic(cfg.priceUsdc),
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
}

/** v2 402 エンベロープのトップレベル resource。 */
function buildResourceInfo(req: Request): ResourceInfo {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = req.headers.host || "localhost";
  return {
    url: `${proto}://${host}${req.originalUrl}`,
    description: `ODO per-call access to ${req.path}`,
    mimeType: "application/json",
  };
}

/** v2 PaymentRequired(402本文)を組み立てる。3つの拒否分岐で共通利用。 */
function build402(req: Request, cfg: GateConfig, error: string): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error,
    resource: buildResourceInfo(req),
    accepts: [buildRequirements(cfg)],
  };
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

/**
 * v2 の 402 を返す。@x402/core v2 クライアントは 402 本文ではなく PAYMENT-REQUIRED ヘッダ(base64 JSON)
 * から PaymentRequired を読む(本文は x402Version===1 のときのみ使う)。よってヘッダに載せる。
 * 本文にも同じ内容を入れる(人間の確認・v1互換)。
 */
function send402(res: Response, req: Request, cfg: GateConfig, error: string): void {
  const body = build402(req, cfg, error);
  res.setHeader("PAYMENT-REQUIRED", b64(body));
  res.status(402).json(body);
}

/**
 * Express ミドルウェア。x402ゲート(v2)。fail-closed 維持。
 * 支払いは v2 クライアントが PAYMENT-SIGNATURE ヘッダで送る(v1 は X-PAYMENT)。両対応で読む。
 */
export function x402Gate(cfg: GateConfig) {
  return async function gate(req: Request, res: Response, next: NextFunction) {
    const requirements = buildRequirements(cfg);
    // v2: PAYMENT-SIGNATURE / v1後方互換: X-PAYMENT
    const payment =
      (req.headers["payment-signature"] as string | undefined) ?? (req.headers["x-payment"] as string | undefined);

    if (!payment) {
      log.info("x402 402 (no payment)", { path: req.path });
      send402(res, req, cfg, "payment required: PAYMENT-SIGNATURE header is missing");
      return;
    }

    const v = await cfg.verifier.verify(payment, requirements);
    if (!v.isValid) {
      log.info("x402 402 (invalid payment)", { path: req.path, reason: v.reason });
      send402(res, req, cfg, v.reason || "invalid payment");
      return;
    }

    if (cfg.settle) {
      const s = await cfg.verifier.settle(payment, requirements);
      if (!s.success) {
        log.warn("x402 settle failed", { path: req.path, reason: s.reason });
        send402(res, req, cfg, s.reason || "settlement failed");
        return;
      }
      // v2 settle 応答: PAYMENT-RESPONSE(settleResponseSchema は transaction/network 必須)。X-PAYMENT-RESPONSE も併置。
      const settleResponse = {
        success: true,
        transaction: s.txHash ?? "",
        network: NETWORK_BASE_MAINNET,
        payer: v.payer,
      };
      res.setHeader("PAYMENT-RESPONSE", b64(settleResponse));
      res.setHeader("X-PAYMENT-RESPONSE", b64(settleResponse));
    }

    (req as Request & { x402Payer?: string }).x402Payer = v.payer;
    next();
  };
}
