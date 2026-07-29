import type { NextConfig } from "next";

const config: NextConfig = {
  // Agent SDK は Node のネイティブバイナリを同梱しているのでバンドルさせない
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  typescript: { ignoreBuildErrors: false },
};

export default config;
