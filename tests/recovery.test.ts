import { describe, expect, it } from 'vitest';
import { TiledDocument } from '../src/kernel/document';
import { MemoryTileStore } from '../src/store/memory-store';
import { WriteJournal } from '../src/kernel/journal';
import { diagnoseProject } from '../src/kernel/diagnostics';
import { recoverProject } from '../src/kernel/recovery';
import { BrushStyle } from '../src/kernel/brush';
import { readBackBitmap } from '../src/kernel/export';
import type { ProjectManifest, TileStore } from '../src/store/types';

const style = (over: Partial<BrushStyle> = {}): BrushStyle => ({
  color: [30, 30, 30, 255],
  radius: 6,
  opacity: 1,
  hardness: 0.5,
  ...over,
});

async function openDoc(store: TileStore, opts: { width: number; height: number; tileSize?: number; journal?: WriteJournal; historyLimit?: number; projectId?: string }) {
  return TiledDocument.open({
    store,
    width: opts.width,
    height: opts.height,
    tileSize: opts.tileSize ?? 32,
    memoryBudgetBytes: 4 * 1024 * 1024,
    historyLimit: opts.historyLimit ?? 32,
    journal: opts.journal,
    projectId: opts.projectId,
  });
}

function hashBitmap(data: Uint8ClampedArray): number {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) h = (h ^ data[i]) * 16777619;
  return h >>> 0;
}

async function canvasHash(doc: TiledDocument, w: number, h: number): Promise<number> {
  const bmp = await readBackBitmap(doc, { rect: { x: 0, y: 0, w, h } });
  return hashBitmap(bmp.data);
}

/** Delete every after-version of history entry `seq` from the store. */
async function deleteAfterVersions(store: TileStore, projectId: string, seq: number): Promise<number> {
  const manifest = await store.getManifest(projectId);
  const entry = manifest!.history.find((h) => h.seq === seq);
  expect(entry).toBeDefined();
  let n = 0;
  for (const c of entry!.changes) {
    if (c.after > 0) {
      await store.deleteTile(projectId, c.key, c.after);
      n++;
    }
  }
  return n;
}

/** Rewrite the manifest, transforming one entry's stroke record (e.g. legacy). */
async function rewriteStrokeRecord(
  store: TileStore,
  projectId: string,
  seq: number,
  transform: (rec: NonNullable<ProjectManifest['history'][number]['stroke']>) => ProjectManifest['history'][number]['stroke']
): Promise<void> {
  const manifest = await store.getManifest(projectId);
  const entry = manifest!.history.find((h) => h.seq === seq);
  expect(entry?.stroke).toBeDefined();
  entry!.stroke = transform(entry!.stroke!);
  await store.putManifest(manifest!);
}

/** Store wrapper completing buffered tile writes in the chosen order. */
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
  async createProject(m: Parameters<TileStore['createProject']>[0]) { return this.inner.createProject(m); }
  async getProject(id: string) { return this.inner.getProject(id); }
  async updateProject(m: Parameters<TileStore['updateProject']>[0]) { return this.inner.updateProject(m); }
  async deleteProject(id: string) { return this.inner.deleteProject(id); }
  async getManifest(id: string) { return this.inner.getManifest(id); }
  async putManifest(m: Parameters<TileStore['putManifest']>[0]) { await this.flush(); return this.inner.putManifest(m); }
  async getTile(id: string, key: string, version: number) { await this.flush(); return this.inner.getTile(id, key, version); }
  async statTile(id: string, key: string, version: number) { await this.flush(); return this.inner.statTile!(id, key, version); }
  async putTile(projectId: string, key: string, version: number, pixels: Uint8Array) {
    this.pending.push({ projectId, key, version, pixels: pixels.slice() });
  }
  async deleteTile(id: string, key: string, version: number) { await this.flush(); return this.inner.deleteTile(id, key, version); }
  async listTileVersions(id: string) { await this.flush(); return this.inner.listTileVersions(id); }
}

