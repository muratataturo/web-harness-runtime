/** Host-side bounded DAG scheduler. Each job is one autonomous runtime invocation. */
export type JobStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped";
export interface RoutedJob<T = unknown> {
  id: string;
  agent: string;
  dependsOn: string[];
  run: (context: {
    results: ReadonlyMap<string, T>;
    signal?: AbortSignal;
  }) => Promise<T>;
}
export interface JobResult<T = unknown> {
  id: string;
  agent: string;
  status: JobStatus;
  result?: T;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}
export interface RouterOptions<T = unknown> {
  concurrency: number;
  signal?: AbortSignal;
  onEvent?: (job: JobResult<T>) => void | Promise<void>;
}
export function validateGraph(jobs: Pick<RoutedJob, "id" | "dependsOn">[]) {
  const map = new Map(jobs.map((j) => [j.id, j]));
  if (map.size !== jobs.length || jobs.some((j) => !j.id.trim()))
    throw new Error("タスクIDが空または重複しています");
  const visited = new Set<string>(),
    visiting = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("循環するタスク依存があります");
    const job = map.get(id);
    if (!job) throw new Error(`依存先が存在しません: ${id}`);
    visiting.add(id);
    job.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  jobs.forEach((j) => visit(j.id));
}
export async function routeJobs<T>(
  jobs: RoutedJob<T>[],
  options: RouterOptions<T>,
): Promise<JobResult<T>[]> {
  validateGraph(jobs);
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 8
  )
    throw new Error("並列数は1〜8です");
  const state = new Map<string, JobResult<T>>(
    jobs.map((j) => [j.id, { id: j.id, agent: j.agent, status: "pending" }]),
  );
  const results = new Map<string, T>();
  const active = new Map<string, Promise<void>>();
  const emit = async (s: JobResult<T>) => {
    await options.onEvent?.({ ...s });
  };
  while (
    [...state.values()].some((s) => s.status === "pending") ||
    active.size
  ) {
    for (const job of jobs) {
      const s = state.get(job.id)!;
      if (s.status !== "pending") continue;
      const failed = job.dependsOn.some((id) =>
        ["failed", "skipped"].includes(state.get(id)!.status),
      );
      if (options.signal?.aborted || failed) {
        s.status = "skipped";
        s.error = failed ? "依存タスクが完了しませんでした" : "中断されました";
        s.endedAt = new Date().toISOString();
        await emit(s);
        continue;
      }
      if (
        active.size >= options.concurrency ||
        !job.dependsOn.every((id) => state.get(id)!.status === "succeeded")
      )
        continue;
      s.status = "running";
      s.startedAt = new Date().toISOString();
      await emit(s);
      const running = (async () => {
        try {
          options.signal?.throwIfAborted();
          const result = await job.run({
            results: new Map(results),
            signal: options.signal,
          });
          options.signal?.throwIfAborted();
          s.result = result;
          results.set(job.id, result);
          s.status = "succeeded";
        } catch (e) {
          s.status = "failed";
          s.error = e instanceof Error ? e.message : String(e);
        }
        s.endedAt = new Date().toISOString();
        await emit(s);
      })();
      active.set(job.id, running);
      void running.finally(() => active.delete(job.id)).catch(() => {});
    }
    if (active.size) await Promise.race(active.values());
  }
  return jobs.map((j) => state.get(j.id)!);
}
