export interface ConcurrencyOptions<T> {
  /** 同時に走らせる数 */
  limit: number;
  /**
   * これが true を返したら、**まだ始めていない仕事を始めない。**
   * 予算の打ち切りに使う（走っているものは最後まで走らせる）。
   */
  shouldStop?: () => boolean;
  /** 始める前に呼ばれる。ログの都合で使う */
  onStart?: (item: T, index: number) => void;
}

export interface ConcurrencyResult<T, R> {
  /** 成功したもの（入力の順） */
  completed: Array<{ item: T; index: number; value: R }>;
  /** 失敗したもの（入力の順）。**1件の失敗で他を止めない** */
  failed: Array<{ item: T; index: number; error: unknown }>;
  /** `shouldStop` により始めなかったもの（入力の順） */
  notStarted: T[];
}

/**
 * 順番を保ったまま、同時実行数を絞って走らせる。
 *
 * 機能ごとの解析は互いに独立で、1件あたり4〜5分かかる。直列だと6機能で29分。
 * **並列にしても費用は変わらず、実時間だけ縮む。**
 *
 * - **入力の順に始める。** 分類は影響の大きい順に並べているので、
 *   打ち切るときに落ちるのが末尾になる
 * - **1件の失敗で他を止めない。** 直列のときと同じく、書けたものは残す
 * - `shouldStop` は「まだ始めていない仕事」にだけ効く。走っている途中の処理は止めない
 *   （途中で止めても費用は戻らないし、中途半端な生成物が残る）
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: ConcurrencyOptions<T>,
): Promise<ConcurrencyResult<T, R>> {
  const limit = Math.max(1, Math.floor(options.limit));
  const completed: ConcurrencyResult<T, R>["completed"] = [];
  const failed: ConcurrencyResult<T, R>["failed"] = [];
  const notStarted: T[] = [];

  let next = 0;
  let stopped = false;

  async function pump(): Promise<void> {
    for (;;) {
      if (stopped) return;
      if (options.shouldStop?.()) {
        stopped = true;
        return;
      }
      const index = next;
      if (index >= items.length) return;
      next += 1;

      const item = items[index] as T;
      options.onStart?.(item, index);
      try {
        completed.push({ item, index, value: await worker(item, index) });
      } catch (error) {
        failed.push({ item, index, error });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pump()));

  // 始めなかったものを入力の順で拾う
  const touched = new Set([...completed, ...failed].map((entry) => entry.index));
  for (let index = 0; index < items.length; index += 1) {
    if (!touched.has(index)) notStarted.push(items[index] as T);
  }

  completed.sort((a, b) => a.index - b.index);
  failed.sort((a, b) => a.index - b.index);
  return { completed, failed, notStarted };
}
