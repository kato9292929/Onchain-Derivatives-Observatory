import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
// AAクライアントが実際に使う @x402/core の decode 関数(一次ソース)で ODO の 402 を照合する。
import { decodePaymentRequiredHeader } from "@x402/core/http";

// MOCKモードでゲートを検証(検証手段が無いと支払い経路をローカルで通せないため)。
process.env.X402_MODE = "mock";
process.env.X402_SETTLE = "false";
process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";

const { buildApp } = await import("../src/api/server.ts");

function listen(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const app = buildApp();
    const srv = app.listen(0, () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

test("無償アクセスは402で弾かれ、accepts(支払い要件)を返す", async () => {
  const { url, close } = await listen();
  try {
    const res = await fetch(`${url}/funding/nowcast/current`);
    assert.equal(res.status, 402);
    const body = (await res.json()) as {
      x402Version: number;
      resource: { url: string };
      accepts: { scheme: string; network: string; asset: string; amount: string; payTo: string; maxAmountRequired?: string }[];
    };
    // v2 に統一: x402Version=2 / network=eip155:8453 / 金額は amount / v1由来フィールドは混ざらない
    assert.equal(body.x402Version, 2);
    assert.ok(body.resource && typeof body.resource.url === "string"); // resource はトップレベル(v2)
    const a = body.accepts[0]!;
    assert.equal(a.scheme, "exact");
    assert.equal(a.network, "eip155:8453"); // CAIP-2 (Base mainnet)。AA/CDPが払える表記
    assert.equal(a.amount, "10000"); // 0.01 USDC(base units)。v1 maxAmountRequired ではない
    assert.equal(a.maxAmountRequired, undefined); // v1由来フィールドが残っていないこと
    assert.match(a.asset, /^0x833589/); // USDC on Base
  } finally {
    close();
  }
});

test("402 は PAYMENT-REQUIRED ヘッダで渡り、@x402/core の decode が受理する(v2ワイヤ)", async () => {
  const { url, close } = await listen();
  try {
    const res = await fetch(`${url}/funding/nowcast/current`);
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header, "PAYMENT-REQUIRED ヘッダが必要(v2クライアントは本文ではなくこのヘッダを読む)");
    // AAクライアントと同一の decode 関数で復号(base64regex + JSON.parse)
    const decoded = decodePaymentRequiredHeader(header!) as {
      x402Version: number;
      resource: { url: string };
      accepts: {
        scheme: string;
        network: string;
        amount: string;
        asset: string;
        payTo: string;
        maxTimeoutSeconds: number;
        extra: { name: string; version: string };
      }[];
    };
    assert.equal(decoded.x402Version, 2);
    assert.ok(typeof decoded.resource.url === "string" && decoded.resource.url.length > 0);
    const a = decoded.accepts[0]!;
    assert.equal(a.scheme, "exact");
    assert.ok(a.network.includes(":")); // CAIP-2
    assert.equal(a.network, "eip155:8453");
    assert.equal(a.amount, "10000");
    assert.ok(a.asset && a.payTo && a.maxTimeoutSeconds > 0);
    // EIP-712 domain: Base USDC の domain name は "USD Coin"(symbol "USDC" ではない)。誤ると署名が復元不能。
    assert.equal(a.extra.name, "USD Coin");
    assert.equal(a.extra.version, "2");
  } finally {
    close();
  }
});

test("支払いは PAYMENT-SIGNATURE ヘッダ(v2)で受理される(mock検証)", async () => {
  const { url, close } = await listen();
  try {
    const payment = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:8453" })).toString("base64");
    const res = await fetch(`${url}/funding/nowcast/current`, { headers: { "PAYMENT-SIGNATURE": payment } });
    assert.equal(res.status, 200);
  } finally {
    close();
  }
});

test("X-PAYMENT 提示でも後方互換で通過する(v1/mock検証)", async () => {
  const { url, close } = await listen();
  try {
    const payment = Buffer.from(JSON.stringify({ scheme: "exact", network: "eip155:8453" })).toString("base64");
    const res = await fetch(`${url}/funding/nowcast/current`, { headers: { "X-PAYMENT": payment } });
    assert.equal(res.status, 200);
  } finally {
    close();
  }
});

test("無償でもヘルス/カタログは通る", async () => {
  const { url, close } = await listen();
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/catalog`)).status, 200);
  } finally {
    close();
  }
});
