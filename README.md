# ODO — Onchain Derivatives Observatory

デリバティブ(perp / オプション)を **観測・採点・配信** する新規プロダクト。取引所ではない。
マーケットメイクもオプション売りもしない。やるのは観測と記録だけ。**非カストディ**(外部送金経路を構造的に持たない)。

`AlternaData for agents`(PRODUCE層)配下。x402 の **売り手**として、各エンドポイントを HTTP 402 でゲートし USDC を per-call で受ける。

---

## モジュール

- **OFN(Onchain Funding Nowcast)**: 各会場の funding rate とベーシスを日次採取し、オンチェーンの借り需要と、それが生むデルタニュートラルのキャリー利回りを観測・指数化する。
- **PCM(Premium Capture Meter)**: オプションの理論プレミアム(フェア値)と売り手が実際に受け取ったプレミアムの差を測り、会場・戦略ごとの **捕捉率**(= 実受取 ÷ フェア値)を日付きで記録する。

両モジュールは「cron・時系列保存・REST+MCP配信・x402・採点」という同じ骨格を共有する。土台は `src/core` に1本化し、OFN/PCM はその上のモジュール。

---

## スタック決定(と理由)

**TypeScript + Node.js (ESM)** を採用。

1. x402 の売り手ゲートと MCP 公式 SDK が TS/JS で一級サポート。
2. osd / JIN が Web/Vercel 系 = JS/TS エコシステムに整合。
3. cron・API・MCP を1言語に統一し、依存と不安定性(volatility)を最小化。

依存は最小限(`express`, `@modelcontextprotocol/sdk`, `zod`)。HTTP は Node 22 組み込み `fetch` を使い axios を入れない(InvestX で問題になった経路を踏まない)。

---

## 絶対制約への対応

| 制約 | 実装上の対応 |
|---|---|
| AAの substrate / x402 **支払い**クライアントを流用しない | 売り手ゲートを `src/core/x402.ts` に**新規実装**。買い手側の決済初期化コードは一切無い。 |
| 依存ゼロ(osd/JIN のコードを流用しない) | 設計の型のみ参考にし、コードは新規記述。 |
| 非カストディ | 本体は秘密鍵も RPC も持たない。署名検証・決済は外部 **facilitator** に委譲。送金機能は無い。 |
| Vercel cron を使わない | 日次収集は **GitHub Actions** の cron(`.github/workflows/`)。 |
| 初期は DB を入れない | 時系列は **日付きJSON を git にコミット**(`data/`)。将来の DB 化は `src/core/storage.ts` に閉じて差し替え可能。 |

---

## ディレクトリ

```
config/              # 定数(会場メタ・資産バスケット・PCM前提)。コードから外出し。
data/                # 日付きJSONの時系列(コミットされる観測・採点履歴)
  ofn/  pcm/  scoring/
fixtures/            # オフライン実証用の固定データ
src/
  core/   # 共通基盤: types, config, http, logger, normalize, storage, x402, queries
  ofn/    # Funding/Basis Nowcast(sources/ + 指数計算)
  pcm/    # Premium Capture Meter(Black-Scholes + 捕捉率)
  scoring/# 週次宣言 → 照合 → agentId 紐づけ
  api/    # REST(x402ゲート)
  mcp/    # MCPサーバー(同一データの二面配信)
  cli/    # 収集・採点・e2e エントリ
.github/workflows/   # 日次OFN/PCM収集・週次採点 cron
```

---

## 使い方

```bash
npm install
npm run typecheck && npm test     # 型チェック + ユニットテスト(13件)
npm run e2e                       # オフライン fixture で end-to-end 実証

# 収集(ライブ。GitHub Actions ランナー等の外部疎通がある環境で)
npm run ofn:collect               # data/ofn/<date>.json
npm run pcm:collect               # data/pcm/<date>.json
npm run ofn:collect -- --offline  # fixture モード

# 採点
npm run score:declare             # 週次の前向き宣言を生成
npm run score:grade               # 実現値と照合して採点

# 配信
npm run api                       # REST (default :8080)
npm run mcp                       # MCP server (stdio)
```

### x402 ゲートの確認

```bash
npm run build
X402_PAY_TO=0x... node dist/api/server.js
curl -i localhost:8080/funding/nowcast/current   # → 402 + accepts(支払い要件JSON)
curl -i localhost:8080/health                    # → 200(無償)
```

未払いリクエストは `402 Payment Required` と x402 標準の `accepts`(scheme=exact / network=base / asset=USDC on Base)を返す。
facilitator 未設定時は **fail-closed**(支払い提示でも拒否)。

