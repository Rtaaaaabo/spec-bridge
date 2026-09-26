-- ジョブ表。キューのために Redis を増やさず、1つの表で永続化・再試行・冪等をまかなう。
create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     text        not null,
  kind          text        not null,
  -- 同じ仕事を二度積まないための鍵。webhook の再送・手動 Redeliver で PR が2つできるのを防ぐ
  dedupe_key    text        not null unique,
  payload       jsonb       not null default '{}'::jsonb,
  state         text        not null default 'queued'
                            check (state in ('queued', 'running', 'succeeded', 'failed')),
  attempts      integer     not null default 0,
  max_attempts  integer     not null default 5,
  run_after     timestamptz not null default now(),
  -- running のあいだだけ入る。過ぎたら他のワーカーが取り直してよい（ワーカーが落ちた場合の回収）
  lease_until   timestamptz,
  last_error    text,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 取り出しの索引。queued の順番待ちと、リースが切れた running の回収の両方に効かせる
create index if not exists jobs_claim_idx on jobs (state, run_after);
create index if not exists jobs_lease_idx on jobs (state, lease_until);
