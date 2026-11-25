import { TiledDocument } from '../kernel/document';
import { BrushStyle } from '../kernel/brush';
import { Rect } from '../kernel/geometry';
import { CanvasRenderer, Viewport } from '../render/renderer';
import { IndexedDbTileStore } from '../store/indexeddb-store';
import { StrokeInput } from '../kernel/raster';
import { readBackBitmap } from '../kernel/export';

const TILE_SIZE = 256;
const MEMORY_BUDGET = 64 * 1024 * 1024; // 64 MiB of decoded tiles max, regardless of canvas size
const DEFAULT_W = 30_000;
const DEFAULT_H = 20_000;

interface ActiveStroke {
  points: { x: number; y: number }[];
  style: BrushStyle;
  /** Bounds of the live preview in canvas pixels. */
  previewDirty: Rect | null;
  /** Cached preview overlay pixels, recomposed incrementally. */
  previewCanvas: HTMLCanvasElement | null;
  previewRect: Rect | null;
}

class VastCanvasApp {
  private store = new IndexedDbTileStore();
  private doc: TiledDocument | null = null;
  private renderer: CanvasRenderer | null = null;
  private vp: Viewport = { x: 0, y: 0, scale: 1 };
  private readonly canvas: HTMLCanvasElement;
  private readonly stage: HTMLElement;
  private brush: BrushStyle = { color: [28, 30, 38, 255], radius: 6, opacity: 1, hardness: 0.65 };
  private active: ActiveStroke | null = null;
  private dirty = true;
  private loadGeneration = 0;
  private panning = false;
  private spaceDown = false;
  private lastPan: { x: number; y: number } | null = null;
  private commitSeq = 0;
  private statsTimer = 0;
  private pendingFit = false;
  private lastRender: {
    tilesDrawn: number;
    tilesMissing: number;
    visibleTiles: number;
    lastFrameMs: number;
    previewFactor: number;
  } | null = null;

  constructor() {
    this.canvas = must<HTMLCanvasElement>('#viewport');
    this.stage = this.canvas.parentElement as HTMLElement;
  }

  async start(): Promise<void> {
    this.bindUi();
    await this.refreshProjects();
    const projects = await this.store.listProjects();
    if (projects.length > 0) await this.openProject(projects[0].id);
    else await this.createProject(DEFAULT_W, DEFAULT_H);
    this.resizeObserver();
    this.loop();
    log('界面已启动。拖动绘制，滚轮缩放，空格或右键拖动平移。', 'ok');
  }

  // ---------------------------------------------------------------- projects

