export type Rect = { x: number; y: number; w: number; h: number };

export const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function isEmptyRect(r: Rect): boolean {
  return r.w <= 0 || r.h <= 0;
}

export function intersectRect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return EMPTY_RECT;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  if (isEmptyRect(a)) return { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRects(rects: Iterable<Rect>): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) out = unionRect(out, r);
  return out;
}

export function expandRect(r: Rect, by: number): Rect {
  if (isEmptyRect(r)) return { ...r };
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function rectArea(r: Rect): number {
  return isEmptyRect(r) ? 0 : r.w * r.h;
}

export function rectFromPoints(
  points: readonly { x: number; y: number }[],
  pad: number
): Rect {
  if (points.length === 0) return EMPTY_RECT;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const x0 = Math.floor(minX) - pad;
  const y0 = Math.floor(minY) - pad;
  // A perfectly axis-aligned stroke has zero extent on one axis but still
  // covers pixels; guarantee at least a one-pixel span on each axis.
  const w = Math.max(1, Math.ceil(maxX) - Math.floor(minX)) + pad * 2;
  const h = Math.max(1, Math.ceil(maxY) - Math.floor(minY)) + pad * 2;
  return { x: x0, y: y0, w, h };
}

/** Tile grid. Tile pixel size is fixed; the grid covers the whole logical canvas. */
export class TileGrid {
  readonly tileSize: number;
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;

  constructor(width: number, height: number, tileSize: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
      throw new RangeError('canvas dimensions must be positive integers');
    if (!Number.isInteger(tileSize) || tileSize <= 0) throw new RangeError('tileSize must be a positive integer');
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    this.cols = Math.ceil(width / tileSize);
    this.rows = Math.ceil(height / tileSize);
  }

  get tileCount(): number {
    return this.cols * this.rows;
  }

  tileKey(tx: number, ty: number): string {
    return `${tx},${ty}`;
  }

  parseKey(key: string): [number, number] {
    const i = key.indexOf(',');
    return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
  }

  /** Width/height of an edge tile in pixels. */
  tilePixelWidth(tx: number): number {
    return Math.min(this.tileSize, this.width - tx * this.tileSize);
  }

  tilePixelHeight(ty: number): number {
    return Math.min(this.tileSize, this.height - ty * this.tileSize);
  }

  tileRect(tx: number, ty: number): Rect {
    return {
      x: tx * this.tileSize,
      y: ty * this.tileSize,
      w: this.tilePixelWidth(tx),
      h: this.tilePixelHeight(ty),
    };
  }

  /** Inclusive tile index range intersecting a canvas-space rect. */
  tilesForRect(r: Rect): { x0: number; y0: number; x1: number; y1: number } | null {
    if (r.w <= 0 || r.h <= 0) return null;
    const x0 = Math.max(0, Math.floor(r.x / this.tileSize));
    const y0 = Math.max(0, Math.floor(r.y / this.tileSize));
    const x1 = Math.min(this.cols - 1, Math.floor((r.x + r.w - 1) / this.tileSize));
    const y1 = Math.min(this.rows - 1, Math.floor((r.y + r.h - 1) / this.tileSize));
    if (x1 < x0 || y1 < y0) return null;
    return { x0, y0, x1, y1 };
  }

  /** Clip a rect into the canvas bounds. */
  clipToCanvas(r: Rect): Rect {
    return intersectRect(r, { x: 0, y: 0, w: this.width, h: this.height });
  }

  /** Iterate every tile intersected by a rect, giving both indices and clipped local rect. */
  forEachTileInRect(
    r: Rect,
    fn: (tx: number, ty: number, tileRect: Rect, localRect: Rect) => void
  ): void {
    const range = this.tilesForRect(r);
    if (!range) return;
    for (let ty = range.y0; ty <= range.y1; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) {
        const tr = this.tileRect(tx, ty);
        const local = intersectRect(r, tr);
        if (isEmptyRect(local)) continue;
        fn(tx, ty, tr, {
          x: local.x - tr.x,
          y: local.y - tr.y,
          w: local.w,
          h: local.h,
        });
      }
    }
  }
}
