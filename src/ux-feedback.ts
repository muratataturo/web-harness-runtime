import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.js";
export interface UxReviewInput {
  exposureMs: number;
  understood: boolean;
  uncertaintyVisible: boolean;
  nextActionClear: boolean;
  appeal: number;
  designVersion: "ten-second-v1";
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
      input.designVersion !== "ten-second-v1"
    )
      throw new Error(
        "10秒レビューの回答が不正です。表示を見てから全項目を選んでください",
      );
    const task = await this.store.get(taskId);
    if (!task.answer || task.evaluation)
      throw new Error("保存された実調査の回答が必要です");
    const record: UxReviewRecord = {
      id: randomUUID(),
      scope: "self-reported-human-ux-review",
      taskId,
      createdAt: new Date().toISOString(),
      exposureMs: input.exposureMs,
      understood: input.understood,
      uncertaintyVisible: input.uncertaintyVisible,
      nextActionClear: input.nextActionClear,
      appeal: input.appeal,
      designVersion: input.designVersion,
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
      result.designVersion !== "ten-second-v1" ||
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