  private async refreshProjects(): Promise<void> {
    const projects = await this.store.listProjects();
    const sel = must<HTMLSelectElement>('#project-select');
    sel.innerHTML = '';
    for (const p of projects) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.name} · ${formatDims(p.width, p.height)}`;
      sel.appendChild(o);
    }
    if (this.doc) sel.value = this.doc.projectId;
  }

  private async createProject(width: number, height: number): Promise<void> {
    this.setBusy(true, '正创建工程…');
    try {
      const doc = await TiledDocument.open({
        store: this.store,
        width,
        height,
        tileSize: TILE_SIZE,
        memoryBudgetBytes: MEMORY_BUDGET,
        name: `画布 ${formatDims(width, height)}`,
        historyLimit: 48,
        onTilesChanged: (info) => {
          this.onTilesCommitted(info.tiles, info.reason);
          this.invalidate(info.reason);
          this.refreshStatsSoon();
        },
      });
      await this.adoptDocument(doc);
      await this.refreshProjects();
      must<HTMLSelectElement>('#project-select').value = doc.projectId;
      log(
        `新工程 ${formatDims(width, height)}；瓦片 ${TILE_SIZE}px，内存上限 ${formatBytes(MEMORY_BUDGET)}。`,
        'ok'
      );
    } catch (e) {
      this.reportError('创建工程失败', e);
    } finally {
      this.setBusy(false);
    }
  }

  private async openProject(id: string): Promise<void> {
    this.setBusy(true, '正在打开工程…');
    try {
      const meta = await this.store.getProject(id);
      if (!meta) throw new Error(`工程 ${id} 不存在`);
      const doc = await TiledDocument.open({
        store: this.store,
        width: meta.width,
        height: meta.height,
        tileSize: meta.tileSize,
        memoryBudgetBytes: MEMORY_BUDGET,
        projectId: id,
        historyLimit: 48,
        onTilesChanged: (info) => {
          this.onTilesCommitted(info.tiles, info.reason);
          this.invalidate(info.reason);
          this.refreshStatsSoon();
        },
      });
      await this.adoptDocument(doc);
      const swept = await this.store.sweepOrphans(id).catch(() => 0);
      if (swept > 0) log(`清理了 ${swept} 个未提交的瓦片版本。`, 'warn');
      log(`已打开工程「${meta.name}」，可撤销 ${doc.undoStepsAvailable} 步。`, 'ok');
    } catch (e) {
      this.reportError('打开工程失败', e);
    } finally {
      this.setBusy(false);
    }
  }

  private async adoptDocument(doc: TiledDocument): Promise<void> {
    this.doc?.dispose();
    this.doc = doc;
    this.active = null;
    this.renderer = new CanvasRenderer(this.canvas, doc);
    this.renderer.onPreviewUpdate = () => this.invalidate('preview-layer');
    this.vp = this.renderer.fitViewport();
    this.updateZoomUi();
    this.invalidate('open');
    this.refreshStats();
    this.pendingFit = true;
    // Derive the coarse zoom layer from committed tiles. This is display-only
    // and never consulted by undo or export; base tiles remain the truth.
    const keys = doc.committedTileKeys();
    if (keys.length > 0 && this.renderer) {
      const preview = this.renderer.preview;
      const job = preview.rebuildAll((done, total) => {
        const busy = must('#busy');
        if (!busy.hidden) must('#busy-text').textContent = `构建缩放预览层 ${done}/${total}`;
      });
      if (keys.length <= 512) {
        await job.catch((e) => log(`预览层构建失败：${(e as Error).message}`, 'err'));
      } else {
        void job
          .then(() => log(`缩放预览层已构建（${keys.length} 个瓦片）。`, 'ok'))
          .catch((e) => log(`预览层构建失败：${(e as Error).message}`, 'err'));
      }
      this.invalidate('preview-ready');
    }
  }

  /** Keep the derived zoom layer in step with committed tile changes. */
  private onTilesCommitted(tiles: Set<string>, reason: string): void {
    if (!this.renderer) return;
    if (reason === 'undo' || reason === 'redo' || reason === 'reopen' || reason === 'open') {
      for (const key of tiles) this.renderer.preview.markTile(key);
    } else {
      for (const key of tiles) {
        const [tx, ty] = this.doc!.grid.parseKey(key);
        const pixels = this.doc!.peekTile(key);
        if (pixels) {
          this.renderer.preview.updateFromPixels(
            key,
            tx,
            ty,
            pixels,
            this.doc!.grid.tilePixelWidth(tx),
            this.doc!.grid.tilePixelHeight(ty)
          );
        } else {
          this.renderer.preview.markTile(key);
        }
      }
    }
    this.invalidate('preview-sync');
  }

  // --------------------------------------------------------------- input

  private bindUi(): void {
    addEventListener('resize', () => {
      this.invalidate('resize');
    });

    const color = must<HTMLInputElement>('#brush-color');
    color.addEventListener('input', () => {
      const rgb = hexToRgb(color.value);
      this.brush = { ...this.brush, color: [rgb[0], rgb[1], rgb[2], 255] };
    });
    bindRange('#brush-radius', '#radius-val', (v) => {
      this.brush = { ...this.brush, radius: v };
    });
    bindRange('#brush-opacity', '#opacity-val', (v) => {
      this.brush = { ...this.brush, opacity: v / 100 };
    });
    bindRange('#brush-hardness', '#hardness-val', (v) => {
      this.brush = { ...this.brush, hardness: v / 100 };
    });

    must('#new-project').addEventListener('click', () => {
      const sel = must<HTMLSelectElement>('#size-select');
      const [w, h] = sel.value.split('x').map(Number);
      void this.createProject(w, h);
    });
    must('#reopen-project').addEventListener('click', async () => {
      if (!this.doc) return;
      const id = this.doc.projectId;
      this.setBusy(true, '重新从存储加载…');
      try {
        await this.doc.reloadFromStore();
        if (this.renderer) {
          this.renderer.preview.clear();
          await this.renderer.preview.rebuildAll((done, total) => {
            must('#busy-text').textContent = `重建预览层… ${done}/${total}`;
          });
        }
        this.invalidate('reopen');
        this.refreshStats();
        toast('已从存储重开工程，画面来自已提交瓦片。', 'success');
      } catch (e) {
        this.reportError('重开失败', e);
      } finally {
        this.setBusy(false);
      }
      void id;
    });
    must('#project-select').addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value;
      if (id && id !== this.doc?.projectId) void this.openProject(id);
    });

    must('#undo').addEventListener('click', () => void this.doUndo());
    must('#redo').addEventListener('click', () => void this.doRedo());
    must('#export').addEventListener('click', () => void this.doExport());
    must('#fit-view').addEventListener('click', () => {
      if (this.renderer) {
        this.vp = this.renderer.fitViewport();
        this.updateZoomUi();
        this.invalidate('fit');
      }
    });
    must('#clear-preview').addEventListener('click', () => {
      this.active = null;
      this.invalidate('discard-preview');
      log('已丢弃未提交的预览笔迹。');
    });

    const zoom = must<HTMLInputElement>('#zoom');
    zoom.addEventListener('input', () => {
      const s = Math.pow(2, Number(zoom.value));
      this.zoomTo(s);
    });
    must('#zoom-in').addEventListener('click', () => this.zoomBy(1.4));
    must('#zoom-out').addEventListener('click', () => this.zoomBy(1 / 1.4));

    addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = true;
        this.canvas.classList.add('panning');
        e.preventDefault();
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) void this.doRedo();
        else void this.doUndo();
      }
      if (e.key === '+' || e.key === '=') this.zoomBy(1.4);
      if (e.key === '-') this.zoomBy(1 / 1.4);
      if (e.key === '0' && this.renderer) {
        this.vp = this.renderer.fitViewport();
        this.updateZoomUi();
        this.invalidate('fit');
      }
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.canvas.classList.remove('panning');
      }
    });

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointerleave', (e) => {
      if (e.buttons === 0) this.updateHud(null);
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0016);
        this.zoomAt(e.offsetX, e.offsetY, factor);
      },
      { passive: false }
    );
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.doc) return;
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.panning = true;
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.canvas.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    const p = this.pointAt(e);
    this.active = {
      points: [p],
      style: this.activeStyle(),
      previewDirty: null,
      previewCanvas: null,
      previewRect: null,
    };
    this.recomposePreview();
    this.invalidate('stroke-start');
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.doc) return;
    if (this.panning && this.lastPan) {
      const dx = e.clientX - this.lastPan.x;
      const dy = e.clientY - this.lastPan.y;
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.vp.x -= dx / this.vp.scale;
      this.vp.y -= dy / this.vp.scale;
      this.invalidate('pan');
      return;
    }
    const p = this.pointAt(e);
    this.updateHud(p);
    if (!this.active) return;
    const pts = this.active.points;
    const last = pts[pts.length - 1];
    const dist = Math.hypot(p.x - last.x, p.y - last.y);
    // Skip micro-movements, but interpolate long jumps (fast input, low zoom,
    // coalesced pointer events) so the stroke stays continuous instead of
    // becoming dotted. Points are added at a fraction of the brush radius.
    const spacing = Math.max(0.5, this.effectiveRadius() * 0.35);
    if (dist < spacing) return;
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      pts.push({ x: last.x + (p.x - last.x) * t, y: last.y + (p.y - last.y) * t });
    }
    this.recomposePreview();
    this.invalidate('stroke-move');
  }

  private async onPointerUp(e: PointerEvent): Promise<void> {
    if (this.panning) {
      this.panning = false;
      this.lastPan = null;
      this.canvas.classList.remove('panning');
      return;
    }
    if (!this.active || e.button !== 0) return;
    const stroke = this.active;
    this.active = null;
    const pts = simplify(stroke.points, 0.35);
    if (pts.length === 0) {
      this.invalidate('stroke-empty');
      return;
    }
    await this.commitStroke(pts, stroke.style);
  }

  /**
   * Brush size in canvas pixels. Below ~25% zoom the raw radius would be
   * sub-pixel on screen, so the radius grows so the stroke stays paintable.
   */
  private effectiveRadius(): number {
    const minScreenRadius = 1.6;
    const r = this.brush.radius;
    if (this.vp.scale >= 0.25) return r;
    return Math.max(r / this.vp.scale * 0.25, minScreenRadius / this.vp.scale);
  }

  private activeStyle(): BrushStyle {
    return { ...this.brush, radius: this.effectiveRadius() };
  }

  private pointAt(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const p = this.renderer!.screenToCanvas(this.vp, sx, sy);
    return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
  }

  // --------------------------------------------------------------- commit

  private async commitStroke(points: { x: number; y: number }[], style: BrushStyle): Promise<void> {
    if (!this.doc) return;
    const doc = this.doc;
    const gen = this.loadGeneration;
    const input: StrokeInput = {
      id: `stroke-${++this.commitSeq}-${Date.now()}`,
      points,
      style,
    };
    const started = performance.now();
    this.setBusy(true, '提交笔画…');
    const result = await doc.commitStroke(input);
    this.setBusy(false);
    if (this.active) {
      // A new stroke began while this one was committing; leave it alone.
    }
    if (!result.ok) {
      // The kernel rolled everything back; drop the preview so the canvas shows
      // the previous committed content, and tell the user plainly.
      this.active = null;
      this.invalidate('commit-failed');
      const reason =
        result.error?.name === 'OutOfMemoryForEditError'
          ? '内存不足，整笔未提交'
          : `提交失败：${result.error?.message ?? '未知错误'}`;
      toast(`${reason}。画布已回退到上一步，未留下半条笔迹。`, 'error');
      log(`${reason}（受影响瓦片 ${result.tilesTouched} 已回滚）`, 'err');
      this.refreshStats();
      return;
    }
    if (gen !== this.loadGeneration) return;
    this.invalidate('commit');
    const ms = Math.round(performance.now() - started);
    must('#stat-last-commit').textContent = `${result.tilesTouched} 瓦片 / ${ms} ms`;
    log(
      `提交 1 笔：${result.tilesTouched} 个瓦片，${result.pixelsAffected.toLocaleString()} 像素，${ms} ms。`,
      'ok'
    );
    this.refreshStats();
  }

  /** Rebuild the live preview overlay for the current active stroke. */
  private recomposePreview(): void {
    if (!this.active || !this.doc) return;
    const st = this.active;
    // Bounds of everything drawn so far, padded by brush radius.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of st.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = st.style.radius + 3;
    const rect: Rect = {
      x: Math.floor(minX - pad),
      y: Math.floor(minY - pad),
      w: Math.ceil(maxX + pad) - Math.floor(minX - pad),
      h: Math.ceil(maxY + pad) - Math.floor(minY - pad),
    };
    const clipped = this.doc.grid.clipToCanvas(rect);
    if (clipped.w <= 0 || clipped.h <= 0) {
      st.previewCanvas = null;
      st.previewRect = null;
      return;
    }
    // Rendering a preview is synchronous and independent of commit state. The
    // preview returns its own bounds; those must be the ones used to size the
    // ImageData, not the padded request rect.
    const preview = composeStrokePreviewSync(this.doc, { id: 'preview', points: st.points, style: st.style });
    if (!preview || preview.rect.w <= 0 || preview.rect.h <= 0) {
      st.previewCanvas = null;
      st.previewRect = null;
      return;
    }
    const pr = preview.rect;
    let cvs = st.previewCanvas;
    if (!cvs || cvs.width !== pr.w || cvs.height !== pr.h) {
      cvs = document.createElement('canvas');
      cvs.width = pr.w;
      cvs.height = pr.h;
    }
    const c = cvs.getContext('2d')!;
    c.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels), pr.w, pr.h), 0, 0);
    st.previewCanvas = cvs;
    st.previewRect = pr;
  }

  // --------------------------------------------------------------- undo etc.

  private async doUndo(): Promise<void> {
    if (!this.doc) return;
    this.setBusy(true, '撤销…');
    const r = await this.doc.undo();
    this.setBusy(false);
    if (r.ok) {
      log('已撤销上一笔，受影响瓦片按原字节恢复。', 'ok');
      this.refreshStats();
    } else if (r.reason === 'empty') {
      toast('没有可撤销的编辑。', 'error');
    } else {
      toast(`撤销失败：${r.message}。画布保持不变。`, 'error');
      log(`撤销失败：${r.message}`, 'err');
    }
  }

  private async doRedo(): Promise<void> {
    if (!this.doc) return;
    this.setBusy(true, '重做…');
    const r = await this.doc.redo();
    this.setBusy(false);
    if (r.ok) {
      log('已重做。', 'ok');
      this.refreshStats();
    } else if (r.reason === 'empty') {
      toast('没有可重做的编辑。', 'error');
    } else {
      toast(`重做失败：${r.message}。画布保持不变。`, 'error');
    }
  }

  private async doExport(): Promise<void> {
    if (!this.doc) return;
    this.setBusy(true, '导出中：读取已提交瓦片…');
    try {
      const bounds = (await this.doc.paintedBounds()) ?? { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
      // Cap the export to a sane pixel budget; a 45 GP canvas cannot be encoded
      // in one PNG, and pretending otherwise would be dishonest.
      const maxPixels = 64 * 1024 * 1024; // 64 MP
      let rect = bounds;
      if (rect.w * rect.h > maxPixels) {
        const scale = Math.sqrt(maxPixels / (rect.w * rect.h));
        rect = {
          x: Math.floor(rect.x + (rect.w * (1 - scale)) / 2),
          y: Math.floor(rect.y + (rect.h * (1 - scale)) / 2),
          w: Math.max(1, Math.floor(rect.w * scale)),
          h: Math.max(1, Math.floor(rect.h * scale)),
        };
        toast('选区超过 64 MP，已导出中心区域。完整导出请用命令行工具。', 'error');
      }
      const bmp = await readBackBitmap(this.doc, {
        rect,
        background: [255, 253, 248, 255],
        bandHeight: 256,
      });
      const blob = await encodePngInBrowser(bmp.width, bmp.height, bmp.data);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vast-canvas-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`已导出 ${bmp.width} × ${bmp.height} PNG（${formatBytes(blob.size)}）。`, 'success');
      log(`导出 ${bmp.width}×${bmp.height}，源为已提交瓦片，非预览层。`, 'ok');
    } catch (e) {
      this.reportError('导出失败', e);
    } finally {
      this.setBusy(false);
    }
  }

  // --------------------------------------------------------------- viewport

  private zoomAt(sx: number, sy: number, factor: number): void {
    if (!this.renderer) return;
    this.zoomTo(this.vp.scale * factor, sx, sy);
  }

  private zoomTo(scale: number, sx?: number, sy?: number): void {
    if (!this.renderer) return;
    const clamped = Math.min(32, Math.max(0.0004, scale));
    const anchorX = sx ?? this.renderer.width / 2;
    const anchorY = sy ?? this.renderer.height / 2;
    const before = this.renderer.screenToCanvas(this.vp, anchorX, anchorY);
    this.vp.scale = clamped;
    const after = this.renderer.screenToCanvas(this.vp, anchorX, anchorY);
    this.vp.x += before.x - after.x;
    this.vp.y += before.y - after.y;
    this.updateZoomUi();
    this.invalidate('zoom');
  }

  private zoomBy(factor: number): void {
    this.zoomTo(this.vp.scale * factor);
  }

  private updateZoomUi(): void {
    const pct = this.vp.scale * 100;
    must('#zoom-val').textContent = pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(2)}%`;
    const z = must<HTMLInputElement>('#zoom');
    z.value = String(Math.log2(Math.max(1e-9, this.vp.scale)));
  }

  // --------------------------------------------------------------- render loop

  private invalidate(reason: string): void {
    this.dirty = true;
    void reason;
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    if (this.dirty) {
      this.dirty = false;
      this.renderFrame();
    }
  };

  private renderFrame(): void {
    if (!this.doc || !this.renderer) return;
    if (this.pendingFit) {
      this.renderer.resize();
      if (this.renderer.width > 10 && this.renderer.height > 10) {
        this.vp = this.renderer.fitViewport();
        this.updateZoomUi();
        this.pendingFit = false;
      }
    }
    const stats = this.renderer.render(this.vp, (ctx) => {
      const st = this.active;
      if (st?.previewCanvas && st.previewRect) {
        const s = this.vp.scale;
        const x = (st.previewRect.x - this.vp.x) * s;
        const y = (st.previewRect.y - this.vp.y) * s;
        ctx.imageSmoothingEnabled = s < 1;
        ctx.drawImage(st.previewCanvas, x, y, st.previewRect.w * s, st.previewRect.h * s);
      }
    });
    this.updateFrameStats(stats);
    const c = this.renderer.canvasToScreen(this.vp, this.doc.width / 2, this.doc.height / 2);
    must('#canvas-label').textContent = this.doc.name;
    void c;
    // Kick background decoding for any visible tile not yet resident.
    if (stats.tilesMissing > 0) this.prefetchVisible();
  }

  private prefetchEpoch = 0;
  private async prefetchVisible(): Promise<void> {
    if (!this.doc || !this.renderer) return;
    const epoch = ++this.prefetchEpoch;
    const rect = this.renderer.visibleRect(this.vp, 0);
    try {
      const { loaded } = await this.doc.prepareView(rect);
      if (epoch !== this.prefetchEpoch) return;
      if (loaded > 0) this.invalidate('prefetch');
    } catch (e) {
      log(`瓦片载入失败：${(e as Error).message}`, 'err');
    }
  }

  private updateFrameStats(stats: {
    tilesDrawn: number;
    tilesMissing: number;
    visibleTiles: number;
    lastFrameMs: number;
    previewFactor: number;
  }): void {
    this.lastRender = stats;
    const preview = stats.previewFactor > 0 ? `预览 1/${stats.previewFactor}  ` : '';
    must('#stat-visible').textContent = String(stats.visibleTiles);
    must('#stat-frame').textContent = stats.previewFactor > 0
      ? `${stats.tilesDrawn} 瓦片 + 预览 1/${stats.previewFactor}`
      : `${stats.tilesDrawn} / ${stats.tilesMissing}`;
    must('#hud').textContent =
      `缩放 ${(this.vp.scale * 100).toFixed(this.vp.scale < 0.01 ? 3 : 1)}%  ` +
      `视口 (${Math.round(this.vp.x)}, ${Math.round(this.vp.y)})  ` +
      `${preview}瓦片 ${stats.tilesDrawn}/${stats.visibleTiles}  ` +
      `${stats.lastFrameMs.toFixed(1)} ms`;
    const cx = this.vp.x + (this.renderer!.width / this.vp.scale) / 2;
    const cy = this.vp.y + (this.renderer!.height / this.vp.scale) / 2;
    must('#center-val').textContent = `${Math.round(cx)}, ${Math.round(cy)}`;
    must('#status-left').textContent =
      `已绘制瓦片 ${this.doc?.paintedTileCount ?? 0} · 常驻 ${formatBytes(this.doc?.residentBytes ?? 0)}` +
      ` / ${formatBytes(this.doc?.memoryBudgetBytes ?? 0)} · 可撤销 ${this.doc?.undoStepsAvailable ?? 0}`;
    must('#status-right').textContent = `渲染 ${stats.lastFrameMs.toFixed(1)} ms · ${(
      this.vp.scale * 100
    ).toFixed(1)}%`;
  }

  private refreshStatsSoon(): void {
    clearTimeout(this.statsTimer);
    this.statsTimer = window.setTimeout(() => this.refreshStats(), 120);
  }

  private refreshStats(): void {
    if (!this.doc) return;
    const d = this.doc;
    must('#stat-size').textContent = formatDims(d.width, d.height);
    must('#stat-tile').textContent = `${d.tileSize} × ${d.tileSize}`;
    must('#stat-painted').textContent = d.paintedTileCount.toLocaleString();
    must('#stat-resident').textContent = `${d.residentTiles} tiles / ${formatBytes(d.residentBytes)}`;
    must('#stat-budget').textContent = formatBytes(d.memoryBudgetBytes);
    const pv = this.renderer?.preview;
    must('#stat-preview').textContent = pv
      ? `${pv.levelCount} 级 / ${formatBytes(pv.pixelBytes)}`
      : '—';
    const u = must<HTMLButtonElement>('#undo');
    const r = must<HTMLButtonElement>('#redo');
    u.disabled = d.undoStepsAvailable === 0;
    r.disabled = d.redoStepsAvailable === 0;
    must('#status-left').textContent =
      `已绘制瓦片 ${d.paintedTileCount} · 常驻 ${formatBytes(d.residentBytes)} / ${formatBytes(
        d.memoryBudgetBytes
      )} · 可撤销 ${d.undoStepsAvailable}`;
  }

  private updateHud(p: { x: number; y: number } | null): void {
    if (!p || !this.doc) return;
    const inside = p.x >= 0 && p.y >= 0 && p.x < this.doc.width && p.y < this.doc.height;
    must('#hud').textContent =
      `缩放 ${(this.vp.scale * 100).toFixed(this.vp.scale < 0.01 ? 3 : 1)}%  ` +
      `视口 (${Math.round(this.vp.x)}, ${Math.round(this.vp.y)})  ` +
      `光标 ${inside ? `${p.x.toFixed(0)}, ${p.y.toFixed(0)}` : '画布外'}`;
  }

  private resizeObserver(): void {
    const ro = new ResizeObserver(() => this.invalidate('resize'));
    ro.observe(this.stage);
  }

  private setBusy(on: boolean, text?: string): void {
    const el = must('#busy');
    el.hidden = !on;
    if (text) must('#busy-text').textContent = text;
  }

  private reportError(prefix: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    toast(`${prefix}：${msg}`, 'error');
    log(`${prefix}：${msg}`, 'err');
  }

  // --------------------------------------------------------------- debug/test surface

  docForDebug(): TiledDocument | null {
    return this.doc;
  }
  async commitForDebug(points: { x: number; y: number }[], style?: Partial<BrushStyle>) {
    if (!this.doc) throw new Error('no document');
    const merged: BrushStyle = { ...this.brush, ...style, color: style?.color ?? this.brush.color };
    return this.doc.commitStroke({
      id: `dbg-${++this.commitSeq}`,
      points,
      style: merged as BrushStyle,
    });
  }
  setFailNextWritesForDebug(n: number): void {
    if (!this.doc) return;
    let left = n;
    const store = this.doc.store;
    const orig = store.putTile.bind(store);
    store.putTile = async (pid, key, version, pixels) => {
      if (left > 0) {
        left--;
        throw new Error('注入的写入失败（测试）');
      }
      return orig(pid, key, version, pixels);
    };
  }
  statsForDebug() {
    const d = this.doc;
    if (!d) return null;
    return {
      projectId: d.projectId,
      width: d.width,
      height: d.height,
      paintedTileCount: d.paintedTileCount,
      residentTiles: d.residentTiles,
      residentBytes: d.residentBytes,
      memoryBudgetBytes: d.memoryBudgetBytes,
      previewBytes: this.renderer?.preview.pixelBytes ?? 0,
      previewLevels: this.renderer?.preview.levelCount ?? 0,
      peakBytes: d.cacheStats.peakBytes,
      undoSteps: d.undoStepsAvailable,
      redoSteps: d.redoStepsAvailable,
      historyDepth: d.historyDepth,
      scale: this.vp.scale,
    };
  }
  viewportForDebug(): Viewport {
    return { ...this.vp };
  }
  setViewportForDebug(x: number, y: number, scale: number): void {
    this.vp = { x, y, scale };
    this.pendingFit = false;
    this.updateZoomUi();
    this.invalidate('debug-viewport');
  }
  async renderNowForDebug(): Promise<void> {
    this.renderFrame();
  }
  renderStatsForDebug() {
    return this.lastRender ? { ...this.lastRender } : null;
  }
  /** Sample the on-screen canvas: how many sampled pixels are visibly inked. */
  visibleInkForDebug(): { inked: number; sampled: number; previewFactor: number } {
    const cvs = this.canvas;
    const ctx = cvs.getContext('2d')!;
    const img = ctx.getImageData(0, 0, cvs.width, cvs.height);
    const d = img.data;
    let inked = 0;
    let sampled = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      sampled++;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      // Paper is ~#f4f1ea; anything clearly darker is committed ink.
      if (r < 200 && g < 200 && b < 200) inked++;
    }
    return { inked, sampled, previewFactor: this.lastRender?.previewFactor ?? 0 };
  }
  async regionHashForDebug(rect: Rect): Promise<{ hash: number; width: number; height: number; inked: number }> {
    if (!this.doc) throw new Error('no document');
    const bmp = await readBackBitmap(this.doc, { rect });
    let h = 2166136261;
    let inked = 0;
    for (let i = 0; i < bmp.data.length; i += 4) {
      if (bmp.data[i + 3] > 0) inked++;
      h = (h ^ bmp.data[i]) * 16777619;
      h = (h ^ bmp.data[i + 1]) * 16777619;
      h = (h ^ bmp.data[i + 2]) * 16777619;
      h = (h ^ bmp.data[i + 3]) * 16777619;
    }
    return { hash: h >>> 0, width: bmp.width, height: bmp.height, inked };
  }

  async reloadForDebug(): Promise<void> {
    if (!this.doc) return;
    await this.doc.reloadFromStore();
    this.invalidate('debug-reload');
    this.refreshStats();
  }
}

