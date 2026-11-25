import { describe, expect, it } from 'vitest';
import { TiledDocument } from '../src/kernel/document';
import { MemoryTileStore } from '../src/store/memory-store';
import { readBackBitmap } from '../src/kernel/export';
import { BrushStyle } from '../src/kernel/brush';
import { CommitAbortedError } from '../src/kernel/errors';
import { StrokeTransaction } from '../src/kernel/transaction';
import type { TileWriteHook } from '../src/store/types';

const style = (over: Partial<BrushStyle> = {}): BrushStyle => ({
  color: [30, 30, 30, 255],
  radius: 6,
  opacity: 1,
  hardness: 0.5,
  ...over,
});

async function open(opts: {
  width?: number;
  height?: number;
  tileSize?: number;
  budget?: number;
  historyLimit?: number;
  barrier?: any;
  store?: MemoryTileStore;
}) {
  const store = opts.store ?? new MemoryTileStore();
  const doc = await TiledDocument.open({
    store,
    width: opts.width ?? 256,
    height: opts.height ?? 256,
    tileSize: opts.tileSize ?? 32,
    memoryBudgetBytes: opts.budget ?? 4 * 1024 * 1024,
    historyLimit: opts.historyLimit ?? 32,
    commitBarrier: opts.barrier,
  });
  return { store, doc };
}

async function snapshotDoc(doc: TiledDocument, w: number, h: number): Promise<Uint8ClampedArray> {
  const bmp = await readBackBitmap(doc, { rect: { x: 0, y: 0, w, h } });
  return bmp.data;
}

