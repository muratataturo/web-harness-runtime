import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { routeJobs, type RoutedJob, type JobStatus } from "./router.js";
import {
  configuredRuntime,
  runtimeTarget,
  type RuntimeExecutor,
} from "./executors.js";
import { Store } from "./store.js";
import type { Task } from "./types.js";
export type Scenario = "travel" | "life";
export type GoalStatus =
  | "awaiting_direction"
  | "researching"
  | "awaiting_delight"
  | "synthesizing"
  | "completed"
  | "blocked"
  | "cancelled"
  | "interrupted";
export interface Choice {
  id: string;
  title: string;
  description: string;
  tradeoff: string;
  recommended?: boolean;
}
export interface Gate {
  id: string;
  revision: number;
  kind: "direction" | "delight";
  title: string;
  description: string;
  choices: Choice[];
  status: "pending" | "approved" | "expired";
  selected?: string;
  note?: string;
  decidedAt?: string;
  afterMessageId?: string;
}
export interface PeerMessage {
  id: string;
  deliveryKey: string;
  goalId: string;
  taskId?: string;
  revision: number;
  correlationId: string;
  from: string;
  to: string;
  kind:
    | "request"
    | "handoff"
    | "review"
    | "revision"
    | "result"
    | "decision"
    | "user";
  text: string;
  createdAt: string;
  hop: number;
}
export interface Work {
  id: string;
  agent: string;
  title: string;
  source: string;
  url: string;
  dependsOn: string[];
  status: JobStatus;
  round: number;
  runtimeTaskId?: string;
  note?: string;
}
export interface PlanItem {
  day: string;
  time: string;
  title: string;
  description: string;
  category: string;
  source: string;
  url: string;
  price?: string;
  demo: boolean;
}
export interface Goal {
  id: string;
  revision: number;
  scenario: Scenario;
  text: string;
  title: string;
  mode: "demo" | "live";
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  budget: number;
  direction?: string;
  delight?: string;
  note: string;
  messages: PeerMessage[];
  gates: Gate[];
  tasks: Work[];
  plan: PlanItem[];
  highlights: string[];
  limitations: string[];
  activeDay: string;
  concurrency: number;
  executionTarget: "local" | "openshell";
}
const AGENTS = new Set([
  "you",
  "concierge",
  "stay",
  "food",
  "explore",
  "career",
  "home",
  "car",
  "reviewer",
]);
export const scenarioDefaults = {
  travel: {
    title: "箱根で、余白のある3日間",
    text: "2人で箱根に2泊3日。温泉とおいしいごはんを楽しみたい。移動を詰め込みすぎず、予算は8万円。",
    budget: 80000,
  },
  life: {
    title: "暮らしから考える、次の一歩",
    text: "湘南で自然に近い暮らしをしたい。リモート中心の仕事と、駅近の家、週末に使える小さな車を一緒に考えて。",
    budget: 180000,
  },
};
export function directionGate(goal: Goal): Gate {
  const travel = goal.scenario === "travel";
  return {
    id: randomUUID(),
    revision: goal.revision,
    kind: "direction",
    status: "pending",
    title: travel
      ? "今回の旅で、いちばん大切にしたいのは？"
      : "新しい暮らしで、いちばん大切にしたいのは？",
    description: travel
      ? "まずは旅の軸だけ。宿・食事・移動は、チームで調べます。"
      : "仕事・家・車を別々に決めず、ひとつの暮らしとして考えます。",
    choices: travel
      ? [
          {
            id: "relax",
            title: "温泉と、何もしない時間",
            description: "宿で過ごす時間を主役に。観光は1日1〜2か所。",
            tradeoff: "宿に予算を寄せて、移動は少なく",
            recommended: true,
          },
          {
            id: "food",
            title: "おいしい発見を、少しずつ",
            description: "土地の食をめぐり、夕食の自由度を確保。",
            tradeoff: "食事を優先し、宿はシンプルに",
          },
          {
            id: "explore",
            title: "景色も、体験も楽しみたい",
            description: "美術館と自然を組み合わせ、街を歩く旅に。",
            tradeoff: "体験を増やして、宿での時間は短め",
          },
        ]
      : [
          {
            id: "balance",
            title: "時間と、暮らしの余白",
            description: "在宅勤務と駅近を軸に、毎月の固定費を抑える。",
            tradeoff: "車は急がず、まず仕事と家から",
            recommended: true,
          },
          {
            id: "career",
            title: "キャリアの可能性を広げたい",
            description: "仕事の選択肢を先に調べ、住む場所を合わせる。",
            tradeoff: "収入や出社条件が決まってから家を選ぶ",
          },
          {
            id: "nature",
            title: "自然のそばで、週末を楽しむ",
            description: "海や緑への近さと、小さな車のある生活を優先。",
            tradeoff: "駅徒歩より、駐車場と暮らしやすさ",
          },
        ],
  };
}
function delightGate(goal: Goal): Gate {
  const travel = goal.scenario === "travel";
  return {
    id: randomUUID(),
    revision: goal.revision,
    kind: "delight",
    status: "pending",
    title: travel
      ? "ひとつだけ、旅のご褒美を選ぶなら？"
      : "次の一歩は、どこから始めましょう？",
    description: travel
      ? "調査の途中で見つけた、こだわりどころ。選んだ案に合わせて、予定と予算を組み直します。"
      : "まだ契約も応募もしません。納得できる順番を、あなたが選べます。",
    choices: travel
      ? [
          {
            id: "bath",
            title: "露天風呂を、ふたりの時間に",
            description: "貸切風呂のある宿を軸に、初日の夕食は宿で。",
            tradeoff: "観光を1つ減らして、宿に早めに到着",
            recommended: goal.direction === "relax",
          },
          {
            id: "dinner",
            title: "忘れられない夕食を一度",
            description: "2日目の夜を旅のハイライトにするプラン。",
            tradeoff: "夕食代を確保して、宿の部屋は標準に",
            recommended: goal.direction === "food",
          },
          {
            id: "view",
            title: "朝の静かな景色を見に行く",
            description:
              goal.mode === "demo"
                ? "芦ノ湖の朝と、ゆっくり楽しむコーヒー。"
                : "朝の景色と、ゆっくり楽しむコーヒー。",
            tradeoff: "朝だけ少し早起き。前夜は早めに休む",
            recommended: goal.direction === "explore",
          },
        ]
      : [
          {
            id: "job-first",
            title: "仕事の条件を、先に確かめる",
            description: "在宅日数と給与の条件を整理し、応募前に確認。",
            tradeoff: "家や車の契約は、雇用条件が見えてから",
            recommended: true,
          },
          {
            id: "visit-first",
            title: "街の空気を、歩いて確かめる",
            description: "駅から海まで歩き、通勤と生活動線を体験。",
            tradeoff: "休日の1日を使い、判断材料を増やす",
          },
          {
            id: "budget-first",
            title: "毎月の安心を、先に作る",
            description: "家賃・駐車場・車の維持費を並べて上限を決める。",
            tradeoff: "車は購入とカーシェアの両方を比較",
          },
        ],
  };
}
export function peerMessage(
  goal: Goal,
  input: Omit<PeerMessage, "id" | "goalId" | "revision" | "createdAt">,
): PeerMessage | undefined {
  if (!AGENTS.has(input.from) || !AGENTS.has(input.to))
    throw new Error("チームに存在しない宛先です");
  if (!Number.isInteger(input.hop) || input.hop < 0 || input.hop > 8)
    throw new Error("A2A hop 上限です");
  if (!input.correlationId || !input.deliveryKey)
    throw new Error("メッセージの関連IDが必要です");
  if (input.taskId && !goal.tasks.some((t) => t.id === input.taskId))
    throw new Error("別目標のタスクには送信できません");
  if (goal.messages.some((m) => m.deliveryKey === input.deliveryKey)) return;
  const message = {
    ...input,
    id: randomUUID(),
    goalId: goal.id,
    revision: goal.revision,
    createdAt: new Date().toISOString(),
  };
  goal.messages.push(message);
  return message;
}
export class GoalRepository {
  root: string;
  private cache = new Map<string, Goal>();
  private pending = new Map<string, Promise<void>>();
  private loading = new Map<string, Promise<Goal>>();
  constructor(root = process.env.RUNTIME_DIR ?? ".runtime") {
    this.root = resolve(root, "goals");
  }
  file(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("不正な目標ID");
    return join(this.root, id + ".json");
  }
  async save(goal: Goal) {
    goal.updatedAt = new Date().toISOString();
    this.cache.set(goal.id, goal);
    const json = JSON.stringify(goal, null, 2);
    const previous = this.pending.get(goal.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const tmp = this.file(goal.id) + "." + randomUUID() + ".tmp";
        await writeFile(tmp, json, { mode: 0o600 });
        await rename(tmp, this.file(goal.id));
      });
    this.pending.set(goal.id, next);
    await next;
    if (this.pending.get(goal.id) === next) this.pending.delete(goal.id);
  }
  async get(id: string): Promise<Goal> {
    this.file(id);
    const cached = this.cache.get(id);
    if (cached) return cached;
    const existing = this.loading.get(id);
    if (existing) return existing;
    const load = (async () => {
      const goal = JSON.parse(await readFile(this.file(id), "utf8")) as Goal;
      if (["researching", "synthesizing"].includes(goal.status)) {
        goal.status = "interrupted";
        goal.tasks
          .filter((t) => t.status === "running")
          .forEach((t) => {
            t.status = "failed";
            t.note = "プロセス再起動で中断。目標を再計画してください";
          });
      }
      this.cache.set(id, goal);
      return goal;
    })();
    this.loading.set(id, load);
    try {
      return await load;
    } finally {
      this.loading.delete(id);
    }
  }
  async list(): Promise<Goal[]> {
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const results = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.get(f.slice(0, -5))),
    );
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
export class GoalEngine {
  private active = new Map<string, AbortController>();
  private work = new Map<string, Promise<void>>();
  constructor(
    public repo = new GoalRepository(),
    private delayMs = 900,
    private runtime: RuntimeExecutor = configuredRuntime(),
  ) {}
  async settle(id: string): Promise<Goal> {
    await this.work.get(id);
    return this.repo.get(id);
  }
  shutdown() {
    for (const controller of this.active.values()) controller.abort();
  }
  private message(
    goal: Goal,
    from: string,
    text: string,
    kind: PeerMessage["kind"] = "result",
    to = "concierge",
    taskId?: string,
    hop = 0,
  ) {
    peerMessage(goal, {
      from,
      to,
      text,
      kind,
      taskId,
      hop,
      correlationId: `${goal.id}:${goal.revision}`,
      deliveryKey: `${goal.id}:${goal.revision}:${goal.messages.length}:${kind}:${taskId ?? from}`,
    });
  }
  async create(input: {
    scenario: Scenario;
    text?: string;
    mode?: "demo" | "live";
    budget?: number;
  }): Promise<Goal> {
    if (!["travel", "life"].includes(input.scenario))
      throw new Error("旅行または暮らしを選択してください");
    if (input.mode && !["demo", "live"].includes(input.mode))
      throw new Error("不正な実行モードです");
    const def = scenarioDefaults[input.scenario];
    const text = (input.text ?? def.text).trim();
    if (!text || text.length > 3000)
      throw new Error("目標は1〜3000文字で入力してください");
    const budget = input.budget ?? def.budget;
    if (!Number.isInteger(budget) || budget < 10000 || budget > 2000000)
      throw new Error("予算は1万〜200万円で指定してください");
    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID(),
      revision: 1,
      scenario: input.scenario,
      text,
      title: input.mode === "live" ? text.slice(0, 30) : def.title,
      mode: input.mode ?? "demo",
      status: "awaiting_direction",
      createdAt: now,
      updatedAt: now,
      budget,
      note: "",
      messages: [],
      gates: [],
      tasks: [],
      plan: [],
      highlights: [],
      limitations: [],
      activeDay: input.scenario === "travel" ? "1日目" : "仕事",
      concurrency: 2,
      executionTarget: runtimeTarget(),
    };
    this.message(goal, "you", text, "user");
    this.message(
      goal,
      "concierge",
      goal.scenario === "travel"
        ? "いい旅にしましょう。宿・ごはん・寄り道をそれぞれの担当が調べ、移動と予算まで一緒に整えます。まず、旅の主役を教えてください。"
        : "仕事・家・車を、ひとつの暮らしとして考えてみましょう。条件が影響し合うところはチームで確認し、大切な選択はあなたに戻します。",
    );
    goal.gates.push({
      ...directionGate(goal),
      afterMessageId: goal.messages.at(-1)?.id,
    });
    await this.repo.save(goal);
    return goal;
  }
  async decide(
    id: string,
    input: {
      gateId: string;
      revision: number;
      choiceId: string;
      note?: string;
      budget?: number;
    },
  ): Promise<Goal> {
    const goal = await this.repo.get(id);
    const gate = goal.gates.find((g) => g.id === input.gateId);
    if (
      input.revision !== goal.revision ||
      !gate ||
      gate.revision !== goal.revision
    )
      throw new Error("古い選択肢です。最新の提案を開いてください");
    if (gate.status === "approved") {
      if (gate.selected === input.choiceId) return goal;
      throw new Error("この選択は確定済みです。方針の見直しを使ってください");
    }
    if (
      gate.status !== "pending" ||
      !["awaiting_direction", "awaiting_delight"].includes(goal.status)
    )
      throw new Error("現在は選択を確定できません");
    if (!gate.choices.some((c) => c.id === input.choiceId))
      throw new Error("提示された選択肢から選んでください");
    if (input.note !== undefined && typeof input.note !== "string")
      throw new Error("こだわりはテキストで入力してください");
    if (input.note && input.note.length > 1000)
      throw new Error("こだわりは1000文字以内です");
    if (
      input.budget !== undefined &&
      (!Number.isInteger(input.budget) ||
        input.budget < 10000 ||
        input.budget > 2000000)
    )
      throw new Error("予算は1万〜200万円で指定してください");
    gate.status = "approved";
    gate.selected = input.choiceId;
    gate.note = input.note?.trim();
    gate.decidedAt = new Date().toISOString();
    goal.note = [goal.note, input.note?.trim()].filter(Boolean).join(" / ");
    if (input.budget !== undefined) goal.budget = input.budget;
    const title = gate.choices.find((c) => c.id === input.choiceId)!.title;
    this.message(
      goal,
      "you",
      `${title}でお願いします。${input.note?.trim() ? ` こだわり：${input.note.trim()}` : ""}`,
      "decision",
    );
    if (gate.kind === "direction") {
      goal.direction = input.choiceId;
      goal.status = "researching";
    } else {
      goal.delight = input.choiceId;
      goal.status = "synthesizing";
    }
    const revision = goal.revision;
    await this.repo.save(goal);
    if (
      goal.revision !== revision ||
      !["researching", "synthesizing"].includes(goal.status)
    )
      return goal;
    const controller = new AbortController();
    this.active.set(goal.id, controller);
    const running = (
      gate.kind === "direction"
        ? this.research(goal, controller.signal, revision)
        : this.synthesize(goal, controller.signal, revision)
    )
      .catch(async (e) => {
        if (goal.revision !== revision) return;
        if (!controller.signal.aborted) {
          goal.status = "interrupted";
          goal.limitations.push(e instanceof Error ? e.message : String(e));
          await this.repo.save(goal);
        }
      })
      .finally(() => {
        if (this.active.get(goal.id) === controller)
          this.active.delete(goal.id);
        if (this.work.get(goal.id) === running) this.work.delete(goal.id);
      });
    this.work.set(goal.id, running);
    return goal;
  }
  async revise(id: string, text?: string): Promise<Goal> {
    const goal = await this.repo.get(id);
    if (text !== undefined && (!text.trim() || text.length > 3000))
      throw new Error("目標は1〜3000文字です");
    this.active.get(id)?.abort();
    this.active.delete(id);
    goal.revision++;
    goal.gates
      .filter((g) => g.status === "pending")
      .forEach((g) => (g.status = "expired"));
    goal.tasks
      .filter((t) => t.status === "pending" || t.status === "running")
      .forEach((t) => {
        t.status = "skipped";
      });
    goal.status = "awaiting_direction";
    goal.text = text?.trim() ?? goal.text;
    goal.direction = undefined;
    goal.delight = undefined;
    goal.plan = [];
    goal.tasks = [];
    goal.highlights = [];
    goal.limitations = [];
    goal.note = text?.includes("追加のこだわり：")
      ? text.split("追加のこだわり：").slice(1).join(" / ")
      : "";
    this.message(
      goal,
      "concierge",
      "方針を見直しましょう。以前の選択は引き継がず、新しい条件で調べ直します。",
      "revision",
    );
    goal.gates.push({
      ...directionGate(goal),
      afterMessageId: goal.messages.at(-1)?.id,
    });
    await this.repo.save(goal);
    return goal;
  }
  async cancel(id: string) {
    const goal = await this.repo.get(id);
    this.active.get(id)?.abort();
    goal.status = "cancelled";
    goal.gates
      .filter((g) => g.status === "pending")
      .forEach((g) => (g.status = "expired"));
    goal.tasks
      .filter((t) => ["pending", "running"].includes(t.status))
      .forEach((t) => (t.status = "skipped"));
    this.message(
      goal,
      "concierge",
      "作業を停止しました。集めた情報と選択履歴は残しています。",
    );
    await this.repo.save(goal);
    return goal;
  }
  private async research(goal: Goal, signal: AbortSignal, revision: number) {
    const travel = goal.scenario === "travel";
    const specs = travel
      ? [
          ["stay", "宿を探す", "じゃらん", "https://www.jalan.net/"],
          [
            "food",
            "食事を探す",
            "Hot Pepper グルメ",
            "https://www.hotpepper.jp/",
          ],
          ["explore", "寄り道を考える", "じゃらん", "https://www.jalan.net/"],
        ]
      : [
          ["career", "仕事の条件を調べる", "Indeed", "https://jp.indeed.com/"],
          ["home", "暮らす場所を探す", "SUUMO", "https://suumo.jp/"],
          [
            "car",
            "移動手段を考える",
            "カーセンサー",
            "https://www.carsensor.net/",
          ],
        ];
    goal.tasks = specs.map(([agent, title, source, url]) => ({
      id: `${revision}-${agent}`,
      agent: agent!,
      title: title!,
      source: source!,
      url: url!,
      dependsOn:
        agent === "car" ? [`${revision}-home`, `${revision}-career`] : [],
      status: "pending",
      round: 1,
    }));
    goal.tasks.push({
      id: `${revision}-review`,
      agent: "reviewer",
      title: travel
        ? "移動と予算を、横断して確認"
        : "仕事・住居・車の整合性を確認",
      source: "チームレビュー",
      url: "",
      dependsOn: specs.map((s) => `${revision}-${s[0]}`),
      status: "pending",
      round: 1,
    });
    this.message(
      goal,
      "concierge",
      travel
        ? "宿と食事は並行して調べます。寄り道も別に集め、最後に移動と予算をレビューします。"
        : "仕事と家を並行して調べます。車は、勤務地と駐車場の条件が見えてから。最後に固定費をまとめて確認します。",
      "handoff",
    );
    await this.repo.save(goal);
    let quotaExhausted = false;
    const jobs: RoutedJob<Task | undefined>[] = specs.map(
      ([agent, _title, _source, url, query]) => {
        const work = goal.tasks.find((t) => t.agent === agent)!;
        const roleQueries: Record<string, string> = {
          stay: "ユーザーの目標に合う宿を2件比較。アクセス、風呂、食事、料金条件を確認。日付未指定の空室や総額を推測しない。",
          food: "ユーザーの目標に合う食事場所を2件比較。場所、料理、営業時間、予算、アクセスを確認。",
          explore:
            "ユーザーの目標に合う観光・体験候補を比較。移動手段と必要な時間、開催条件を確認。",
          career:
            "ユーザーの目標に合う求人を2件比較。職種、場所、給与下限、雇用形態、出社条件を確認。",
          home: "ユーザーの目標に合う住居を2件比較。家賃と管理費、駅、間取り、初期費用、駐車場を確認。",
          car: "ユーザーの目標に合う車両を2件比較。支払総額、年式、走行距離、修復歴、販売店を確認。",
        };
        return {
          id: work.id,
          agent: work.agent,
          dependsOn: work.dependsOn,
          run: async () => {
            if (goal.revision !== revision) throw new Error("改訂済み");
            this.message(
              goal,
              "concierge",
              `${work.title}をお願いします。方針：${goal.direction}。予算：${goal.budget.toLocaleString()}円。${goal.note ? `こだわり：${goal.note}` : ""}`,
              "request",
              work.agent,
              work.id,
            );
            await this.repo.save(goal);
            if (goal.mode === "demo") {
              await wait(
                this.delayMs +
                  (agent === "food" ? 200 : agent === "car" ? 400 : 0),
                signal,
              );
              if (goal.revision !== revision) return;
              const text: Record<string, string> = {
                stay: "温泉とアクセスを軸に、宿のタイプを比較しました。貸切風呂は予約条件の確認が必要です。",
                food: "夕食を外で楽しむ案と、宿でゆっくりする案を用意しました。",
                explore:
                  "芦ノ湖と美術館を候補に。詰め込みすぎないよう、1日の移動を抑えます。",
                career:
                  "在宅日数と給与の表記を分けて整理しました。出社条件は応募前に確認する必要があります。",
                home: "駅徒歩と家賃に加え、車を持つ場合の駐車場条件を整理しました。",
                car: "小さな車の購入と、必要な日だけ借りる案を比較しました。車両価格だけで判断しません。",
              };
              this.message(
                goal,
                work.agent,
                text[work.agent]!,
                "result",
                "reviewer",
                work.id,
              );
              return;
            }
            if (quotaExhausted)
              throw new Error(
                "無料利用枠が枯渇したため、この調査は開始しませんでした",
              );
            const task = await this.runtime(
              {
                query: `${roleQueries[work.agent]}\n目標:${goal.text}\n優先:${goal.direction}\n予算(${travel ? "旅行全体" : "毎月の固定費"}):${goal.budget}円\nこだわり:${goal.note}\n提示されていない個人条件や予約日程は推測しない。`,
                urls: [url!],
                goalId: goal.id,
                maxSteps: 50,
                maxPages: 7,
                timeoutSeconds: 210,
                signal,
              },
              new Store(resolve(this.repo.root, "..")),
            );
            if (goal.revision !== revision) return task;
            work.runtimeTaskId = task.id;
            work.note = task.answer?.summary ?? task.error ?? task.status;
            this.message(
              goal,
              work.agent,
              work.note,
              "result",
              "reviewer",
              work.id,
            );
            if (!task.answer?.candidates.length) {
              goal.limitations.push(
                `${work.source}: 確認できる候補がありません。${task.error ?? task.answer?.limitations.join(" ") ?? ""}`,
              );
            }
            if (task.failure?.kind === "quota_exhausted") quotaExhausted = true;
            if (
              task.status !== "succeeded" ||
              !task.answer?.candidates.some((c) => c.eligible)
            )
              throw new Error(
                `${work.source}: ${task.status} — 依存タスクを進める条件が未確認です`,
              );
            return task;
          },
        };
      },
    );
    const review = goal.tasks.find((t) => t.agent === "reviewer")!;
    jobs.push({
      id: review.id,
      agent: "reviewer",
      dependsOn: review.dependsOn,
      run: async ({ results }) => {
        await wait(this.delayMs, signal);
        if (goal.revision !== revision) return;
        if (goal.mode === "live") {
          const tasks = [...results.values()].filter((t): t is Task => !!t);
          const unknown = tasks
            .flatMap((t) => t.answer?.candidates ?? [])
            .flatMap((c) => c.matches)
            .filter((m) => m.status === "unknown").length;
          this.message(
            goal,
            "reviewer",
            `実候補の構造を照合しました。未確認の条件は${unknown}件あります。料金の合算・交通時間・求人と住居の実際の整合性は未検証のため、確定案として扱いません。`,
            "review",
            "concierge",
            review.id,
            1,
          );
          return undefined;
        }
        this.message(
          goal,
          "reviewer",
          travel
            ? "ひとつ見直したい点があります。初日の夕食を外にすると、チェックイン後の移動が増えます。宿での夕食に替えて、ゆっくり過ごす時間を守りませんか。"
            : "車を先に買うと、家の駐車場と仕事の出社条件で選び直す可能性があります。住居と雇用条件の確認後に決める順番へ変更したいです。",
          "review",
          travel ? "stay" : "car",
          review.id,
          1,
        );
        return undefined;
      },
    });
    await routeJobs(jobs, {
      concurrency: goal.concurrency,
      signal,
      onEvent: async (result) => {
        if (goal.revision !== revision || signal.aborted) return;
        const work = goal.tasks.find((t) => t.id === result.id)!;
        work.status = result.status;
        if (result.error) work.note = result.error;
        await this.repo.save(goal);
      },
    });
    signal.throwIfAborted();
    if (goal.revision !== revision) return;
    const failed = goal.tasks.filter((t) => t.status === "failed");
    if (failed.length)
      this.message(
        goal,
        "reviewer",
        `${failed.map((t) => t.source).join("・")}の情報取得に制約がありました。未確認の条件を残し、断定を避けて次の選択へ進みます。`,
        "review",
      );
    if (goal.mode === "demo") {
      // One bounded rework task demonstrates another invocation and records the causal review.
      const worker = travel ? "stay" : "car";
      const original = goal.tasks.find((t) => t.agent === worker)!;
      const rework: Work = {
        ...original,
        id: `${revision}-${worker}-rework`,
        title: travel
          ? "夕食とチェックインを組み直す"
          : "購入を急がない移動案に見直す",
        dependsOn: [review.id],
        status: "running",
        round: 2,
      };
      goal.tasks.push(rework);
      this.message(
        goal,
        "concierge",
        "指摘を反映して、担当に再調査を依頼します。",
        "revision",
        worker,
        rework.id,
        2,
      );
      await this.repo.save(goal);
      await wait(this.delayMs, signal);
      if (goal.revision !== revision) return;
      rework.status = "succeeded";
      this.message(
        goal,
        worker,
        travel
          ? "1泊目は宿で夕食、2日目は外で食事を楽しむ構成に変更しました。貸切風呂と特別な夕食、どちらを主役にするか選べます。"
          : "車の契約を後ろに置き、最初の1か月はカーシェアも検討する案に変えました。家と仕事を確かめながら決められます。",
        "result",
        "reviewer",
        rework.id,
        3,
      );
    } else
      this.message(
        goal,
        "reviewer",
        "実サイトの候補と未確認事項を整理しました。空席・在庫・雇用条件を保証せず、次は優先したい点を確認します。",
        "review",
      );
    goal.status = "awaiting_delight";
    goal.gates.push({
      ...delightGate(goal),
      afterMessageId: goal.messages.at(-1)?.id,
    });
    await this.repo.save(goal);
  }
  private async synthesize(goal: Goal, signal: AbortSignal, revision: number) {
    const valid = () => {
      signal.throwIfAborted();
      if (goal.revision !== revision || goal.status !== "synthesizing")
        throw new Error("改訂または停止済み");
    };
    this.message(
      goal,
      "concierge",
      "選んだこだわりを軸に、全体のつながりを整えます。",
    );
    await this.repo.save(goal);
    await wait(this.delayMs, signal);
    valid();
    let plan: PlanItem[] = [],
      highlights: string[] = [],
      limitations = [...goal.limitations];
    if (goal.mode === "live") {
      const store = new Store(resolve(this.repo.root, ".."));
      const selectedAgent =
        goal.scenario === "travel"
          ? { bath: "stay", dinner: "food", view: "explore" }[
              goal.delight ?? ""
            ]
          : {
              "job-first": "career",
              "visit-first": "home",
              "budget-first": "car",
            }[goal.delight ?? ""];
      const original = goal.tasks.find(
        (t) =>
          t.agent === selectedAgent &&
          t.status === "succeeded" &&
          t.round === 1,
      );
      const choice = goal.gates
        .find((g) => g.revision === revision && g.kind === "delight")
        ?.choices.find((c) => c.id === goal.delight);
      if (original) {
        const work: Work = {
          ...original,
          id: `${revision}-${selectedAgent}-followup`,
          title: "選んだこだわりで再調査",
          dependsOn: [original.id],
          status: "running",
          round: 2,
        };
        goal.tasks.push(work);
        this.message(
          goal,
          "concierge",
          `選んだ「${choice?.title}」を条件に追加し、もう一度調べてください。`,
          "revision",
          selectedAgent,
          work.id,
          2,
        );
        await this.repo.save(goal);
        valid();
        const followup = await this.runtime(
          {
            query: `${goal.text}\n特に優先:${choice?.title}。${choice?.description}。追加条件:${goal.note}。公開情報で検証できる候補のみ示し、未確認を埋めない。`,
            urls: [original.url],
            parentId: original.runtimeTaskId,
            goalId: goal.id,
            maxSteps: 35,
            maxPages: 5,
            timeoutSeconds: 180,
            signal,
          },
          store,
        );
        valid();
        work.runtimeTaskId = followup.id;
        work.status = followup.status === "succeeded" ? "succeeded" : "failed";
        work.note = followup.answer?.summary ?? followup.error;
        this.message(
          goal,
          selectedAgent ?? "concierge",
          work.note ?? "追加調査が完了しませんでした。",
          "result",
          "reviewer",
          work.id,
          3,
        );
      }
      for (const work of goal.tasks.filter((t) => t.runtimeTaskId)) {
        const task = await store.get(work.runtimeTaskId!);
        valid();
        for (const candidate of task.answer?.candidates ?? []) {
          const entry = {
            day: work.source,
            time: work.round > 1 ? "こだわりを反映して再調査" : "取得した候補",
            title: candidate.name,
            description: candidate.matches
              .map(
                (m) =>
                  `${m.status === "supported" ? "確認" : m.status === "unknown" ? "未確認" : "不一致"}: ${m.explanation}`,
              )
              .join(" / "),
            category: work.agent,
            source: work.source,
            url: candidate.url,
            demo: false,
          };
          const old = plan.findIndex((p) => p.url === entry.url);
          if (old >= 0) plan[old] = entry;
          else plan.push(entry);
        }
      }
      highlights = [
        "実サイトで取得した候補のみを表示",
        "空席・在庫・雇用条件は出典で最終確認",
        `選んだこだわり: ${choice?.title ?? goal.delight}`,
      ];
      limitations.push(
        "実調査モードの横断レビューは未確認条件と依存関係のルール検証です。交通時間・費用の合算、日程の最適化を保証するエージェントレビューは未実装です。",
      );
      if (!original)
        limitations.push(
          "選んだ分野の確認済み候補がないため、追加の再調査は開始していません。",
        );
    } else {
      plan = demoPlan(goal);
      highlights =
        goal.scenario === "travel"
          ? [
              "予定を詰めずに、1日1〜2か所",
              goal.delight === "bath"
                ? "初日は早めに宿へ。貸切風呂をご褒美に"
                : goal.delight === "dinner"
                  ? "2日目の夕食を、旅のハイライトに"
                  : "芦ノ湖の静かな朝から始める",
              `2人の参考予算 ¥${goal.budget.toLocaleString()}以内を目標に`,
            ]
          : [
              "仕事 → 家 → 車の順で、選び直しを減らす",
              goal.delight === "job-first"
                ? "まず在宅日数と給与条件を確認"
                : goal.delight === "visit-first"
                  ? "休日に街の生活動線を歩いてみる"
                  : "家賃と駐車場、維持費をまとめて比較",
              "応募・契約は、条件に納得してから",
            ];
      limitations.push(
        "体験用の架空プランです。店舗・宿・求人・物件・車両の実在、料金、営業状況、空きは確認していません。",
      );
      if (goal.scenario === "travel" && goal.budget < 70000)
        limitations.push(
          "選んだ予算では表示した参考費用の合計を超える可能性があります。宿泊・移動・食費の見直しが必要です。",
        );
    }
    valid();
    goal.plan = plan;
    goal.highlights = highlights;
    goal.limitations = limitations;
    if (goal.note) goal.highlights.push(`大切にすること: ${goal.note}`);
    this.message(
      goal,
      "reviewer",
      goal.mode === "demo"
        ? "選んだこだわりをプランに反映しました。施設や金額は体験用のサンプルで、合計額や移動の成立を実証したものではありません。"
        : "取得できた候補と未確認項目を表示しました。実データがない部分は埋めていません。",
      "review",
    );
    this.message(
      goal,
      "concierge",
      goal.mode === "live"
        ? !plan.length
          ? "今回は確認できる候補がありませんでした。取得できなかった理由をプラン欄に残しています。"
          : "調査した候補と未確認事項を、右のプランにまとめました。こだわりの追加調査は履歴から確認できます。"
        : goal.scenario === "travel"
          ? "旅の案がまとまりました。大切にしたい時間を残しながら、3日間の流れを右のプランにまとめています。"
          : "暮らしの案をまとめました。一度に全部を決めず、次の一歩と、決める順番を確認してみてください。",
    );
    goal.status =
      goal.mode === "live" && !plan.length ? "blocked" : "completed";
    await this.repo.save(goal);
  }
}
export function demoPlan(goal: Goal): PlanItem[] {
  const item = (
    day: string,
    time: string,
    title: string,
    description: string,
    category: string,
    source: string,
    url: string,
    price?: string,
  ): PlanItem => ({
    day,
    time,
    title,
    description,
    category,
    source,
    url,
    price,
    demo: true,
  });
  if (goal.scenario === "life")
    return [
      item(
        "仕事",
        "STEP 01",
        goal.delight === "job-first"
          ? "在宅日数から、仕事の候補を絞る"
          : "仕事の条件を整理する",
        "リモート中心のエンジニア職。額面給与と出社頻度を分け、勤務地・雇用形態を確認する。",
        "career",
        "Indeed",
        "https://jp.indeed.com/",
        "条件は要確認",
      ),
      item(
        "住まい",
        "STEP 02",
        goal.delight === "visit-first"
          ? "藤沢の街を、休日に歩いてみる"
          : "駅と日常の動線から、住まいを選ぶ",
        "1LDK・駅徒歩15分以内を参考条件に。管理費と駐車場も含め、仕事の出社条件が見えてから内見する。",
        "home",
        "SUUMO",
        "https://suumo.jp/",
        "家賃目安 ¥100,000〜120,000",
      ),
      item(
        "移動",
        "STEP 03",
        goal.delight === "budget-first"
          ? "毎月の固定費を、先に比較する"
          : "車を買う前に、使う頻度を確かめる",
        goal.direction === "nature"
          ? "週末の海や自然へ行く頻度を試し、駐車場と車の維持費を比較。購入は雇用と住居の条件が決まってから。"
          : "コンパクトカーとカーシェアを比較。総額・保険・税金・駐車場を分け、必要な日に使うところから始める。",
        "car",
        "カーセンサー",
        "https://www.carsensor.net/",
        "購入総額の上限 ¥1,500,000",
      ),
    ];
  const bath = goal.delight === "bath",
    dinner = goal.delight === "dinner",
    view = goal.delight === "view";
  const base = [
    item(
      "1日目",
      "11:30",
      "箱根湯本で、旅のスイッチを入れる",
      "駅の近くで軽めの昼食。荷物を預けて、川沿いをゆっくり歩く。",
      "food",
      "Hot Pepper グルメ",
      "https://www.hotpepper.jp/",
      "2人 ¥3,000〜4,000",
    ),
    item(
      "1日目",
      "15:00",
      bath ? "少し早めに、温泉の宿へ" : "緑に囲まれた温泉の宿へ",
      "体験用の宿プラン。初日は移動を増やさず、夕食を宿で楽しむ。実際の宿はじゃらんで確認。",
      "stay",
      "じゃらん",
      "https://www.jalan.net/",
      "2泊・2人 ¥40,000〜50,000",
    ),
    item(
      "1日目",
      "16:00",
      bath ? "ふたりだけの、貸切露天風呂" : "予定のない、ゆっくりした時間",
      bath
        ? "旅のご褒美は、温泉の時間に。貸切の予約時間と追加料金は、宿の条件を確認する。"
        : "ラウンジや温泉でひと休み。到着してすぐに次へ向かわない日。",
      "stay",
      "じゃらん",
      "https://www.jalan.net/",
    ),
    item(
      "2日目",
      view ? "08:00" : "10:30",
      view ? "静かな朝の芦ノ湖へ" : "芦ノ湖の景色を、ゆっくり味わう",
      view
        ? "早朝の景色とコーヒーを主役に。前夜の予定を早めに切り上げる。"
        : "湖のまわりを散歩。公共交通の本数を確認し、余裕を持って戻る。",
      "explore",
      "じゃらん",
      "https://www.jalan.net/",
    ),
    item(
      "2日目",
      "13:00",
      goal.direction === "explore"
        ? "美術館で、少し長めの寄り道"
        : "ランチのあとは、気分で寄り道",
      "美術館やカフェは、天気と体調に合わせて。行かない選択も、プランの一部。",
      "explore",
      "じゃらん",
      "https://www.jalan.net/",
    ),
    item(
      "2日目",
      "18:00",
      dinner ? "今日の主役は、特別な夕食" : "土地の味で、2日目の夕食",
      dinner
        ? "夕食に予算を寄せるプラン。宿の部屋は標準にして、食事をゆっくり楽しむ。"
        : "箱根・小田原の食を楽しむ案。営業時間と帰りの交通は、予約前に確認。",
      "food",
      "Hot Pepper グルメ",
      "https://www.hotpepper.jp/",
      dinner ? "2人 ¥12,000〜16,000" : "2人 ¥6,000〜8,000",
    ),
    item(
      "3日目",
      "10:00",
      "朝ごはんのあとも、急がない",
      "チェックアウトまでゆっくり。お土産と軽めの昼食を楽しみ、午後には帰路へ。",
      "stay",
      "じゃらん",
      "https://www.jalan.net/",
    ),
  ];
  if (goal.direction === "food")
    base[4] = item(
      "2日目",
      "13:00",
      "ランチとカフェで、もうひとつの発見",
      "食を主役にした方針を反映。美術館の代わりに、昼食とお茶の時間を長めに確保。",
      "food",
      "Hot Pepper グルメ",
      "https://www.hotpepper.jp/",
    );
  return base;
}
