import { expect, test, type Page } from '@playwright/test';

const CHROMIUM = process.env.CHROMIUM_PATH;

test.skip(!CHROMIUM, 'CHROMIUM_PATH not set');

interface Stats {
  projectId: string;
  width: number;
  height: number;
  paintedTileCount: number;
  residentTiles: number;
  residentBytes: number;
  memoryBudgetBytes: number;
  previewBytes: number;
  previewLevels: number;
  peakBytes: number;
  undoSteps: number;
  redoSteps: number;
  historyDepth: number;
  scale: number;
}

declare global {
  interface Window {
    __vast: {
      getDoc: () => unknown;
      commitStroke: (points: { x: number; y: number }[], style?: Record<string, unknown>) => Promise<{
        ok: boolean;
        tilesTouched: number;
        error?: { name: string; message: string };
      }>;
      setFailNextWrites: (n: number) => void;
      stats: () => Stats;
      viewport: () => { x: number; y: number; scale: number };
      setViewport: (x: number, y: number, scale: number) => void;
      renderNow: () => Promise<void>;
      reload: () => Promise<void>;
      regionHash: (rect: { x: number; y: number; w: number; h: number }) => Promise<{
        hash: number;
        width: number;
        height: number;
        inked: number;
      }>;
      renderStats: () => { previewFactor: number; tilesDrawn: number; tilesMissing: number } | null;
      visibleInk: () => { inked: number; sampled: number; previewFactor: number };
    };
  }
}

async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __vast?: unknown }).__vast));
  await page.waitForTimeout(800);
  (page as unknown as { _errors: string[] })._errors = errors;
}

