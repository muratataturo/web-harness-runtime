import { test } from "node:test";
import assert from "node:assert/strict";
import {
  privateAddress,
  publicTarget,
  managedSyntheticDnsAddress,
} from "../src/net-policy.js";

test("public research rejects special-purpose and malformed destinations", () => {
  for (const address of [
    "192.0.0.8",
    "192.0.2.10",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.5",
    "203.0.113.8",
    "224.0.0.1",
    "255.255.255.255",
    "2001:db8::1",
    "2001:2::1",
    "2001:0:1234::1",
    "2002:7f00:1::",
    "3fff::1",
    "::ffff:8.8.8.8",
    "64:ff9b::7f00:1",
    "2606:4700::1%eth0",
    "not-an-ip",
    "999.1.1.1",
    "",
  ])
    assert.equal(privateAddress(address), true, address);
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "192.0.3.1",
    "198.17.255.255",
    "198.20.0.1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "2606:4700::1",
    "2606:4700:0:0:0:0:0:1",
  ])
    assert.equal(privateAddress(address), false, address);
});

test("one unsafe DNS answer blocks a mixed public/private target before use", async () => {
  for (const answers of [
    [],
    ["8.8.8.8", "10.0.0.1"],
    ["8.8.8.8", "198.18.0.1"],
    ["2606:4700::1", "2001:db8::1"],
    ["bad-answer"],
  ]) {
    await assert.rejects(
      publicTarget(
        "https://books.rakuten.co.jp/rb/123/",
        ["books.rakuten.co.jp"],
        async () => answers.map((address) => ({ address })),
      ),
      /公開 IP/,
    );
  }
});
test("synthetic DNS cannot be enabled by environment markers outside a managed guest", () => {
  const old = [
    process.env.OPENSHELL_SANDBOX,
    process.env.WEB_HARNESS_MANAGED_WORKER,
  ];
  try {
    process.env.OPENSHELL_SANDBOX = "pretend-sandbox";
    process.env.WEB_HARNESS_MANAGED_WORKER = "pi";
    assert.equal(managedSyntheticDnsAddress("198.18.0.2"), false);
    assert.equal(privateAddress("198.18.0.2"), true);
    assert.equal(managedSyntheticDnsAddress("10.0.0.1"), false);
  } finally {
    for (const [i, key] of [
      "OPENSHELL_SANDBOX",
      "WEB_HARNESS_MANAGED_WORKER",
    ].entries()) {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    }
  }
});

test("Recruit and Rakuten source URLs keep their exact host boundary", async () => {
  for (const host of [
    "beauty.hotpepper.jp",
    "www.jalan.net",
    "books.rakuten.co.jp",
    "travel.rakuten.co.jp",
  ]) {
    const url = `https://${host}/`;
    assert.equal(
      await publicTarget(url, [host], async () => [{ address: "8.8.8.8" }]),
      url,
    );
    await assert.rejects(
      publicTarget(`https://${host}.attacker.example/`, [host], async () => [
        { address: "8.8.8.8" },
      ]),
      /許可対象外/,
    );
  }
});
