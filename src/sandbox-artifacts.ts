import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "./types.js";
import type { RunOptions } from "./runtime.js";
export async function recoverSandboxTask(
  root: string,
  options: RunOptions,
): Promise<Task> {
  async function visit(dir: string, depth = 0): Promise<Task[]> {
    if (depth > 5) return [];
    const tasks: Task[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) tasks.push(...(await visit(path, depth + 1)));
      else if (entry.name === "task.json") {
        const task = JSON.parse(await readFile(path, "utf8")) as Task;
        if (
          task.query === options.query &&
          task.agent === options.agent &&
          /^[a-zA-Z0-9-]+$/.test(task.id) &&
          Array.isArray(task.urls) &&
          task.urls.join("\n") === options.urls.join("\n") &&
          [
            "succeeded",
            "partial",
            "failed",
            "blocked",
            "cancelled",
            "timed_out",
          ].includes(task.status) &&
          [task.pages, task.evidence, task.criteria, task.sources].every(
            Array.isArray,
          )
        )
          tasks.push(task);
      }
    }
    return tasks;
  }
  const tasks = await visit(root);
  if (tasks.length !== 1)
    throw new Error("sandbox成果物を一意に検証できません");
  return tasks[0]!;
}
