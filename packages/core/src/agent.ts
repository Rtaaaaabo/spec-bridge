import { query } from "@anthropic-ai/claude-agent-sdk";

export interface RunAgentOptions {
  systemPrompt: string;
  prompt: string;
  cwd?: string;
  model?: string;
  /** 自動承認するツール。注意: これは「使えるツールの制限」ではない */
  allowedTools?: string[];
  /** 実際にツールを禁止する唯一の手段。バレ名を渡すとコンテキストから削除される */
  disallowedTools?: string[];
  maxTurns?: number;
  onProgress?: (line: string) => void;
}

/**
 * 解析エージェントに絶対に渡さないツール。
 *
 * `allowedTools` は自動承認リストであって制限ではなく、`bypassPermissions` と
 * 組み合わせると全ツールが使えてしまう。実際に禁止できるのは `disallowedTools` だけ。
 *
 * - 書き込み系: 解析対象リポジトリを書き換えさせない
 * - ネットワーク系: 顧客のソースコードを外部に送信させない
 */
export const READ_ONLY_DENY_LIST = [
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
] as const;

/**
 * Claude Agent SDK を1往復動かして最終テキストを返す。
 *
 * 認証は Agent SDK に任せている（ANTHROPIC_API_KEY があればそれを、
 * なければ Claude Code のログイン情報を使う）。
 * Messages API を直接叩かないので、API クレジットがなくても動く。
 */
export async function runAgent(options: RunAgentOptions): Promise<string> {
  const stream = query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd ?? process.cwd(),
      model: options.model,
      systemPrompt: options.systemPrompt,
      allowedTools: options.allowedTools ?? [],
      disallowedTools: options.disallowedTools ?? [...READ_ONLY_DENY_LIST],
      permissionMode: "bypassPermissions",
      maxTurns: options.maxTurns ?? 60,
      // 解析対象リポジトリの CLAUDE.md や設定に引きずられないようにする
      settingSources: [],
    },
  });

  let resultText: string | null = null;

  for await (const message of stream) {
    const m = message as { type: string; [k: string]: unknown };

    if (m.type === "assistant" && options.onProgress) {
      const content = (m.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const block of content as Array<{ type: string; name?: string }>) {
        if (block.type === "tool_use" && block.name) options.onProgress(`  ↳ ${block.name}`);
      }
    }

    if (m.type === "result") {
      if (m.subtype !== "success") {
        throw new Error(`エージェントが失敗しました: ${String(m.subtype)}`);
      }
      resultText = String(m.result ?? "");
    }
  }

  if (resultText === null) {
    throw new Error("エージェントが result メッセージを返しませんでした");
  }
  return resultText;
}

/** エージェントの最終テキストから JSON を取り出す */
export function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const candidate = fenced.at(-1)?.[1];
  if (candidate) return JSON.parse(candidate);

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("エージェントの出力から JSON を取り出せませんでした");
  }
  return JSON.parse(text.slice(start, end + 1));
}
