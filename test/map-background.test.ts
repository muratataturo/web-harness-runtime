import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundFor, fetchTilePng } from "../web/map-background.js";
import { mapTile } from "./fixtures/map-tile.mjs";
const tile = "https://cyberjapandata.gsi.go.jp/xyz/pale/16/58212/25798.png";
test("Japan background uses GSI; missing or out-of-coverage coordinates stay schematic", () => {
  const provider = backgroundFor([
    { coordinates: { lat: 35.715, lon: 139.77 } },
  ]);
  assert.equal(provider?.id, "gsi-pale");
  assert.ok(!provider?.url.includes("openstreetmap"));
  assert.match(provider!.attribution, /地理院タイル/);
  assert.equal(backgroundFor([]), null);
  assert.equal(
    backgroundFor([{ coordinates: { lat: 51.5, lon: -0.1 } }]),
    null,
  );
});
test("an HTTP 403 image must never be treated as a successful tile", async () => {
  for (const status of [403, 404, 429, 500])
    await assert.rejects(
      fetchTilePng(tile, {
        fetcher: async () =>
          new Response(mapTile, {
            status,
            headers: { "Content-Type": "image/png" },
          }),
      }),
      new RegExp("HTTP " + status),
    );
});
test("only bounded PNG data reaches the image, using normal CORS caching without spoofing", async () => {
  const blob = await fetchTilePng(tile, {
    fetcher: async (_url, options) => {
      assert.equal(options?.mode, "cors");
      assert.equal(options?.cache, "default");
      assert.equal(options?.credentials, "omit");
      assert.equal(options?.redirect, "error");
      assert.equal(options?.headers, undefined);
      return new Response(mapTile, {
        headers: { "Content-Type": "image/png" },
      });
    },
  });
  assert.equal(blob.type, "image/png");
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), mapTile);
  for (const [body, headers] of [
    ["<p>Access blocked</p>", { "Content-Type": "text/html" }],
    ["Access blocked", { "Content-Type": "image/png" }],
    [
      mapTile,
      { "Content-Type": "image/png", "Content-Length": String(1024 * 1024) },
    ],
  ] as const)
    await assert.rejects(
      fetchTilePng(tile, {
        fetcher: async () => new Response(body, { headers }),
      }),
      /invalid/,
    );
  await assert.rejects(
    fetchTilePng(tile, {
      fetcher: async () => {
        throw new TypeError("CORS rejected");
      },
    }),
    /CORS/,
  );
});
