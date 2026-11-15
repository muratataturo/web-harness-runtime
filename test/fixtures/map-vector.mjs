// Synthetic geometry only. CI never fetches public map tiles.
import { PbfWriter } from "pbf";
const w = new PbfWriter();
function geometry(points, polygon) {
  let x = 0,
    y = 0;
  const out = [];
  points.forEach(([nx, ny], i) => {
    out.push(i === 0 ? 9 : 10);
    const dx = nx - x,
      dy = ny - y;
    out.push((dx << 1) ^ (dx >> 31), (dy << 1) ^ (dy >> 31));
    x = nx;
    y = ny;
  });
  if (polygon) out.push(15);
  return out;
}
for (const [name, type, points] of [
  [
    "building",
    3,
    [
      [200, 200],
      [1100, 200],
      [1100, 1200],
      [200, 1200],
    ],
  ],
  [
    "waterarea",
    3,
    [
      [2600, 0],
      [4096, 0],
      [4096, 4096],
      [2600, 4096],
    ],
  ],
  [
    "road",
    2,
    [
      [0, 2000],
      [4096, 2000],
    ],
  ],
  ["label", 1, [[2000, 2000]]],
])
  w.writeMessage(
    3,
    (_, l) => {
      l.writeStringField(1, name);
      l.writeVarintField(15, 2);
      l.writeVarintField(5, 4096);
      l.writeMessage(
        2,
        (_, f) => {
          f.writeVarintField(3, type);
          f.writePackedVarint(4, geometry(points, type === 3));
        },
        null,
      );
    },
    null,
  );
export const mapVector = Buffer.from(w.finish());
