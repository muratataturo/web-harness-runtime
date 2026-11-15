import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const liveReceiptPath = ".runtime/chat-runtime-live/report.json";
export const requiredChatChecks = [
  "uiSubmitted",
  "progressVisible",
  "sseReceived",
  "answerVisible",
  "candidateQuoteVisible",
  "sourceBodyVisible",
  "reloadRestored",
  "noPageErrors",
];
export async function acceptanceRevision(root = process.cwd()) {
  const files = [];
  for (const dir of ["dist", "web", "config"]) {
    for (const entry of await readdir(join(root, dir), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && /\.(?:js|html|css|json)$/.test(entry.name))
        files.push(`${dir}/${entry.name}`);
    }
  }
  if (!files.includes("dist/cli.js"))
    throw Error("Build the runtime before chat acceptance.");
  files.push(
    "package.json",
    "package-lock.json",
    "scripts/chat-runtime-e2e.mjs",
    "scripts/chat-acceptance.mjs",
    "scripts/package-cli.mjs",
  );
  const hash = createHash("sha256");
  for (const file of files.sort())
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(root, file)))
      .update("\0");
  return hash.digest("hex");
}
export function assertLiveAcceptance(report, revision, now = Date.now()) {
  const fail = () => {
    throw Error(
      "Recruit/Rakuten Chat live acceptance is missing, stale or incomplete. Run npm run test:chat:live; fixture/replay results cannot authorize a release.",
    );
  };
  if (
    report?.schemaVersion !== 1 ||
    report.mode !== "live" ||
    report.passed !== true ||
    report.revision !== revision
  )
    fail();
  const timestamp = Date.parse(report.completedAt);
  if (
    !Number.isFinite(timestamp) ||
    now < timestamp ||
    now - timestamp > 24 * 60 * 60 * 1000
  )
    fail();
  if (!Array.isArray(report.cases) || report.cases.length !== 2) fail();
  for (const family of ["recruit", "rakuten"]) {
    const matches = report.cases.filter((c) => c.family === family);
    if (matches.length !== 1) fail();
    const c = matches[0];
    if (
      c.runStatus !== "succeeded" ||
      c.taskStatus !== "succeeded" ||
      c.source !== "live" ||
      c.mode !== "auto" ||
      c.agent !== "codex" ||
      !Number.isSafeInteger(c.modelTokens) ||
      c.modelTokens <= 0 ||
      c.execution?.target !== "openshell" ||
      c.execution.cleanupStatus !== "stopped" ||
      !c.execution.sandboxId ||
      c.security?.mode !== "hardened" ||
      c.security.profileId !== `${family}-public-research` ||
      c.security.artifactNonce !== c.taskId ||
      !c.taskId ||
      !(c.evidenceCount > 0) ||
      !requiredChatChecks.every((key) => c.checks?.[key] === true)
    )
      fail();
  }
  return report;
}
export async function requireLiveAcceptance(root = process.cwd()) {
  const path = resolve(root, liveReceiptPath);
  let report;
  try {
    report = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw Error(
      "Chat live acceptance receipt is missing. Run npm run test:chat:live before packaging; use --preview only for an unverified CI artifact.",
    );
  }
  return assertLiveAcceptance(report, await acceptanceRevision(root));
}
