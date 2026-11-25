import { Rect } from '../kernel/geometry';
import { TiledDocument } from '../kernel/document';
import { PreviewCache } from './preview-cache';

/** Upper bound on base-tile keys materialized for one frame. */
const MAX_VISIBLE_TILE_KEYS = 8192;

export interface Viewport {
  /** Canvas pixel at the top-left of the view. */
  x: number;
  y: number;
  /** Device pixels per canvas pixel. */
  scale: number;
}

export interface RenderStats {
  tilesDrawn: number;
  tilesMissing: number;
  drawCalls: number;
  lastFrameMs: number;
  visibleTiles: number;
  totalTilesInView: number;
  /** Preview downsample factor used this frame, 0 when drawing base tiles. */
  previewFactor: number;
}

/**
 * Draws the current viewport from committed tiles. At any zoom each visible
 * tile is drawn only when it is decoded in memory; undecoded or unpainted tiles
 * leave the paper background showing, and a background loader fills them in.
 * When a tile is too large to be worth drawing at this zoom (zoomed in), only
 * the visible sub-rect is blitted. When zoomed far out, tiny samples are drawn.
 */
export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly paper: HTMLCanvasElement;
  private stats: RenderStats = {
    tilesDrawn: 0,
    tilesMissing: 0,
    drawCalls: 0,
    lastFrameMs: 0,
    visibleTiles: 0,
    totalTilesInView: 0,
    previewFactor: 0,
  };
  private dpr = 1;
  /** Derived zoom layer. Never persisted and never consulted for undo/export. */
  readonly preview: PreviewCache;
  /** Called after the preview layer changes, so the app can schedule a frame. */
  onPreviewUpdate: (() => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly doc: TiledDocument
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.paper = document.createElement('canvas');
    this.paintPaper();
    this.preview = new PreviewCache(doc, { onUpdate: () => this.onPreviewUpdate?.() });
  }

  /** A subtle checker texture so transparent canvas areas are distinguishable. */
  private paintPaper(): void {
    const size = 32;
    this.paper.width = size * 2;
    this.paper.height = size * 2;
    const c = this.paper.getContext('2d')!;
    c.fillStyle = '#f4f1ea';
    c.fillRect(0, 0, size * 2, size * 2);
    c.fillStyle = '#eae5da';
    c.fillRect(0, 0, size, size);
    c.fillRect(size, size, size, size);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  get width(): number {
    return this.canvas.width / this.dpr;
  }

  get height(): number {
    return this.canvas.height / this.dpr;
  }

  /** Canvas-space rect currently visible. */
  visibleRect(vp: Viewport, pad = 0): Rect {
    const w = this.width / vp.scale;
    const h = this.height / vp.scale;
    return {
      x: Math.floor(vp.x - pad),
      y: Math.floor(vp.y - pad),
      w: Math.ceil(w + pad * 2),
      h: Math.ceil(h + pad * 2),
    };
  }

  /** Screen (CSS px) -> canvas pixel. */
  screenToCanvas(vp: Viewport, sx: number, sy: number): { x: number; y: number } {
    return { x: vp.x + sx / vp.scale, y: vp.y + sy / vp.scale };
  }

  canvasToScreen(vp: Viewport, cx: number, cy: number): { x: number; y: number } {
    return { x: (cx - vp.x) * vp.scale, y: (cy - vp.y) * vp.scale };
  }

  /** Fit the whole canvas in the viewport with a small margin. */
  fitViewport(): Viewport {
    const sx = this.width / this.doc.width;
    const sy = this.height / this.doc.height;
    const scale = Math.min(sx, sy) * 0.92;
    const w = this.width / scale;
    const h = this.height / scale;
    return {
      x: (this.doc.width - w) / 2,
      y: (this.doc.height - h) / 2,
      scale,
    };
  }

  /**
   * Full valid raster of the current viewport. `extra` layers are drawn on top
   * (live stroke preview, selection, etc.) and are exempt from the "committed
   * data only" rule because they are never persisted.
   */
  render(vp: Viewport, extra?: (ctx: CanvasRenderingContext2D) => void): RenderStats {
    const t0 = performance.now();
    this.resize();
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Paper background.
    ctx.fillStyle = ctx.createPattern(this.paper, 'repeat') ?? '#f4f1ea';
    ctx.fillRect(0, 0, this.width, this.height);

    const origin = this.canvasToScreen(vp, 0, 0);
    const corner = this.canvasToScreen(vp, this.doc.width, this.doc.height);

    const view = this.visibleTiles(vp);
    const tiles = view.keys;
    let drawn = 0;
    let missing = 0;
    let calls = 0;

    // Decide whether base tiles can cover this view within the decoded-tile
    // budget. When they cannot (zoomed far out on a huge canvas, or any view
    // spanning more tiles than the budget holds), fill from the derived
    // preview layer and blit whatever base tiles are resident on top.
    const byteBudget = this.doc.memoryBudgetBytes;
    const perTile = this.doc.tileSize * this.doc.tileSize * 4;
    const budgetTiles = Math.max(1, Math.floor(byteBudget / perTile));
    const needPreview = view.span > budgetTiles || view.capped;
    const previewFactor = this.preview.draw(ctx, vp, this.width, this.height, needPreview);

    // Canvas boundary, on top of the preview so the sheet edge stays readable.
    ctx.strokeStyle = 'rgba(60,50,35,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(origin.x + 0.5, origin.y + 0.5, corner.x - origin.x, corner.y - origin.y);

    for (const key of tiles) {
      const [tx, ty] = this.doc.grid.parseKey(key);
      const tileRect = this.doc.grid.tileRect(tx, ty);
      const screenX = (tileRect.x - vp.x) * vp.scale;
      const screenY = (tileRect.y - vp.y) * vp.scale;
      const screenW = tileRect.w * vp.scale;
      const screenH = tileRect.h * vp.scale;
      const pixels = this.doc.peekTile(key);
      if (!pixels) {
        missing++;
        continue;
      }
      const bitmap = bitmapFor(pixels, tileRect.w, tileRect.h);
      if (screenW < 2 || screenH < 2) {
        // Zoomed far out: a single averaged block is enough and avoids
        // interpolation artifacts from drawing thousands of sub-pixel tiles.
        ctx.fillStyle = averageColor(pixels);
        ctx.fillRect(screenX, screenY, Math.max(1, screenW), Math.max(1, screenH));
      } else {
        ctx.imageSmoothingEnabled = vp.scale < 1;
        ctx.drawImage(bitmap, screenX, screenY, screenW, screenH);
      }
      calls++;
      drawn++;
    }

    // Overlay layers (preview stroke, brush cursor) in screen space.
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    extra?.(ctx);
    ctx.restore();

    ctx.restore();
    const elapsed = performance.now() - t0;
    this.stats = {
      tilesDrawn: drawn,
      tilesMissing: missing,
      drawCalls: calls,
      lastFrameMs: elapsed,
      visibleTiles: view.span,
      totalTilesInView: view.span,
      previewFactor,
    };
    return this.stats;
  }

  /**
   * Tile keys intersecting the view. When the span is impractically large
   * (e.g. fit zoom on a terapixel canvas), enumeration is skipped but the true
   * span is still reported so the caller knows to use the preview layer.
   */
  private visibleTiles(vp: Viewport): { keys: string[]; span: number; capped: boolean } {
    const rect = this.visibleRect(vp, 1);
    const range = this.doc.grid.tilesForRect(this.doc.grid.clipToCanvas(rect));
    if (!range) return { keys: [], span: 0, capped: false };
    const span = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
    if (span > MAX_VISIBLE_TILE_KEYS) return { keys: [], span, capped: true };
    const out: string[] = [];
    for (let ty = range.y0; ty <= range.y1; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) out.push(this.doc.grid.tileKey(tx, ty));
    }
    return { keys: out, span, capped: false };
  }

  get lastStats(): RenderStats {
    return this.stats;
  }

  /** Number of tiles intersecting the view that are decoded and paintable. */
  countReadyTiles(vp: Viewport): number {
    let n = 0;
    for (const key of this.visibleTiles(vp).keys) if (this.doc.peekTile(key)) n++;
    return n;
  }
}

// Cache keyed by the pixel buffer object itself. A decoded tile is immutable
// for its lifetime, so a WeakMap is both faster and impossible to alias across
// versions/reloads (a new buffer can never collide with an old cache entry).
const bitmapCache = new WeakMap<Uint8ClampedArray, HTMLCanvasElement>();

function bitmapFor(pixels: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const hit = bitmapCache.get(pixels);
  if (hit) return hit;
  // Canvas is synchronous; ImageBitmap creation is async. A canvas snapshot is
  // adequate here and keeps rendering deterministic frame-to-frame.
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cc = c.getContext('2d')!;
  cc.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
  bitmapCache.set(pixels, c);
  return c;
}

function averageColor(pixels: Uint8ClampedArray): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4 * 17) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
    a += pixels[i + 3];
    n++;
  }
  if (n === 0) return 'rgba(0,0,0,0)';
  return `rgba(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)},${(a / n / 255).toFixed(3)})`;
}
