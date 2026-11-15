/** Display curves express visit order only. Endpoints remain sourced coordinates. */
export function visitCurve(map, from, to, index) {
  const a = map.project(from, 16),
    b = map.project(to, 16),
    dx = b.x - a.x,
    dy = b.y - a.y;
  const bend = index % 2 === 0 ? 0.12 : -0.12,
    c = { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend };
  return Array.from({ length: 25 }, (_, i) => {
    const t = i / 24,
      u = 1 - t;
    return map.unproject(
      [
        u * u * a.x + 2 * u * t * c.x + t * t * b.x,
        u * u * a.y + 2 * u * t * c.y + t * t * b.y,
      ],
      16,
    );
  });
}
