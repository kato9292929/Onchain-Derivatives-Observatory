# ODO — Onchain Derivatives Observatory

デリバティブ(perp / オプション)を **観測・採点・配信** する新規プロダクト。取引所ではない。
マーケットメイクもオプション売りもしない。やるのは観測と記録だけ。**非カストディ**(外部送金経路を構造的に持たない)。

`AlternaData for agents`(PRODUCE層)配下。x402 の **売り手**として、各エンドポイントを HTTP 402 でゲートし USDC を per-call で受ける。

---

## モジュール

- **OFN(Onchain Funding Nowcast)**: 各会場の funding rate とベーシスを日次採取し、オンチェーンの借り需要と、それが生むデルタニュートラルのキャリー利回りを観測・指数化する。
- **PCM(Premium Capture Meter)**: オプションの理論プレミアム(フェア値)と売り手が実際に受け取ったプレミアムの差を測り、会場・戦略ごとの **捕捉率**(= 実受取 ÷ フェア値)を日付きで記録する。

両モジュールは「cron・時系列保存・REST+MCP配信・x402・採点」という同じ骨格を共有する。土台は `src/core` に1本化し、OFN/PCM はその上のモジュール。

### 会場ポリシー(日本拠点)

無登録/規制対象の **CEX(Binance・Bybit・Deribit 等)は基準線としてデータに組み込まない**。
OFN はオンチェーン会場のみで成立させる(現状ライブは **Hyperliquid**。Drift/Aevo/Lighter/Extended は設計段階)。
会場横断比較は「オンチェーン会場どうしの funding ばらつき」として出す(CEX乖離の意味づけは持たない)。
PCM はオンチェーンのオプション会場 **Derive** をライブ対象とする(下記)。

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
| `GET /funding/venues/{symbol}` | 会場横断 funding(オンチェーン会場どうしの比較) |
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
- **生funding値の保存**: OFN 各観測に取得元の生 funding 値(正規化前・未加工)`fundingRateRaw` を残す。複数資産が同一値でも、それがソース由来(Hyperliquid の金利成分=0.01%/8h への張り付き)か取得ロジック由来かを後から判別できる。
- **実測 vs 近似の分離**: PCM の実受取は `receiptSource`(`last_trade`=実約定 / `board_bid`=板bid近似)で全件区別。リーダーボードは両者を混ぜず別々に返す(検証可能性を濁さない)。建玉は near-ATM かつ流動性優先で選定し、時間窓内の実約定があればそれを、無ければ板bidを使う。

---

## 採点層

週次で前向きの宣言を日付きで残し(`score:declare`)、週末に同じ日次観測から計算した実現値と機械照合する(`score:grade`)。
方向はヒット率 + 較正(brier)、水準は実現値との誤差。結果は当落の別なく全件、ODO の ERC-8004 `agentId` に紐づけて `data/scoring/grades.json` に記録する。

---

## 運用者チェックリスト(本リポジトリの外で必要な作業)

このコードベースは観測・採点・配信を完結して実装・テスト済み(`npm run e2e` / `npm test`)。
一方、以下は**ウォレット・資格情報・本番ホストを要する運用者タスク**であり、コードからは実行しない(設計段階として明示):

1. **Vercel デプロイ(API + MCP)**: サーバレスで配信する。構成は同梱済み(`vercel.json` / `api/index.ts` / `public/`)。
   - Vercel プロジェクトを作成しリポジトリを接続。**Production ブランチを cron の書き込み先ブランチと一致させる**(現状 `claude/odo-derivatives-observatory-87e880`)。ブランチがずれると更新されない古いデータを配る。
   - Node 20+。ビルドは `vercel.json` の `buildCommand: npm run build`(TS→`dist/`)。`api/index.ts` が Express アプリ(`buildApp`)を関数として公開し、`rewrites` で全ルートを流す。`config/**`・`data/**` は `includeFiles` で関数に同梱。
   - **データ鮮度**: cron がデータを push した後に Vercel を再デプロイさせる。**Deploy Hook** を Vercel で作成し、その URL を GitHub の Secrets `VERCEL_DEPLOY_HOOK_URL` に設定(3つの cron が push 成功時に叩く)。未設定でも push はされるが、Production ブランチ一致による自動再デプロイに頼る場合はブランチ設定を必ず合わせること。**cron のコミットに `[skip ci]` は付けない**(付けると再デプロイが黙って止まり古いデータを配る)。
   - **MCP 面**: `POST /mcp`(Streamable HTTP, ステートレス)。Vercel サーバレスで動作確認済み(常駐不要=Railway 等は不要)。REST と同じく x402 ゲート下(未払い 402 / 支払いで通過)。`ODO_MCP_HTTP=false` で無効化可。
2. **x402 facilitator(CDP)/ 決済 env(Vercel Project Settings に設定。コミットしない)**:
   - **CDP認証**: `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`(CDPダッシュボードで x402/facilitator 用に発行)。CDP の verify/settle は認証必須で、この2つから JWT を生成して付与する(`@coinbase/x402` の `createFacilitatorConfig`)。**両方揃うと本番(mode=facilitator-cdp)、揃わないと fail-closed(mode=null)**。認証情報が無いのに認証なしPOSTで素通しはしない。
   - `X402_PAY_TO`(Base 上の受取アドレス)、`X402_PRICE_USDC`(1コール価格)、任意で `X402_SETTLE`。CDP経路の facilitator URL は CDP 固定URL(`config.url`)を使うため `X402_FACILITATOR_URL` の上書きは不要。
   - 設定後に **Redeploy**。その後、USDC を持つウォレット + x402 クライアントで有償エンドポイントに実決済し **pay→200**・`X-PAYMENT-RESPONSE` の txHash をオンチェーンで確認(ハッピーパス。実測するまで「課金が動いた」とは言わない)。
