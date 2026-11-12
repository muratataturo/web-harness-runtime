import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFile } from "../scripts/release-preflight.mjs";
test("release preflight rejects credential files, private paths, local secrets and oversized artifacts without echoing values", () => {
  assert.equal(
    auditFile(".env", Buffer.from("x")).some((x) => x.rule === "private-file"),
    true,
  );
  assert.equal(
    auditFile(".env.example", Buffer.from("OPENROUTER_API_KEY=\n")).length,
    0,
  );
  assert.equal(
    auditFile("backups/auth.json", Buffer.from("{}")).some(
      (x) => x.rule === "credential-or-generated-file",
    ),
    true,
  );
  assert.equal(
    auditFile("docs/large.png", Buffer.alloc(1024 * 1024 + 1)).some(
      (x) => x.rule === "file-over-1MiB",
    ),
    true,
  );
  const personal = "/" + ["Users", "private-person", "project"].join("/");
  const privateResult = auditFile("docs/result.json", Buffer.from(personal));
  assert.equal(
    privateResult.some((x) => x.rule === "personal-home-path"),
    true,
  );
  const secret = "example-sensitive-local-value";
  const result = auditFile("docs/result.json", Buffer.from(secret), [secret]);
  assert.equal(
    result.some((x) => x.rule === "local-secret-value"),
    true,
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(privateResult).includes(personal), false);
});
