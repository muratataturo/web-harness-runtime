import { mkdir, writeFile, rename, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
export interface AnswerFeedback {
  taskId: string;
  rating: number;
  helpful: boolean;
  candidateUrl?: string;
  note?: string;
  createdAt: string;
  scope: "local-user-answer-feedback";
}
export class FeedbackStore {
  constructor(private store = new Store()) {}
  private path(taskId: string) {
    this.store.dir(taskId);
    return join(this.store.root, "feedback", taskId + ".json");
  }
  async add(
    taskId: string,
    input: {
      rating: number;
      helpful: boolean;
      candidateUrl?: string;
      note?: string;
    },
  ) {
    if (
      !Number.isInteger(input.rating) ||
      input.rating < 1 ||
      input.rating > 5 ||
      typeof input.helpful !== "boolean"
    )
      throw new Error("ratingは1〜5の整数、helpfulはyes/noです");
    if (
      input.note !== undefined &&
      (typeof input.note !== "string" || input.note.length > 500)
    )
      throw new Error("コメントは500字以内です");
    const task = await this.store.get(taskId);
    if (!task.answer || task.evaluation)
      throw new Error(
        "実調査の回答があるタスクのみ評価できます。ベンチマークは別評価です",
      );
    if (
      input.candidateUrl &&
      !task.answer.candidates.some((c) => c.url === input.candidateUrl)
    )
      throw new Error("候補URLは回答内の候補を指定してください");
    const feedback: AnswerFeedback = {
      ...input,
      taskId,
      createdAt: new Date().toISOString(),
      scope: "local-user-answer-feedback",
    };
    const path = this.path(taskId);
    await mkdir(join(this.store.root, "feedback"), {
      recursive: true,
      mode: 0o700,
    });
    const temp = path + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(feedback, null, 2), { mode: 0o600 });
    await rename(temp, path);
    return feedback;
  }
  async list(): Promise<AnswerFeedback[]> {
    let names: string[];
    try {
      names = await readdir(join(this.store.root, "feedback"));
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map(async (name) => {
          const f = JSON.parse(
            await readFile(this.path(name.slice(0, -5)), "utf8"),
          );
          if (
            f.taskId !== name.slice(0, -5) ||
            f.scope !== "local-user-answer-feedback" ||
            !Number.isInteger(f.rating) ||
            f.rating < 1 ||
            f.rating > 5 ||
            typeof f.helpful !== "boolean"
          )
            throw new Error("回答フィードバックの保存データが不正です");
          return f;
        }),
    );
  }
  async summary() {
    const feedback = await this.list(),
      n = feedback.length;
    return {
      scope: "local-user-answer-feedback",
      responses: n,
      uniqueTasks: n,
      meanRating: n ? feedback.reduce((sum, f) => sum + f.rating, 0) / n : null,
      csat4or5: n ? feedback.filter((f) => f.rating >= 4).length / n : null,
      helpfulRate: n ? feedback.filter((f) => f.helpful).length / n : null,
      denominator:
        "回答を評価したタスク数。未回答は除外。同一タスクの再投稿は上書き。全ユーザーの満足度とは異なる",
    };
  }
}
