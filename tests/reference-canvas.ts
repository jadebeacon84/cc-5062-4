import { BrushStyle, brushCoverage } from '../src/kernel/brush';
import { Rect } from '../src/kernel/geometry';

/**
 * Reference implementation: one monolithic canvas, painted naively. Used only
 * by tests to prove that the tiled kernel produces the same local pixels. It is
 * intentionally simple and allocates the whole image, which is exactly what the
 * real kernel must not do.
 */
export class ReferenceCanvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  paintStroke(points: readonly { x: number; y: number }[], style: BrushStyle): Rect | null {
    if (points.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = Math.ceil(style.radius) + 2;
    const x0 = Math.max(0, Math.floor(minX) - pad);
    const y0 = Math.max(0, Math.floor(minY) - pad);
    const x1 = Math.min(this.width, Math.ceil(maxX) + pad);
    const y1 = Math.min(this.height, Math.ceil(maxY) + pad);
    if (x1 <= x0 || y1 <= y0) return null;
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

    const [cr, cg, cb] = style.color;
    const colorAlpha = style.color[3] / 255;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = distanceToStroke(x + 0.5, y + 0.5, points);
        let a = brushCoverage(d, style.radius, style.hardness) * style.opacity * colorAlpha;
        if (a <= 0) continue;
        if (a > 1) a = 1;
        const o = (y * this.width + x) * 4;
        // The tiled kernel stores each stroke's coverage as 8-bit alpha in the
        // tile overlay, then composites source-over from that byte. Match the
        // same quantization so parity is exact rather than near-exact.
        const a8 = Math.round(a * 255);
        if (a8 === 0) continue;
        const s = a8 / 255;
        const da = this.data[o + 3] / 255;
        const outA = s + da * (1 - s);
        const outA8 = Math.round(outA * 255);
        if (outA8 === 0) continue;
        this.data[o] = Math.round((cr * s + this.data[o] * da * (1 - s)) / outA);
        this.data[o + 1] = Math.round((cg * s + this.data[o + 1] * da * (1 - s)) / outA);
        this.data[o + 2] = Math.round((cb * s + this.data[o + 2] * da * (1 - s)) / outA);
        this.data[o + 3] = outA8;
      }
    }
    return rect;
  }

  sample(x: number, y: number): [number, number, number, number] {
    const o = (y * this.width + x) * 4;
    return [this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3]];
  }
}

function distanceToStroke(px: number, py: number, points: readonly { x: number; y: number }[]): number {
  if (points.length === 1) return Math.hypot(px - points[0].x, py - points[0].y);
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, segDist(px, py, points[i], points[i + 1]));
  }
  return best;
}

function segDist(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
