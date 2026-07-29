## 変更内容

<!-- 何を、なぜ変えたか -->

## 不変条件の確認

このプロジェクトが守っている不変条件（詳細は [CONTRIBUTING.md](../CONTRIBUTING.md)）を壊していないか確認してください。

- [ ] 出典のない記述がドキュメントに出る余地を作っていない
- [ ] 「わからない」と言える挙動（`verdict: "unknown"` / `openQuestions`）を壊していない
- [ ] Markdown 生成の決定論性を壊していない
- [ ] 解析エージェントに書き込み・ネットワーク系ツールを渡していない
      （`allowedTools` は制限ではありません。`disallowedTools` を確認してください）

## 確認したこと

- [ ] `pnpm test` が通る
- [ ] `pnpm typecheck` が通る
- [ ] スキーマの緩和を追加した場合、`types.test.ts` にケースを足した

## プロンプトを変更した場合

変更前後で生成されたドキュメントの差分を貼ってください。機密は伏せて構いません。

<details>
<summary>変更前</summary>

</details>

<details>
<summary>変更後</summary>

</details>