// ------------------------------------------------------------------ helpers

function composeStrokePreviewSync(
  doc: TiledDocument,
  input: StrokeInput
): { pixels: Uint8ClampedArray; rect: Rect } | null {
  // A synchronous facade over the kernel's streaming renderer: the preview is a
  // pure function of stroke geometry and never reads or mutates committed tiles.
  const grid = doc.grid;
  const { createStrokeRenderer } = previewKernel;
  const renderer = createStrokeRenderer(input, grid);
  const b = renderer.plan.bounds;
  if (b.w <= 0 || b.h <= 0) return null;
  const out = new Uint8ClampedArray(b.w * b.h * 4);
  for (const t of renderer.plan.tiles) {
    const overlay = renderer.renderTile(t);
    const tileRect = grid.tileRect(t.tx, t.ty);
    for (let y = 0; y < t.local.h; y++) {
      for (let x = 0; x < t.local.w; x++) {
        const so = (y * t.local.w + x) * 4;
        const sa = overlay[so + 3];
        if (sa === 0) continue;
        const cx = tileRect.x + t.local.x + x - b.x;
        const cy = tileRect.y + t.local.y + y - b.y;
        if (cx < 0 || cy < 0 || cx >= b.w || cy >= b.h) continue;
        const doff = (cy * b.w + cx) * 4;
        const s = sa / 255;
        const d = out[doff + 3] / 255;
        const outA = s + d * (1 - s);
        const outA8 = Math.round(outA * 255);
        if (outA8 === 0) continue;
        out[doff] = Math.round((overlay[so] * s + out[doff] * d * (1 - s)) / outA);
        out[doff + 1] = Math.round((overlay[so + 1] * s + out[doff + 1] * d * (1 - s)) / outA);
        out[doff + 2] = Math.round((overlay[so + 2] * s + out[doff + 2] * d * (1 - s)) / outA);
        out[doff + 3] = outA8;
      }
    }
  }
  return { pixels: out, rect: b };
}

