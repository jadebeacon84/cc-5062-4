import { describe, expect, it } from 'vitest';
import { TiledDocument } from '../src/kernel/document';
import { MemoryTileStore } from '../src/store/memory-store';
import { BrushStyle } from '../src/kernel/brush';
import { planStroke } from '../src/kernel/raster';
import { readBackBitmap } from '../src/kernel/export';
import { tileBytes } from '../src/kernel/memory';

const style = (over: Partial<BrushStyle> = {}): BrushStyle => ({
  color: [40, 40, 40, 255],
  radius: 8,
  opacity: 1,
  hardness: 0.5,
  ...over,
});

const TILE = 128;
const TILE_BYTES = tileBytes(TILE, TILE);

/**
 * A "gigapixel" logical canvas. Only a handful of tiles are ever painted, so
 * the store and RAM stay tiny; the point is that nothing is preallocated.
 */
describe('vast canvas memory behaviour', () => {
  it('supports a canvas far larger than the memory budget without preallocation', async () => {
    const W = 250_000;
    const H = 180_000; // 45 gigapixels, 180 GB if fully allocated
    const store = new MemoryTileStore();
    // Budget: 12 tiles only.
    const budget = TILE_BYTES * 12;
    const doc = await TiledDocument.open({
      store,
      width: W,
      height: H,
      tileSize: TILE,
      memoryBudgetBytes: budget,
    });

    expect(doc.grid.cols * doc.grid.rows).toBeGreaterThan(2_000_000);
    expect(store.tileCount(doc.projectId)).toBe(0);
    expect(doc.residentBytes).toBe(0);

    // A stroke crossing a few tiles at the far corner.
    const strokes: { points: { x: number; y: number }[]; style: BrushStyle }[] = [
      { points: [{ x: W - 60, y: H - 60 }, { x: W - 900, y: H - 30 }], style: style() },
      { points: [{ x: 1000, y: 1000 }, { x: 1400, y: 1200 }, { x: 900, y: 1500 }], style: style({ radius: 12 }) },
    ];
    for (let i = 0; i < strokes.length; i++) {
      const res = await doc.commitStroke({ id: `s${i}`, ...strokes[i] });
      expect(res.ok).toBe(true);
      expect(doc.residentBytes).toBeLessThanOrEqual(budget);
    }

    // Full-resolution readback of a small window is exact and independent of
    // total canvas size: decoding only touches the tiles under the window.
    const win = { x: 900, y: 960, w: 560, h: 320 };
    const bmp = await readBackBitmap(doc, { rect: win });
    expect(bmp.width).toBe(560);
    expect(bmp.height).toBe(320);
    let inked = 0;
    for (let i = 3; i < bmp.data.length; i += 4) if (bmp.data[i] > 0) inked++;
    expect(inked).toBeGreaterThan(0);
    expect(inked).toBeLessThan(win.w * win.h);

    // Peak resident bytes never exceeded the cap. Decoded tiles are strictly
    // bounded by the budget regardless of the 45-gigapixel logical size.
    expect(doc.cacheStats.peakBytes).toBeLessThanOrEqual(budget);
    expect(doc.residentTiles).toBeLessThanOrEqual(budget / TILE_BYTES);
    doc.dispose();
  });

  it('allocates storage proportional to painted tiles, not canvas area', async () => {
    const store = new MemoryTileStore();
    const budget = TILE_BYTES * 8;
    const doc = await TiledDocument.open({
      store,
      width: 1_000_000,
      height: 1_000_000,
      tileSize: TILE,
      memoryBudgetBytes: budget,
    });
    for (let i = 0; i < 20; i++) {
      const x = 200_000 + i * 5000;
      const y = 300_000 + (i % 5) * 4000;
      const res = await doc.commitStroke({
        id: `t${i}`,
        points: [{ x, y }, { x: x + 300, y: y + 120 }],
        style: style({ radius: 4 }),
      });
      expect(res.ok).toBe(true);
    }
    // One megapixel canvas would be 4 TB if fully allocated. Painted tiles only:
    expect(store.totalTileBytes(doc.projectId)).toBeLessThan(64 * 1024 * 1024);
    expect(doc.paintedTileCount).toBeLessThan(200);
    expect(doc.residentBytes).toBeLessThanOrEqual(budget);
    doc.dispose();
  });

  it('plans and commits a long diagonal in time proportional to the stroke, not its bounding box', async () => {
    const store = new MemoryTileStore();
    const doc = await TiledDocument.open({
      store,
      width: 1_000_000,
      height: 1_000_000,
      tileSize: TILE,
      memoryBudgetBytes: TILE_BYTES * 4,
    });
    const pts = [{ x: 100, y: 100 }, { x: 700_000, y: 700_000 }];
    const plan = planStroke({ id: 'diag', points: pts, style: style({ radius: 6 }) }, doc.grid);
    // Bounding box covers ~30M tiles; the stroke itself crosses far fewer.
    const bboxTiles = Math.ceil(plan.bounds.w / TILE) * Math.ceil(plan.bounds.h / TILE);
    expect(plan.tiles.length).toBeLessThan(bboxTiles / 100);
    // Roughly one tile per tile-diagonal step, times a narrow band.
    const steps = Math.ceil((700_000 - 100) / TILE);
    expect(plan.tiles.length).toBeLessThan(steps * 6);

    const commit = await doc.commitStroke({ id: 'diag', points: pts, style: style({ radius: 6 }) });
    expect(commit.ok).toBe(true);
    expect(doc.residentBytes).toBeLessThanOrEqual(doc.memoryBudgetBytes);
    expect(doc.cacheStats.peakBytes).toBeLessThanOrEqual(doc.memoryBudgetBytes);
    expect(doc.paintedTileCount).toBe(plan.tiles.length);
    doc.dispose();
  }, 60_000);

  it('rejects a memory budget that cannot hold a single tile', async () => {
    const store = new MemoryTileStore();
    await expect(
      TiledDocument.open({
        store,
        width: 1000,
        height: 1000,
        tileSize: 256,
        memoryBudgetBytes: 1024,
      })
    ).rejects.toThrow(/at least one/);
  });
});
