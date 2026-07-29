import type { FeatureDoc } from "@spec-bridge/core";

/**
 * 読み込んだ機能ドキュメントからサンプル質問を組み立てる。
 *
 * ここをハードコードすると特定プロダクト専用の画面になってしまうので、
 * ドキュメントの中身（振る舞い・用語の別名・制限事項）からテンプレートで生成する。
 *
 * 並び順は意図的。ドキュメントで答えられる質問を先に置き、
 * 「判断できない」になる曖昧な質問は最後に回している
 * （最初の1問が根拠0件だと、この画面が何をするものか伝わらないため）。
 */
export function buildSampleQuestions(docs: FeatureDoc[], limit = 4): string[] {
  const answerable: string[] = [];
  const ambiguous: string[] = [];

  for (const doc of docs) {
    const title = doc.body.title;

    // 1) 具体的な振る舞いの確認。ドキュメントに書いてあるので出典付きで答えられる
    const behavior = doc.body.userBehavior[0];
    if (behavior) {
      answerable.push(
        `お客様に「${behavior.replace(/[。.]$/, "")}」とご案内して問題ないでしょうか？`,
      );
    }

    // 2) 顧客が使う言葉で聞く。用語の揺れを吸収できるかの確認になる
    const alias = doc.body.glossary.flatMap((g) => g.aliases).find(Boolean);
    if (alias) {
      answerable.push(`お客様が「${alias}」と呼んでいる機能について、現在の仕様を教えてください。`);
    }

    // 3) 制限事項。「できません」と正しく答えられるかの確認
    const limitation = doc.body.limitations[0];
    if (limitation) {
      answerable.push(
        `「${limitation.replace(/[。.]$/, "")}」という認識で合っていますか？お客様に説明したいです。`,
      );
    }

    // 4) 曖昧な問い合わせ。根拠がないので「判断できない」になるのが正しい挙動
    ambiguous.push(
      `お客様から「${title}が説明どおりに動かない」と問い合わせがありました。仕様ですか、バグですか？`,
    );
  }

  return [...answerable, ...ambiguous].slice(0, limit);
}