// Lazy import to keep the heavy rasterizer out of the initial parse path.
import * as previewKernel from '../kernel/raster';

function simplify(points: { x: number; y: number }[], tol: number): { x: number; y: number }[] {
  if (points.length <= 2) return points;
  const out: { x: number; y: number }[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const p = points[i];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) >= tol) out.push(p);
  }
  out.push(points[points.length - 1]);
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function formatDims(w: number, h: number): string {
  const px = w * h;
  const gp = px / 1e9;
  const label = gp >= 1 ? `${gp.toFixed(gp >= 100 ? 0 : 1)} GP` : `${(px / 1e6).toFixed(1)} MP`;
  return `${w.toLocaleString()} × ${h.toLocaleString()} · ${label}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export async function encodePngInBrowser(
  width: number,
  height: number,
  rgba: Uint8ClampedArray
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
  });
}

function must<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el as T;
}

function bindRange(sel: string, labelSel: string, onChange: (v: number) => void): void {
  const input = must<HTMLInputElement>(sel);
  const label = must(labelSel);
  const apply = () => {
    const v = Number(input.value);
    label.textContent = String(v);
    onChange(v);
  };
  input.addEventListener('input', apply);
  apply();
}

let toastTimer = 0;
function toast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  const el = must('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 6500 : 3800);
}

function log(message: string, kind: 'ok' | 'warn' | 'err' | '' = ''): void {
  const box = must('#log');
  const line = document.createElement('div');
  line.className = 'line';
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.innerHTML = `<span class="t">${t}</span><span class="${kind}"></span>`;
  line.lastElementChild!.textContent = message;
  box.prepend(line);
  while (box.childElementCount > 60) box.lastElementChild?.remove();
}

const app = new VastCanvasApp();
void (async () => {
  await app.start();
  (window as unknown as { __app?: unknown }).__app = app;
})();

/**
 * Test/debug control surface. Exposed on purpose so an automated run can drive
 * the kernel directly and force failure paths that are otherwise hard to reach
 * from real input (e.g. storage refusing a tile write mid-stroke).
 */
(window as unknown as { __vast?: unknown }).__vast = {
  getDoc: () => app.docForDebug(),
  commitStroke: (points: { x: number; y: number }[], style?: Partial<BrushStyle>) =>
    app.commitForDebug(points, style),
  setFailNextWrites: (n: number) => app.setFailNextWritesForDebug(n),
  stats: () => app.statsForDebug(),
  viewport: () => app.viewportForDebug(),
  setViewport: (x: number, y: number, scale: number) => app.setViewportForDebug(x, y, scale),
  renderNow: () => app.renderNowForDebug(),
  reload: () => app.reloadForDebug(),
  regionHash: (rect: Rect) => app.regionHashForDebug(rect),
  renderStats: () => app.renderStatsForDebug(),
  visibleInk: () => app.visibleInkForDebug(),
};
