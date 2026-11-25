import { Rect } from './geometry';
import { createStrokeRenderer, StrokeInput, StrokePlan } from './raster';
import { compositeOverlay, PreparedEdit, TiledDocument } from './document';
import { OutOfMemoryForEditError } from './errors';
import { tileBytes } from './memory';

export interface TransactionResult {
  ok: boolean;
  tilesTouched: number;
  pixelsAffected: number;
  error?: Error;
}

/**
 * Builds a multi-tile edit unit from stroke geometry, one tile at a time.
 *
 * Memory behaviour: `build()` accepts a budget; it stops staging new tiles once
 * the retained pixel payload would exceed that budget and reports `truncated`.
 * In that case the transaction is NOT committed — the caller sees a failure and
 * can raise the budget or split the edit. It never commits a partial stroke.
 */
export class StrokeTransaction {
  readonly plan: StrokePlan;
  private readonly edits: PreparedEdit[] = [];
  private retainedBytes = 0;
  private truncated = false;

  private constructor(private readonly doc: TiledDocument, input: StrokeInput) {
    this.plan = createStrokeRenderer(input, doc.grid).plan;
  }

  static async build(
    doc: TiledDocument,
    input: StrokeInput,
    opts: { maxStageBytes: number }
  ): Promise<StrokeTransaction> {
    const tx = new StrokeTransaction(doc, input);
    const renderer = createStrokeRenderer(input, doc.grid);
    for (const tile of tx.plan.tiles) {
      const overlay = renderer.renderTile(tile);
      if (!hasInk(overlay)) continue;
      const w = doc.grid.tilePixelWidth(tile.tx);
      const h = doc.grid.tilePixelHeight(tile.ty);
      const bytes = tileBytes(w, h);
      if (tx.retainedBytes + bytes > opts.maxStageBytes) {
        tx.truncated = true;
        break;
      }
      const existing = await doc.getTileByKey(tile.key);
      const dest = new Uint8ClampedArray(bytes);
      if (existing) dest.set(existing);
      compositeOverlay(dest, w, overlay, tile.local);
      tx.edits.push({ key: tile.key, tx: tile.tx, ty: tile.ty, local: tile.local, pixels: dest });
      tx.retainedBytes += bytes;
    }
    return tx;
  }

  get bytesRetained(): number {
    return this.retainedBytes;
  }

  get tilesTouched(): number {
    return this.edits.length;
  }

  /** Throws if the stroke did not fit the staging budget; commits otherwise. */
  async commit(): Promise<TransactionResult> {
    if (this.truncated) {
      throw new OutOfMemoryForEditError(
        this.plan.tiles.length,
        this.edits.length,
        `stroke spans ${this.plan.tiles.length} tiles but only ${this.edits.length} fit the ` +
          `staging budget; nothing was committed`
      );
    }
    const res = await this.doc.commitEdits(this.edits, 'stroke', this.plan.bounds);
    return {
      ok: res.ok,
      tilesTouched: res.tilesTouched,
      pixelsAffected: res.pixelsAffected,
      error: res.error,
    };
  }

  /** Explicitly abandon without touching the document. */
  dispose(): void {
    this.edits.length = 0;
    this.retainedBytes = 0;
  }
}

function hasInk(o: Uint8ClampedArray): boolean {
  for (let i = 3; i < o.length; i += 4) if (o[i] !== 0) return true;
  return false;
}

/** Convenience: union of a set of full-canvas rects. */
export function unionOf(rects: Rect[]): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) {
    if (!out) out = { ...r };
    else {
      const x0 = Math.min(out.x, r.x);
      const y0 = Math.min(out.y, r.y);
      const x1 = Math.max(out.x + out.w, r.x + r.w);
      const y1 = Math.max(out.y + out.h, r.y + r.h);
      out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
  }
  return out;
}
