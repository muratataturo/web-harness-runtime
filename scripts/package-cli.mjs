import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const out = resolve(".runtime/releases");
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
  "dist/cli.js",
  "dist/public-mcp.js",
  "web/chat.html",
  "config/runtime-dependencies.json",
  "docs/evidence/delivery-results.json",
])
  if (!files.includes(required))
    throw Error("Missing package file: " + required);
const report = {
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
