import {
  mkdir,
  writeFile,
  rename,
  appendFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "./types.js";
export class Store {
  root: string;
  constructor(root = process.env.RUNTIME_DIR ?? ".runtime") {
    this.root = resolve(root);
  }
  dir(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("不正なタスク ID");
    return join(this.root, "tasks", id);
  }
  async save(task: Task) {
    task.updatedAt = new Date().toISOString();
    const dir = this.dir(task.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `task-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(task, null, 2), { mode: 0o600 });
    await rename(temporary, join(dir, "task.json"));
  }
  async event(id: string, type: string, data: unknown = {}) {
    await appendFile(
      join(this.dir(id), "events.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), type, data }) + "\n",
      { mode: 0o600 },
    );
  }
  async get(id: string): Promise<Task> {
    return JSON.parse(await readFile(join(this.dir(id), "task.json"), "utf8"));
  }
  async list(): Promise<Task[]> {
    let entries: string[];
    try {
      entries = await readdir(join(this.root, "tasks"));
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const tasks = await Promise.all(
      entries.map((id) => this.get(id).catch(() => undefined)),
    );
    return tasks
      .filter((t): t is Task => !!t)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
