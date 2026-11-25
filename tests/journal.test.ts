import { describe, expect, it } from 'vitest';
import { TiledDocument } from '../src/kernel/document';
import { MemoryTileStore } from '../src/store/memory-store';
import { WriteJournal } from '../src/kernel/journal';
import { BrushStyle } from '../src/kernel/brush';
import { readBackBitmap } from '../src/kernel/export';

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
  journal?: WriteJournal;
  store?: MemoryTileStore;
}) {
  const store = opts.store ?? new MemoryTileStore();
  const journal = opts.journal ?? new WriteJournal();
  const doc = await TiledDocument.open({
    store,
    width: opts.width ?? 128,
    height: opts.height ?? 128,
    tileSize: opts.tileSize ?? 32,
    memoryBudgetBytes: 4 * 1024 * 1024,
    journal,
  });
  return { store, doc, journal };
}

describe('write journal: evidence chain for commits, versions and disk writes', () => {
  it('records every phase of a cross-block stroke with real tile revisions', async () => {
    const { doc, journal, store } = await open({ width: 96, height: 32, tileSize: 32 });
    const res = await doc.commitStroke({
      id: 's1',
      points: [{ x: 4, y: 16 }, { x: 92, y: 16 }],
      style: style({ radius: 4 }),
    });
    expect(res.ok).toBe(true);
    expect(res.tilesTouched).toBe(3); // crosses all three 32px tiles

    const events = journal.retained();
    const phases = events.map((e) => e.phase);
    expect(phases).toContain('begin');
    expect(phases).toContain('before-manifest');
    expect(phases).toContain('manifest');
    expect(phases).toContain('publish');

    const staged = events.filter((e) => e.phase === 'staging');
    expect(staged.length).toBe(3);
    // Every staged version the journal reports is physically in the store.
    const stored = new Set((await store.listTileVersions(doc.projectId)).map((v) => `${v.key}@${v.version}`));
    for (const e of staged) {
      expect(stored.has(`${e.key}@${e.after}`)).toBe(true);
      expect(e.bytes).toBe(32 * 32 * 4);
      expect(e.ok).toBe(true);
    }
    // Manifest event carries the exact staged byte total.
    const manifest = events.find((e) => e.phase === 'manifest');
    const stagedBytes = staged.reduce((n, e) => n + (e.bytes ?? 0), 0);
    expect(manifest?.bytes).toBe(stagedBytes);

    // The durable stroke record on the history entry allows replay.
    const entry = res.entry!;
    expect(entry.stroke?.tool).toBe('paint');
    expect(entry.stroke?.points.length).toBe(2);
    expect(entry.stroke?.style?.color).toEqual([30, 30, 30, 255]);

    const snap = journal.snapshot();
    expect(snap.phases['staging']).toBe(3);
    expect(snap.bytesStaged).toBe(stagedBytes);
    expect(snap.failures).toBe(0);
    doc.dispose();
  });

  it('never reports a write that did not happen when a commit rolls back', async () => {
    const store = new MemoryTileStore();
    const journal = new WriteJournal();
    let calls = 0;
    const origPut = store.putTile.bind(store);
    store.putTile = async (pid, key, version, pixels) => {
      calls++;
      if (calls === 2) throw new Error('disk full');
      return origPut(pid, key, version, pixels);
    };
    const { doc } = await open({ store, journal, width: 128, height: 32, tileSize: 32 });
    const res = await doc.commitStroke({
      id: 'bad',
      points: [{ x: 4, y: 16 }, { x: 124, y: 16 }],
      style: style(),
    });
    expect(res.ok).toBe(false);

    const events = journal.retained();
    // Exactly one tile reached the disk before the failure; the journal says so.
    expect(events.filter((e) => e.phase === 'staging').length).toBe(1);
    const failed = events.filter((e) => e.phase === 'staging-failed');
    expect(failed.length).toBe(1);
    expect(failed[0].ok).toBe(false);
    // No manifest event: the stroke never committed, and the journal must not
    // claim one. Rollback is recorded instead.
    expect(events.some((e) => e.phase === 'manifest')).toBe(false);
    expect(events.some((e) => e.phase === 'rollback')).toBe(true);
    // Store agrees: nothing left behind.
    expect(await store.listTileVersions(doc.projectId)).toEqual([]);
    expect(journal.snapshot().failures).toBeGreaterThanOrEqual(2);
    doc.dispose();
  });

  it('bounds log cost with a ring buffer while counters stay exact', async () => {
    const journal = new WriteJournal(16);
    const { doc } = await open({ journal, width: 128, height: 32, tileSize: 32 });
    const strokes = 12;
    let stagedTotal = 0;
    for (let i = 0; i < strokes; i++) {
      const r = await doc.commitStroke({
        id: `s${i}`,
        points: [{ x: 4, y: 8 + (i % 3) * 8 }, { x: 124, y: 8 + (i % 3) * 8 }],
        style: style({ radius: 3 }),
      });
      expect(r.ok).toBe(true);
      stagedTotal += r.tilesTouched;
    }
    const snap = journal.snapshot();
    expect(snap.retained).toBeLessThanOrEqual(16);
    expect(snap.droppedEvents).toBeGreaterThan(0);
    // Counters are exact even though event detail was truncated.
    expect(snap.phases['staging']).toBe(stagedTotal);
    expect(snap.phases['manifest']).toBe(strokes);
    expect(snap.totalEvents).toBe(snap.retained + snap.droppedEvents);
    doc.dispose();
  });

  it('records undo, redo and reload against the same evidence chain', async () => {
    const { doc, journal } = await open({ width: 64, height: 64 });
    await doc.commitStroke({ id: 'a', points: [{ x: 4, y: 4 }, { x: 60, y: 60 }], style: style() });
    await doc.undo();
    await doc.redo();
    await doc.reloadFromStore();
    const phases = journal.retained().map((e) => e.phase);
    expect(phases).toContain('undo');
    expect(phases).toContain('redo');
    expect(phases).toContain('reload');
    doc.dispose();
  });

  it('records the color a smudge stroke actually picked, with its source revision', async () => {
    const { doc, journal } = await open({ width: 64, height: 64 });
    await doc.commitStroke({
      id: 'base',
      points: [{ x: 8, y: 8 }, { x: 56, y: 56 }],
      style: style({ color: [220, 30, 30, 255], radius: 8 }),
    });
    const sourceVersion = doc.tileVersion('1,1');
    expect(sourceVersion).toBeGreaterThan(0);

    const smudge = await doc.commitStroke({
      id: 'sm',
      points: [{ x: 40, y: 40 }, { x: 20, y: 20 }],
      style: style({ mode: 'smudge', radius: 5 }),
    });
    expect(smudge.ok).toBe(true);

    const pick = journal.retained().find((e) => e.phase === 'color-source');
    expect(pick).toBeDefined();
    expect(pick!.key).toBe('1,1');
    expect(pick!.after).toBe(sourceVersion);
    // Picked the red ink, not the fallback style color.
    expect(pick!.rgba![0]).toBeGreaterThan(150);
    expect(pick!.rgba![1]).toBeLessThan(90);

    const rec = smudge.entry!.stroke!;
    expect(rec.tool).toBe('smudge');
    expect(rec.colorSource?.key).toBe('1,1');
    expect(rec.colorSource?.version).toBe(sourceVersion);

    // The stroke really painted with the picked color.
    const bmp = await readBackBitmap(doc, { rect: { x: 0, y: 0, w: 64, h: 64 } });
    let reddest = 0;
    for (let i = 0; i < bmp.data.length; i += 4) {
      if (bmp.data[i + 3] > 0) reddest = Math.max(reddest, bmp.data[i] - bmp.data[i + 1]);
    }
    expect(reddest).toBeGreaterThan(100);
    doc.dispose();
  });

  it('smudge on blank canvas is a no-op and says why', async () => {
    const { doc, journal } = await open({ width: 64, height: 64 });
    const res = await doc.commitStroke({
      id: 'sm',
      points: [{ x: 10, y: 10 }, { x: 50, y: 50 }],
      style: style({ mode: 'smudge' }),
    });
    expect(res.ok).toBe(true);
    expect(res.tilesTouched).toBe(0);
    expect(doc.paintedTileCount).toBe(0);
    const pick = journal.retained().find((e) => e.phase === 'color-source');
    expect(pick?.message).toMatch(/blank/);
    doc.dispose();
  });

  it('fails cleanly when the color source read fails, without fabricating ink', async () => {
    const store = new MemoryTileStore();
    const journal = new WriteJournal();
    const { doc } = await open({ store, journal, width: 64, height: 64 });
    await doc.commitStroke({
      id: 'base',
      points: [{ x: 8, y: 8 }, { x: 56, y: 56 }],
      style: style({ color: [10, 10, 200, 255], radius: 8 }),
    });
    // Cut the color source: the committed tile version vanishes from the store.
    const key = '1,1';
    const v = doc.tileVersion(key);
    await store.deleteTile(doc.projectId, key, v);
    doc.dispose();

    const doc2 = await TiledDocument.open({
      store,
      width: 64,
      height: 64,
      tileSize: 32,
      memoryBudgetBytes: 4 * 1024 * 1024,
      projectId: (await store.listProjects())[0].id,
      journal,
    });
    const res = await doc2.commitStroke({
      id: 'sm',
      points: [{ x: 32, y: 32 }, { x: 48, y: 48 }],
      style: style({ mode: 'smudge' }),
    });
    expect(res.ok).toBe(false);
    const pick = journal.retained().filter((e) => e.phase === 'color-source');
    expect(pick.some((e) => e.ok === false)).toBe(true);
    doc2.dispose();
  });
});