3. **ERC-8004 agentId 登録**(配線済・実行は運用者): ODO 専用 ID を IdentityRegistry に新規登録(AAの55560・InvestX とは別)。
   - 配線: 採点層は `ODO_AGENT_ID`(または `data/scoring/identity.json`)から agentId を読み、宣言・採点の全記録に紐づける。未設定なら「未登録」(ダミーは入れない)。
   - 手順: `scripts/register-agent.ts`(`npm run agent:register`)。Circle Developer-Controlled Wallet でウォレットを用意し、ERC-8004 IdentityRegistry へ `newAgent(agentDomain, agentAddress)` を contractExecution(AAと同じ作法)。
   - 必要な資格情報/設定(`.env.example` 参照): `CIRCLE_API_KEY`・`CIRCLE_ENTITY_SECRET`・`CIRCLE_WALLET_SET_ID`(または `CIRCLE_WALLET_ID`)、`ODO_ERC8004_REGISTRY`(**現行の公開情報でアドレスを確認**)、`ODO_ERC8004_ABI_FN`(登録関数、現行デプロイで要確認)、`ODO_AGENT_DOMAIN`。これらが揃わないとスクリプトは fail-closed。
   - 登録後: 発行された agentId を `npm run agent:register -- --set-agent-id=<agentId>` で `data/scoring/identity.json` に記録(または `ODO_AGENT_ID` を設定)。
   - **サンドボックス/CI からは実行しない**(秘密鍵・ガス・Circle資格情報が必要)。この環境で「登録できた」とは書かない。
4. **cron 有効化**: スケジュールはデフォルトブランチでのみ発火する(GitHub 仕様)。マージ後に有効。検証は `workflow_dispatch` で手動実行可能。
5. **Derive ライブ検証**: PCM の Derive adapter はライブ実装済(`public/get_instruments`→`get_ticker`→`get_trade_history`)。ただしサンドボックスからは egress 制限で到達できず、ランナーIPも会場によりジオブロック(451/403)されうる。ランナー上で `PCM daily collect` を `workflow_dispatch` し、ログの `[PCM] source venue=derive mode=live`(成功)/ `mode=fixture reason=...`(到達不可)で実取得可否を判定する。`mode=live` を確認するまで「Deriveがライブで動いた」とは言わない。

環境変数は `.env.example` を参照。`DERIVE_API_URL` で Derive ベースURL(既定 `https://api.lyra.finance`)を上書き可能。

---

## 完了の定義に対する現状

- [x] 新規リポジトリ、osd/JIN/AA/InvestX への依存ゼロ
- [x] GitHub Actions cron(日次 OFN/PCM・週次採点)を用意、`data/` にコミットする構成
- [x] REST API と MCP サーバーが起動し、ログがクリーン(構造化JSON)
- [x] x402 per-call ゲートが機能(無償アクセスが 402 で弾かれる)
- [x] 最低1資産1会場で OFN(ゲージ+キャリー指数)と PCM(捕捉率)が e2e で通る(BTC / Hyperliquid・Derive、オフライン fixture で実証)
- [x] OFN はオンチェーン会場のみ(CEX基準線を除去)。Hyperliquid のライブ収集は従来どおり
- [x] PCM の Derive adapter をライブ実装(IV・実受取とも公開APIで取得可と一次資料で確認)。near-ATM・流動性優先、last_trade優先→board_bidフォールバック、receiptSourceで実測/近似を分離
- [x] OFN 各観測に生funding値 `fundingRateRaw` を追加(funding同一値の素性を後日判別可能に)
- [x] 採点層の agentId 配線(env/設定から読み全記録に紐づけ、未設定は未登録・ダミー無し)+ 登録スクリプト `npm run agent:register`
- [x] Vercel サーバレス構成(`vercel.json` / `api/index.ts` / `public/`)。ローカルで build・/health・/catalog=200・有償=402(fail-closed)・`POST /mcp`(x402下でツール応答)を確認
- [x] データ鮮度: cron の push 成功時に Vercel Deploy Hook を叩く配線(3ワークフロー)。`[skip ci]` 不使用を確認
- [ ] Derive `mode=live` の実取得確認・funding素性の数日データ確認(ランナー上で workflow_dispatch、運用者)
- [ ] Vercel 実デプロイ Online・facilitator 接続・pay→200・cron後の再デプロイ・agentId オンチェーン登録(= 運用者チェックリスト。コードは対応済み、実行は運用者)

## やらないこと

取引所・マーケットメイク・オプション売りの実装はしない(Derive/Rysk の土俵)。外部送金経路は持たない(非カストディ)。
AAの x402 支払いクライアントは流用しない。実在しないエンドポイントを実在として書かない(設計段階のものは設計と明記)。