test.describe('vast canvas painting window', () => {
  test('boots with a huge logical canvas and a strictly bounded tile budget', async ({ page }) => {
    await boot(page);
    const stats = await page.evaluate(() => window.__vast.stats());
    // 30,000 x 20,000 = 600 megapixels: far larger than any single RGBA buffer
    // that could be resident under the 64 MiB budget.
    expect(stats.width * stats.height).toBeGreaterThanOrEqual(600_000_000);
    expect(stats.paintedTileCount).toBe(0);
    expect(stats.residentBytes).toBe(0);
    // The memory cap is far below the canvas' hypothetical size.
    expect(stats.memoryBudgetBytes).toBeLessThan(stats.width * stats.height * 4);
    // The preview/zoom layer is bounded too, independent of canvas size.
    expect(stats.previewBytes).toBeGreaterThan(0);
    expect(stats.previewBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(stats.previewLevels).toBeGreaterThan(0);
    // The UI declares the real dimensions, not just a label.
    await expect(page.locator('#stat-size')).toContainText('30,000 × 20,000');
    await expect(page.locator('#stat-tile')).toContainText('256');
    // Canvas is drawn (label present).
    await expect(page.locator('#canvas-label')).not.toBeEmpty();
  });

  test('a long drag across many tiles commits, and undo returns to empty', async ({ page }) => {
    await boot(page);
    const box = (await page.locator('#viewport').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Zoom so the drag crosses a good number of 256px tiles.
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(250);
    const before = await page.evaluate(() => window.__vast.stats());
    expect(before.paintedTileCount).toBe(0);

    await page.mouse.move(cx - 260, cy - 120);
    await page.mouse.down();
    for (let i = 0; i <= 48; i++) {
      await page.mouse.move(cx - 260 + i * 11, cy - 120 + Math.sin(i / 7) * 90);
    }
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const after = await page.evaluate(() => window.__vast.stats());
    expect(after.paintedTileCount).toBeGreaterThan(3);
    expect(after.undoSteps).toBe(1);
    // Resident memory never exceeds the cap.
    expect(after.residentBytes).toBeLessThanOrEqual(after.memoryBudgetBytes);
    expect(after.peakBytes).toBeLessThanOrEqual(after.memoryBudgetBytes);
    await expect(page.locator('#stat-painted')).toHaveText(String(after.paintedTileCount));

    // Undo restores the empty canvas at the data level.
    await page.click('#undo');
    await page.waitForTimeout(800);
    const undone = await page.evaluate(() => window.__vast.stats());
    expect(undone.paintedTileCount).toBe(0);
    expect(undone.undoSteps).toBe(0);
    expect(undone.redoSteps).toBe(1);

    // Redo brings every tile back.
    await page.click('#redo');
    await page.waitForTimeout(800);
    const redone = await page.evaluate(() => window.__vast.stats());
    expect(redone.paintedTileCount).toBe(after.paintedTileCount);
  });

  test('a storage failure mid-stroke leaves the canvas unchanged and reports failure', async ({ page }) => {
    await boot(page);
    const box = (await page.locator('#viewport').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(250);

    // A successful stroke first, for a non-empty baseline.
    const ok = await page.evaluate(() =>
      window.__vast.commitStroke([{ x: 4000, y: 4000 }, { x: 8000, y: 6000 }], { radius: 40 })
    );
    expect(ok.ok).toBe(true);
    const before = await page.evaluate(() => window.__vast.stats());
    expect(before.paintedTileCount).toBeGreaterThan(0);

    // Now fail writes on a real drag; the UI must roll back and say so.
    await page.evaluate(() => window.__vast.setFailNextWrites(3));
    await page.mouse.move(cx - 200, cy - 80);
    await page.mouse.down();
    for (let i = 0; i < 30; i++) await page.mouse.move(cx - 200 + i * 13, cy - 80 + Math.sin(i / 4) * 50);
    await page.mouse.up();
    await page.waitForTimeout(900);

    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toContainText('未留下半条笔迹');
    const after = await page.evaluate(() => window.__vast.stats());
    expect(after.paintedTileCount).toBe(before.paintedTileCount);
    expect(after.undoSteps).toBe(before.undoSteps);

    // And a reload agrees: the failed stroke is gone, the good one remains.
    await page.evaluate(() => window.__vast.reload());
    await page.waitForTimeout(500);
    const reloaded = await page.evaluate(() => window.__vast.stats());
    expect(reloaded.paintedTileCount).toBe(before.paintedTileCount);
  });

  test('zoom extremes keep rendering and never blow the budget', async ({ page }) => {
    await boot(page);
    await page.evaluate(() =>
      window.__vast.commitStroke(
        [{ x: 1000, y: 1000 }, { x: 25000, y: 18000 }, { x: 2000, y: 15000 }],
        { radius: 120, color: [200, 40, 90, 255] }
      )
    );
    // Fit (zoomed way out).
    await page.click('#fit-view');
    await page.waitForTimeout(400);
    let s = await page.evaluate(() => window.__vast.stats());
    expect(s.residentBytes).toBeLessThanOrEqual(s.memoryBudgetBytes);
    expect(await page.evaluate(() => document.querySelector('#stat-frame')!.textContent)).toBeTruthy();

    // Zoom in hard.
    const box = (await page.locator('#viewport').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (let i = 0; i < 30; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(10);
    }
    await page.waitForTimeout(500);
    s = await page.evaluate(() => window.__vast.stats());
    // Zoomed in far past 100%, so single tiles exceed the screen.
    expect(s.scale).toBeGreaterThanOrEqual(1);
    expect(s.residentBytes).toBeLessThanOrEqual(s.memoryBudgetBytes);
    const errors = (page as unknown as { _errors: string[] })._errors;
    expect(errors).toEqual([]);
  });

  test('reopening from storage reproduces the committed painting', async ({ page }) => {
    await boot(page);
    await page.evaluate(() =>
      window.__vast.commitStroke([{ x: 3000, y: 2000 }, { x: 9000, y: 8000 }], {
        radius: 50,
        color: [10, 160, 80, 255],
      })
    );
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => window.__vast.stats());
    expect(before.paintedTileCount).toBeGreaterThan(0);

    // Capture a hash of a committed window read back from the kernel (not the
    // preview layer).
    const hashBefore = await page.evaluate(() =>
      window.__vast.regionHash({ x: 2500, y: 1500, w: 7000, h: 7000 })
    );
    expect(hashBefore.inked).toBeGreaterThan(0);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean((window as unknown as { __vast?: unknown }).__vast));
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => window.__vast.stats());
    expect(after.projectId).toBe(before.projectId);
    expect(after.paintedTileCount).toBe(before.paintedTileCount);
    expect(after.undoSteps).toBe(before.undoSteps);

    const hashAfter = await page.evaluate(() =>
      window.__vast.regionHash({ x: 2500, y: 1500, w: 7000, h: 7000 })
    );
    expect(hashAfter).toEqual(hashBefore);
  });

  test('zoomed-out view shows committed strokes via the derived preview layer', async ({ page }) => {
    await boot(page);
    // Baseline at fit zoom on the empty canvas: only paper and the sheet border.
    await page.click('#fit-view');
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__vast.renderNow());
    const baseline = await page.evaluate(() => window.__vast.visibleInk());

    // A very long committed stroke across a large area.
    const res = await page.evaluate(() =>
      window.__vast.commitStroke(
        [{ x: 2000, y: 2000 }, { x: 27000, y: 17000 }],
        { radius: 200, color: [20, 30, 60, 255] }
      )
    );
    expect(res.ok).toBe(true);
    // Fit the whole 600 MP canvas: the viewport spans far more tiles than the
    // memory budget can hold, so the preview layer must be what fills it.
    await page.click('#fit-view');
    await page.waitForTimeout(700);
    await page.evaluate(() => window.__vast.renderNow());
    const ink = await page.evaluate(() => window.__vast.visibleInk());
    expect(ink.sampled).toBeGreaterThan(100);
    // Clearly more than the empty-canvas baseline: the stroke is on screen.
    expect(ink.inked).toBeGreaterThan(baseline.inked + 20);
    expect(ink.previewFactor).toBeGreaterThan(0);

    // Undo must clear it from the preview layer too (it is derived, not truth).
    await page.click('#undo');
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.__vast.renderNow());
          return (await page.evaluate(() => window.__vast.visibleInk())).inked;
        },
        { timeout: 15000 }
      )
      .toBeLessThanOrEqual(baseline.inked);
    const s = await page.evaluate(() => window.__vast.stats());
    expect(s.paintedTileCount).toBe(0);
  });

  test('exporting produces a real PNG download', async ({ page }) => {
    await boot(page);
    await page.evaluate(() =>
      window.__vast.commitStroke([{ x: 5000, y: 5000 }, { x: 9000, y: 7500 }], { radius: 60 })
    );
    await page.waitForTimeout(500);
    const downloadPromise = page.waitForEvent('download');
    await page.click('#export');
    const download = await downloadPromise;
    const name = download.suggestedFilename();
    expect(name).toMatch(/vast-canvas-.*\.png/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream!) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    // PNG signature and non-trivial payload.
    expect([...buf.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(buf.length).toBeGreaterThan(1000);
  });
});