---

## API(全データエンドポイントが x402 課金)

| エンドポイント | 内容 |
|---|---|
| `GET /funding/nowcast/current` | 借り需要ゲージ最新値(Majors / Long-tail 別) |
| `GET /funding/nowcast/history` | ゲージ時系列 |
| `GET /funding/asset/{symbol}` | 資産別 funding・basis・carry(fundable/harvestable タグ付き) |
| `GET /funding/venues/{symbol}` | 会場横断 funding(オンチェーン vs CEX 乖離) |
| `GET /funding/carry/leaderboard` | harvestable net carry ランキング + キャリー収穫指数 |
| `GET /funding/carry/index/{basket}` | キャリー収穫指数(累積, 基準日=100)の時系列 |
| `GET /premium/capture/current` | 会場・戦略別の最新捕捉率 |
| `GET /premium/capture/history` | 捕捉率の時系列 |
| `GET /premium/capture/leaderboard` | 捕捉率ランキング(薄商いは信頼度を下げる) |

無償: `GET /health`, `GET /catalog`。MCP サーバーは同じものをツールとして出す(二面配信)。

---

## 指標の設計(正直さの肝)

- **借り需要ゲージ**(当日水準): 中央値 + ウィンザライズ平均(上下10%刈り)+ 分散(市場ストレス指標)。Kioxia +900% 型の外れ値に一本で支配されない。
- **キャリー収穫指数**(累積, 基準日=100): `harvestable` のみで構成。OI から想定ノーショナル上限を置き、大口で取り切れない利回りを過大表示しない。funding が負なら指数は下がる(それで正しい)。
- **fundable / harvestable タグ**: spot が無く実収穫できない perp(HIP-3 等)は `fundable` として水準観測のみ。デルタニュートラルで実収穫できるものだけ `harvestable`。
- **PCM 前提開示**: 使った IV の出所(`ivSource`)と金利を全件 observation に残す。薄商いは `lowLiquidity` タグで捕捉率の信頼度を下げる。

---

## 採点層

週次で前向きの宣言を日付きで残し(`score:declare`)、週末に同じ日次観測から計算した実現値と機械照合する(`score:grade`)。
方向はヒット率 + 較正(brier)、水準は実現値との誤差。結果は当落の別なく全件、ODO の ERC-8004 `agentId` に紐づけて `data/scoring/grades.json` に記録する。

---

## 運用者チェックリスト(本リポジトリの外で必要な作業)

このコードベースは観測・採点・配信を完結して実装・テスト済み(`npm run e2e` / `npm test`)。
一方、以下は**ウォレット・資格情報・本番ホストを要する運用者タスク**であり、コードからは実行しない(設計段階として明示):

1. **デプロイ**: API/MCP を本番ホスト(osd/JIN に合わせる)へ。`X402_PAY_TO` 等を環境変数で設定。
2. **x402 facilitator**: `X402_FACILITATOR_URL` を設定(未設定だと fail-closed)。Base mainnet USDC で per-call 受領。
3. **ERC-8004 agentId 登録**: ODO 専用 ID を IdentityRegistry に新規登録(AAの55560・InvestX とは別)。得られた値を `ODO_AGENT_ID` または `data/scoring/identity.json` に記録。
4. **cron 有効化**: スケジュールはデフォルトブランチでのみ発火する(GitHub 仕様)。マージ後に有効。検証は `workflow_dispatch` で手動実行可能。

環境変数は `.env.example` を参照。

---

## 完了の定義に対する現状

- [x] 新規リポジトリ、osd/JIN/AA/InvestX への依存ゼロ
- [x] GitHub Actions cron(日次 OFN/PCM・週次採点)を用意、`data/` にコミットする構成
- [x] REST API と MCP サーバーが起動し、ログがクリーン(構造化JSON)
- [x] x402 per-call ゲートが機能(無償アクセスが 402 で弾かれる)
- [x] 最低1資産1会場で OFN(ゲージ+キャリー指数)と PCM(捕捉率)が e2e で通る(BTC / Hyperliquid・Derive)
- [ ] 本番デプロイ Online・facilitator 接続・agentId オンチェーン登録(= 上記「運用者チェックリスト」。コードは対応済み、実行は運用者)

## やらないこと

取引所・マーケットメイク・オプション売りの実装はしない(Derive/Rysk の土俵)。外部送金経路は持たない(非カストディ)。
AAの x402 支払いクライアントは流用しない。実在しないエンドポイントを実在として書かない(設計段階のものは設計と明記)。
