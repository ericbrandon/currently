// Small planar-geometry helpers for viewport ∩ zone-polygon tests.
// Lon/lat treated as plain x/y — fine at BC-coast scale, no antimeridian.

export type Ring = [number, number][];
export type Rect = [number, number, number, number]; // [w, s, e, n]

export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function orient(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): number {
  return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

/** Proper or improper intersection of segments AB and CD. */
export function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear touching cases — good enough to treat bounding-range
  // overlap as intersection for our purposes.
  const onSeg = (
    px: number, py: number, qx: number, qy: number, rx: number, ry: number,
  ) =>
    Math.min(px, qx) <= rx && rx <= Math.max(px, qx) &&
    Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
  if (o1 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true;
  if (o2 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true;
  if (o3 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
  if (o4 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

/** Exact test: does the polygon's outer ring intersect the rectangle?
 *  Three cases cover all configurations:
 *    1. a polygon vertex lies inside the rect,
 *    2. a rect corner lies inside the polygon (rect fully inside),
 *    3. a polygon edge crosses a rect edge (band through the middle —
 *       neither vertex set inside the other; this is exactly the case a
 *       bounding-box test gets wrong for long diagonal zones). */
export function polygonIntersectsRect(ring: Ring, rect: Rect): boolean {
  const [w, s, e, n] = rect;
  for (const [x, y] of ring) {
    if (x >= w && x <= e && y >= s && y <= n) return true;
  }
  if (pointInRing(w, s, ring)) return true;
  const rectEdges: [number, number, number, number][] = [
    [w, s, e, s],
    [e, s, e, n],
    [e, n, w, n],
    [w, n, w, s],
  ];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    for (const [cx, cy, dx, dy] of rectEdges) {
      if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return true;
    }
  }
  return false;
}
