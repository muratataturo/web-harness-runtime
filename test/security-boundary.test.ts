import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockList } from "node:net";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createResearchProfile,
  checkResearchNavigation,
  assetHosts,
} from "../src/runtime-profile.js";
import { pinnedLookup, publicFetch } from "../src/public-fetch.js";
import { publicNetworkCidrs, privateAddress } from "../src/net-policy.js";
import { newTask } from "../src/runtime.js";
import {
  validateSandboxTask,
  recoverSandboxTask,
} from "../src/sandbox-artifacts.js";
import { openShellPolicy } from "../src/sandbox.js";
import { Browser } from "../src/browser.js";

test("fixed profiles never grant another family or mutate from external page content", () => {
  const old = process.env.RUNTIME_PROFILE;
  try {
    process.env.RUNTIME_PROFILE = "recruit";
    const p = createResearchProfile([
      "https://www.hotpepper.jp/strJ001100102/",
    ]);
    assert.equal(p.id, "recruit-public-research");
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.hosts));
    assert.throws(() =>
      createResearchProfile(["https://books.rakuten.co.jp/rb/123/"]),
    );
    process.env.RUNTIME_PROFILE = "rakuten";
    assert.throws(() =>
      createResearchProfile(["https://books.rakuten.co.jp.attacker.example/"]),
    );
  } finally {
    if (old === undefined) delete process.env.RUNTIME_PROFILE;
    else process.env.RUNTIME_PROFILE = old;
  }
  assert.deepEqual(assetHosts("evilrakuten.co.jp"), ["evilrakuten.co.jp"]);
  assert.deepEqual(assetHosts("rakuten.co.jp.evil.example"), [
    "rakuten.co.jp.evil.example",
  ]);
});

test("read-only requests reject action paths, encoded forms, credentials and long queries", () => {
  const host = "books.rakuten.co.jp";
  assert.equal(
    checkResearchNavigation(`https://${host}/rb/123/?l-id=source#anchor`, [
      host,
    ]),
    `https://${host}/rb/123/?l-id=source`,
  );
  for (const suffix of [
    "/checkout/",
    "/rb/123/%6cogin",
    "/rb/123/%256cogin",
    "/rb/123/%25256cogin",
    "/rb/123/%2fapply",
    "/rb/123/%5csecret",
    "/rb/123/?token=secret",
    "/rb/123/?redirect=https://attacker.example",
    "/rb/123/?q=" + "x".repeat(2048),
  ])
    assert.throws(
      () => checkResearchNavigation(`https://${host}${suffix}`, [host]),
      suffix,
    );
  assert.throws(() =>
    checkResearchNavigation(`https://${host}/admin/`, [host]),
  );
});
test("service prefix paths admit detail descendants with OpenShell segment semantics", () => {
  for (const url of [
    "https://www.hotpepper.jp/strJ001100102/",
    "https://www.hotpepper.jp/strJ001100102/lunch/",
    "https://beauty.hotpepper.jp/slnH000074059/coupon/",
    "https://www.jalan.net/140000/LRG_141600/",
  ])
    assert.equal(checkResearchNavigation(url, [new URL(url).hostname]), url);
  for (const url of [
    "https://www.hotpepper.jp/unlisted/strJ001100102/",
    "https://www.hotpepper.jp/strJ001100102/LOGIN/",
    "https://books.rakuten.co.jp/rb/123/nested/PURCHASE/",
  ])
    assert.throws(() => checkResearchNavigation(url, [new URL(url).hostname]));
});

