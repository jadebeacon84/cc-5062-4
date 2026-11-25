import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { TiledDocument } from '../src/kernel/document';
import { FsTileStore } from '../src/store/fs-store';
import { readBackBitmap } from '../src/kernel/export';
import { encodePng } from '../src/export/png';
import { BrushStyle } from '../src/kernel/brush';

const style = (over: Partial<BrushStyle> = {}): BrushStyle => ({
  color: [20, 120, 220, 255],
  radius: 5,
  opacity: 0.9,
  hardness: 0.5,
  ...over,
});

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'huge-canvas-'));
}

describe('filesystem store: real export and project reopen', () => {
  it('writes files that a second process-like open reads back identically', async () => {
    const root = await tmpRoot();
    const store = new FsTileStore(root);
    const doc = await TiledDocument.open({
      store,
      width: 600,
      height: 400,
      tileSize: 64,
      memoryBudgetBytes: 2 * 64 * 64 * 4,
      name: 'disk painting',
    });
    const strokes = [
      { pts: [{ x: 10, y: 20 }, { x: 580, y: 380 }], style: style({ color: [240, 40, 40, 255] }) },
      { pts: [{ x: 590, y: 20 }, { x: 10, y: 380 }], style: style({ color: [40, 200, 120, 200], radius: 3 }) },
      { pts: [{ x: 300, y: 0 }, { x: 300, y: 400 }], style: style({ color: [0, 0, 0, 255], radius: 1.5 }) },
    ];
    for (let i = 0; i < strokes.length; i++) {
      const r = await doc.commitStroke({ id: `s${i}`, points: strokes[i].pts, style: strokes[i].style });
      expect(r.ok).toBe(true);
    }
    const before = await readBackBitmap(doc, { rect: { x: 0, y: 0, w: 600, h: 400 } });
    const projectId = doc.projectId;
    doc.dispose();

    // Reopen with a brand-new store instance rooted at the same files.
    const store2 = new FsTileStore(root);
    const projects = await store2.listProjects();
    expect(projects.some((p) => p.id === projectId)).toBe(true);
    const reopened = await TiledDocument.open({
      store: store2,
      width: 600,
      height: 400,
      tileSize: 64,
      memoryBudgetBytes: 2 * 64 * 64 * 4,
      projectId,
    });
    const after = await readBackBitmap(reopened, { rect: { x: 0, y: 0, w: 600, h: 400 } });
    expect(after.data).toEqual(before.data);
    expect(reopened.undoStepsAvailable).toBe(3);
    reopened.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('exports a valid PNG whose pixels match committed data', async () => {
    const root = await tmpRoot();
    const store = new FsTileStore(root);
    const doc = await TiledDocument.open({
      store,
      width: 300,
      height: 180,
      tileSize: 32,
      memoryBudgetBytes: 4 * 1024 * 1024,
    });
    const st = style({ color: [255, 0, 128, 255], radius: 7, opacity: 1, hardness: 1 });
    await doc.commitStroke({ id: 'a', points: [{ x: 0, y: 0 }, { x: 299, y: 179 }], style: st });
    const rect = (await doc.paintedBounds()) ?? { x: 0, y: 0, w: 300, h: 180 };
    const bmp = await readBackBitmap(doc, { rect });
    const png = encodePng(bmp.width, bmp.height, new Uint8Array(bmp.data.buffer));
    const file = path.join(root, 'export.png');
    await fs.writeFile(file, png);
    const decoded = PNG.sync.read(Buffer.from(await fs.readFile(file)));
    expect(decoded.width).toBe(bmp.width);
    expect(decoded.height).toBe(bmp.height);
    for (let i = 0; i < bmp.data.length; i++) {
      expect(decoded.data[i]).toBe(bmp.data[i]);
    }
    doc.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('leaves no half stroke on disk if the manifest write is interrupted', async () => {
    const root = await tmpRoot();
    const store = new FsTileStore(root);
    const doc = await TiledDocument.open({
      store,
      width: 256,
      height: 256,
      tileSize: 32,
      memoryBudgetBytes: 4 * 1024 * 1024,
    });
    await doc.commitStroke({ id: 'good', points: [{ x: 10, y: 10 }, { x: 240, y: 240 }], style: style() });
    const before = await readBackBitmap(doc, { rect: { x: 0, y: 0, w: 256, h: 256 } });
    const pid = doc.projectId;
    const manifestPath = path.join(root, 'projects', pid, 'manifest.json');
    const trueManifest = await fs.readFile(manifestPath, 'utf8');

    // Simulate an interrupted commit: tile files land, rename never happens.
    const origPutManifest = store.putManifest.bind(store);
    store.putManifest = async (m) => {
      if (m.history.length > 1) throw new Error('simulated crash before manifest rename');
      return origPutManifest(m);
    };
    const bad = await doc.commitStroke({ id: 'bad', points: [{ x: 240, y: 10 }, { x: 10, y: 240 }], style: style({ radius: 10 }) });
    expect(bad.ok).toBe(false);
    doc.dispose();

    // Manifest on disk still names exactly the first stroke.
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(trueManifest);
    const reopened = await TiledDocument.open({
      store: new FsTileStore(root),
      width: 256,
      height: 256,
      tileSize: 32,
      memoryBudgetBytes: 4 * 1024 * 1024,
      projectId: pid,
    });
    const after = await readBackBitmap(reopened, { rect: { x: 0, y: 0, w: 256, h: 256 } });
    expect(after.data).toEqual(before.data);
    reopened.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
});
