// ODO専用 agentId 登録スクリプト(ERC-8004 IdentityRegistry / Circle Developer-Controlled Wallet)。
//
// これは運用者タスク。実行には Circle APIキー・entity secret・ガス(Base mainnet)が要る。
// 本リポジトリは非カストディで秘密鍵を持たないため、サンドボックス/CIからは実行しない。
// 資格情報が無い場合は fail-closed(何もせず終了)。ダミーIDは絶対に書かない。
//
// 作法は AA の contractExecution と同じ:
//   1) Circle DCW でウォレット(または既存ウォレット)を用意(Base)。
//   2) そのウォレットアドレスを agentAddress として ERC-8004 IdentityRegistry に登録。
//   3) 発行された agentId を控え、ODO_AGENT_ID もしくは data/scoring/identity.json に設定。
//
// 使い方:
//   # (A) 登録を実行(要 Circle 資格情報 + 検証済みレジストリ情報)
//   CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=<hex32> CIRCLE_WALLET_SET_ID=... \
//   ODO_ERC8004_REGISTRY=0x... ODO_AGENT_DOMAIN=odo.example \
//   npm run agent:register
//
//   # (B) 登録後、得た agentId を身元ファイルに記録
//   npm run agent:register -- --set-agent-id=<agentId>
//
// 重要: ODO_ERC8004_REGISTRY(レジストリアドレス)と ODO_ERC8004_ABI_FN(登録関数シグネチャ)は
//   現行の ERC-8004 デプロイの公開情報で必ず確認してから設定すること。既定値は参照実装ベースの目安であり、
//   デプロイ差異があり得る。未確認のまま本番実行しないこと。

import { publicEncrypt, constants as cryptoConstants, randomUUID } from "node:crypto";
import { setIdentity } from "../src/scoring/identity.js";

const CIRCLE_BASE = process.env.CIRCLE_API_BASE || "https://api.circle.com/v1/w3s";
// ERC-8004 参照実装の登録関数(要現行確認)。agentDomain と agentAddress を登録し agentId を発行。
const ABI_FN = process.env.ODO_ERC8004_ABI_FN || "newAgent(string,address)";
const CHAIN = process.env.ODO_CIRCLE_BLOCKCHAIN || "BASE"; // Circle の blockchain 識別子(Base mainnet)

function die(msg: string): never {
  process.stderr.write(`[register-agent] ${msg}\n`);
  process.exit(1);
}

async function circle<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) die("CIRCLE_API_KEY 未設定: fail-closed(登録は運用者が資格情報を持って実行)");
  const res = await fetch(`${CIRCLE_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) die(`Circle ${method} ${path} -> HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Circle entity secret ciphertext を都度生成(RSA-OAEP SHA-256, base64)。 */
async function entitySecretCiphertext(): Promise<string> {
  const secretHex = process.env.CIRCLE_ENTITY_SECRET;
  if (!secretHex) die("CIRCLE_ENTITY_SECRET(hex32)未設定");
  const pk = await circle<{ data: { publicKey: string } }>("/config/entity/publicKey", "GET");
  const encrypted = publicEncrypt(
    { key: pk.data.publicKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(secretHex, "hex"),
  );
  return encrypted.toString("base64");
}

async function ensureWallet(): Promise<{ id: string; address: string }> {
  const existing = process.env.CIRCLE_WALLET_ID;
  if (existing) {
    const w = await circle<{ data: { wallet: { id: string; address: string } } }>(`/wallets/${existing}`, "GET");
    return { id: w.data.wallet.id, address: w.data.wallet.address };
  }
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (!walletSetId) die("CIRCLE_WALLET_ID も CIRCLE_WALLET_SET_ID も未設定");
  const created = await circle<{ data: { wallets: { id: string; address: string }[] } }>(
    "/developer/wallets",
    "POST",
    {
      idempotencyKey: randomUUID(),
      entitySecretCiphertext: await entitySecretCiphertext(),
      walletSetId,
      blockchains: [CHAIN],
      count: 1,
      accountType: "SCA",
    },
  );
  const w = created.data.wallets[0];
  if (!w) die("ウォレット作成に失敗");
  process.stdout.write(`[register-agent] created wallet ${w.id} (${w.address}) on ${CHAIN}\n`);
  return { id: w.id, address: w.address };
}

async function register(): Promise<void> {
  const registry = process.env.ODO_ERC8004_REGISTRY;
  if (!registry) die("ODO_ERC8004_REGISTRY(IdentityRegistryアドレス)未設定。現行公開情報で確認して設定すること");
  const domain = process.env.ODO_AGENT_DOMAIN;
  if (!domain) die("ODO_AGENT_DOMAIN(agent domain)未設定");

  const wallet = await ensureWallet();
  const exec = await circle<{ data: { id: string; state: string } }>(
    "/developer/transactions/contractExecution",
    "POST",
    {
      idempotencyKey: randomUUID(),
      entitySecretCiphertext: await entitySecretCiphertext(),
      walletId: wallet.id,
      contractAddress: registry,
      abiFunctionSignature: ABI_FN,
      abiParameters: [domain, wallet.address],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    },
  );
  process.stdout.write(
    `[register-agent] contractExecution submitted: txId=${exec.data.id} state=${exec.data.state}\n` +
      `  agentAddress=${wallet.address} registry=${registry} fn=${ABI_FN} domain=${domain}\n` +
      `  次: GET ${CIRCLE_BASE}/transactions/${exec.data.id} で CONFIRMED を待ち、\n` +
      `  レジストリのイベント/リゾルバから発行された agentId を取得する。\n` +
      `  取得後: npm run agent:register -- --set-agent-id=<agentId> で身元に記録。\n`,
  );
  // 身元ファイルに登録メタを先行記録(agentIdは確定後に別途set)。registeredAtは確定時に更新。
  setIdentity({ registry, domain, chain: (process.env.ODO_CHAIN || "base") });
}

function setAgentId(agentId: string): void {
  if (!/^\d+$/.test(agentId) && !/^0x[0-9a-fA-F]+$/.test(agentId))
    die(`agentId の形式が不正: ${agentId}(数値または 0x hex を想定)`);
  const id = setIdentity({
    agentId,
    registeredAt: new Date().toISOString(),
    note: "登録済(運用者が ERC-8004 IdentityRegistry へ登録)。採点記録はこの agentId に紐づく。",
  });
  process.stdout.write(`[register-agent] identity 更新: ${JSON.stringify(id)}\n`);
}

const setArg = process.argv.find((a) => a.startsWith("--set-agent-id="));
if (setArg) {
  setAgentId(setArg.split("=")[1] ?? "");
} else {
  register().catch((e) => die(String(e)));
}
