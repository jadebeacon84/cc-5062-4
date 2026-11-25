import { describe, expect, it } from 'vitest';
import { TiledDocument } from '../src/kernel/document';
import { MemoryTileStore } from '../src/store/memory-store';
import { BrushStyle } from '../src/kernel/brush';
import { readBackBitmap } from '../src/kernel/export';
import { RGBABitmap } from '../src/kernel/export';

const style = (over: Partial<BrushStyle> = {}): BrushStyle => ({
  color: [10, 40, 200, 255],
  radius: 9,
  opacity: 0.85,
  hardness: 0.4,
  ...over,
});

async function openDoc(
  width: number,
  height: number,
  opts: { tileSize?: number; budget?: number; historyLimit?: number; barrier?: any } = {}
) {
  const store = new MemoryTileStore();
  const doc = await TiledDocument.open({
    store,
    width,
    height,
    tileSize: opts.tileSize ?? 32,
    memoryBudgetBytes: opts.budget ?? 4 * 1024 * 1024,
    historyLimit: opts.historyLimit,
    commitBarrier: opts.barrier,
    name: 'test',
  });
  return { store, doc };
}

function diffCount(a: RGBABitmap, b: RGBABitmap, budget = 0): { count: number; maxDelta: number } {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let count = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    if (d > budget) count++;
    maxDelta = Math.max(maxDelta, d);
  }
  return { count, maxDelta };
}

/** Deterministic pseudo-random path generator (seeded, no Math.random). */
function makePath(seed: number, n: number, w: number, h: number, step = 18) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const pts = [{ x: rnd() * w, y: rnd() * h }];
  let angle = rnd() * Math.PI * 2;
  for (let i = 1; i < n; i++) {
    angle += (rnd() - 0.5) * 0.9;
    const p = pts[pts.length - 1];
    pts.push({
      x: Math.max(-20, Math.min(w + 20, p.x + Math.cos(angle) * step)),
      y: Math.max(-20, Math.min(h + 20, p.y + Math.sin(angle) * step)),
    });
  }
  return pts;
}

describe('geometry and tiling', () => {
  it('covers edge tiles with correct partial sizes', async () => {
    const { doc } = await openDoc(100, 70, { tileSize: 32 });
    expect(doc.grid.cols).toBe(4);
    expect(doc.grid.rows).toBe(3);
    expect(doc.grid.tilePixelWidth(3)).toBe(4);
    expect(doc.grid.tilePixelHeight(2)).toBe(6);
    doc.dispose();
  });
});

describe('local pixel parity with a monolithic canvas', () => {
  it('matches a single-canvas implementation for strokes crossing many tiles', async () => {
    const W = 200;
    const H = 160;
    const tileSize = 32;
    const { doc } = await openDoc(W, H, { tileSize, budget: 8 * 1024 * 1024 });
    const ref = new (await import('../tests/reference-canvas')).ReferenceCanvas(W, H);

    // Several long strokes that deliberately cross tile borders and corners.
    const strokes = [
      { pts: [{ x: 5, y: 5 }, { x: 190, y: 150 }, { x: 20, y: 140 }, { x: 180, y: 10 }], style: style() },
      { pts: makePath(7, 40, W, H, 26), style: style({ color: [220, 30, 20, 255], radius: 5, opacity: 0.6, hardness: 0.9 }) },
      { pts: [{ x: 64, y: 0 }, { x: 64, y: 160 }], style: style({ color: [0, 160, 60, 200], radius: 11, hardness: 0.2 }) },
      { pts: [{ x: 0, y: 96 }, { x: 200, y: 96 }], style: style({ color: [0, 0, 0, 255], radius: 3, hardness: 1 }) },
    ];

    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      const res = await doc.commitStroke({ id: `s${i}`, points: s.pts, style: s.style });
      expect(res.ok).toBe(true);
      ref.paintStroke(s.pts, s.style);
    }

    const tiled = await readBackBitmap(doc, { rect: { x: 0, y: 0, w: W, h: H } });
    const reference: RGBABitmap = { width: W, height: H, data: ref.data };
    const { count, maxDelta } = diffCount(tiled, reference, 1);
    expect(maxDelta).toBeLessThanOrEqual(1);
    expect(count).toBe(0);
    doc.dispose();
  });

  it('keeps parity when tiles are evicted from memory between strokes', async () => {
    const W = 160;
    const H = 160;
    const tileSize = 32;
    // Budget holds only ~4 tiles, forcing constant eviction/reload.
    const { doc } = await openDoc(W, H, { tileSize, budget: 4 * 32 * 32 * 4 + 16 });
    const ref = new (await import('../tests/reference-canvas')).ReferenceCanvas(W, H);
    const strokes = Array.from({ length: 6 }, (_, i) => makePath(100 + i, 30, W, H, 22));
    for (let i = 0; i < strokes.length; i++) {
      const st = style({ radius: 4 + i, color: [i * 40, 255 - i * 30, 80 + i * 20, 255] });
      const res = await doc.commitStroke({ id: `e${i}`, points: strokes[i], style: st });
      expect(res.ok).toBe(true);
      ref.paintStroke(strokes[i], st);
      expect(doc.residentBytes).toBeLessThanOrEqual(doc.memoryBudgetBytes);
    }
    const tiled = await readBackBitmap(doc, { rect: { x: 0, y: 0, w: W, h: H } });
    const { count, maxDelta } = diffCount(tiled, { width: W, height: H, data: ref.data }, 1);
    expect(maxDelta).toBeLessThanOrEqual(1);
    expect(count).toBe(0);
    doc.dispose();
  });

  it('renders hairlines exactly on tile boundaries', async () => {
    const W = 128;
    const H = 128;
    const tileSize = 32;
    const { doc } = await openDoc(W, H, { tileSize });
    const ref = new (await import('../tests/reference-canvas')).ReferenceCanvas(W, H);
    const st = style({ color: [255, 0, 0, 255], radius: 1.2, opacity: 1, hardness: 1 });
    // Lines exactly on tile edges/joints, both axes.
    const paths = [
      [{ x: 32, y: 0 }, { x: 32, y: 128 }],
      [{ x: 0, y: 64 }, { x: 128, y: 64 }],
      [{ x: 31.5, y: 0 }, { x: 96.5, y: 128 }],
    ];
    for (const p of paths) {
      await doc.commitStroke({ id: 'line', points: p, style: st });
      ref.paintStroke(p, st);
    }
    const tiled = await readBackBitmap(doc, { rect: { x: 0, y: 0, w: W, h: H } });
    const { count, maxDelta } = diffCount(tiled, { width: W, height: H, data: ref.data }, 1);
    expect(maxDelta).toBeLessThanOrEqual(1);
    expect(count).toBe(0);
    doc.dispose();
  });
});
