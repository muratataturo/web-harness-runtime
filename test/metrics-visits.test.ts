import { test } from "node:test";
import assert from "node:assert/strict";
import { codexUsage } from "../src/metrics.js";
import { entityKey } from "../src/sources.js";
import { verifyDetail } from "../src/detail-contracts.js";
const raw = {
  inputTokens: 150,
  outputTokens: 30,
  cachedInputTokens: 100,
  reasoningOutputTokens: 8,
  totalTokens: 180,
};
test("native token parsing preserves cache/reasoning subsets and treats missing counters as unknown", () => {
  assert.equal(codexUsage(raw)!.totalTokens, 180);
  assert.equal(codexUsage(undefined), undefined);
  assert.equal(codexUsage({ ...raw, inputTokens: -1 }), undefined);
  assert.equal(codexUsage({ ...raw, totalTokens: NaN }), undefined);
  assert.equal(codexUsage({ inputTokens: 150 }), undefined);
});
test("official visitor sources bind only known facility paths and keep the original detail requirements", () => {
  const url = "https://www.tokyo-zoo.net/ueno/visitor-info/tickets/";
  assert.equal(
    entityKey(url),
    entityKey("https://www.tokyo-zoo.net/ueno/visitor-info/access/"),
  );
  assert.equal(entityKey("https://www.tokyo-zoo.net/"), undefined);
  assert.notEqual(
    entityKey(url),
    entityKey("https://www.kahaku.go.jp/riyou/nyukan-annai/"),
  );
  const page = {
    id: "p",
    url,
    title: "上野動物園の入園案内",
    text: `開園時間9時30分～17時。入園料 一般600円。${"動物と施設の案内です。".repeat(30)}`,
    links: [],
    truncated: false,
    capturedAt: new Date().toISOString(),
  };
  assert.equal(verifyDetail(page).status, "verified");
  assert.equal(
    verifyDetail({ ...page, text: "営業時間・料金はこちら" }).status,
    "insufficient_detail",
  );
});
