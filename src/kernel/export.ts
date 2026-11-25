import { Rect, isEmptyRect } from './geometry';
import { TiledDocument } from './document';

export interface ExportOptions {
  /** Region to export; defaults to the painted bounds, or the whole canvas. */
  rect?: Rect;
  /** Background flattened behind transparent pixels, as [r,g,b,a]. */
  background?: readonly [number, number, number, number];
  /** Number of rows rendered per band; controls peak memory of the reader. */
  bandHeight?: number;
  /** Called as bands are produced, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
}

export interface RGBABitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Reads the committed canvas back at full resolution, band by band. Peak memory
 * is one band plus one decoded tile, not the whole image. The emitted pixels are
 * exactly the committed tile bytes — the low-resolution preview is never read.
 */
export async function readBackBitmap(
  doc: TiledDocument,
  opts: ExportOptions = {}
): Promise<RGBABitmap> {
  const rect = doc.grid.clipToCanvas(opts.rect ?? (await doc.paintedBounds()) ?? doc.grid.clipToCanvas({ x: 0, y: 0, w: doc.width, h: doc.height }));
  if (isEmptyRect(rect)) return { width: 0, height: 0, data: new Uint8ClampedArray(0) };
  const band = Math.max(1, opts.bandHeight ?? 256);
  const data = new Uint8ClampedArray(rect.w * rect.h * 4);
  const bmp: RGBABitmap = { width: rect.w, height: rect.h, data };
  let done = 0;
  for (let y = 0; y < rect.h; y += band) {
    const h = Math.min(band, rect.h - y);
    const bandOut = new Uint8ClampedArray(rect.w * h * 4);
    const outRect = { x: rect.x, y: rect.y + y, w: rect.w, h };
    await doc.readPixels(outRect, bandOut, rect.w, { background: opts.background });
    data.set(bandOut, y * rect.w * 4);
    done += h;
    opts.onProgress?.(done, rect.h);
  }
  return bmp;
}

/**
 * Compose a large export from tile reads into a caller-provided sink. Used by
 * the PNG encoder so a full canvas never has to be contiguous in memory.
 */
export async function streamReadBands(
  doc: TiledDocument,
  rect: Rect,
  bandHeight: number,
  sink: (band: Uint8ClampedArray, y: number, h: number) => void | Promise<void>,
  background?: readonly [number, number, number, number]
): Promise<void> {
  const clipped = doc.grid.clipToCanvas(rect);
  if (isEmptyRect(clipped)) return;
  for (let y = 0; y < clipped.h; y += bandHeight) {
    const h = Math.min(bandHeight, clipped.h - y);
    const bandOut = new Uint8ClampedArray(clipped.w * h * 4);
    await doc.readPixels(
      { x: clipped.x, y: clipped.y + y, w: clipped.w, h },
      bandOut,
      clipped.w,
      { background }
    );
    await sink(bandOut, y, h);
  }
}

export interface PreviewLevel {
  /** Downsample factor relative to full resolution (power of two). */
  scale: number;
  width: number;
  height: number;
  /** Full-resolution canvas pixel at (0,0) represented by this level. */
  originX: number;
  originY: number;
}

/**
 * Preview pyramid, stored separately from base tiles. Levels are built from
 * committed pixels only and are used for zoomed-out display and viewport
 * planning. They are never used as a data source for undo or export.
 */
export class PreviewPyramid {
  readonly levels: PreviewLevel[] = [];
  private readonly images = new Map<number, Uint8ClampedArray>();

  constructor(private readonly source: TiledDocument) {
    let scale = 16;
    while (scale >= 1) {
      const width = Math.ceil(source.width / scale);
      const height = Math.ceil(source.height / scale);
      if (width * height <= 8 * 1024 * 1024) {
        this.levels.push({ scale, width, height, originX: 0, originY: 0 });
      }
      scale = Math.floor(scale / 2);
    }
    this.levels.sort((a, b) => b.scale - a.scale);
  }

  /** Build one level from committed base pixels. */
  async buildLevel(scale: number, opts: { maxPixels?: number } = {}): Promise<Uint8ClampedArray | null> {
    const level = this.levels.find((l) => l.scale === scale);
    if (!level) return null;
    const maxPixels = opts.maxPixels ?? 4 * 1024 * 1024;
    if (level.width * level.height > maxPixels) return null;
    const out = new Uint8ClampedArray(level.width * level.height * 4);
    // Sample the center pixel of each source cell; preview is approximate by
    // design, and is explicitly not a source of truth for undo/export.
    const source = this.source;
    for (let y = 0; y < level.height; y++) {
      const rectRow = { x: 0, y: y * scale, w: source.width, h: Math.min(scale, source.height - y * scale) };
      const rowPixels = new Uint8ClampedArray(rectRow.w * rectRow.h * 4);
      await source.readPixels(rectRow, rowPixels, rectRow.w);
      const sy = Math.floor(rectRow.h / 2);
      for (let x = 0; x < level.width; x++) {
        const sx = Math.min(rectRow.w - 1, x * scale + Math.floor(scale / 2));
        const src = (sy * rectRow.w + sx) * 4;
        const dst = (y * level.width + x) * 4;
        out[dst] = rowPixels[src];
        out[dst + 1] = rowPixels[src + 1];
        out[dst + 2] = rowPixels[src + 2];
        out[dst + 3] = rowPixels[src + 3];
      }
    }
    this.images.set(scale, out);
    return out;
  }

  getImage(scale: number): Uint8ClampedArray | null {
    return this.images.get(scale) ?? null;
  }

  has(scale: number): boolean {
    return this.images.has(scale);
  }

  clear(): void {
    this.images.clear();
  }
}
