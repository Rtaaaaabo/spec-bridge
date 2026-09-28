# spec-bridge を1つのイメージで動かす。
#
# プロセスは2つ（fly.toml 参照）:
#   app    … 画面 + webhook の受け口（Next.js）
#   worker … 解析の実行（常駐）
#
# **git が要る。** 解析対象リポジトリを一時ディレクトリへ浅くクローンするため。
FROM node:22-slim AS base

# ca-certificates は GitHub / Anthropic への HTTPS に、git はクローンに使う
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# 依存だけ先に入れて、コードの変更でキャッシュが飛ばないようにする
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json      apps/cli/
COPY apps/web/package.json      apps/web/
COPY apps/webhook/package.json  apps/webhook/
COPY packages/backfill/package.json packages/backfill/
COPY packages/core/package.json     packages/core/
COPY packages/github/package.json   packages/github/
COPY packages/ingest/package.json   packages/ingest/
COPY packages/jobs/package.json     packages/jobs/
COPY packages/tenants/package.json  packages/tenants/

# tsx で TypeScript をそのまま動かすので、devDependencies も要る（--prod にしない）
RUN pnpm install --frozen-lockfile

COPY . .

# 画面だけ事前ビルドする。worker は tsx で直接動かす
RUN pnpm --filter @spec-bridge/web build

# Fly の既定ポート
ENV PORT=8080
EXPOSE 8080

# 既定は画面（fly.toml が worker 側のコマンドを上書きする）
CMD ["pnpm", "--filter", "@spec-bridge/web", "start"]