describe('transaction replay recovery', () => {
  const W = 128;
  const H = 64;

  async function buildThreeStrokeCanvas(store: TileStore, journal?: WriteJournal) {
    const doc = await openDoc(store, { width: W, height: H, journal });
    const s1 = await doc.commitStroke({
      id: 's1',
      points: [{ x: 4, y: 8 }, { x: 124, y: 8 }],
      style: style({ color: [200, 0, 0, 255], radius: 4 }),
    });
    const s2 = await doc.commitStroke({
      id: 's2',
      points: [{ x: 4, y: 40 }, { x: 124, y: 40 }],
      style: style({ color: [0, 0, 200, 255], radius: 4 }),
    });
    const s3 = await doc.commitStroke({
      id: 's3',
      points: [{ x: 4, y: 4 }, { x: 124, y: 24 }],
      style: style({ color: [0, 150, 0, 220], radius: 3 }),
    });
    expect(s1.ok && s2.ok && s3.ok).toBe(true);
    return { doc, seqs: [s1.entry!.seq, s2.entry!.seq, s3.entry!.seq] };
  }

  it('rebuilds strokes from the log when intermediate blocks are missing', async () => {
    const store = new MemoryTileStore();
    const journal = new WriteJournal();
    const { doc, seqs } = await buildThreeStrokeCanvas(store, journal);
    const original = await canvasHash(doc, W, H);
    const pid = doc.projectId;

    // Lose the middle stroke's tile versions: the current canvas and the
    // history chain both break.
    const lost = await deleteAfterVersions(store, pid, seqs[1]);
    expect(lost).toBeGreaterThan(0);
    const diag = await diagnoseProject(store, pid);
    expect(diag.totals.missing).toBe(lost);
    expect(diag.missingCommitted.some((a) => a.stage === 'committed-current')).toBe(true);
    doc.dispose();

    const result = await recoverProject({ store, projectId: pid, journal });
    expect(result.rolledBackToSeq).toBe(seqs[0]);
    expect(result.replayed.map((r) => r.fromSeq)).toEqual([seqs[1], seqs[2]]);
    expect(result.complete).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.recoveredPixels).toBeGreaterThan(0);
    expect(result.tileRevisions.length).toBeGreaterThanOrEqual(lost);
    expect(result.after.ok).toBe(true);
    // The replaced tail of the chain shows up as uncommitted remnants.
    expect(result.after.totals.orphan).toBeGreaterThan(0);

    const reopened = await openDoc(store, { width: W, height: H, projectId: pid });
    expect(await canvasHash(reopened, W, H)).toBe(original);
    reopened.dispose();

    // The recovery itself is on the evidence chain.
    const events = journal.retained();
    expect(events.some((e) => e.phase === 'manifest' && e.commitSeq! > seqs[2])).toBe(true);
    expect(result.evidence.journalTo).toBeGreaterThanOrEqual(result.evidence.journalFrom);
  });

  it('verifies the same canvas under two opposite tile-completion orders', async () => {
    const run = async (order: 'forward' | 'reverse') => {
      const inner = new MemoryTileStore();
      const store = new ReorderStore(inner, order);
      const { doc, seqs } = await buildThreeStrokeCanvas(store);
      const original = await canvasHash(doc, W, H);
      const pid = doc.projectId;
      await deleteAfterVersions(store, pid, seqs[1]);
      doc.dispose();
      const result = await recoverProject({ store, projectId: pid });
      expect(result.complete).toBe(true);
      const reopened = await openDoc(store, { width: W, height: H, projectId: pid });
      const hash = await canvasHash(reopened, W, H);
      reopened.dispose();
      return { original, recovered: hash };
    };
    const fwd = await run('forward');
    const rev = await run('reverse');
    // Each run recovers its own canvas exactly, and both orders agree.
    expect(fwd.recovered).toBe(fwd.original);
    expect(rev.recovered).toBe(rev.original);
    expect(rev.recovered).toBe(fwd.recovered);
  });

  it('replays a legacy position-only smudge when its pick tile survives', async () => {
    const store = new MemoryTileStore();
    const doc = await openDoc(store, { width: 64, height: 64 });
    await doc.commitStroke({
      id: 'base',
      points: [{ x: 8, y: 8 }, { x: 56, y: 56 }],
      style: style({ color: [220, 30, 30, 255], radius: 8 }),
    });
    const sm = await doc.commitStroke({
      id: 'sm',
      points: [{ x: 32, y: 32 }, { x: 52, y: 16 }],
      style: style({ mode: 'smudge', radius: 5 }),
    });
    await doc.commitStroke({
      id: 'top',
      points: [{ x: 8, y: 56 }, { x: 24, y: 40 }],
      style: style({ color: [0, 40, 200, 255], radius: 4 }),
    });
    const pid = doc.projectId;
    const original = await canvasHash(doc, 64, 64);
    const smudgeSeq = sm.entry!.seq;

    // Turn the smudge record into a legacy one: positions and brush geometry
    // only, no resolved color and no color source.
    await rewriteStrokeRecord(store, pid, smudgeSeq, (rec) => ({
      tool: 'smudge',
      points: rec!.points,
      style: { ...rec!.style!, color: [0, 0, 0, 0] },
    }));
    await deleteAfterVersions(store, pid, smudgeSeq);
    doc.dispose();

    const result = await recoverProject({ store, projectId: pid });
    expect(result.complete).toBe(true);
    expect(result.replayed.map((r) => r.fromSeq)).toEqual([smudgeSeq, smudgeSeq + 1]);
    expect(result.replayed[0].tool).toBe('smudge');

    const reopened = await openDoc(store, { width: 64, height: 64, projectId: pid });
    expect(await canvasHash(reopened, 64, 64)).toBe(original);
    reopened.dispose();
  });

  it('returns to the last complete canvas and leaves strokes pending when the color source is unrecoverable', async () => {
    const store = new MemoryTileStore();
    const doc = await openDoc(store, { width: 64, height: 64 });
    const base = await doc.commitStroke({
      id: 'base',
      points: [{ x: 8, y: 8 }, { x: 56, y: 56 }],
      style: style({ color: [220, 30, 30, 255], radius: 8 }),
    });
    const sm = await doc.commitStroke({
      id: 'sm',
      points: [{ x: 32, y: 32 }, { x: 52, y: 16 }],
      style: style({ mode: 'smudge', radius: 5 }),
    });
    const pid = doc.projectId;
    // The base stroke is pre-journal history: no replay record at all.
    await rewriteStrokeRecord(store, pid, base.entry!.seq, () => undefined);
    // Both the base ink and the smudge output are gone from the store.
    await deleteAfterVersions(store, pid, base.entry!.seq);
    await deleteAfterVersions(store, pid, sm.entry!.seq);
    doc.dispose();

    const result = await recoverProject({ store, projectId: pid });
    expect(result.complete).toBe(false);
    expect(result.rolledBackToSeq).toBe(0);
    expect(result.replayed).toEqual([]);
    expect(result.pending.map((p) => p.seq)).toEqual([base.entry!.seq, sm.entry!.seq]);
    expect(result.pending[0].reason).toMatch(/no replayable stroke record/);

    // The canvas is the last complete one (empty here) — nothing fabricated.
    const reopened = await openDoc(store, { width: 64, height: 64, projectId: pid });
    const bmp = await readBackBitmap(reopened, { rect: { x: 0, y: 0, w: 64, h: 64 } });
    expect(bmp.data.every((v) => v === 0)).toBe(true);
    reopened.dispose();
  });

  it('leaves a legacy smudge pending when its pick point is blank in the restored canvas', async () => {
    const store = new MemoryTileStore();
    // History limit 1: the base stroke's entry is trimmed from the log, so its
    // pixels are the log's "pre-history" and cannot be rebuilt once lost.
    const doc = await openDoc(store, { width: 64, height: 64, historyLimit: 1 });
    await doc.commitStroke({
      id: 'base',
      points: [{ x: 8, y: 8 }, { x: 56, y: 56 }],
      style: style({ color: [220, 30, 30, 255], radius: 8 }),
    });
    const sm = await doc.commitStroke({
      id: 'sm',
      points: [{ x: 32, y: 32 }, { x: 52, y: 16 }],
      style: style({ mode: 'smudge', radius: 5 }),
    });
    const pid = doc.projectId;
    await rewriteStrokeRecord(store, pid, sm.entry!.seq, (rec) => ({
      tool: 'smudge',
      points: rec!.points,
      style: { ...rec!.style!, color: [0, 0, 0, 0] },
    }));
    // Every tile version disappears: committed loss of both strokes' output.
    for (const v of await store.listTileVersions(pid)) {
      await store.deleteTile(pid, v.key, v.version);
    }
    doc.dispose();

    const result = await recoverProject({ store, projectId: pid });
    expect(result.complete).toBe(false);
    expect(result.pending.length).toBe(1);
    expect(result.pending[0].reason).toMatch(/color source lost/);
    const reopened = await openDoc(store, { width: 64, height: 64, projectId: pid });
    const bmp = await readBackBitmap(reopened, { rect: { x: 0, y: 0, w: 64, h: 64 } });
    expect(bmp.data.every((v) => v === 0)).toBe(true);
    reopened.dispose();
  });

  it('distinguishes cutting a cross-seam stroke’s color source from cutting its final write', async () => {
    const build = async () => {
      const store = new MemoryTileStore();
      const journal = new WriteJournal();
      const doc = await openDoc(store, { width: 64, height: 64, journal });
      // Cross-seam base stroke: covers all four tiles around the seam at 32.
      await doc.commitStroke({
        id: 'base',
        points: [{ x: 4, y: 32 }, { x: 60, y: 32 }],
        style: style({ color: [210, 20, 20, 255], radius: 6 }),
      });
      // Cross-seam smudge starting exactly on the seam crossing.
      const sm = await doc.commitStroke({
        id: 'sm',
        points: [{ x: 32, y: 32 }, { x: 56, y: 56 }],
        style: style({ mode: 'smudge', radius: 5 }),
      });
      const pid = doc.projectId;
      const original = await canvasHash(doc, 64, 64);
      return { store, journal, doc, pid, smudgeSeq: sm.entry!.seq, original };
    };

    // Case 1: cut the color source (the pre-image revision the smudge sampled).
    {
      const { store, journal, doc, pid, smudgeSeq } = await build();
      const manifest = await store.getManifest(pid);
      const smEntry = manifest!.history.find((h) => h.seq === smudgeSeq)!;
      const src = smEntry.stroke!.colorSource!;
      await store.deleteTile(pid, src.key, src.version);
      const diag = await diagnoseProject(store, pid);
      // The lost revision is undo payload / history, not the current canvas.
      expect(diag.totals.missing).toBe(1);
      expect(diag.missingCommitted[0].stage).toBe('undo-payload');
      doc.dispose();

      // Reopen and let the next stroke pick: it reads the real current pixel.
      const reopened = await openDoc(store, { width: 64, height: 64, journal, projectId: pid });
      const next = await reopened.commitStroke({
        id: 'next',
        points: [{ x: 44, y: 44 }, { x: 60, y: 60 }],
        style: style({ mode: 'smudge', radius: 4 }),
      });
      expect(next.ok).toBe(true);
      const picked = next.entry!.stroke!.colorSource!.rgba;
      expect(picked[0]).toBeGreaterThan(150);
      expect(picked[1]).toBeLessThan(80);
      reopened.dispose();
    }

    // Case 2: cut the same stroke's final write (its committed output tile).
    {
      const { store, journal, doc, pid, smudgeSeq, original } = await build();
      const manifest = await store.getManifest(pid);
      const smEntry = manifest!.history.find((h) => h.seq === smudgeSeq)!;
      const written = smEntry.changes.find((c) => c.key === '1,1')!;
      await store.deleteTile(pid, written.key, written.after);
      const diag = await diagnoseProject(store, pid);
      expect(diag.missingCommitted.some((a) => a.stage === 'committed-current')).toBe(true);
      doc.dispose();

      const result = await recoverProject({ store, projectId: pid, journal });
      expect(result.complete).toBe(true);
      expect(result.replayed.map((r) => r.fromSeq)).toEqual([smudgeSeq]);

      const reopened = await openDoc(store, { width: 64, height: 64, journal, projectId: pid });
      expect(await canvasHash(reopened, 64, 64)).toBe(original);
      // After the restart, the next stroke picks the same true color.
      const next = await reopened.commitStroke({
        id: 'next',
        points: [{ x: 44, y: 44 }, { x: 60, y: 60 }],
        style: style({ mode: 'smudge', radius: 4 }),
      });
      expect(next.ok).toBe(true);
      const picked = next.entry!.stroke!.colorSource!.rgba;
      expect(picked[0]).toBeGreaterThan(150);
      expect(picked[1]).toBeLessThan(80);
      reopened.dispose();
    }
  });
});
