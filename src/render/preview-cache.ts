import { TiledDocument } from '../kernel/document';

interface Level {
  factor: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** Total pixels across all preview levels. Separate from the base-tile budget. */
export const PREVIEW_BUDGET_BYTES = 24 * 1024 * 1024;
/**
 * Above this display scale, base tiles are drawn instead of the preview layer.
 * At 1:2 a 256px tile covers 128 screen px, so resident tiles read sharply.
 */
export const PREVIEW_MAX_SCALE = 0.5;

/**
 * A coarse, zoomed-out view built by downsampling committed tiles.
 *
 * This layer exists only for display when a screen pixel covers many canvas
 * pixels, where decoding every 256px base tile would exceed the memory budget.
 * It is strictly derived from committed tile bytes and is never a source of
 * truth: undo and export always go back to the base tiles.
 *
 * Memory is bounded by construction: levels are chosen coarsest-first under a
 * fixed byte budget, independent of how large the logical canvas is.
 */
export class PreviewCache {
  private readonly levels: Level[] = [];
  private pending = new Set<string>();
  private flushHandle = 0;
  private flushing = false;
  private lastLevel = 0;
  private readonly onUpdate?: () => void;

  constructor(
    private readonly doc: TiledDocument,
    opts: { budgetBytes?: number; onUpdate?: () => void } = {}
  ) {
    const budget = opts.budgetBytes ?? PREVIEW_BUDGET_BYTES;
    this.onUpdate = opts.onUpdate;

    const candidates: { factor: number; w: number; h: number; bytes: number }[] = [];
    let factor = 2;
    for (;;) {
      const w = Math.ceil(doc.width / factor);
      const h = Math.ceil(doc.height / factor);
      candidates.push({ factor, w, h, bytes: w * h * 4 });
      if (w <= 512 && h <= 512) break;
      if (factor > Math.max(doc.width, doc.height)) break;
      factor *= 2;
    }
    // Coarsest first, so a bounded budget always yields a full-canvas view.
    candidates.sort((a, b) => b.factor - a.factor);
    let used = 0;
    const chosen: typeof candidates = [];
    for (const c of candidates) {
      if (c.bytes > budget && chosen.length > 0) continue;
      if (used + c.bytes > budget && chosen.length > 0) continue;
      chosen.push(c);
      used += c.bytes;
    }
    chosen.sort((a, b) => a.factor - b.factor);
    for (const c of chosen) this.levels.push(this.makeLevel(c.factor, c.w, c.h));
  }

  private makeLevel(factor: number, w: number, h: number): Level {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    return { factor, canvas, ctx };
  }

  get levelCount(): number {
    return this.levels.length;
  }

  /** Backing-store bytes across all levels (bounded by the constructor budget). */
  get pixelBytes(): number {
    let n = 0;
    for (const l of this.levels) n += l.canvas.width * l.canvas.height * 4;
    return n;
  }

  get activeFactor(): number {
    return this.lastLevel;
  }

  /**
   * Finest level that still has at least display resolution, else the finest
   * available (upscaled slightly, which is preferable to blank paper). Unless
   * `force`, returns null at 1:2 zoom and above so base tiles are used.
   */
  levelForScale(scale: number, force = false): Level | null {
    if (this.levels.length === 0) return null;
    if (!force && scale >= PREVIEW_MAX_SCALE) return null;
    const needed = 1 / Math.max(scale, 1e-9);
    let best: Level | null = null;
    for (const l of this.levels) {
      if (l.factor <= needed && (!best || l.factor > best.factor)) best = l;
    }
    return best ?? this.levels[0]!;
  }

  /** Mark a committed tile for redraw at every level. */
  markTile(key: string): void {
    this.pending.add(key);
    this.scheduleFlush();
  }

  /** Redraw from pixels that are already decoded (commit fast path). */
  updateFromPixels(
    key: string,
    tx: number,
    ty: number,
    pixels: Uint8ClampedArray,
    w: number,
    h: number
  ): void {
    this.blit(tx, ty, pixels, w, h);
    this.pending.delete(key);
  }

  private blit(tx: number, ty: number, pixels: Uint8ClampedArray, w: number, h: number): void {
    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
    const x = tx * this.doc.tileSize;
    const y = ty * this.doc.tileSize;
    for (const l of this.levels) {
      const dx = x / l.factor;
      const dy = y / l.factor;
      const dw = w / l.factor;
      const dh = h / l.factor;
      l.ctx.clearRect(dx, dy, dw, dh);
      l.ctx.drawImage(src, dx, dy, dw, dh);
    }
  }

  private clearTile(tx: number, ty: number): void {
    const x = tx * this.doc.tileSize;
    const y = ty * this.doc.tileSize;
    for (const l of this.levels) {
      const s = this.doc.tileSize / l.factor + 1;
      l.ctx.clearRect(x / l.factor, y / l.factor, s, s);
    }
  }

  /** Rebuild pending tiles by reading committed bytes from the store. */
  private scheduleFlush(): void {
    if (this.flushHandle) return;
    this.flushHandle = window.setTimeout(() => {
      this.flushHandle = 0;
      void this.flush();
    }, 40);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const keys = [...this.pending];
    this.pending.clear();
    try {
      for (const key of keys) {
        const [tx, ty] = this.doc.grid.parseKey(key);
        const pixels = await this.doc.readCommittedTile(key).catch(() => null);
        if (!pixels) {
          this.clearTile(tx, ty);
          continue;
        }
        this.updateFromPixels(
          key,
          tx,
          ty,
          pixels,
          this.doc.grid.tilePixelWidth(tx),
          this.doc.grid.tilePixelHeight(ty)
        );
      }
    } finally {
      this.flushing = false;
      if (this.pending.size > 0) this.scheduleFlush();
      else this.onUpdate?.();
    }
  }

  clear(): void {
    this.pending.clear();
    for (const l of this.levels) l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
  }

  /** Build preview state for every currently committed tile (project open). */
  async rebuildAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const keys = this.doc.committedTileKeys();
    let done = 0;
    for (const key of keys) {
      const [tx, ty] = this.doc.grid.parseKey(key);
      const pixels = await this.doc.readCommittedTile(key).catch(() => null);
      if (pixels) {
        this.blit(tx, ty, pixels, this.doc.grid.tilePixelWidth(tx), this.doc.grid.tilePixelHeight(ty));
      }
      done++;
      if (done % 32 === 0 || done === keys.length) {
        onProgress?.(done, keys.length);
        this.onUpdate?.();
      }
      if (done % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    onProgress?.(done, keys.length);
  }

  /**
   * Draw the zoom layer for this viewport. Returns the downsample factor used,
   * or 0 when base tiles should be drawn instead.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    vp: { x: number; y: number; scale: number },
    destW: number,
    destH: number,
    force = false
  ): number {
    const level = this.levelForScale(vp.scale, force);
    if (!level) return 0;
    const f = level.factor;
    const sw = destW / (vp.scale * f);
    const sh = destH / (vp.scale * f);
    if (sw <= 0 || sh <= 0) return 0;
    this.lastLevel = f;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(level.canvas, vp.x / f, vp.y / f, sw, sh, 0, 0, destW, destH);
    return f;
  }
}
