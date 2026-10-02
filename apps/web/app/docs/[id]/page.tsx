import { notFound, redirect } from "next/navigation";
import {
  QUESTION_KIND_LABEL,
  QUESTION_KINDS,
  questionsOfKind,
  type SourceRef,
} from "@spec-bridge/core";
import { currentSession } from "@/lib/auth";
import { loadDoc } from "@/lib/docs";
import { docFileUrl, sourceLabel, sourceUrl, STATUS_LABEL } from "@/lib/doc-view";
import { SiteNav } from "../../site-nav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Sources({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
      {sources.map((source, i) => {
        const url = sourceUrl(source);
        const label = sourceLabel(source);
        return url ? (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] underline"
            style={{ color: "var(--muted)" }}
          >
            {label}
          </a>
        ) : (
          <span key={i} className="font-mono text-[11px]" style={{ color: "var(--muted)" }}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * 機能ドキュメント1件。
 *
 * 一覧のカードは要約しか出さないので、**根拠（出典）と、人が確かめるべきこと**をここで見せる。
 * レビュー済にする操作は、いまは docs リポジトリのファイルを直す運用なので、その手順も添える。
 */
export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { id } = await params;
  // 不正な ID は loadDoc が null にする
  const loaded = await loadDoc(id);
  if (!loaded) notFound();

  const { meta, body, changelog } = loaded.doc;
  const status = STATUS_LABEL[meta.status];
  const fileUrl =
    loaded.source.kind === "github" ? docFileUrl(loaded.source.repo, meta.id, loaded.source.ref) : null;

  return (
    <>
      <SiteNav current="ask" login={session.login} />
      <main className="mx-auto max-w-4xl px-6 py-8">
        <a href="/" className="text-xs underline" style={{ color: "var(--muted)" }}>
          ← 仕様の一覧に戻る
        </a>

        <header className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${status.cls}`}>{status.text}</span>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              更新 {meta.updatedAt} · 確度 {Math.round(meta.confidence * 100)}%
            </span>
          </div>
          <h1 className="mt-2 text-2xl font-bold">{body.title}</h1>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
            {body.summary}
          </p>
        </header>

        <div
          className="mt-6 rounded-lg border p-4 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--panel)" }}
        >
          <p>{status.hint}</p>
          {meta.status !== "verified" && (
            <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
              内容を確かめたら、docs リポジトリの{" "}
              {fileUrl ? (
                <a href={fileUrl} target="_blank" rel="noreferrer" className="font-mono underline">
                  features/{meta.id}.md
                </a>
              ) : (
                <code className="font-mono">features/{meta.id}.md</code>
              )}{" "}
              の先頭にある <code className="font-mono">status: draft</code> を{" "}
              <code className="font-mono">status: verified</code> に変えてください。
            </p>
          )}
        </div>

        {body.overview && (
          <Section title="概要">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{body.overview}</p>
          </Section>
        )}

        {body.userBehavior.length > 0 && (
          <Section title="ユーザーから見た振る舞い">
            <Bullets items={body.userBehavior} />
          </Section>
        )}

        {body.rules.length > 0 && (
          <Section title={`仕様の詳細（${body.rules.length}件・出典付き）`}>
            <ul className="space-y-3">
              {body.rules.map((rule, i) => (
                <li key={i} className="text-sm leading-relaxed">
                  {rule.text}
                  <Sources sources={rule.sources} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {body.limitations.length > 0 && (
          <Section title="既知の制限">
            <Bullets items={body.limitations} />
          </Section>
        )}

        {body.openQuestions.length > 0 && (
          <Section title="確認事項">
            <div className="space-y-4">
              {QUESTION_KINDS.map((kind) => {
                const items = questionsOfKind(body.openQuestions, kind);
                if (items.length === 0) return null;
                return (
                  <div key={kind}>
                    <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--muted)" }}>
                      {QUESTION_KIND_LABEL[kind]}（{items.length}件）
                    </h3>
                    <ul className="space-y-2">
                      {items.map((q, i) => (
                        <li key={i} className="text-sm leading-relaxed">
                          {q.question}
                          {q.searched.length > 0 && (
                            <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
                              確認した箇所:{" "}
                              <span className="font-mono">{q.searched.join(", ")}</span>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {changelog.length > 0 && (
          <Section title="変更履歴">
            <ul className="space-y-1 text-sm">
              {changelog.map((entry, i) => (
                <li key={i} className="flex gap-3">
                  <span className="shrink-0 text-xs" style={{ color: "var(--muted)" }}>
                    {entry.date}
                  </span>
                  <span>
                    {entry.summary}
                    {entry.pr && (
                      <span className="ml-2 text-xs" style={{ color: "var(--muted)" }}>
                        {entry.pr}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </main>
    </>
  );
}
