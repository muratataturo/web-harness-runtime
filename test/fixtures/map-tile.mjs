// Synthetic 256px PNG for deterministic map transport tests. No third-party tiles.
import { deflateSync } from "node:zlib";
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, payload) {
  const label = Buffer.from(type),
    data = Buffer.concat([label, payload]),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  crc.writeUInt32BE(crc32(data));
  return Buffer.concat([length, data, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(256, 0);
header.writeUInt32BE(256, 4);
header[8] = 8;
header[9] = 2;
const rows = Buffer.alloc(256 * (1 + 256 * 3));
for (let y = 0; y < 256; y++)
  for (let x = 0; x < 256; x++) {
    const p = y * (1 + 256 * 3) + 1 + x * 3;
    rows[p] = x % 64 === 0 || y % 64 === 0 ? 190 : 235;
    rows[p + 1] = x % 64 === 0 || y % 64 === 0 ? 205 : 241;
    rows[p + 2] = x % 64 === 0 || y % 64 === 0 ? 190 : 229;
  }
export const mapTile = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(rows)),
  chunk("IEND", Buffer.alloc(0)),
]);
