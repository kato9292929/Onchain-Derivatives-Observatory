// Vercel サーバレス関数エントリ。
// Express アプリ(buildApp)をそのまま関数ハンドラとして公開する。Express app は (req,res) 互換なので
// Vercel の Node ランタイムはこれをハンドラとして扱える。vercel.json の rewrites で全ルートをここへ流す。
//
// buildApp は listen しない(常駐しない)。isMain ガードにより import 時にサーバ起動は走らない。
// dist からインポート(vercel.json の buildCommand=`npm run build` で先にコンパイルされる)。

import { buildApp } from "../dist/api/server.js";

const app = buildApp();

export default app;
