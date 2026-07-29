import type { FeatureDoc } from "@spec-bridge/core";

/**
 * 読み込んだ機能ドキュメントからサンプル質問を組み立てる。
 *
 * ここをハードコードすると特定プロダクト専用の画面になってしまうので、
 * ドキュメントの中身（タイトル・用語の別名）からテンプレートで生成する。
 */
export function buildSampleQuestions(docs: FeatureDoc[], limit = 4): string[] {
  const questions: string[] = [];

  for (const doc of docs) {
    const title = doc.body.title;

    // 1) 仕様どおりかバグかを判定させる、CS で最も多い形の質問
    questions.push(
      `お客様から「${title}が説明どおりに動かない」と問い合わせがありました。仕様ですか、バグですか？`,
    );

    // 2) 用語表に別名があれば、顧客が使う言葉で聞く質問（用語の揺れを吸収できるかの確認になる）
    const alias = doc.body.glossary.flatMap((g) => g.aliases).find(Boolean);
    if (alias) {
      questions.push(`お客様が「${alias}」と呼んでいる機能について、現在の仕様を教えてください。`);
    }

    // 3) 制限事項があれば、それを踏む質問（「できません」と正しく answer できるかの確認）
    const limitation = doc.body.limitations[0];
    if (limitation) {
      questions.push(`「${limitation}」という認識で合っていますか？お客様に説明したいです。`);
    }
  }

  return questions.slice(0, limit);
}
