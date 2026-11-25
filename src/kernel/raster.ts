import { Rect, TileGrid, rectFromPoints } from './geometry';
import { BrushStyle, brushCoverage } from './brush';

export interface StrokeInput {
  id: string;
  points: readonly { x: number; y: number }[];
  style: BrushStyle;
  /** Stable seed for any stochastic brush behaviour. */
  seed?: number;
}

export interface TileRef {
  tx: number;
  ty: number;
}

export interface DirtyRegion {
  tx: number;
  ty: number;
  local: Rect;
}

/** Result of applying a stroke: the tiles and exact local regions changed. */
export interface RasterResult {
  tiles: Map<string, { tx: number; ty: number; local: Rect }>;
  bounds: Rect | null;
  pixelsTouched: number;
}

/**
 * Segment lookup for per-pixel coverage. Segments are sorted by the minimum X of
 * their padded bounding box and paired with a running maximum X, which lets a
 * binary search skip every segment whose box ends left of the query pixel. This
 * keeps memory linear in the number of stroke points (a long straight stroke is
 * a handful of segments) instead of proportional to the stroke's area.
 */
class SegmentIndex {
  private readonly xs: Float64Array;
  private readonly x0: Float64Array;
  private readonly x1: Float64Array;
  private readonly y0: Float64Array;
  private readonly y1: Float64Array;
  private readonly ax: Float64Array;
  private readonly ay: Float64Array;
  private readonly bx: Float64Array;
  private readonly by: Float64Array;
  private readonly prefixMaxX: Float64Array;
  private readonly count: number;
  private readonly pointCount: number;
  private readonly single: { x: number; y: number } | null;

  constructor(points: readonly { x: number; y: number }[], radius: number) {
    this.pointCount = points.length;
    this.single = points.length === 1 ? points[0] : null;
    const n = Math.max(0, points.length - 1);
    this.count = n;
    const pad = radius + 2;
    const order: number[] = [];
    for (let i = 0; i < n; i++) order.push(i);
    const a = points;
    order.sort((i, j) => Math.min(a[i].x, a[i + 1].x) - Math.min(a[j].x, a[j + 1].x));
    this.ax = new Float64Array(n);
    this.ay = new Float64Array(n);
    this.bx = new Float64Array(n);
    this.by = new Float64Array(n);
    this.x0 = new Float64Array(n);
    this.x1 = new Float64Array(n);
    this.y0 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.xs = new Float64Array(n);
    this.prefixMaxX = new Float64Array(n);
    let maxX = -Infinity;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const p = a[i];
      const q = a[i + 1];
      this.ax[k] = p.x;
      this.ay[k] = p.y;
      this.bx[k] = q.x;
      this.by[k] = q.y;
      this.x0[k] = Math.min(p.x, q.x) - pad;
      this.x1[k] = Math.max(p.x, q.x) + pad;
      this.y0[k] = Math.min(p.y, q.y) - pad;
      this.y1[k] = Math.max(p.y, q.y) + pad;
      this.xs[k] = this.x0[k];
      maxX = Math.max(maxX, this.x1[k]);
      this.prefixMaxX[k] = maxX;
    }
  }

  /** Closest distance from a pixel center to the stroke, or Infinity if far. */
  distance(px: number, py: number): number {
    if (this.pointCount === 0) return Infinity;
    if (this.pointCount === 1) {
      return Math.hypot(px - this.single!.x, py - this.single!.y);
    }
    // Binary search for the last segment whose padded box starts at/before px.
    let lo = 0;
    let hi = this.count - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.xs[mid] <= px) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (last < 0) return Infinity;
    let best = Infinity;
    for (let k = last; k >= 0; k--) {
      // Once the running max right edge is left of px, no earlier segment can
      // contain px either.
      if (this.prefixMaxX[k] < px) break;
      if (this.x1[k] < px || this.y1[k] < py || this.y0[k] > py) continue;
      const d = segDist(px, py, this.ax[k], this.ay[k], this.bx[k], this.by[k]);
      if (d < best) best = d;
    }
    return best;
  }
}

