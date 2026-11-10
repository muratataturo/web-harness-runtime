import { pageArtifact, type PageArtifact } from "./artifacts.js";
import {
  ProgressDecoder,
  researchProgress,
  type ResearchProgress,
} from "./progress.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.js";
import {
  configuredRuntime,
  runtimeTarget,
  type RuntimeExecutor,
} from "./executors.js";
import { agentEngine, type AgentEngine } from "./codex.js";
import { interactionMode, type InteractionMode } from "./interaction.js";
import {
  routeSources,
  allowedHosts,
  checkNavigation,
  entityKey,
} from "./sources.js";
import {
  improveTask,
  decideImprovement,
  type ImprovementLoop,
} from "./improvement.js";
import type { Task } from "./types.js";
import { roomConflicts } from "./improvement-conflicts.js";
const listingReview = (t: Task) => {
  const found = roomConflicts({
    ...t,
    pages: t.pages.filter((p) => typeof p.text === "string"),
  });
  return found.stationConflicts.size
    ? [
        "同一住居の掲載間で駅徒歩の記載が一致していません。徒歩条件は未確認として扱ってください: " +
          [...found.stationConflicts.keys()].join(", "),
      ]
    : [];
};
export interface RunInput {
  query: string;
  urls: string[];
  agent?: AgentEngine;
  model?: string;
  mode?: InteractionMode;
  source?: "live" | "replay";
  example?: "day-out" | "life-plan" | "books";
  confirmLive?: boolean;
}
export interface RunGate {
  id: string;
  kind: "direction" | "result";
  title: string;
  reason: string;
  choices: {
    id: string;
    title: string;
    tradeoff: string;
    recommended?: boolean;
  }[];
}
export interface RunRecord {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  updateSeq?: number;
  status:
    | "needs_input"
    | "running"
    | "succeeded"
    | "completed_partial"
    | "failed"
    | "cancelled"
    | "interrupted";
  input: RunInput;
  target: string;
  phase: string;
  gate?: RunGate;
  decisions: {
    gateId: string;
    choiceId: string;
    decidedBy: "user" | "runtime";
    at: string;
    additionalUrls?: string[];
  }[];
  progress: string[];
  activities?: ResearchProgress[];
  artifacts?: PageArtifact[];
  taskId?: string;
  task?: Task;
  loop?: ImprovementLoop;
  error?: string;
  reviewWarnings?: string[];
}
const summaryTask = (t: Task): Task => ({
  ...t,
  pages: t.pages.map((p) => ({ ...p, text: "", links: [] })),
});
export function runtimeCapabilities() {
  return {
    version: "0.3.0",
    interfaces: ["cli", "mcp-stdio", "local-chat"],
    executor: runtimeTarget(),
    defaultAgent: agentEngine(),
    engines: ["codex", "claude-code", "pi-openrouter", "opencode"].map(
      (agent) => ({
        agent,
        local: true,
        openshell: agent === "codex" || agent === "pi-openrouter",
      }),
    ),
    modes: ["auto", "approval"],
    mcpProtocol: "2025-11-25",
    liveCosts:
      "Subscription/GPU/VM allocation unknown; no paid provider fallback",
    sourcePolicy:
      "Public pages only. Access denial and retired listings stop retrieval.",
  };
}
export class RunService {
  private runs = new Map<string, RunRecord>();
  private listeners = new Map<string, Set<(record: RunRecord) => void>>();
  subscribe(id: string, fn: (record: RunRecord) => void) {
    const group = this.listeners.get(id) ?? new Set();
    group.add(fn);
    this.listeners.set(id, group);
    return () => {
      group.delete(fn);
      if (!group.size) this.listeners.delete(id);
    };
  }
  private activity(r: RunRecord, event: Omit<ResearchProgress, "seq">) {
    r.activities = [
      ...(r.activities ?? []),
      { ...event, seq: (r.activities?.at(-1)?.seq ?? 0) + 1 },
    ].slice(-80);
    r.phase = event.title;
    if (event.artifact)
      r.artifacts = [
        ...(r.artifacts ?? []).filter((a) => a.id !== event.artifact!.id),
        event.artifact,
      ].slice(-80);
  }
  private progressSink(r: RunRecord) {
    const decoder = new ProgressDecoder((event) => this.activity(r, event));
    return (message: string) => {
      decoder.push(message);
      if (message.startsWith("Codex account-worker"))
        this.activity(
          r,
          researchProgress("prepare", "active", { pages: 0, evidence: 0 }),
        );
      r.progress = [...r.progress, message.slice(-600)].slice(-40);
      void this.save(r).catch(() => {});
    };
  }

