import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundFor, fetchTilePng } from "../web/map-background.js";
import { mapVector } from "./fixtures/map-vector.mjs";
import { decodeMapTile, paintMapTile } from "../web/vector-map.js";
import { fetchVectorTile } from "../web/map-background.js";
import { mapTile } from "./fixtures/map-tile.mjs";
const tile = "https://cyberjapandata.gsi.go.jp/xyz/pale/16/58212/25798.png";
test("Japan background uses GSI; missing or out-of-coverage coordinates stay schematic", () => {
  const provider = backgroundFor([
    { coordinates: { lat: 35.715, lon: 139.77 } },
  ]);
  assert.equal(provider?.id, "gsi-vector-clean");
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

test("vector background excludes clutter layers and rejects denied or malformed payloads", async () => {
  const layers = await fetchVectorTile(
    "https://cyberjapandata.gsi.go.jp/test.pbf",
    {
      fetcher: async () =>
        new Response(mapVector, {
          headers: { "Content-Type": "application/octet-stream" },
        }),
    },
  );
  assert.deepEqual(
    layers.map((l) => l.name),
    ["building", "waterarea", "road"],
  );
  assert.ok(!layers.some((l) => l.name === "label"));
  for (const response of [
    new Response(mapTile, {
      status: 403,
      headers: { "Content-Type": "image/png" },
    }),
    new Response(mapTile, { headers: { "Content-Type": "image/png" } }),
    new Response("Access blocked", {
      headers: { "Content-Type": "application/octet-stream" },
    }),
  ])
    await assert.rejects(
      fetchVectorTile("https://cyberjapandata.gsi.go.jp/test.pbf", {
        fetcher: async () => response,
      }),
      /HTTP 403|invalid-vector/,
    );
  const operations = [];
  const context = new Proxy(
    {},
    {
      get:
        (_t, key) =>
        (...args) =>
          operations.push([key, ...args]),
      set: (t, key, value) => {
        t[key] = value;
        return true;
      },
    },
  );
  const canvas = { getContext: () => context };
  paintMapTile(canvas, layers, 2);
  assert.equal(canvas.width, 512);
  assert.ok(operations.some((op) => op[0] === "fill"));
  assert.ok(!operations.some((op) => op[0] === "fillText"));
  assert.throws(() => decodeMapTile(new Uint8Array([0])), /./);
});
