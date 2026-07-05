import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { selectVerifier, NullVerifier, FacilitatorVerifier, type PaymentRequirements } from "../src/core/x402.ts";

const REQ: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  maxAmountRequired: "10000",
  resource: "http://x/test",
  description: "t",
  mimeType: "application/json",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  extra: { name: "USDC", version: "2" },
};
const PAY = Buffer.from(JSON.stringify({ scheme: "exact", network: "eip155:8453" })).toString("base64");

/** リクエストの Authorization ヘッダを記録し、指定ボディを返す簡易 facilitator。 */
function fakeFacilitator(body: unknown): Promise<{ url: string; seen: { auth?: string }; close: () => void }> {
  const seen: { auth?: string } = {};
  return new Promise((resolve) => {
    const srv: Server = createServer((req, res) => {
      if (req.url?.endsWith("/verify") || req.url?.endsWith("/settle")) seen.auth = req.headers["authorization"] as string;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => srv.close() });
    });
  });
}

test("selectVerifier: CDP資格情報が無ければ NullVerifier(fail-closed)", () => {
  const save = { mode: process.env.X402_MODE, id: process.env.CDP_API_KEY_ID, sec: process.env.CDP_API_KEY_SECRET, url: process.env.X402_FACILITATOR_URL };
  delete process.env.X402_MODE;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  try {
    const { verifier, mode } = selectVerifier();
    assert.equal(mode, "null");
    assert.ok(verifier instanceof NullVerifier);
  } finally {
    if (save.mode !== undefined) process.env.X402_MODE = save.mode;
    if (save.id !== undefined) process.env.CDP_API_KEY_ID = save.id;
    if (save.sec !== undefined) process.env.CDP_API_KEY_SECRET = save.sec;
    if (save.url !== undefined) process.env.X402_FACILITATOR_URL = save.url;
  }
});

test("selectVerifier: X402_FACILITATOR_URLだけでCDP資格情報が無い→認証なしPOSTに落ちず fail-closed", () => {
  const save = { mode: process.env.X402_MODE, id: process.env.CDP_API_KEY_ID, sec: process.env.CDP_API_KEY_SECRET, url: process.env.X402_FACILITATOR_URL };
  delete process.env.X402_MODE;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  process.env.X402_FACILITATOR_URL = "https://example.test/facilitator";
  try {
    const { verifier, mode } = selectVerifier();
    assert.equal(mode, "null");
    assert.ok(verifier instanceof NullVerifier);
  } finally {
    if (save.mode !== undefined) process.env.X402_MODE = save.mode; else delete process.env.X402_MODE;
    if (save.id !== undefined) process.env.CDP_API_KEY_ID = save.id;
    if (save.sec !== undefined) process.env.CDP_API_KEY_SECRET = save.sec;
    if (save.url !== undefined) process.env.X402_FACILITATOR_URL = save.url; else delete process.env.X402_FACILITATOR_URL;
  }
});

test("FacilitatorVerifier: createAuthHeaders の Authorization を verify POST に載せる", async () => {
  const fac = await fakeFacilitator({ isValid: true, payer: "0xabc" });
  try {
    const v = new FacilitatorVerifier(fac.url, async () => ({
      verify: { Authorization: "Bearer TESTJWT-VERIFY" },
      settle: { Authorization: "Bearer TESTJWT-SETTLE" },
      supported: {},
    }));
    const r = await v.verify(PAY, REQ);
    assert.equal(r.isValid, true);
    assert.equal(r.payer, "0xabc");
    assert.equal(fac.seen.auth, "Bearer TESTJWT-VERIFY");
  } finally {
    fac.close();
  }
});

test("FacilitatorVerifier: 認証を付けても facilitator が isValid:false(HTTP200)なら拒否(fail-closed)", async () => {
  const fac = await fakeFacilitator({ isValid: false, invalidReason: "insufficient_funds" });
  try {
    const v = new FacilitatorVerifier(fac.url, async () => ({
      verify: { Authorization: "Bearer X" },
      settle: { Authorization: "Bearer X" },
      supported: {},
    }));
    const r = await v.verify(PAY, REQ);
    assert.equal(r.isValid, false);
    assert.equal(r.reason, "insufficient_funds");
  } finally {
    fac.close();
  }
});

test("FacilitatorVerifier: createAuthHeaders 未指定なら Authorization は付かない(後方互換)", async () => {
  const fac = await fakeFacilitator({ isValid: true });
  try {
    const v = new FacilitatorVerifier(fac.url); // 認証なし
    await v.verify(PAY, REQ);
    assert.equal(fac.seen.auth, undefined);
  } finally {
    fac.close();
  }
});