  private active = new Map<string, AbortController>();
  private writes = new Map<string, Promise<void>>();
  private pending = new Set<Promise<unknown>>();
  constructor(
    readonly store = new Store(),
    private runtime: RuntimeExecutor = configuredRuntime(),
  ) {}
  private file(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error("不正な相談ID");
    return join(this.store.root, "runs", id + ".json");
  }
  private async save(r: RunRecord) {
    r.updateSeq = (r.updateSeq ?? 0) + 1;
    r.updatedAt = new Date().toISOString();
    this.runs.set(r.id, r);
    const contents = JSON.stringify(r, null, 2);
    const write = (this.writes.get(r.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(join(this.store.root, "runs"), {
          recursive: true,
          mode: 0o700,
        });
        const tmp = this.file(r.id) + "." + randomUUID() + ".tmp";
        await writeFile(tmp, contents, { mode: 0o600 });
        await rename(tmp, this.file(r.id));
      });
    this.writes.set(r.id, write);
    await write;
    if (this.listeners.has(r.id)) {
      const snapshot = JSON.parse(contents) as RunRecord;
      for (const fn of this.listeners.get(r.id)!) fn(snapshot);
    }
  }
  async get(id: string) {
    await this.writes.get(id);
    if (this.runs.has(id)) return structuredClone(this.runs.get(id)!);
    const r = JSON.parse(await readFile(this.file(id), "utf8")) as RunRecord;
    if (r.taskId && r.reviewWarnings === undefined) {
      const full = await this.store.get(r.taskId).catch(() => undefined);
      r.reviewWarnings = full
        ? listingReview(full)
        : (r.task?.reviewWarnings ?? []);
    }
    if (r.task && r.artifacts === undefined) {
      const full = await this.store.get(r.task.id).catch(() => r.task!);
      r.artifacts = full.pages.map((p, i) => pageArtifact(full, p, i));
    }
    if (r.status === "running") {
      r.status = "interrupted";
      r.phase = "プロセス再起動により中断。自動再送しません";
      await this.save(r);
    }
    this.runs.set(id, r);
    return r;
  }
  async artifact(id: string, artifactId: string) {
    const r = await this.get(id);
    const a = r.artifacts?.find((a) => a.id === artifactId);
    if (!a)
      throw Object.assign(Error("成果物が見つかりません"), { code: "ENOENT" });
    const full = await this.store.get(a.taskId).catch(() => undefined);
    const page = full?.pages.find((p) =>
      a.pageId ? p.id === a.pageId : p.url === a.url,
    );
    return {
      ...a,
      body: page?.text || a.preview,
      excerptOnly: !page?.text,
      quotes: (full?.evidence ?? r.task?.evidence ?? []).filter(
        (e) => e.url === a.url,
      ),
      source: r.input.source,
    };
  }
  async list() {
    const names = await readdir(join(this.store.root, "runs")).catch(() => []);
    const rs = await Promise.all(
      names
        .filter((n) => /^[a-zA-Z0-9-]+\.json$/.test(n))
        .map((n) => this.get(n.slice(0, -5))),
    );
    return rs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async create(input: RunInput) {
    const agent = agentEngine(input.agent),
      mode = interactionMode(input.mode);
    if (
      typeof input.query !== "string" ||
      !input.query.trim() ||
      Buffer.byteLength(input.query) > 16000 ||
      !Array.isArray(input.urls) ||
      !input.urls.length ||
      input.urls.length > 12
    )
      throw Error("質問と1〜12件の公開URLが必要です");
    routeSources(input.query, input.urls);
    if (input.source && !["live", "replay"].includes(input.source))
      throw Error("不正な実行データ設定");
    const source = input.source ?? "live";
    if (source === "live" && input.confirmLive !== true)
      throw Error("実調査による利用枠の使用を明示してください");
    if (
      input.example &&
      !["day-out", "life-plan", "books"].includes(input.example)
    )
      throw Error("不明な実測例");
    if (
      source === "live" &&
      runtimeTarget() === "openshell" &&
      !["codex", "pi-openrouter"].includes(agent)
    )
      throw Error(
        "このエンジンのVM実行は未対応です。実行先を明示してlocalで利用してください",
      );
    const at = new Date().toISOString();
    const r: RunRecord = {
      id: randomUUID(),
      revision: 1,
      createdAt: at,
      updatedAt: at,
      status: "needs_input",
      input: {
        query: input.query.trim(),
        urls: input.urls,
        agent,
        model: input.model,
        mode,
        source,
        example: input.example ?? "day-out",
      },
      target: source === "replay" ? "recorded-result" : runtimeTarget(),
      phase: "方針を選ぶ",
      decisions: [],
      progress: [],
    };
    r.gate = {
      id: randomUUID(),
      kind: "direction",
      title: "何をいちばん大切にしますか？",
      reason:
        source === "replay"
          ? "保存済みの実測で、選択・再開の操作を体験します。選択しても当時の回答を再生成しません。新しく調べる場合は実調査を選んでください。"
          : "調査を始める前に、優先することを1つ選べます。",
      choices: [
        {
          id: "balance",
          title: "余白と予算を大切に",
          tradeoff: "候補を詰め込まず、未確認の費用に余裕を残します。",
          recommended: true,
        },
        {
          id: "experience",
          title: "体験・こだわりを優先",
          tradeoff: "特徴を優先し、移動や費用が増える場合は明記します。",
        },
      ],
    };
    await this.save(r);
    if (mode === "auto")
      await this.decide(
        r.id,
        { gateId: r.gate.id, revision: 1, choiceId: "balance" },
        "runtime",
      );
    return this.get(r.id);
  }
  private background(
    r: RunRecord,
    action: (signal: AbortSignal) => Promise<void>,
  ) {
    const c = new AbortController();
    this.active.set(r.id, c);
    const p = (async () => {
      try {
        await action(c.signal);
      } catch (e) {
        r.status = c.signal.aborted ? "cancelled" : "failed";
        r.phase = "調査を終了しました";
        r.error = e instanceof Error ? e.message : "実行失敗";
        delete r.gate;
        await this.save(r);
      } finally {
        this.active.delete(r.id);
      }
    })();
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }
  private async replay(r: RunRecord) {
    const path =
      r.input.example === "books"
        ? new URL("../docs/evidence/codex-strata.json", import.meta.url)
        : new URL("../docs/evidence/delivery-results.json", import.meta.url);
    const data = JSON.parse(await readFile(path, "utf8"));
    const t =
      r.input.example === "books"
        ? data.codexApproval.task
        : r.input.example === "life-plan"
          ? data.lifePlan
          : data.dayOut;
    return { ...t, pages: t.pages ?? [] } as Task;
  }
  private async finish(r: RunRecord, t: Task, signal: AbortSignal) {
    signal.throwIfAborted();
    if (r.input.source === "live")
      this.activity(
        r,
        researchProgress("finish_task", t.answer ? "done" : "error", {
          pages: t.pages.length,
          evidence: t.evidence.length,
          step: t.steps,
        }),
      );
    r.taskId = t.id;
    r.task = summaryTask(t);
    const full =
      r.input.source === "replay"
        ? await this.store.get(t.id).catch(() => t)
        : t;
    const captured = full.pages.map((p, i) => pageArtifact(full, p, i));
    r.artifacts = [
      ...captured,
      ...(r.artifacts ?? []).filter(
        (a) =>
          a.state === "unavailable" &&
          !captured.some((p) => p.id === a.id || p.url === a.url),
      ),
    ];
    r.reviewWarnings = t.reviewWarnings ?? listingReview(t);
    if (!t.answer) {
      r.status = t.status === "cancelled" ? "cancelled" : "failed";
      r.error = t.error ?? "回答を取得できませんでした";
      r.phase = "調査が完了しませんでした";
      await this.save(r);
      return;
    }
    r.phase = "回答が届きました";
    if (t.status === "succeeded") {
      r.status = "succeeded";
      await this.save(r);
      return;
    }
    if (r.input.mode === "auto") {
      r.status = "completed_partial";
      r.progress.push("未確認を保持して返却しました。承認待ちはありません。");
      await this.save(r);
      return;
    }
    if (
      r.input.source === "live" &&
      t.criteria.length &&
      t.answer.candidates.length
    ) {
      try {
        r.loop = await improveTask(
          t.id,
          {
            diagnoseOnly: true,
            interactionMode: "approval",
            maxIterations: 1,
            timeoutSeconds: 180,
          },
          this.store,
        );
      } catch {
        /* still offer partial acceptance when there is no improvable entity */
      }
    }
    r.status = "needs_input";
    r.gate = {
      id: r.loop?.approval?.id ?? randomUUID(),
      kind: "result",
      title: r.loop?.approval?.title ?? "未確認の部分があります",
      reason:
        r.loop?.approval?.reason ?? t.answer.limitations.slice(0, 2).join("\n"),
      choices: [
        {
          id: "return_partial",
          title: "未確認を明記して受け取る",
          tradeoff: "追加の推論は行いません。",
          recommended: true,
        },
        ...(r.input.source === "live" && r.loop?.approval?.status === "pending"
          ? [
              {
                id: "research_more",
                title: "同じ条件でもう一度調べる",
                tradeoff: "最大1回・180秒の追加調査。利用枠を追加で使います。",
              },
              {
                id: "add_url",
                title: "公式URLを追加して調べる",
                tradeoff: "同一候補の公開URLを指定して追加調査します。",
              },
            ]
          : []),
      ],
    };
    await this.save(r);
  }
  async decide(
    id: string,
    input: {
      gateId: string;
      revision: number;
      choiceId: string;
      additionalUrls?: string[];
    },
    by: "user" | "runtime" = "user",
  ) {
    await this.get(id);
    const r =
      this.runs.get(id) ?? JSON.parse(await readFile(this.file(id), "utf8"));
    this.runs.set(id, r);
    const previous = r.decisions.find((d: any) => d.gateId === input.gateId);
    if (previous?.choiceId === input.choiceId) {
      if (
        JSON.stringify(previous.additionalUrls ?? []) !==
        JSON.stringify(input.additionalUrls ?? [])
      )
        throw Error("確定済みの選択のURLを変更できません");
      return structuredClone(r);
    }
    if (
      r.status !== "needs_input" ||
      r.gate?.id !== input.gateId ||
      r.revision !== input.revision
    )
      throw Error(
        "古い、または確定済みの選択です。最新の状態を取得してください",
      );
    const gate = r.gate;
    if (!gate.choices.some((c: any) => c.id === input.choiceId))
      throw Error("不正な選択肢です");
    if (
      input.choiceId === "add_url" &&
      (!Array.isArray(input.additionalUrls) || !input.additionalUrls.length)
    )
      throw Error("追加する公式URLが必要です");
    if (input.choiceId === "add_url") {
      if (input.additionalUrls!.length > 8) throw Error("追加URLは8件までです");
      for (const url of input.additionalUrls!) {
        checkNavigation(
          url,
          allowedHosts(routeSources(r.input.query, r.input.urls)),
        );
        if (
          !r.loop?.candidateUrls.some(
            (candidate: string) => entityKey(candidate) === entityKey(url),
          )
        )
          throw Error("追加URLは同一候補の公開詳細に限ります");
      }
    } else if (input.additionalUrls?.length)
      throw Error("URL追加を選んだ場合だけURLを指定できます");
    r.decisions.push({
      gateId: gate.id,
      choiceId: input.choiceId,
      decidedBy: by,
      at: new Date().toISOString(),
      ...(input.additionalUrls?.length
        ? { additionalUrls: input.additionalUrls }
        : {}),
    });
    r.revision++;
    delete r.gate;
    if (gate.kind === "direction") {
      r.status = "running";
      r.phase =
        r.input.source === "replay"
          ? "保存済み実測を読み込み中"
          : "公開ページを調べています";
      await this.save(r);
      this.background(r, async (signal) => {
        const t =
          r.input.source === "replay"
            ? await this.replay(r)
            : await this.runtime(
                {
                  agent: r.input.agent,
                  model: r.input.model,
                  query:
                    r.input.query +
                    "\n優先方針：" +
                    gate.choices.find((c: any) => c.id === input.choiceId)!
                      .title,
                  urls: r.input.urls,
                  interactionMode: r.input.mode,
                  maxSteps: 90,
                  maxPages: 12,
                  timeoutSeconds: 240,
                  deepenRounds: 1,
                  signal,
                  onProgress: this.progressSink(r),
                },
                this.store,
              );
        await this.finish(r, t, signal);
      });
    } else if (input.choiceId === "return_partial") {
      if (r.loop?.approval?.status === "pending")
        r.loop = await decideImprovement(
          r.loop.id,
          { approvalId: gate.id, choiceId: "return_partial" },
          this.store,
        );
      r.status = "completed_partial";
      r.phase = "未確認を明記して受け取りました";
      await this.save(r);
    } else {
      r.status = "running";
      r.phase = "同じ条件で追加調査しています";
      await this.save(r);
      this.background(r, async (signal) => {
        const loop = await decideImprovement(
          r.loop!.id,
          {
            approvalId: gate.id,
            choiceId: input.choiceId,
            additionalUrls: input.additionalUrls,
          },
          this.store,
          (options, store) =>
            this.runtime(
              { ...options, signal, onProgress: this.progressSink(r) },
              store,
            ),
        );
        r.loop = loop;
        await this.finish(r, await this.store.get(loop.bestTaskId), signal);
      });
    }
    return this.get(id);
  }
  async cancel(id: string) {
    await this.get(id);
    const r = this.runs.get(id)!;
    this.active.get(id)?.abort();
    r.status = "cancelled";
    r.phase = "停止しました";
    delete r.gate;
    await this.save(r);
    return this.get(id);
  }
  async shutdown() {
    for (const c of this.active.values()) c.abort();
    await Promise.allSettled([...this.pending]);
  }
}
