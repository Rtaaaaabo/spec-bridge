export const runtime = "nodejs";

/**
 * 死活監視用。**ログインの外側**に置く（`proxy.ts` の matcher から外してある）。
 *
 * DB には触らない。ここで DB を見ると、DB が一時的に落ちたときに
 * プロセスごと入れ替えられてしまう（直るのはプロセスではなく DB のほう）。
 */
export function GET(): Response {
  return Response.json({ ok: true });
}
