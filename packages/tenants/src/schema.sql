-- テナント = GitHub App のインストール1つ。
-- 「どのインストールの生成物を、どのリポジトリへ出すか」だけを持つ。
create table if not exists installations (
  installation_id bigint      primary key,
  account         text        not null,
  -- 未設定なら解析しない（提出先の無い解析をさせない）
  docs_repo       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
