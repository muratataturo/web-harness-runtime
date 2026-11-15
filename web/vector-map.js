import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
export const mapPalette = {
  land: "#f5f7f3",
  building: "#e6e5dd",
  water: "#c6dff2",
  road: "#fffefa",
  roadEdge: "#dedcd2",
  rail: "#d0d2c7",
};
/** Decode only the layers we draw; labels/symbols and their payloads never reach HTML. */
export function decodeMapTile(bytes) {
  const tile = new VectorTile(new PbfReader(bytes)),
    layers = [];
  let features = 0,
    vertices = 0;
  for (const name of ["building", "waterarea", "river", "road", "railway"]) {
    const source = tile.layers[name];
    if (!source) continue;
    if ((features += source.length) > 18000)
      throw Error("vector-feature-limit");
    const out = [];
    for (let i = 0; i < source.length; i++) {
      const f = source.feature(i);
      if (f.type !== 2 && f.type !== 3) continue;
      const geometry = f.loadGeometry();
      for (const ring of geometry) {
        vertices += ring.length;
        if (vertices > 500000) throw Error("vector-geometry-limit");
      }
      out.push({
        type: f.type,
        code: Number(f.properties.ftCode),
        width: Number(f.properties.rnkWidth ?? 0),
        geometry,
      });
    }
    layers.push({ name, extent: source.extent, features: out });
  }
  if (!layers.length) throw Error("empty-vector-tile");
  return layers;
}
export function paintMapTile(canvas, layers, pixelRatio = 1) {
  const size = 256;
  canvas.width = size * pixelRatio;
  canvas.height = size * pixelRatio;
  const c = canvas.getContext("2d");
  if (!c) throw Error("canvas-unavailable");
  c.scale(pixelRatio, pixelRatio);
  c.fillStyle = mapPalette.land;
  c.fillRect(0, 0, size, size);
  c.lineCap = "round";
  c.lineJoin = "round";
  const path = (feature, extent) => {
    c.beginPath();
    for (const ring of feature.geometry) {
      ring.forEach((p, i) => {
        const x = (p.x * size) / extent,
          y = (p.y * size) / extent;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      if (feature.type === 3) c.closePath();
    }
  };
  for (const layer of layers) {
    for (const f of layer.features) {
      path(f, layer.extent);
      if (layer.name === "building") {
        if (f.type === 3) {
          c.fillStyle = mapPalette.building;
          c.fill("evenodd");
        }
      } else if (layer.name === "waterarea") {
        c.fillStyle = mapPalette.water;
        c.fill("evenodd");
      } else if (layer.name === "river") {
        c.strokeStyle = mapPalette.water;
        c.lineWidth = 1;
        c.stroke();
      } else if (layer.name === "road") {
        c.strokeStyle = mapPalette.roadEdge;
        c.lineWidth = 1.5;
        c.stroke();
        c.strokeStyle = mapPalette.road;
        c.lineWidth = f.code >= 2700 ? 2.8 : 0.8;
        c.stroke();
      } else if (layer.name === "railway") {
        c.strokeStyle = mapPalette.rail;
        c.lineWidth = 1.6;
        c.stroke();
        c.strokeStyle = mapPalette.land;
        c.lineWidth = 0.5;
        c.setLineDash([2, 3]);
        c.stroke();
        c.setLineDash([]);
      }
    }
  }
}