test("pinned socket lookup uses one DNS snapshot and rejects mixed rebinding answers", async () => {
  let calls = 0;
  const resolver = async () => [
    { address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1" },
  ];
  const lookup = await pinnedLookup("example.com", resolver);
  lookup("example.com", {}, (err, address) => {
    assert.equal(err, null);
    assert.equal(address, "8.8.8.8");
  });
  lookup("example.com", { all: true }, (err, addresses) => {
    assert.equal(err, null);
    assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
  });
  assert.equal(calls, 1);
  await assert.rejects(
    pinnedLookup("example.com", async () => [
      { address: "8.8.8.8" },
      { address: "10.0.0.1" },
    ]),
  );
  await assert.rejects(
    publicFetch("https://example.com/", { method: "POST", redirect: "manual" }),
  );
  await assert.rejects(
    publicFetch("https://example.com/", {
      redirect: "manual",
      headers: { Authorization: "secret" },
    }),
  );
});

test("gateway CIDRs and application IP checks enforce the same public destination boundary", () => {
  const allowed = new BlockList();
  for (const cidr of publicNetworkCidrs) {
    const [ip, bits] = cidr.split("/");
    allowed.addSubnet(ip!, Number(bits), ip!.includes(":") ? "ipv6" : "ipv4");
  }
  for (const ip of [
    "8.8.8.8",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.2.1",
    "198.18.1.1",
    "2001:db8::1",
    "2002:7f00:1::",
    "2606:4700::1",
    "2001:4860::1",
    "3fff::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(
      allowed.check(ip, ip.includes(":") ? "ipv6" : "ipv4"),
      !privateAddress(ip),
      ip,
    );
  const policy = openShellPolicy(["books.rakuten.co.jp"]);
  assert.match(policy, /protocol: rest/);
  assert.match(policy, /enforcement: enforce/);
  assert.doesNotMatch(policy, /tls: skip|chromium|method: POST/);
  assert.match(policy, /allowed_ips:/);
});

const options = {
  query: "compare public page",
  urls: ["https://example.com/detail"],
  agent: "codex" as const,
  maxSteps: 10,
  maxPages: 2,
  timeoutSeconds: 30,
  artifactNonce: randomUUID(),
};
function fixture() {
  const task = newTask(options);
  task.status = "succeeded";
  task.criteria = [
    { id: "price", description: "price", weight: 1, required: true },
  ];
  task.pages = [
    {
      id: "page-1",
      url: options.urls[0]!,
      title: "public detail",
      text: "Published price is 1000 yen. " + "Public information. ".repeat(20),
      links: [],
      truncated: false,
      capturedAt: task.createdAt,
      acquisition: { kind: "public-html", status: 200 },
    },
  ];
  task.evidence = [
    {
      id: "ev-1",
      pageId: "page-1",
      url: task.pages[0]!.url,
      capturedAt: task.createdAt,
      quote: "Published price is 1000 yen.",
    },
  ];
  task.answer = {
    summary: "Read the public detail",
    limitations: [],
    candidates: [
      {
        name: "public detail",
        url: task.pages[0]!.url,
        eligible: true,
        score: 100,
        matches: [
          {
            criterionId: "price",
            status: "supported",
            evidenceIds: ["ev-1"],
            explanation: "quoted",
          },
        ],
      },
    ],
  };
  task.retrieval = {
    status: "verified",
    verifiedDetailUrls: options.urls,
    checkedPages: 1,
  };
  return task;
}
test("host import rejects replay, fabricated quotes, invalid schema and cross-host pages; recomputes trust", () => {
  assert.equal(validateSandboxTask(fixture(), options).status, "partial");
  const replay = fixture();
  replay.security!.artifactNonce = randomUUID();
  assert.throws(() => validateSandboxTask(replay, options), /nonce/);
  const quote = fixture();
  quote.evidence[0]!.quote = "Fabricated secret evidence";
  assert.throws(() => validateSandboxTask(quote, options), /引用/);
  const foreign = fixture();
  foreign.pages[0]!.url = "https://attacker.example/detail";
  assert.throws(() => validateSandboxTask(foreign, options), /許可対象外/);
  const malformed = fixture();
  (malformed.answer!.candidates[0]!.matches as unknown) = "forged";
  assert.throws(() => validateSandboxTask(malformed, options), /schema/);
  const forged = fixture();
  forged.security!.policyHash = "forged";
  assert.throws(() => validateSandboxTask(forged, options), /profile/);
});
test("sandbox imports captured map previews and bounded photo receipts without accepting foreign references", () => {
  const t = fixture(),
    page = t.pages[0]!;
  const embed = "https://www.google.com/maps/embed?pb=!1m18!2d139.77";
  page.mapEmbeds = [embed, "https://evil.example/embed"];
  page.images = [{ url: page.url + "photo.jpg", alt: "参照写真" }];
  t.photoInspections = [
    {
      pageId: page.id,
      imageIndex: 0,
      file: "a".repeat(64) + ".jpg",
      sourceUrl: page.images[0]!.url,
      type: "image/jpeg",
      shownAt: t.createdAt,
    },
  ];
  const imported = validateSandboxTask(t, options);
  assert.deepEqual(imported.pages[0]!.mapEmbeds, [embed]);
  assert.deepEqual(imported.photoInspections, t.photoInspections);
  t.photoInspections[0]!.sourceUrl = "https://evil.example/photo.jpg";
  assert.throws(() => validateSandboxTask(t, options), /写真確認/);
});
test("bounded artifact import refuses symlinks and oversized task files", async () => {
  const root = await mkdtemp(join(tmpdir(), "boundary-import-"));
  try {
    await writeFile(join(root, "task.json"), JSON.stringify(fixture()));
    assert.equal(
      (
        await recoverSandboxTask(root, options, {
          readPage: async () => fixture().pages[0]!,
        })
      ).status,
      "partial",
    );
    await assert.rejects(
      recoverSandboxTask(root, options, {
        readPage: async () => ({
          ...fixture().pages[0]!,
          text: "Actual publisher content contains no claimed price.",
        }),
      }),
      /引用/,
    );
    await symlink(join(root, "task.json"), join(root, "alias"));
    await assert.rejects(recoverSandboxTask(root, options), /symlink/);
    await rm(join(root, "alias"));
    await writeFile(join(root, "task.json"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(recoverSandboxTask(root, options), /サイズ/);
    const browser = new Browser(
      "test",
      root,
      ["example.com"],
      AbortSignal.timeout(1000),
    );
    await assert.rejects(
      browser.command(["open", "https://example.com/"]),
      /強化モード/,
    );
    await assert.rejects(
      browser.open("https://example.com/", { render: true }),
      /強化モード/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox preserves bounded PDF inspection provenance and rejects a mismatched document or page", () => {
  const t = fixture();
  t.pages[0]!.acquisition = { kind: "public-pdf", status: 200 };
  t.pages[0]!.pdf = { sha256: "a".repeat(64), pages: 2 };
  t.pdfInspections = [
    {
      pageId: t.pages[0]!.id,
      pageNumber: 2,
      sha256: "a".repeat(64),
      shownAt: t.createdAt,
    },
  ];
  const imported = validateSandboxTask(t, options);
  assert.deepEqual(imported.pdfInspections, t.pdfInspections);
  t.pdfInspections[0]!.pageNumber = 3;
  assert.throws(() => validateSandboxTask(t, options), /PDF確認/);
  t.pdfInspections[0]!.pageNumber = 2;
  t.pdfInspections[0]!.sha256 = "b".repeat(64);
  assert.throws(() => validateSandboxTask(t, options), /PDF確認/);
});
