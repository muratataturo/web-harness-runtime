import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse } from "dotenv";

const maxBytes = 1024 * 1024;
export function auditFile(path, bytes, localSecrets = []) {
  const failures = [];
  const report = (rule) => failures.push({ path, rule });
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|\.runtime|\.codex|\.claude|\.pi|\.opencode|node_modules)(?:\/|$)/.test(
      path,
    ) &&
    path !== ".env.example"
  )
    report("private-file");
  if (
    /(?:^|\/)(?:auth\.json|credentials[^/]*\.json)$|\.(?:pem|key|p12|pfx|sqlite3?|db|tgz|tar|zip|qcow2|vmdk|vhdx|img|iso)$|\.tar\.gz$/i.test(
      path,
    )
  )
    report("credential-or-generated-file");
  if (bytes.length > maxBytes) report("file-over-1MiB");
  if (localSecrets.some((value) => bytes.includes(Buffer.from(value))))
    report("local-secret-value");
  if (!bytes.includes(0)) {
    const text = bytes.toString("utf8");
    if (
      /\/(?:Users|home)\/(?!runner(?:\/|\b)|node(?:\/|\b)|sandbox(?:\/|\b))[^/\s"'`]+/.test(
        text,
      )
    )
      report("personal-home-path");
    if (
      /(?:sk-or-v1-[A-Za-z0-9]{16,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,})/.test(
        text,
      )
    )
      report("credential-pattern");
  }
  return failures;
}
async function main() {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const env = await readFile(".env")
    .then(parse)
    .catch((e) => {
      if (e.code === "ENOENT") return {};
      throw e;
    });
  const localSecrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        /KEY|TOKEN|PASSWORD|SECRET/i.test(key) && value.length >= 16,
    )
    .map(([, value]) => value);
  const failures = [];
  let totalBytes = 0,
    largestBytes = 0;
  for (const path of paths) {
    const bytes = await readFile(path);
    totalBytes += bytes.length;
    largestBytes = Math.max(largestBytes, bytes.length);
    failures.push(...auditFile(path, bytes, localSecrets));
  }
  // Never print matching source text, secret values, or a copy of .env.
  console.log(
    JSON.stringify(
      {
        trackedFiles: paths.length,
        totalBytes,
        largestBytes,
        maxFileBytes: maxBytes,
        failures,
      },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Release preflight failed; inspect tracked file availability locally.",
    );
    process.exitCode = 1;
  });
}
