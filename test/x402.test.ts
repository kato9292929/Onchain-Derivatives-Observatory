import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

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
    const body = (await res.json()) as { x402Version: number; accepts: { network: string; asset: string }[] };
    assert.equal(body.x402Version, 1);
    assert.equal(body.accepts[0]!.network, "base");
    assert.match(body.accepts[0]!.asset, /^0x833589/); // USDC on Base
  } finally {
    close();
  }
});

test("X-PAYMENT 提示で通過する(mock検証)", async () => {
  const { url, close } = await listen();
  try {
    const payment = Buffer.from(JSON.stringify({ scheme: "exact", network: "base" })).toString("base64");
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
