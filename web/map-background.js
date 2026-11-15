import { decodeMapTile, paintMapTile } from "./vector-map.js";
/** Background geography is a trusted presentation choice, never model-supplied URLs.
 * GSI supports CORS (including file:// Origin:null) and requires visible attribution.
 * Outside its Japan coverage the sourced points remain on a schematic canvas.
 */
export function backgroundFor(stops) {
  const points = stops.flatMap((s) => (s.coordinates ? [s.coordinates] : []));
  if (
    !points.length ||
    !points.every(
      (p) => p.lat >= 20 && p.lat <= 46 && p.lon >= 122 && p.lon <= 154,
    )
  )
    return null;
  return {
    id: "gsi-vector-clean",
    name: "地理院タイル",
    url: "https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf",
    minZoom: 5,
    maxNativeZoom: 16,
    maxZoom: 18,
    attribution:
      '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>',
  };
}
export class TileError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "TileError";
    this.reason = reason;
  }
}
/** An <img> can display an HTTP 403 PNG and still fire load. Check status before
 * assigning any image source; opaque/no-cors responses are intentionally refused. */
export async function fetchTilePng(url, { signal, fetcher = fetch } = {}) {
  const response = await fetcher(url, {
    mode: "cors",
    credentials: "omit",
    cache: "default",
    redirect: "error",
    signal,
  });
  if (response.type === "opaque" || response.status !== 200) {
    await response.body?.cancel();
    throw new TileError(`HTTP ${response.status || "unavailable"}`);
  }
  const limit = 512 * 1024;
  if (
    !/^image\/png(?:;|$)/i.test(response.headers.get("content-type") ?? "") ||
    Number(response.headers.get("content-length")) > limit
  ) {
    await response.body?.cancel();
    throw new TileError("invalid-image");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TileError("empty-image");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new TileError("image-too-large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const view = new DataView(bytes.buffer);
  if (
    size < 33 ||
    !signature.every((n, i) => bytes[i] === n) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR" ||
    view.getUint32(16) !== 256 ||
    view.getUint32(20) !== 256
  )
    throw new TileError("invalid-png");
  return new Blob([bytes], { type: "image/png" });
}
/** CORS/status/size limits are checked before decoding, including error PNGs. */
export async function fetchVectorTile(url, { signal, fetcher = fetch } = {}) {
  const response = await fetcher(url, {
    mode: "cors",
    credentials: "omit",
    cache: "default",
    redirect: "error",
    signal,
  });
  if (response.type === "opaque" || response.status !== 200) {
    await response.body?.cancel();
    throw new TileError(`HTTP ${response.status || "unavailable"}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (
    !/^(?:application\/(?:octet-stream|x-protobuf|vnd.mapbox-vector-tile)|binary\/octet-stream)(?:;|$)/i.test(
      type,
    ) ||
    Number(response.headers.get("content-length")) > 2 * 1024 * 1024
  ) {
    await response.body?.cancel();
    throw new TileError("invalid-vector");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TileError("empty-vector");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new TileError("vector-too-large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return decodeMapTile(bytes);
  } catch {
    throw new TileError("invalid-vector");
  }
}

/** One failure stops the whole background. No provider rotation, proxy, spoofed
 * headers, or automatic retries. Pins and visit order are separate Leaflet layers. */
export function verifiedTileLayer(L, provider, onFailure) {
  let stopped = false;
  const pending = new Set(),
    states = new WeakMap();
  const dispose = (state) => {
    if (state.disposed) return;
    state.disposed = true;
    clearTimeout(state.timer);
    state.controller.abort();
    if (state.url) URL.revokeObjectURL(state.url);
    pending.delete(state);
  };
  const Layer = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("canvas");
      tile.setAttribute("aria-hidden", "true");
      tile.setAttribute("role", "presentation");
      const state = {
        controller: new AbortController(),
        disposed: false,
        url: null,
        timer: null,
      };
      states.set(tile, state);
      pending.add(state);
      if (stopped) {
        dispose(state);
        return tile;
      }
      state.timer = setTimeout(() => state.controller.abort(), 8000);
      const fail = (error) => {
        if (state.disposed || stopped) return;
        stopped = true;
        dispose(state);
        for (const other of [...pending]) dispose(other);
        done(error, tile);
        onFailure(
          error instanceof TileError ? error.reason : "network-or-timeout",
        );
      };
      fetchVectorTile(this.getTileUrl(coords), {
        signal: state.controller.signal,
      })
        .then((layers) => {
          if (state.disposed || stopped) return;
          try {
            paintMapTile(
              tile,
              layers,
              Math.min(window.devicePixelRatio || 1, 2),
            );
            tile.dataset.vectorReady = "true";
            dispose(state);
            done(null, tile);
          } catch {
            fail(new TileError("vector-render"));
          }
        })
        .catch(fail);
      return tile;
    },
  });
  const layer = new Layer(provider.url, {
    minZoom: provider.minZoom,
    maxZoom: provider.maxZoom,
    maxNativeZoom: provider.maxNativeZoom,
    attribution: provider.attribution,
    updateWhenIdle: true,
    keepBuffer: 0,
  });
  layer.on("tileunload", ({ tile }) => {
    const state = states.get(tile);
    if (state) dispose(state);
  });
  layer.on("remove", () => {
    stopped = true;
    for (const state of [...pending]) dispose(state);
  });
  return layer;
}
