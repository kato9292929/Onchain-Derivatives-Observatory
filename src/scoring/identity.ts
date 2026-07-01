// ODO身元(ERC-8004 agentId)管理。採点記録はこの身元に紐づける。
//
// 重要(設計段階の明示): agentId の「オンチェーン登録」はウォレット・RPC・ガスを要し、
// 本リポジトリ(非カストディ、秘密鍵を持たない)からは実行しない。登録は運用者の1タスクとして
// 別途行い、得られた agentId を環境変数 ODO_AGENT_ID または data/scoring/identity.json に記録する。
// AAの55560・InvestXとは別の、ODO専用IDを新規登録すること。

import { readNamed, writeNamed } from "../core/storage.js";

export interface Identity {
  agentId: string | null;
  registry: string; // ERC-8004 IdentityRegistry アドレス(登録時に設定)
  chain: string; // 例: "base"
  domain: string; // agent domain
  registeredAt: string | null;
  note: string;
}

const DEFAULT: Identity = {
  agentId: null,
  registry: "",
  chain: "base",
  domain: "",
  registeredAt: null,
  note: "未登録。運用者が ERC-8004 IdentityRegistry に ODO専用agentIdを登録し、この値を更新する。",
};

export function getIdentity(): Identity {
  const stored = readNamed<Identity>("scoring", "identity");
  const base = stored ?? DEFAULT;
  // 環境変数が優先(設定より上)。未設定の項目は stored/DEFAULT を使う。ダミーは入れない。
  const merged: Identity = {
    ...base,
    agentId: process.env.ODO_AGENT_ID ?? base.agentId,
    registry: process.env.ODO_ERC8004_REGISTRY ?? base.registry,
    chain: process.env.ODO_CHAIN ?? base.chain,
    domain: process.env.ODO_AGENT_DOMAIN ?? base.domain,
  };
  return merged;
}

export function setIdentity(partial: Partial<Identity>): Identity {
  const cur = getIdentity();
  const next: Identity = { ...cur, ...partial };
  writeNamed("scoring", "identity", next);
  return next;
}

export function currentAgentId(): string | null {
  return getIdentity().agentId;
}
