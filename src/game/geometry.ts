/** Does the segment A→B pass within r of the point C? (Blade vs fruit.) */
export function segmentHitsCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((cx - ax) * dx + (cy - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const px = ax + t * dx;
  const py = ay + t * dy;
  const ex = cx - px;
  const ey = cy - py;
  return ex * ex + ey * ey <= r * r;
}
