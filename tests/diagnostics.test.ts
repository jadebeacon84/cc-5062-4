import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TiledDocument } from '../src/kernel/document';
import { MemoryTileStore } from '../src/store/memory-store';
import { FsTileStore } from '../src/store/fs-store';
import { WriteJournal } from '../src/kernel/journal';
import { diagnoseProject } from '../src/kernel/diagnostics';
import { BrushStyle } from '../src/kernel/brush';
import { readBackBitmap } from '../src/kernel/export';
import type { TileStore } from '../src/store/types';

const style = (over: Partial<BrushStyle> = {}): BrushStyle => ({
  color: [30, 30, 30, 255],
  radius: 6,
  opacity: 1,
  hardness: 0.5,
  ...over,
});

async function openDoc(opts: {
  store: TileStore;
  width: number;
  height: number;
  tileSize?: number;
  journal?: WriteJournal;
  historyLimit?: number;
}) {
  return TiledDocument.open({
    store: opts.store,
    width: opts.width,
    height: opts.height,
    tileSize: opts.tileSize ?? 32,
    memoryBudgetBytes: 4 * 1024 * 1024,
    historyLimit: opts.historyLimit ?? 32,
    journal: opts.journal,
  });
}

function hashBitmap(data: Uint8ClampedArray): number {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) {
    h = (h ^ data[i]) * 16777619;
  }
  return h >>> 0;
}

/**
 * Store wrapper that acknowledges tile writes immediately but only makes them
 * durable on flush(), in a caller-chosen order. Simulates a device that
 * completes writes out of order; the manifest is always written after all
 * buffered tiles, mirroring the real commit protocol.
 */
class ReorderStore implements TileStore {
  private pending: { projectId: string; key: string; version: number; pixels: Uint8Array }[] = [];
  constructor(private readonly inner: MemoryTileStore, private readonly order: 'forward' | 'reverse') {}
  writeHook?: TileStore['writeHook'];

  private async flush(): Promise<void> {
    const batch = this.pending.splice(0);
    if (this.order === 'reverse') batch.reverse();
    for (const p of batch) await this.inner.putTile(p.projectId, p.key, p.version, p.pixels);
  }

  async listProjects() { return this.inner.listProjects(); }
  async createProject(meta: Parameters<TileStore['createProject']>[0]) { return this.inner.createProject(meta); }
  async getProject(id: string) { return this.inner.getProject(id); }
  async updateProject(meta: Parameters<TileStore['updateProject']>[0]) { return this.inner.updateProject(meta); }
  async deleteProject(id: string) { return this.inner.deleteProject(id); }
  async getManifest(projectId: string) { return this.inner.getManifest(projectId); }
  async putManifest(manifest: Parameters<TileStore['putManifest']>[0]) {
    await this.flush();
    return this.inner.putManifest(manifest);
  }
  async getTile(projectId: string, key: string, version: number) {
    await this.flush();
    return this.inner.getTile(projectId, key, version);
  }
  async statTile(projectId: string, key: string, version: number) {
    await this.flush();
    return this.inner.statTile!(projectId, key, version);
  }
  async putTile(projectId: string, key: string, version: number, pixels: Uint8Array) {
    this.pending.push({ projectId, key, version, pixels: pixels.slice() });
  }
  async deleteTile(projectId: string, key: string, version: number) {
    await this.flush();
    return this.inner.deleteTile(projectId, key, version);
  }
  async listTileVersions(projectId: string) {
    await this.flush();
    return this.inner.listTileVersions(projectId);
  }
}

