import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requireLiveAcceptance } from "./chat-acceptance.mjs";
const preview = process.argv.includes("--preview");
if (process.argv.slice(2).some((a) => a !== "--preview"))
  throw Error("Unknown packaging option");
const acceptance = preview ? undefined : await requireLiveAcceptance();
const out = resolve(".runtime/releases", ...(preview ? ["preview"] : []));
await mkdir(out, { recursive: true, mode: 0o700 });
const { stdout } = await promisify(execFile)(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", out],
  { timeout: 30000, maxBuffer: 2000000 },
);
const [pack] = JSON.parse(stdout);
const files = pack.files.map((f) => f.path);
if (
  files.some((p) =>
    /(?:^|\/)(?:\.env(?:\.|$)|\.runtime|auth\.json|node_modules|\.pi|\.codex)(?:\/|$)/.test(
      p,
    ),
  )
)
  throw Error("Private file in package");
for (const required of [
  "benchmarks/semantic-v1.json",
  "dist/cli.js",
  "dist/public-mcp.js",
  "dist/public-fetch.js",
  "dist/runtime-profile.js",
  "dist/sandbox-artifacts.js",
  "dist/strata-colab.js",
  "config/strata-colab.json",
  "infra/strata/remote.py",
  "infra/strata/proxy.py",
  "web/chat.html",
  "web/presentation.js",
  "config/runtime-dependencies.json",
  "config/ux-quality.json",
  "dist/offline-learning.js",
  "dist/ux-feedback.js",
  "dist/answer-plan.js",
  "dist/provenance.js",
  "dist/answer-html.js",
  "dist/visual-artifact.js",
  "dist/visual-refinement.js",
  "dist/geocoding.js",
  "web/artifact-client.bundle.js",
  "web/artifact-client.bundle.css",
  "docs/evidence/delivery-results.json",
  "docs/security-boundary-results.md",
  "docs/chat-runtime-acceptance.md",
  "docs/evidence/security-boundary-results.json",
  "docs/evidence/chat-runtime-results.json",
])
  if (!files.includes(required))
    throw Error("Missing package file: " + required);
const report = {
  verification: preview ? "unverified-preview" : "chat-live-accepted",
  chatAcceptanceRevision: acceptance?.revision,
  chatAcceptanceCompletedAt: acceptance?.completedAt,
  artifact: resolve(out, pack.filename),
  shasum: pack.shasum,
  integrity: pack.integrity,
  size: pack.size,
  fileCount: files.length,
  privateFilesAbsent: true,
  requiredAssetsPresent: true,
};
await writeFile(
  resolve(out, "manifest.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
