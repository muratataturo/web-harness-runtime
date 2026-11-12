import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  access,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planOpenShellTask,
  openShellPolicy,
  writeOpenShellPlan,
  executeOpenShellPlan,
  runOpenShellCommand,
} from "../src/sandbox.js";
const options = {
  query: "渋谷の和食レストランを比較",
  urls: ["https://www.hotpepper.jp/"],
  gateway: "selfhost",
  name: "research-test",
};

test("OpenShell plans real lifecycle argv without contacting gateway or exposing secrets", () => {
  const plan = planOpenShellTask(options);
  assert.equal(plan.validation, "plan-only");
  assert.equal(plan.specVersion, "v0.1.7");
  assert.equal(plan.secretMode, "gateway-provider-placeholder");
  const create = plan.commands[0]!;
  assert.equal(create.executable, "openshell");
  assert.deepEqual(create.args.slice(0, 6), [
    "-g",
    "selfhost",
    "sandbox",
    "create",
    "--name",
    "research-test",
  ]);
  assert.ok(create.args.includes("--provider"));
  assert.ok(create.args.includes("--policy"));
  assert.ok(create.args.includes("/opt/web-harness/dist/cli.js"));
  assert.ok(create.args.includes("--env"));
  assert.ok(create.args.includes("RUNTIME_DIR=/sandbox/.runtime"));
  assert.ok(!create.args.some((a) => a.startsWith("OPENROUTER_API_KEY=")));
  assert.ok(create.args.includes("--no-auto-providers"));
  assert.ok(!create.args.includes("--env-from"));
  assert.ok(!create.args.includes("--upload"));
  assert.ok(!create.args.includes("--no-keep"));
  assert.deepEqual(plan.commands[1]!.args.slice(2, 5), [
    "sandbox",
    "download",
    "research-test",
  ]);
  assert.ok(plan.deleteCommand.args.includes("delete"));
});
test("Untrusted goals stay a single argument, including shell metacharacters", () => {
  const query = '家を探して $(touch /tmp/oops); `whoami` "quoted"\n次の行';
  const plan = planOpenShellTask({ ...options, query });
  const args = plan.commands[0]!.args;
  assert.equal(args.filter((arg) => arg === query).length, 1);
  assert.equal(args[args.indexOf("run") + 1], query);
});
test("Sandbox names, gateway, provider, image and limits cannot inject flags or scripts", () => {
  for (const patch of [
    { gateway: "https://gateway.example.com" },
    { gateway: "-g bad" },
    { name: "../escape" },
    { provider: "x; echo" },
    { image: "$(curl bad)" },
    { timeoutSeconds: 0 },
    { cpu: 0 },
    { maxPages: 101 },
    { query: "x".repeat(25000) },
  ]) {
    assert.throws(() => planOpenShellTask({ ...options, ...patch }));
  }
  assert.throws(() =>
    planOpenShellTask({ ...options, urls: ["http://localhost/"] }),
  );
  assert.throws(
    () =>
      planOpenShellTask({
        ...options,
        urls: ["https://example.com/" + "x".repeat(33000)],
      }),
    /argument size/,
  );
});
test("Browser egress policy is host-scoped, nonroot and fails closed on Landlock", () => {
  const plan = planOpenShellTask({
    ...options,
    urls: ["https://beauty.hotpepper.jp/", "https://www.jalan.net/"],
  });
  assert.match(plan.policyYaml, /compatibility: hard_requirement/);
  assert.match(plan.policyYaml, /run_as_user: "1000"/);
  assert.match(plan.policyYaml, /host: "beauty.hotpepper.jp"/);
  assert.match(plan.policyYaml, /host: "www.jalan.net"/);
  assert.doesNotMatch(plan.policyYaml, /host: ["']?\*/);
  assert.doesNotMatch(plan.policyYaml, /registry.npmjs.org/);
  assert.throws(() => openShellPolicy(["localhost"]));
});
test("Plan writing persists reviewable policy and commands with no allocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whr-sandbox-"));
  try {
    const plan = planOpenShellTask({ ...options, directory: dir });
    await writeOpenShellPlan(plan);
    assert.equal(await readFile(plan.policyPath, "utf8"), plan.policyYaml);
    assert.equal(
      JSON.parse(await readFile(join(dir, "plan.json"), "utf8")).sandboxName,
      "research-test",
    );
    await assert.rejects(access(join(dir, "execution.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Sandbox execution refuses a missing explicit host-side confirmation", async () => {
  const plan = planOpenShellTask(options);
  await assert.rejects(
    executeOpenShellPlan(plan, { confirmed: false as true }),
    /Explicit execution/,
  );
});

test("OpenShell runner bounds timeout and output even if a child ignores SIGTERM", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "whr-command-"));
  const original = process.env.PATH;
  try {
    const path = join(directory, "openshell");
    await writeFile(
      path,
      `#!/usr/bin/env node
process.on('SIGTERM',()=>{});
process.stdout.write('READY\\n');
if(process.argv.includes('flood'))setInterval(()=>process.stdout.write('x'.repeat(4096)),1);
else setInterval(()=>{},1000);
`,
    );
    await chmod(path, 0o755);
    process.env.PATH = directory + ":" + original;
    await t.test("timeout escalates to SIGKILL and settles", async () => {
      const start = Date.now();
      const result = await runOpenShellCommand(
        { label: "timeout", executable: "openshell", args: ["hang"] },
        { timeoutMs: 1500, killGraceMs: 50 },
      );
      assert.equal(result.exitCode, 124);
      assert.equal(result.termination, "timeout");
      assert.match(result.stdout, /READY/);
      assert.ok(Date.now() - start >= 1540);
      assert.ok(Date.now() - start < 4000);
    });
    await t.test(
      "output is capped and the flooding child is killed",
      async () => {
        const result = await runOpenShellCommand(
          { label: "limit", executable: "openshell", args: ["flood"] },
          { timeoutMs: 2000, killGraceMs: 50, maxOutputBytes: 1024 },
        );
        assert.equal(result.exitCode, 125);
        assert.equal(result.termination, "output_limit");
        assert.ok(
          Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
            1024,
        );
      },
    );
    await t.test("already aborted command is not spawned", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await runOpenShellCommand(
        { label: "abort", executable: "openshell", args: ["hang"] },
        { signal: controller.signal },
      );
      assert.equal(result.exitCode, 130);
      assert.equal(result.termination, "aborted");
    });
  } finally {
    process.env.PATH = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenShell forwards mode, model and the immutable improvement contract instead of dropping context", async () => {
  const { decodeImprovementContext } =
    await import("../src/improvement-context.js");
  const context = {
    loopId: "loop-1",
    iteration: 1,
    criteria: [
      { id: "fee", description: "掲載価格", weight: 5, required: true },
    ],
    candidateUrls: ["https://www.hotpepper.jp/strJ000000001/"],
    gaps: [
      { url: "https://www.hotpepper.jp/strJ000000001/", fields: ["掲載価格"] },
    ],
    priorityUrls: [],
    visitedUrls: [],
    strategy: "targeted-links" as const,
  };
  const plan = planOpenShellTask({
    ...options,
    interactionMode: "auto",
    model: "openrouter/free",
    deepenRounds: 1,
    improvement: context,
  });
  const args = plan.commands[0]!.args;
  assert.equal(args[args.indexOf("--mode") + 1], "auto");
  assert.equal(args[args.indexOf("--model") + 1], "openrouter/free");
  assert.deepEqual(
    decodeImprovementContext(args[args.indexOf("--improvement-context") + 1]!),
    context,
  );
  assert.ok(plan.commands[1]!.args.includes("/sandbox/.runtime"));
  assert.ok(plan.stopCommand.args.includes("stop"));
  assert.throws(
    () => planOpenShellTask({ ...options, name: "abcdefghijklmnopqrst" }),
    /19/,
  );
  assert.throws(
    () => planOpenShellTask({ ...options, deepenRounds: 4 }),
    /0〜3/,
  );
  assert.throws(
    () =>
      decodeImprovementContext(
        Buffer.from(JSON.stringify({ ...context, iteration: 100 })).toString(
          "base64url",
        ),
      ),
    /スキーマ/,
  );
});