function boundsOf(points: readonly { x: number; y: number }[], radius: number): Rect {
  return rectFromPoints(points, Math.ceil(radius) + 2);
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Rasterizes a whole stroke once and returns per-tile RGBA overlays. The overlay
 * for a tile depends only on absolute stroke geometry and that tile's origin, so
 * the same stroke produces identical pixels no matter how tiles are partitioned
 * or how many tiles were evicted from memory in between.
 */
export interface StrokePlan {
  /** Ideal, unbounded stroke bounds clipped to the canvas. */
  bounds: Rect;
  /** Tile list in row-major order. */
  tiles: { key: string; tx: number; ty: number; local: Rect }[];
  /** Total full-resolution pixels inside the touched local regions. */
  pixelsPlanned: number;
}

/**
 * Computes which tiles a stroke can affect without producing pixel buffers.
 * This is the only allocation proportional to the stroke's footprint, and it
 * scales with the stroke, never with the canvas.
 */
export function planStroke(input: StrokeInput, grid: TileGrid): StrokePlan {
  if (input.points.length === 0) return { bounds: { x: 0, y: 0, w: 0, h: 0 }, tiles: [], pixelsPlanned: 0 };
  const bounds = grid.clipToCanvas(boundsOf(input.points, input.style.radius));
  if (bounds.w <= 0 || bounds.h <= 0)
    return { bounds, tiles: [], pixelsPlanned: 0 };

  // Collect the tiles the stroke's geometry actually touches. Walking the
  // stroke segments (each padded by the brush radius, snapped to the tile grid)
  // costs work proportional to the stroke length, not to the area of its
  // bounding box: a thin diagonal across a huge canvas touches only the tiles
  // under the line, never the millions inside the box.
  const pad = input.style.radius + 2;
  const ts = grid.tileSize;
  // Per-tile tight local rect: the union of the stroke's padded chunk boxes
  // clipped to that tile. This keeps each tile's rendered region as small as
  // the ink it actually contains, so a thin diagonal crossing a tile's corner
  // renders a few pixels, not a full 128x128 tile.
  const locals = new Map<string, { tx: number; ty: number; local: Rect }>();
  const addBox = (bx0: number, by0: number, bx1: number, by1: number) => {
    const tx0 = Math.max(0, Math.floor(bx0 / ts));
    const ty0 = Math.max(0, Math.floor(by0 / ts));
    const tx1 = Math.min(grid.cols - 1, Math.floor(bx1 / ts));
    const ty1 = Math.min(grid.rows - 1, Math.floor(by1 / ts));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tileRect = { x: tx * ts, y: ty * ts, w: grid.tilePixelWidth(tx), h: grid.tilePixelHeight(ty) };
        const box = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
        const hit = intersectTwo(tileRect, box);
        if (hit.w <= 0 || hit.h <= 0) continue;
        const key = grid.tileKey(tx, ty);
        const prev = locals.get(key);
        // Snap to whole pixels: local rects drive pixel buffers, and a fraction
        // would silently clip exactly the fringe pixels the brush needs.
        const px0 = Math.floor(hit.x - tileRect.x);
        const py0 = Math.floor(hit.y - tileRect.y);
        const px1 = Math.ceil(hit.x + hit.w - tileRect.x);
        const py1 = Math.ceil(hit.y + hit.h - tileRect.y);
        if (!prev) {
          locals.set(key, { tx, ty, local: { x: px0, y: py0, w: px1 - px0, h: py1 - py0 } });
        } else {
          const l = prev.local;
          const nx0 = Math.min(l.x, px0);
          const ny0 = Math.min(l.y, py0);
          const nx1 = Math.max(l.x + l.w, px1);
          const ny1 = Math.max(l.y + l.h, py1);
          prev.local = { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
        }
      }
    }
  };
  const pts = input.points;
  if (pts.length === 1) {
    addBox(pts[0].x - pad, pts[0].y - pad, pts[0].x + pad, pts[0].y + pad);
  } else {
    // Subdivide each segment into chunks no longer than the brush pad and add
    // each chunk's padded bounding box. A chunk's box is small (O(pad^2)), so
    // a long segment only marks the tiles along the line, never the tiles
    // filling its axis-aligned bounding rectangle.
    const step = Math.max(1, pad * 0.75);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        const ax = a.x + (b.x - a.x) * t0;
        const ay = a.y + (b.y - a.y) * t0;
        const bx = a.x + (b.x - a.x) * t1;
        const by = a.y + (b.y - a.y) * t1;
        addBox(
          Math.min(ax, bx) - pad,
          Math.min(ay, by) - pad,
          Math.max(ax, bx) + pad,
          Math.max(ay, by) + pad
        );
      }
    }
  }

  const tiles: StrokePlan['tiles'] = [];
  let pixelsPlanned = 0;
  // Clamp the tight local rects to the canvas bounds (strokes may go negative).
  for (const [key, t] of locals) {
    const tileRect = grid.tileRect(t.tx, t.ty);
    const canvasLocal = intersectTwo(tileRect, bounds);
    if (canvasLocal.w <= 0 || canvasLocal.h <= 0) continue;
    const x0 = Math.max(t.local.x, canvasLocal.x - tileRect.x);
    const y0 = Math.max(t.local.y, canvasLocal.y - tileRect.y);
    const x1 = Math.min(t.local.x + t.local.w, canvasLocal.x + canvasLocal.w - tileRect.x);
    const y1 = Math.min(t.local.y + t.local.h, canvasLocal.y + canvasLocal.h - tileRect.y);
    if (x1 <= x0 || y1 <= y0) continue;
    tiles.push({ key, tx: t.tx, ty: t.ty, local: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
    pixelsPlanned += (x1 - x0) * (y1 - y0);
  }
  tiles.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
  return { bounds, tiles, pixelsPlanned };
}

function intersectTwo(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface StrokeTileRenderer {
  plan: StrokePlan;
  /** Render one tile's RGBA overlay on demand and release it from the caller. */
  renderTile(tile: { tx: number; ty: number; local: Rect }): Uint8ClampedArray;
}

/**
 * Streaming rasterizer. The segment index is built once for the whole stroke;
 * overlays are produced one tile at a time so peak memory is one tile overlay,
 * independent of how many tiles the stroke crosses.
 */
export function createStrokeRenderer(input: StrokeInput, grid: TileGrid): StrokeTileRenderer {
  const plan = planStroke(input, grid);
  const index = new SegmentIndex(input.points, input.style.radius);
  return {
    plan,
    renderTile(tile) {
      return renderTileOverlay(input, index, grid.tileRect(tile.tx, tile.ty), tile.local);
    },
  };
}

/** Convenience for tests: render the whole stroke, one overlay per tile. */
export function rasterizeStroke(
  input: StrokeInput,
  grid: TileGrid
): { result: RasterResult; overlays: Map<string, Uint8ClampedArray> } {
  const renderer = createStrokeRenderer(input, grid);
  const overlays = new Map<string, Uint8ClampedArray>();
  const tiles = new Map<string, { tx: number; ty: number; local: Rect }>();
  for (const t of renderer.plan.tiles) {
    const out = renderer.renderTile(t);
    // A tile entirely outside the geometric ink is omitted.
    if (tileHasInk(out)) {
      overlays.set(t.key, out);
      tiles.set(t.key, { tx: t.tx, ty: t.ty, local: t.local });
    }
  }
  let pixelsTouched = 0;
  for (const t of tiles.values()) pixelsTouched += t.local.w * t.local.h;
  return {
    result: { tiles, bounds: renderer.plan.bounds, pixelsTouched },
    overlays,
  };
}

function tileHasInk(overlay: Uint8ClampedArray): boolean {
  for (let i = 3; i < overlay.length; i += 4) if (overlay[i] !== 0) return true;
  return false;
}

function renderTileOverlay(
  input: StrokeInput,
  index: SegmentIndex,
  tileRect: Rect,
  local: Rect
): Uint8ClampedArray {
  const { style } = input;
  const [cr, cg, cb] = style.color;
  const colorAlpha = style.color[3] / 255;
  const radius = style.radius;
  const hardness = style.hardness;
  const opacity = style.opacity;

  const out = new Uint8ClampedArray(local.w * local.h * 4);
  let wrote = false;
  for (let y = 0; y < local.h; y++) {
    for (let x = 0; x < local.w; x++) {
      const px = tileRect.x + local.x + x;
      const py = tileRect.y + local.y + y;
      const d = index.distance(px + 0.5, py + 0.5);
      if (!Number.isFinite(d)) continue;
      let a = brushCoverage(d, radius, hardness) * opacity * colorAlpha;
      if (a <= 0) continue;
      if (a > 1) a = 1;
      const o = (y * local.w + x) * 4;
      out[o] = cr;
      out[o + 1] = cg;
      out[o + 2] = cb;
      out[o + 3] = Math.round(a * 255);
      wrote = true;
    }
  }
  if (!wrote) return new Uint8ClampedArray(0);
  return out;
}
