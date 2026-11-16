import { proposalRevision } from "./proposals.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.js";
export interface UxReviewInput {
  exposureMs: number;
  understood: boolean;
  uncertaintyVisible: boolean;
  nextActionClear: boolean;
  appeal: number;
  designVersion: "ten-second-v1" | "ten-second-v2";
  reviewerId?: string;
  artifactRevision?: string;
  proposalId?: string;
  issues?: (
    | "too_dense"
    | "unclear_difference"
    | "not_for_me"
    | "unrealistic"
    | "hard_to_read"
  )[];
}
interface UxReviewRecord extends UxReviewInput {
  id?: string;
  scope: "self-reported-human-ux-review";
  taskId: string;
  createdAt: string;
  passed: boolean;
}
export class UxFeedbackStore {
  constructor(private store = new Store()) {}
  async add(taskId: string, input: UxReviewInput) {
    if (
      !input ||
      !Number.isFinite(input.exposureMs) ||
      input.exposureMs < 9000 ||
      input.exposureMs > 30000 ||
      ![
        input.understood,
        input.uncertaintyVisible,
        input.nextActionClear,
      ].every((v) => typeof v === "boolean") ||
      !Number.isInteger(input.appeal) ||
      input.appeal < 1 ||
      input.appeal > 5 ||
      !["ten-second-v1", "ten-second-v2"].includes(input.designVersion)
    )
      throw new Error(
        "10秒レビューの回答が不正です。表示を見てから全項目を選んでください",
      );
    const task = await this.store.get(taskId);
    if (!task.answer || task.evaluation)
      throw new Error("保存された実調査の回答が必要です");
    if (input.designVersion === "ten-second-v2") {
      if (
        input.exposureMs < 10000 ||
        !/^[a-zA-Z0-9-]{8,80}$/.test(input.reviewerId ?? "") ||
        input.artifactRevision !== proposalRevision(task) ||
        !task.answer.visualArtifact?.proposalSet?.options.some(
          (o) => o.id === input.proposalId,
        )
      )
        throw Error("評価対象の版・案・10秒の表示時間を確認してください");
      if (
        input.issues &&
        (!Array.isArray(input.issues) ||
          input.issues.length > 5 ||
          new Set(input.issues).size !== input.issues.length ||
          input.issues.some(
            (x) =>
              ![
                "too_dense",
                "unclear_difference",
                "not_for_me",
                "unrealistic",
                "hard_to_read",
              ].includes(x),
          ))
      )
        throw Error("UX改善点の指定が不正です");
    }
    const record: UxReviewRecord = {
      id:
        input.designVersion === "ten-second-v2"
          ? createHash("sha256")
              .update(
                [
                  input.reviewerId,
                  input.artifactRevision,
                  input.proposalId,
                ].join(":"),
              )
              .digest("hex")
          : randomUUID(),
      scope: "self-reported-human-ux-review",
      taskId,
      createdAt: new Date().toISOString(),
      exposureMs: input.exposureMs,
      understood: input.understood,
      uncertaintyVisible: input.uncertaintyVisible,
      nextActionClear: input.nextActionClear,
      appeal: input.appeal,
      designVersion: input.designVersion,
      ...(input.designVersion === "ten-second-v2"
        ? {
            reviewerId: input.reviewerId,
            artifactRevision: input.artifactRevision,
            proposalId: input.proposalId,
            issues: input.issues ?? [],
          }
        : {}),
      passed:
        input.understood &&
        input.uncertaintyVisible &&
        input.nextActionClear &&
        input.appeal >= 4,
    };
    const root = join(this.store.root, "ux-feedback");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, taskId + "-" + record.id + ".json"),
      temp = path + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(temp, path);
    return record;
  }
  private validate(result: any, file: string): UxReviewRecord {
    this.store.dir(result.taskId);
    if (
      result.scope !== "self-reported-human-ux-review" ||
      (file !== result.taskId + ".json" &&
        file !== result.taskId + "-" + result.id + ".json") ||
      !["ten-second-v1", "ten-second-v2"].includes(result.designVersion) ||
      !Number.isFinite(result.exposureMs) ||
      result.exposureMs < 9000 ||
      result.exposureMs > 30000 ||
      ![
        result.understood,
        result.uncertaintyVisible,
        result.nextActionClear,
      ].every((v) => typeof v === "boolean") ||
      !Number.isInteger(result.appeal) ||
      result.appeal < 1 ||
      result.appeal > 5
    )
      throw new Error("保存されたUX評価が不正です");
    if (
      result.designVersion === "ten-second-v2" &&
      (result.exposureMs < 10000 ||
        !/^[a-zA-Z0-9-]{8,80}$/.test(result.reviewerId ?? "") ||
        !/^[a-f0-9]{64}$/.test(result.artifactRevision ?? "") ||
        typeof result.proposalId !== "string" ||
        !Array.isArray(result.issues) ||
        result.issues.some(
          (x: string) =>
            ![
              "too_dense",
              "unclear_difference",
              "not_for_me",
              "unrealistic",
              "hard_to_read",
            ].includes(x),
        ))
    )
      throw Error("保存された比較UX評価が不正です");
    return result as UxReviewRecord;
  }
  private async records() {
    let files: string[];
    try {
      files = await readdir(join(this.store.root, "ux-feedback"));
    } catch (error: any) {
      if (error.code === "ENOENT") files = [];
      else throw error;
    }
    const reviews: UxReviewRecord[] = [];
    for (const name of files.filter((n) => n.endsWith(".json"))) {
      const r = this.validate(
        JSON.parse(
          await readFile(join(this.store.root, "ux-feedback", name), "utf8"),
        ),
        name,
      );
      const task = await this.store.get(r.taskId).catch(() => undefined);
      if (task?.answer && !task.evaluation) reviews.push(r);
    }
    return reviews;
  }
  async get(taskId: string) {
    this.store.dir(taskId);
    const record = (await this.records())
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!record)
      throw Object.assign(new Error("UXレビューがありません"), {
        code: "ENOENT",
      });
    return record;
  }
  async learningContext(taskId: string) {
    const task = await this.store.get(taskId),
      revision = proposalRevision(task);
    const all = (await this.records())
      .filter(
        (r) =>
          r.taskId === taskId &&
          r.designVersion === "ten-second-v2" &&
          r.artifactRevision === revision,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const seen = new Set<string>(),
      reviews = all.filter((r) => {
        const key = r.reviewerId + ":" + r.proposalId;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const median = (values: number[]) => {
      const a = values.sort((a, b) => a - b);
      return a.length
        ? (a[Math.floor((a.length - 1) / 2)]! + a[Math.floor(a.length / 2)]!) /
            2
        : null;
    };
    const issues = Object.fromEntries(
      [
        "too_dense",
        "unclear_difference",
        "not_for_me",
        "unrealistic",
        "hard_to_read",
      ].map((k) => [
        k,
        reviews.filter((r) => r.issues?.includes(k as any)).length,
      ]),
    );
    const guidance = [
      ...(issues.too_dense || reviews.some((r) => r.appeal < 4)
        ? ["比較表の情報量を減らし、行動と違いを先に示す"]
        : []),
      ...(issues.unclear_difference || reviews.some((r) => !r.understood)
        ? ["案ごとの操作と残る成果を明確に変える"]
        : []),
      ...(issues.not_for_me
        ? ["入力条件に合う理由と不向きな条件を具体化する"]
        : []),
      ...(issues.unrealistic ? ["元の時間枠・費用・移動条件を再点検する"] : []),
      ...(issues.hard_to_read
        ? ["文字階層・コントラスト・モバイル表示を再検査する"]
        : []),
      ...(reviews.some((r) => !r.uncertaintyVisible)
        ? ["重要な未確認事項を選択理由の近くに示す"]
        : []),
      ...(reviews.some((r) => !r.nextActionClear)
        ? ["次にする操作と小さな完了条件を先に示す"]
        : []),
    ];
    return {
      scope: "self-reported-human-ux-review" as const,
      sourceTaskId: taskId,
      artifactRevision: revision,
      responses: reviews.length,
      uniqueBrowserReviewers: new Set(reviews.map((r) => r.reviewerId)).size,
      independentHumansVerified: false,
      humanAppealStatus: reviews.length ? "self-reported-only" : "unrated",
      issues,
      guidance,
      variants: (task.answer?.visualArtifact?.proposalSet?.options ?? []).map(
        (o) => ({
          proposalId: o.id,
          theme: o.theme,
          responses: reviews.filter((r) => r.proposalId === o.id).length,
          medianAppeal: median(
            reviews.filter((r) => r.proposalId === o.id).map((r) => r.appeal),
          ),
        }),
      ),
      note: "同じ版・ブラウザ識別子・案の最新回答だけを使用。本人性・独立した人間の人数は未検証。新しい生成物の評価点として転用しない。",
    };
  }
  async summary() {
    const reviews = await this.records();
    const standards = JSON.parse(
      await readFile(
        new URL("../config/ux-quality.json", import.meta.url),
        "utf8",
      ),
    ).human;
    const n = reviews.length,
      ratings = reviews.map((r) => r.appeal).sort((a, b) => a - b);
    const median = n
      ? (ratings[Math.floor((n - 1) / 2)]! + ratings[Math.floor(n / 2)]!) / 2
      : null;
    const rate = (
      key: "understood" | "uncertaintyVisible" | "nextActionClear",
    ) => (n ? reviews.filter((r) => r[key] === true).length / n : null);
    const nextSteps =
      n === 0
        ? ["実際の人による10秒レビューを集める。自動検査を人の評価へ計上しない"]
        : [
            ...(rate("understood")! < standards.understoodRate
              ? ["見出しと冒頭の理由を短くし、同じ回答で再評価する"]
              : []),
            ...(rate("uncertaintyVisible")! < standards.uncertaintyVisibleRate
              ? ["重要な未確認を結論の近くへ移し、確認済み情報と区別する"]
              : []),
            ...(rate("nextActionClear")! < standards.nextActionClearRate
              ? ["主要操作を一つ明示し、根拠へ進む導線を再評価する"]
              : []),
            ...(median! < standards.medianAppeal
              ? ["余白・文字の階層・情報密度をスクリーンショットと一緒に見直す"]
              : []),
            "独立したレビュアー数を別途確認し、別の課題でも再評価する",
          ];
    return {
      scope: "self-reported-human-ux-review",
      responses: n,
      unit: "review responses; repeated reviewers are not deduplicated or verified",
      understoodRate: rate("understood"),
      uncertaintyVisibleRate: rate("uncertaintyVisible"),
      nextActionClearRate: rate("nextActionClear"),
      medianAppeal: median,
      humanStudyStatus: "requires-verified-independent-reviewers",
      nextSteps,
      observedResponseTargetsMet:
        n >= standards.minimumReviewers &&
        rate("understood")! >= standards.understoodRate &&
        rate("uncertaintyVisible")! >= standards.uncertaintyVisibleRate &&
        rate("nextActionClear")! >= standards.nextActionClearRate &&
        median! >= standards.medianAppeal,
    };
  }
}