describe('atomic commit and failure rollback', () => {
  it('leaves no partial stroke when staging a later tile fails', async () => {
    const W = 192;
    const H = 64;
    let failAt = 3;
    let writes = 0;
    const store: MemoryTileStore = new MemoryTileStore();
    const origPut = store.putTile.bind(store);
    store.putTile = async (pid, key, version, pixels) => {
      writes++;
      if (writes === failAt) throw new Error('disk full');
      return origPut(pid, key, version, pixels);
    };
    const { doc } = await open({ width: W, height: H, store, tileSize: 32 });
    const before = await snapshotDoc(doc, W, H);
    const res = await doc.commitStroke({
      id: 'long',
      points: [{ x: 8, y: 32 }, { x: W - 8, y: 32 }],
      style: style({ radius: 5 }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(CommitAbortedError);
    expect(res.tilesTouched).toBe(0);
    // Canvas unchanged.
    const after = await snapshotDoc(doc, W, H);
    expect(after).toEqual(before);
    // No orphan tile versions left behind.
    expect(store.tileCount(doc.projectId)).toBe(0);
    // No history was recorded.
    expect(doc.historyDepth).toBe(0);
    expect(doc.paintedTileCount).toBe(0);
    doc.dispose();
  });

  it('rolls back if the manifest write fails', async () => {
    const store = new MemoryTileStore();
    const origPut = store.putManifest.bind(store);
    let fail = true;
    store.putManifest = async (m) => {
      if (fail && m.history.length > 0) throw new Error('manifest fsync failed');
      return origPut(m);
    };
    const { doc } = await open({ store, width: 64, height: 64 });
    const res = await doc.commitStroke({ id: 'a', points: [{ x: 8, y: 8 }, { x: 56, y: 56 }], style: style() });
    expect(res.ok).toBe(false);
    expect(doc.paintedTileCount).toBe(0);
    expect(store.tileCount(doc.projectId)).toBe(0);
    fail = false;
    const ok = await doc.commitStroke({ id: 'b', points: [{ x: 8, y: 8 }, { x: 56, y: 56 }], style: style() });
    expect(ok.ok).toBe(true);
    expect(doc.paintedTileCount).toBeGreaterThan(0);
    doc.dispose();
  });

  it('never exposes a partially staged stroke through the manifest', async () => {
    const store = new MemoryTileStore();
    let releaseStaging!: () => void;
    const staged = new Promise<void>((r) => (releaseStaging = r));
    let hookCalls = 0;
    const { doc } = await open({
      store,
      width: 256,
      height: 64,
      barrier: async (phase: string) => {
        if (phase === 'after-staging') {
          hookCalls++;
          await staged;
        }
      },
    });
    const p = doc.commitStroke({ id: 'a', points: [{ x: 4, y: 32 }, { x: 250, y: 32 }], style: style() });
    // While staging is blocked, a fresh reader sees no stroke at all.
    await new Promise((r) => setTimeout(r, 20));
    const manifest = await store.getManifest(doc.projectId);
    expect(manifest?.history.length ?? 0).toBe(0);
    releaseStaging();
    const res = await p;
    expect(res.ok).toBe(true);
    expect(hookCalls).toBe(1);
    const after = await store.getManifest(doc.projectId);
    expect(after?.history.length).toBe(1);
    expect(after?.cursor).toBe(1);
    doc.dispose();
  });

  it('surfaces a memory error instead of committing a truncated stroke', async () => {
    const { doc } = await open({ width: 512, height: 512, tileSize: 32, budget: 64 * 1024 });
    const tx = await StrokeTransaction.build(
      doc,
      {
        id: 'all',
        points: [{ x: 0, y: 0 }, { x: 500, y: 500 }, { x: 0, y: 500 }, { x: 500, y: 0 }],
        style: style({ radius: 10 }),
      },
      { maxStageBytes: 48 * 1024 }
    );
    expect(tx.tilesTouched).toBeLessThan(tx.plan.tiles.length);
    await expect(tx.commit()).rejects.toThrow(/nothing was committed/);
    expect(doc.paintedTileCount).toBe(0);
    doc.dispose();
  });
});

describe('undo / redo restore exact affected data', () => {
  it('undo restores prior tile bytes exactly and redo reapplies them', async () => {
    const { doc } = await open({ width: 160, height: 160 });
    const s1 = { id: 's1', points: [{ x: 10, y: 10 }, { x: 140, y: 30 }], style: style({ color: [200, 0, 0, 255] }) };
    const s2 = { id: 's2', points: [{ x: 20, y: 130 }, { x: 120, y: 140 }], style: style({ color: [0, 0, 200, 255] }) };
    expect((await doc.commitStroke(s1)).ok).toBe(true);
    const afterS1 = await snapshotDoc(doc, 160, 160);
    expect((await doc.commitStroke(s2)).ok).toBe(true);
    const afterS2 = await snapshotDoc(doc, 160, 160);
    expect(afterS2).not.toEqual(afterS1);

    const u = await doc.undo();
    expect(u.ok).toBe(true);
    expect(await snapshotDoc(doc, 160, 160)).toEqual(afterS1);

    const r = await doc.redo();
    expect(r.ok).toBe(true);
    expect(await snapshotDoc(doc, 160, 160)).toEqual(afterS2);
    doc.dispose();
  });

  it('does not use the low-resolution preview to restore pixels', async () => {
    const { doc } = await open({ width: 128, height: 128 });
    await doc.commitStroke({ id: 'a', points: [{ x: 5, y: 5 }, { x: 120, y: 120 }], style: style({ radius: 3 }) });
    const before = await snapshotDoc(doc, 128, 128);
    // Build a deliberately wrong preview; undo must ignore it.
    const { PreviewPyramid } = await import('../src/kernel/export');
    const preview = new PreviewPyramid(doc);
    const level = await preview.buildLevel(16);
    expect(level).not.toBeNull();
    level!.fill(255);
    const u = await doc.undo();
    expect(u.ok).toBe(true);
    const after = await snapshotDoc(doc, 128, 128);
    expect(after.every((v) => v === 0)).toBe(true);
    // Redo restores from committed tiles, matching the pre-undo image.
    await doc.redo();
    expect(await snapshotDoc(doc, 128, 128)).toEqual(before);
    doc.dispose();
  });

  it('report a clean failure when the undo payload is missing', async () => {
    const store = new MemoryTileStore();
    const { doc } = await open({ store, width: 64, height: 64 });
    await doc.commitStroke({ id: 'a', points: [{ x: 4, y: 4 }, { x: 60, y: 60 }], style: style() });
    // Remove the pre-stroke version; undo needs the "before" version (0 here),
    // so instead remove the post version used by redo after an undo.
    await doc.undo();
    const entry = (await store.getManifest(doc.projectId))!;
    const afterVersion = entry.history[0].changes[0].after;
    await store.deleteTile(doc.projectId, entry.history[0].changes[0].key, afterVersion);
    const r = await doc.redo();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('storage');
    doc.dispose();
  });

  it('serializes undo behind an in-flight commit and restores a coherent state', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stagingHits = 0;
    let armed = false;
    const { doc } = await open({
      width: 256,
      height: 64,
      barrier: async (phase: string) => {
        if (phase === 'after-staging') {
          stagingHits++;
          if (armed) await gate;
        }
      },
    });
    await doc.commitStroke({ id: 'base', points: [{ x: 2, y: 32 }, { x: 250, y: 32 }], style: style({ radius: 4 }) });
    armed = true;
    const base = await snapshotDoc(doc, 256, 64);
    const commit = doc.commitStroke({ id: 'next', points: [{ x: 2, y: 16 }, { x: 250, y: 48 }], style: style({ radius: 8 }) });
    // Undo starts while the second stroke is staging; it must wait, then undo
    // the second stroke only (never a half-written one).
    const undo = doc.undo();
    await new Promise((r) => setTimeout(r, 15));
    release();
    const c = await commit;
    expect(c.ok).toBe(true);
    const u = await undo;
    expect(u.ok).toBe(true);
    expect(await snapshotDoc(doc, 256, 64)).toEqual(base);
    expect(stagingHits).toBeGreaterThanOrEqual(2);
    doc.dispose();
  });
});

describe('persistence and reopen', () => {
  it('reopening a project reproduces exactly the committed pixels', async () => {
    const store = new MemoryTileStore();
    const { doc } = await open({ store, width: 200, height: 120 });
    await doc.commitStroke({ id: 'a', points: [{ x: 5, y: 5 }, { x: 190, y: 100 }], style: style({ color: [12, 200, 90, 255] }) });
    await doc.commitStroke({ id: 'b', points: [{ x: 5, y: 100 }, { x: 190, y: 10 }], style: style({ radius: 3, color: [200, 10, 10, 255] }) });
    const before = await snapshotDoc(doc, 200, 120);
    const projectId = doc.projectId;
    doc.dispose();

    // A brand-new document reading the same store object = process reopen.
    const reopened = await TiledDocument.open({
      store,
      width: 200,
      height: 120,
      tileSize: 32,
      memoryBudgetBytes: 4 * 1024 * 1024,
      projectId,
    });
    const after = await snapshotDoc(reopened, 200, 120);
    expect(after).toEqual(before);
    expect(reopened.undoStepsAvailable).toBe(2);
    reopened.dispose();
  });

  it('reload after a crash mid-stroke cannot contain half a stroke', async () => {
    const store = new MemoryTileStore();
    const projectId = 'crash-test';
    const { doc } = await open({ store, width: 128, height: 128 });
    await doc.commitStroke({ id: 'ok', points: [{ x: 4, y: 4 }, { x: 124, y: 124 }], style: style({ radius: 2 }) });
    await doc.rename('crash-test');
    const committed = await snapshotDoc(doc, 128, 128);

    // Simulate a failed stroke whose tiles landed but manifest did not.
    const hook: TileWriteHook = async ({ phase }) => {
      if (phase === 'staging') throw new Error('power loss');
    };
    store.writeHook = hook;
    const res = await doc.commitStroke({ id: 'bad', points: [{ x: 100, y: 4 }, { x: 4, y: 124 }], style: style({ radius: 10 }) });
    expect(res.ok).toBe(false);
    store.writeHook = undefined;
    doc.dispose();

    const reopened = await TiledDocument.open({
      store,
      width: 128,
      height: 128,
      tileSize: 32,
      memoryBudgetBytes: 4 * 1024 * 1024,
      projectId: doc.projectId,
    });
    const after = await snapshotDoc(reopened, 128, 128);
    expect(after).toEqual(committed);
    // Reopened history has only the successful stroke.
    expect(reopened.historyDepth).toBe(1);
    reopened.dispose();
    void projectId;
  });

  it('undo history survives reopen and undo still works', async () => {
    const store = new MemoryTileStore();
    const { doc } = await open({ store, width: 96, height: 96 });
    await doc.commitStroke({ id: 'a', points: [{ x: 4, y: 4 }, { x: 90, y: 90 }], style: style() });
    const pid = doc.projectId;
    doc.dispose();
    const reopened = await TiledDocument.open({ store, width: 96, height: 96, tileSize: 32, projectId: pid });
    expect(reopened.undoStepsAvailable).toBe(1);
    const u = await reopened.undo();
    expect(u.ok).toBe(true);
    expect((await snapshotDoc(reopened, 96, 96)).every((v) => v === 0)).toBe(true);
    reopened.dispose();
  });
});