describe('tile lost-write diagnostics', () => {
  it('reports a clean bill for a healthy project, with exact counters', async () => {
    const store = new MemoryTileStore();
    const doc = await openDoc({ store, width: 128, height: 64 });
    await doc.commitStroke({ id: 'a', points: [{ x: 4, y: 8 }, { x: 124, y: 8 }], style: style() });
    await doc.commitStroke({ id: 'b', points: [{ x: 4, y: 40 }, { x: 124, y: 56 }], style: style({ color: [200, 0, 0, 255] }) });
    const report = await diagnoseProject(store, doc.projectId);
    expect(report.ok).toBe(true);
    expect(report.manifestPresent).toBe(true);
    expect(report.totals).toEqual({ missing: 0, corrupt: 0, orphan: 0 });
    expect(report.referencedVersions).toBeGreaterThan(0);
    expect(report.storeVersions).toBeGreaterThan(0);
    expect(report.truncated).toBe(false);
    doc.dispose();
  });

  it('distinguishes an interrupted save (uncommitted remnants) from committed loss', async () => {
    const store = new MemoryTileStore();
    const doc = await openDoc({ store, width: 128, height: 32 });
    await doc.commitStroke({ id: 'good', points: [{ x: 4, y: 16 }, { x: 124, y: 16 }], style: style() });

    // Crash mid-commit: staged tiles land, the manifest never does, and the
    // process dies before rollback can delete the staged versions.
    const origPutManifest = store.putManifest.bind(store);
    store.putManifest = async () => { throw new Error('power loss before manifest'); };
    const origDelete = store.deleteTile.bind(store);
    store.deleteTile = async () => { throw new Error('process already gone'); };
    const bad = await doc.commitStroke({ id: 'bad', points: [{ x: 4, y: 8 }, { x: 124, y: 24 }], style: style({ radius: 9 }) });
    expect(bad.ok).toBe(false);
    store.putManifest = origPutManifest;
    store.deleteTile = origDelete;

    const report = await diagnoseProject(store, doc.projectId);
    // Uncommitted edit: orphan staged versions, zero committed loss.
    expect(report.totals.missing).toBe(0);
    expect(report.totals.orphan).toBeGreaterThan(0);
    expect(report.ok).toBe(true); // committed canvas is intact
    doc.dispose();
  });

  it('locates a lost committed tile to its stroke, with cross-block evidence', async () => {
    const store = new MemoryTileStore();
    const doc = await openDoc({ store, width: 128, height: 32 });
    // Cross-block stroke: spans all four 32px tiles.
    const r1 = await doc.commitStroke({ id: 'wide', points: [{ x: 4, y: 16 }, { x: 124, y: 16 }], style: style() });
    expect(r1.tilesTouched).toBe(4);
    const lostKey = '2,0';
    const lostVersion = doc.tileVersion(lostKey);
    await store.deleteTile(doc.projectId, lostKey, lostVersion);

    const report = await diagnoseProject(store, doc.projectId);
    expect(report.ok).toBe(false);
    expect(report.totals.missing).toBe(1);
    const a = report.missingCommitted[0];
    expect(a.key).toBe(lostKey);
    expect(a.version).toBe(lostVersion);
    expect(a.problem).toBe('missing');
    expect(a.stage).toBe('committed-current');
    expect(a.expectedBytes).toBe(32 * 32 * 4);
    const currentRef = a.referencedBy.find((r) => r.role === 'current');
    expect(currentRef).toBeDefined();
    expect(currentRef!.crossBlock).toBe(true);
    expect(currentRef!.commitSeq).toBe(r1.entry!.seq);
    doc.dispose();
  });

  it('classifies a lost undo payload separately from the current canvas', async () => {
    const store = new MemoryTileStore();
    const doc = await openDoc({ store, width: 64, height: 64 });
    await doc.commitStroke({ id: 'a', points: [{ x: 4, y: 4 }, { x: 60, y: 60 }], style: style() });
    const firstVersion = doc.tileVersion('1,1');
    await doc.commitStroke({ id: 'b', points: [{ x: 40, y: 40 }, { x: 60, y: 40 }], style: style({ color: [0, 180, 0, 255] }) });
    // The first version of the tile is now only undo payload for entry #2.
    await store.deleteTile(doc.projectId, '1,1', firstVersion);

    const report = await diagnoseProject(store, doc.projectId);
    expect(report.totals.missing).toBe(1);
    const a = report.missingCommitted[0];
    expect(a.stage).toBe('undo-payload');
    expect(a.referencedBy.every((r) => r.role !== 'current')).toBe(true);
    expect(a.referencedBy.some((r) => r.role === 'history-before')).toBe(true);
    doc.dispose();
  });

  it('flags corrupted bytes (size mismatch) as committed damage', async () => {
    const store = new MemoryTileStore();
    const doc = await openDoc({ store, width: 64, height: 64 });
    await doc.commitStroke({ id: 'a', points: [{ x: 4, y: 4 }, { x: 60, y: 60 }], style: style() });
    const key = '1,1';
    const v = doc.tileVersion(key);
    // Overwrite the committed version with truncated bytes (bit rot / short write).
    await store.putTile(doc.projectId, key, v, new Uint8Array(100));

    const report = await diagnoseProject(store, doc.projectId);
    expect(report.ok).toBe(false);
    expect(report.totals.corrupt).toBe(1);
    const a = report.missingCommitted[0];
    expect(a.problem).toBe('size-mismatch');
    expect(a.actualBytes).toBe(100);
    expect(a.expectedBytes).toBe(32 * 32 * 4);
    doc.dispose();
  });

  it('reaches the same conclusions through a fresh store with no document or cache involved', async () => {
    // Build a project, then diagnose through a store instance that has never
    // had a TiledDocument opened on it: conclusions must come from the real
    // external storage path, not from any resident canvas state.
    const backing = new MemoryTileStore();
    const doc = await openDoc({ store: backing, width: 96, height: 96 });
    await doc.commitStroke({ id: 'a', points: [{ x: 4, y: 4 }, { x: 92, y: 92 }], style: style() });
    const pid = doc.projectId;
    const v = doc.tileVersion('1,1');
    await backing.deleteTile(pid, '1,1', v);
    doc.dispose();

    const fresh = new MemoryTileStore();
    // Copy the raw records over: same external state, no shared caches.
    fresh.putManifest((await backing.getManifest(pid))!);
    const meta = await backing.getProject(pid);
    await fresh.createProject(meta!);
    for (const t of await backing.listTileVersions(pid)) {
      await fresh.putTile(pid, t.key, t.version, (await backing.getTile(pid, t.key, t.version))!);
    }
    const report = await diagnoseProject(fresh, pid);
    expect(report.totals.missing).toBe(1);
    expect(report.missingCommitted[0].key).toBe('1,1');
  });

  it('produces the identical canvas whether tile writes complete forward or in reverse', async () => {
    const strokes = [
      { id: 's1', points: [{ x: 4, y: 16 }, { x: 124, y: 16 }], style: style({ color: [200, 0, 0, 255] }) },
      { id: 's2', points: [{ x: 16, y: 4 }, { x: 100, y: 28 }], style: style({ color: [0, 0, 200, 255], radius: 4 }) },
      { id: 's3', points: [{ x: 120, y: 4 }, { x: 8, y: 28 }], style: style({ color: [0, 150, 0, 200], radius: 8 }) },
    ];
    const run = async (order: 'forward' | 'reverse') => {
      const inner = new MemoryTileStore();
      const store = new ReorderStore(inner, order);
      const doc = await openDoc({ store, width: 128, height: 32 });
      for (const s of strokes) {
        const r = await doc.commitStroke(s);
        expect(r.ok).toBe(true);
      }
      const bmp = await readBackBitmap(doc, { rect: { x: 0, y: 0, w: 128, h: 32 } });
      const report = await diagnoseProject(store, doc.projectId);
      doc.dispose();
      return { hash: hashBitmap(bmp.data), report };
    };
    const fwd = await run('forward');
    const rev = await run('reverse');
    expect(rev.hash).toBe(fwd.hash);
    expect(fwd.report.ok).toBe(true);
    expect(rev.report.ok).toBe(true);
  });

  it('verifies the real file-system path, including nested tile directories', async () => {
    // The fs store nests tiles one directory per tx; the version index and the
    // diagnostics built on it must see through that layout, not just flat dirs.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vast-diag-'));
    try {
      const store = new FsTileStore(root);
      const doc = await openDoc({ store, width: 128, height: 32 });
      await doc.commitStroke({ id: 'a', points: [{ x: 4, y: 16 }, { x: 124, y: 16 }], style: style() });
      const pid = doc.projectId;
      const versions = await store.listTileVersions(pid);
      expect(versions.length).toBe(4); // one per 32px tile across the row

      const healthy = await diagnoseProject(store, pid);
      expect(healthy.ok).toBe(true);
      expect(healthy.storeVersions).toBe(4);

      await store.deleteTile(pid, '2,0', doc.tileVersion('2,0'));
      doc.dispose();
      const report = await diagnoseProject(store, pid);
      expect(report.totals.missing).toBe(1);
      expect(report.missingCommitted[0].key).toBe('2,0');
      expect(report.missingCommitted[0].stage).toBe('committed-current');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps its own log cost bounded on a giant canvas rerun', async () => {
    // 45 GP canvas: diagnostics must conclude from sparse store records, and
    // the write journal must stay capped while its counters remain exact.
    const store = new MemoryTileStore();
    const journal = new WriteJournal(8);
    const doc = await openDoc({ store, width: 250_000, height: 180_000, tileSize: 256, journal });
    const spots = [
      { x: 1000, y: 1000 },
      { x: 249_000, y: 179_000 },
      { x: 125_000, y: 90_000 },
    ];
    for (let i = 0; i < spots.length; i++) {
      const r = await doc.commitStroke({
        id: `g${i}`,
        points: [spots[i], { x: spots[i].x + 700, y: spots[i].y + 300 }],
        style: style({ radius: 40 }),
      });
      expect(r.ok).toBe(true);
    }
    const healthy = await diagnoseProject(store, doc.projectId);
    expect(healthy.ok).toBe(true);
    expect(healthy.totals).toEqual({ missing: 0, corrupt: 0, orphan: 0 });

    // Lose one committed tile at the far corner; the report must name it.
    const versions = await store.listTileVersions(doc.projectId);
    const victim = versions[versions.length - 1];
    await store.deleteTile(doc.projectId, victim.key, victim.version);
    const report = await diagnoseProject(store, doc.projectId);
    expect(report.totals.missing).toBe(1);
    expect(report.missingCommitted[0].key).toBe(victim.key);
    expect(report.missingCommitted[0].version).toBe(victim.version);

    const snap = journal.snapshot();
    expect(snap.retained).toBeLessThanOrEqual(8);
    expect(snap.droppedEvents).toBeGreaterThan(0);
    // Counters stay exact even though event detail was truncated away.
    expect(snap.phases['manifest']).toBe(3);
    expect(snap.totalEvents).toBe(snap.retained + snap.droppedEvents);
    doc.dispose();
  });
});
