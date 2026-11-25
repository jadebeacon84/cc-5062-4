import { Rect, TileGrid, intersectRect, isEmptyRect } from './geometry';
import { BrushStyle } from './brush';
import { createStrokeRenderer, planStroke, StrokeInput, StrokePlan } from './raster';
import { BudgetedLru, tileBytes } from './memory';
import { CommitAbortedError, InsufficientMemoryError, StorageError } from './errors';
import { AsyncMutex } from './mutex';
import { WriteJournal } from './journal';
import type {
  HistoryEntry,
  ProjectManifest,
  ProjectMeta,
  StrokeRecord,
  TileChange,
  TileStore,
} from '../store/types';

export interface TiledDocumentOptions {
  store: TileStore;
  /** Logical canvas size in pixels. May greatly exceed the memory budget. */
  width: number;
  height: number;
  tileSize?: number;
  /** Hard cap, in bytes, for decoded base tiles resident in memory. */
  memoryBudgetBytes?: number;
  /** Number of edits retained for undo. Undo payload lives in the store. */
  historyLimit?: number;
  projectId?: string;
  name?: string;
  onTilesChanged?: (info: { tiles: Set<string>; bounds: Rect | null; reason: string }) => void;
  /** Async seam used by tests to interleave commits, flushes and undo. */
  commitBarrier?: (phase: 'begin' | 'after-staging' | 'before-manifest' | 'after-manifest') => Promise<void>;
  /** Evidence chain for every durability-relevant step. Bounded; see WriteJournal. */
  journal?: WriteJournal;
}

export type UndoResult =
  | { ok: true; entry: HistoryEntry }
  | { ok: false; reason: 'empty' | 'storage'; message: string };

/** A full-resolution replacement for one tile, produced before a commit starts. */
export interface PreparedEdit {
  key: string;
  tx: number;
  ty: number;
  local: Rect;
  pixels: Uint8ClampedArray;
}

export interface CommitResult {
  ok: boolean;
  entry?: HistoryEntry;
  error?: Error;
  tilesTouched: number;
  pixelsAffected: number;
}

interface TileState {
  tx: number;
  ty: number;
  version: number;
}

const DEFAULT_TILE = 256;

/**
 * A vast tiled raster document.
 *
 * Pixels exist only for tiles that were painted or loaded. There is no
 * full-canvas buffer at any point. Decoded tiles live in a byte-budgeted LRU
 * and are dropped as soon as the budget is needed elsewhere.
 *
 * Durability protocol:
 *   1. New immutable tile versions are written to the store.
 *   2. A single manifest record is replaced atomically; it roots every tile
 *      version the committed canvas needs and carries the undo history.
 * Because step 2 is one atomic record, a reload observes either the whole
 * stroke or none of it — never a partially written stroke.
 *
 * Concurrency protocol:
 *   Commits, undo and redo share one async mutex, so undo can never interleave
 *   with a partially staged stroke. Rendering only reads committed versions,
 *   which are immutable, so it never needs the lock. When undo has to wait for
 *   an in-flight write it blocks; when it cannot run it fails cleanly without
 *   changing state.
 */
export class TiledDocument {
  readonly store: TileStore;
  readonly grid: TileGrid;
  readonly projectId: string;
  private nameValue: string;
  private readonly tileCache: BudgetedLru<Uint8ClampedArray>;
  private readonly historyLimit: number;
  private readonly onTilesChanged?: TiledDocumentOptions['onTilesChanged'];
  private readonly commitBarrier?: TiledDocumentOptions['commitBarrier'];
  /** Write-tracking evidence chain; always present so nothing is under-reported. */
  readonly journal: WriteJournal;
  private readonly lock = new AsyncMutex();

  private tiles = new Map<string, TileState>();
  private history: HistoryEntry[] = [];
  private cursor = 0;
  private seq = 0;
  private nextVersion = 1;

  private constructor(opts: TiledDocumentOptions, meta: ProjectMeta) {
    this.store = opts.store;
    this.grid = new TileGrid(opts.width, opts.height, opts.tileSize ?? DEFAULT_TILE);
    this.projectId = meta.id;
    this.nameValue = meta.name;
    this.historyLimit = Math.max(1, opts.historyLimit ?? 64);
    const budget = opts.memoryBudgetBytes ?? 32 * 1024 * 1024;
    this.tileCache = new BudgetedLru<Uint8ClampedArray>('base-tiles', budget);
    this.onTilesChanged = opts.onTilesChanged;
    this.commitBarrier = opts.commitBarrier;
    this.journal = opts.journal ?? new WriteJournal();
  }

  static async open(opts: TiledDocumentOptions): Promise<TiledDocument> {
    const tileSize = opts.tileSize ?? DEFAULT_TILE;
    if (opts.memoryBudgetBytes !== undefined && opts.memoryBudgetBytes < tileBytes(tileSize, tileSize)) {
      throw new InsufficientMemoryError(
        tileBytes(tileSize, tileSize),
        opts.memoryBudgetBytes,
        `memory budget must hold at least one ${tileSize}x${tileSize} RGBA tile`
      );
    }
    let meta: ProjectMeta;
    if (opts.projectId) {
      const found = await opts.store.getProject(opts.projectId);
      if (!found) throw new StorageError(`project ${opts.projectId} not found`);
      if (found.width !== opts.width || found.height !== opts.height || found.tileSize !== tileSize) {
        throw new StorageError(
          `project ${opts.projectId} is ${found.width}x${found.height}@${found.tileSize}, requested ${opts.width}x${opts.height}@${tileSize}`
        );
      }
      meta = found;
    } else {
      const now = Date.now();
      meta = {
        id: `proj-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: opts.name ?? 'Untitled',
        width: opts.width,
        height: opts.height,
        tileSize,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      };
      await opts.store.createProject(meta);
    }
    const doc = new TiledDocument(opts, meta);
    await doc.reloadFromStore();
    return doc;
  }

  /** Re-read the manifest and drop every decoded tile. Used by "reopen project". */
  async reloadFromStore(): Promise<void> {
    const manifest = await this.store.getManifest(this.projectId);
    this.tileCache.clear(true);
    this.tiles.clear();
    this.history = [];
    this.cursor = 0;
    this.seq = 0;
    this.nextVersion = 1;
    if (!manifest) {
      this.journal.record({ phase: 'reload', kind: 'reload', commitSeq: 0, ok: true, message: 'no manifest' });
      return;
    }
    this.seq = manifest.seq;
    this.nextVersion = manifest.nextVersion;
    this.cursor = Math.max(0, Math.min(manifest.cursor, manifest.history.length));
    this.history = manifest.history.slice();
    for (const [key, t] of Object.entries(manifest.tiles)) {
      const [tx, ty] = this.grid.parseKey(key);
      if (!this.inBounds(tx, ty) || t.v === 0) continue;
      this.tiles.set(key, { tx, ty, version: t.v });
    }
    this.journal.record({
      phase: 'reload',
      kind: 'reload',
      commitSeq: manifest.seq,
      ok: true,
      message: `${this.tiles.size} tiles, cursor ${this.cursor}/${this.history.length}`,
    });
  }

  private inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.grid.cols && ty < this.grid.rows;
  }

  get width(): number {
    return this.grid.width;
  }

  get height(): number {
    return this.grid.height;
  }

  get tileSize(): number {
    return this.grid.tileSize;
  }

  get name(): string {
    return this.nameValue;
  }

  get residentTiles(): number {
    return this.tileCache.size;
  }

  get residentBytes(): number {
    return this.tileCache.bytes;
  }

  get memoryBudgetBytes(): number {
    return this.tileCache.budgetBytes;
  }

  setMemoryBudget(bytes: number): void {
    this.tileCache.setBudget(bytes);
  }

  get cacheStats() {
    return this.tileCache.snapshot();
  }

  get paintedTileCount(): number {
    return this.tiles.size;
  }

  get historyDepth(): number {
    return this.history.length;
  }

  get undoStepsAvailable(): number {
    return this.cursor;
  }

  get redoStepsAvailable(): number {
    return this.history.length - this.cursor;
  }

  get busy(): boolean {
    return this.lock.held || this.lock.pending > 0;
  }

  /** Keys of every tile that currently has committed pixels. */
  committedTileKeys(): string[] {
    return [...this.tiles.keys()];
  }

  /** Bytes of committed pixel data (not RAM): sum of painted tiles at full resolution. */
  get committedPixelBytes(): number {
    let n = 0;
    for (const t of this.tiles.values()) {
      n += tileBytes(this.grid.tilePixelWidth(t.tx), this.grid.tilePixelHeight(t.ty));
    }
    return n;
  }

  tileVersion(key: string): number {
    return this.tiles.get(key)?.version ?? 0;
  }

  /** Decoded committed tile, loading from the store on a miss. */
  async getTileByKey(key: string): Promise<Uint8ClampedArray | null> {
    const cached = this.tileCache.touch(key);
    if (cached) return cached;
    const state = this.tiles.get(key);
    if (!state) return null;
    const pixels = await this.readVersion(state, key);
    this.tileCache.set(key, pixels, pixels.byteLength);
    return pixels;
  }

  async getTile(tx: number, ty: number): Promise<Uint8ClampedArray | null> {
    return this.getTileByKey(this.grid.tileKey(tx, ty));
  }

  /** Synchronous decoded-pixel lookup for render loops; null means "not resident". */
  peekTile(key: string): Uint8ClampedArray | null {
    return this.tileCache.touch(key) ?? null;
  }

  /** Read a committed tile directly from the store without disturbing the cache. */
  async readCommittedTile(key: string): Promise<Uint8ClampedArray | null> {
    const state = this.tiles.get(key);
    if (!state) return null;
    return this.readVersion(state, key);
  }

  private async readVersion(state: TileState, key: string): Promise<Uint8ClampedArray> {
    const bytes = await this.store.getTile(this.projectId, key, state.version);
    if (!bytes) throw new StorageError(`tile ${key} v${state.version} missing from store`);
    const w = this.grid.tilePixelWidth(state.tx);
    const h = this.grid.tilePixelHeight(state.ty);
    const expected = tileBytes(w, h);
    if (bytes.byteLength !== expected) {
      throw new StorageError(`tile ${key} v${state.version} is ${bytes.byteLength} bytes, expected ${expected}`);
    }
    return new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  /**
   * Load every tile intersecting a canvas rect, if it fits the budget. Tiles
   * outside the budget are simply not resident; the renderer draws tiles as it
   * loads them and can always fall back to preview levels.
   */
  async prepareView(rect: Rect): Promise<{ loaded: number; evicted: number }> {
    const before = this.tileCache.snapshot().evictions;
    const range = this.grid.tilesForRect(this.grid.clipToCanvas(rect));
    if (!range) return { loaded: 0, evicted: 0 };
    let loaded = 0;
    for (let ty = range.y0; ty <= range.y1; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) {
        const key = this.grid.tileKey(tx, ty);
        if (!this.tiles.has(key)) continue;
        await this.getTileByKey(key);
        loaded++;
      }
    }
    const after = this.tileCache.snapshot().evictions;
    return { loaded, evicted: after - before };
  }

  /**
   * Commit a stroke as a single atomic edit unit. Either every affected tile
   * reaches the new manifest, or the document (memory + store) stays at the
   * previous state; the caller gets ok:false and drops its live overlay.
   */
  async commitStroke(input: StrokeInput): Promise<CommitResult> {
    return this.lock.run(() => this.commitStrokeLocked(input));
  }

  /** Caller must already hold `lock`. */
  private async commitStrokeLocked(input: StrokeInput): Promise<CommitResult> {
    // Smudge strokes pick their ink color from the committed canvas before any
    // tile is touched. The sample goes through the normal committed-tile read
    // path; if that read fails (color source lost) the commit fails cleanly
    // instead of fabricating a color.
    let resolved = input;
    let strokeRecord: StrokeRecord | undefined;
    if (input.style.mode === 'smudge') {
      const first = input.points[0];
      let sample: { rgba: [number, number, number, number]; key: string; version: number } | null = null;
      try {
        sample = first ? await this.sampleCommittedColor(first.x, first.y) : null;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.journal.record({
          phase: 'color-source',
          kind: 'stroke',
          commitSeq: this.seq + 1,
          ok: false,
          message: `color source unreadable: ${error.message}`,
        });
        return { ok: false, error, tilesTouched: 0, pixelsAffected: 0 };
      }
      const rgba: [number, number, number, number] = sample ? sample.rgba : [0, 0, 0, 0];
      resolved = { ...input, style: { ...input.style, color: rgba } };
      strokeRecord = {
        tool: 'smudge',
        points: input.points.map((p) => ({ x: p.x, y: p.y })),
        style: resolved.style,
      };
      if (sample && first) {
        strokeRecord.colorSource = {
          key: sample.key,
          version: sample.version,
          x: Math.floor(first.x),
          y: Math.floor(first.y),
          rgba: sample.rgba,
        };
      }
      this.journal.record({
        phase: 'color-source',
        kind: 'stroke',
        commitSeq: this.seq + 1,
        key: sample?.key,
        after: sample?.version,
        rgba,
        ok: true,
        message: sample ? undefined : 'blank canvas: no ink picked up',
      });
    } else {
      strokeRecord = {
        tool: 'paint',
        points: input.points.map((p) => ({ x: p.x, y: p.y })),
        style: input.style,
      };
    }

    const renderer = createStrokeRenderer(resolved, this.grid);
    const plan = renderer.plan;
    if (plan.tiles.length === 0) return { ok: true, tilesTouched: 0, pixelsAffected: 0 };
    const edits: PreparedEdit[] = [];
    // Stream: at most one overlay + one composited tile is alive at a time.
    for (const tile of plan.tiles) {
      const overlay = renderer.renderTile(tile);
      if (!hasInk(overlay)) continue;
      const w = this.grid.tilePixelWidth(tile.tx);
      const h = this.grid.tilePixelHeight(tile.ty);
      const dest = new Uint8ClampedArray(tileBytes(w, h));
      const before = this.tileVersion(tile.key);
      if (before > 0) {
        const existing = await this.getTileByKey(tile.key);
        if (existing) dest.set(existing);
      }
      compositeOverlay(dest, w, overlay, tile.local);
      edits.push({ key: tile.key, tx: tile.tx, ty: tile.ty, local: tile.local, pixels: dest });
    }
    if (edits.length === 0) return { ok: true, tilesTouched: 0, pixelsAffected: 0 };
    return this.commitPreparedLocked(edits, 'stroke', plan.bounds, plan.pixelsPlanned, strokeRecord);
  }

  /**
   * Committed-pixel color at a canvas point, read through the normal tile
   * path. Returns null when the point is off-canvas or unpainted.
   */
  async sampleColor(
    x: number,
    y: number
  ): Promise<{ rgba: [number, number, number, number]; key: string; version: number } | null> {
    return this.sampleCommittedColor(x, y);
  }

  /**
   * Committed-pixel color at a canvas point, read through the normal tile
   * path. Returns null when the point is off-canvas or unpainted.
   */
  private async sampleCommittedColor(
    x: number,
    y: number
  ): Promise<{ rgba: [number, number, number, number]; key: string; version: number } | null> {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return null;
    const tx = Math.floor(px / this.grid.tileSize);
    const ty = Math.floor(py / this.grid.tileSize);
    const key = this.grid.tileKey(tx, ty);
    const state = this.tiles.get(key);
    if (!state) return null;
    const tile = await this.getTileByKey(key);
    if (!tile) return null;
    const w = this.grid.tilePixelWidth(tx);
    const o = ((py - ty * this.grid.tileSize) * w + (px - tx * this.grid.tileSize)) * 4;
    return { rgba: [tile[o], tile[o + 1], tile[o + 2], tile[o + 3]], key, version: state.version };
  }

  /**
   * Commit arbitrary full-resolution tile replacements atomically. Used by the
   * transaction wrapper for composite edits (fills, imports, stroke batches).
   */
  async commitEdits(
    edits: PreparedEdit[],
    kind: HistoryEntry['kind'] = 'edit',
    bounds?: Rect | null
  ): Promise<CommitResult> {
    return this.lock.run(async () => {
      if (edits.length === 0) return { ok: true, tilesTouched: 0, pixelsAffected: 0 };
      const b = bounds !== undefined ? bounds : boundsOfEdits(edits, this.grid);
      let pixels = 0;
      for (const e of edits) pixels += e.local.w * e.local.h;
      return this.commitPreparedLocked(edits, kind, b, pixels);
    });
  }

  /**
   * The one atomic commit path. Stages immutable tile versions, then swaps a
   * single manifest. Failures before the manifest swap leave both store and
   * memory untouched; the caller observes ok:false and the previous canvas.
   * Every step is written to the journal as it happens.
   */
  private async commitPreparedLocked(
    edits: PreparedEdit[],
    kind: HistoryEntry['kind'],
    bounds: Rect | null,
    pixelsAffected: number,
    stroke?: StrokeRecord
  ): Promise<CommitResult> {
    const staged: { key: string; tx: number; ty: number; version: number; bytes: number; local: Rect; before: number }[] = [];
    let manifestDurable = false;
    let entry: HistoryEntry | undefined;
    const commitSeq = this.seq + 1;

    try {
      await this.commitBarrier?.('begin');
      this.journal.record({ phase: 'begin', kind, commitSeq, ok: true, message: `${edits.length} tile edit(s)` });

      for (const edit of edits) {
        const w = this.grid.tilePixelWidth(edit.tx);
        const h = this.grid.tilePixelHeight(edit.ty);
        if (edit.pixels.byteLength !== tileBytes(w, h)) {
          throw new Error(
            `edit for ${edit.key} is ${edit.pixels.byteLength} bytes, expected ${w}x${h}x4`
          );
        }
        const before = this.tileVersion(edit.key);
        const version = this.nextVersion++;
        try {
          await this.store.putTile(this.projectId, edit.key, version, new Uint8Array(edit.pixels.buffer, edit.pixels.byteOffset, edit.pixels.byteLength));
        } catch (err) {
          this.journal.record({
            phase: 'staging-failed',
            kind,
            commitSeq,
            key: edit.key,
            before,
            after: version,
            bytes: edit.pixels.byteLength,
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        await this.store.writeHook?.({
          projectId: this.projectId,
          key: edit.key,
          version,
          bytes: edit.pixels.byteLength,
          phase: 'staging',
        });
        this.journal.record({
          phase: 'staging',
          kind,
          commitSeq,
          key: edit.key,
          before,
          after: version,
          bytes: edit.pixels.byteLength,
          ok: true,
        });
        staged.push({
          key: edit.key,
          tx: edit.tx,
          ty: edit.ty,
          version,
          bytes: edit.pixels.byteLength,
          local: edit.local,
          before,
        });
      }

      await this.commitBarrier?.('after-staging');

      const changes: TileChange[] = staged.map((s) => ({
        key: s.key,
        before: s.before,
        after: s.version,
        bytes: s.bytes,
      }));
      entry = {
        id: `h-${this.seq + 1}`,
        seq: this.seq + 1,
        kind,
        createdAt: Date.now(),
        bounds,
        changes,
        tilesTouched: staged.length,
        pixelsAffected,
      };
      if (stroke) entry.stroke = stroke;

      const nextHistoryFull = this.history.slice(0, this.cursor).concat(entry);
      const trimmed = trimOldest(nextHistoryFull, this.historyLimit);
      const discarded = this.history.slice(this.cursor);
      const nextTiles = new Map(this.tiles);
      for (const s of staged) nextTiles.set(s.key, { tx: s.tx, ty: s.ty, version: s.version });

      await this.commitBarrier?.('before-manifest');
      this.journal.record({ phase: 'before-manifest', kind, commitSeq, ok: true });
      const manifest: ProjectManifest = {
        schemaVersion: 1,
        projectId: this.projectId,
        seq: entry.seq,
        nextVersion: this.nextVersion,
        tiles: serializeTiles(nextTiles, this.grid),
        history: trimmed.entries,
        cursor: trimmed.cursor,
        updatedAt: Date.now(),
      };
      let stagedBytes = 0;
      for (const s of staged) stagedBytes += s.bytes;
      await this.store.putManifest(manifest);
      manifestDurable = true;
      await this.store.writeHook?.({
        projectId: this.projectId,
        key: '*',
        version: entry.seq,
        bytes: 0,
        phase: 'manifest',
      });
      this.journal.record({
        phase: 'manifest',
        kind,
        commitSeq: entry.seq,
        bytes: stagedBytes,
        ok: true,
        message: `${staged.length} tile version(s) rooted`,
      });

      // Publish in memory only after the manifest is durable.
      this.tiles = nextTiles;
      this.history = trimmed.entries;
      this.cursor = trimmed.cursor;
      this.seq = entry.seq;
      // Keep the freshly committed tiles resident so the canvas shows them at
      // once; the budgeted LRU still owns eviction. A tile larger than the
      // whole budget simply stays decoded-on-demand.
      for (const s of staged) this.tileCache.delete(s.key);
      for (const edit of edits) {
        try {
          this.tileCache.set(edit.key, edit.pixels, edit.pixels.byteLength);
        } catch {
          /* over-budget single tile: fall back to store reads */
        }
      }
      this.journal.record({ phase: 'publish', kind, commitSeq: entry.seq, ok: true });

      void this.collectGarbage(trimmed.dropped, discarded);
      await this.commitBarrier?.('after-manifest');
      this.notify(new Set(staged.map((s) => s.key)), bounds, kind);
      return { ok: true, entry, tilesTouched: staged.length, pixelsAffected };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!manifestDurable) {
        for (const s of staged) {
          try {
            await this.store.deleteTile(this.projectId, s.key, s.version);
          } catch {
            /* unrooted versions are unreachable */
          }
        }
        this.journal.record({
          phase: 'rollback',
          kind,
          commitSeq,
          ok: false,
          message: `${staged.length} staged version(s) discarded: ${error.message}`,
        });
        return {
          ok: false,
          error:
            error instanceof InsufficientMemoryError
              ? error
              : new CommitAbortedError(`${kind} commit rolled back: ${error.message}`, error),
          tilesTouched: 0,
          pixelsAffected: 0,
        };
      }
      this.notify(new Set(staged.map((s) => s.key)), bounds, kind);
      return { ok: true, entry, tilesTouched: staged.length, pixelsAffected };
    }
  }

  private async collectGarbage(dropped: HistoryEntry[], discarded: HistoryEntry[]): Promise<void> {
    const live = new Set<string>();
    for (const t of this.tiles.values()) live.add(`${t.tx},${t.ty}@${t.version}`);
    for (const h of this.history) {
      for (const c of h.changes) {
        if (c.before > 0) live.add(`${c.key}@${c.before}`);
        if (c.after > 0) live.add(`${c.key}@${c.after}`);
      }
    }
    const candidates = [...dropped, ...discarded];
    for (const h of candidates) {
      for (const c of h.changes) {
        for (const v of [c.before, c.after]) {
          if (v > 0 && !live.has(`${c.key}@${v}`)) {
            try {
              await this.store.deleteTile(this.projectId, c.key, v);
              this.journal.record({ phase: 'gc-delete', kind: 'gc', key: c.key, after: v, ok: true });
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }

  async undo(): Promise<UndoResult> {
    return this.stepHistory(-1);
  }

  async redo(): Promise<UndoResult> {
    return this.stepHistory(1);
  }

  private async stepHistory(dir: -1 | 1): Promise<UndoResult> {
    // Blocking behind any in-flight commit is deliberate: we always act on a
    // fully committed state. There is no window where undo can see staged tiles.
    return this.lock.run(async () => {
      if (dir === -1 && this.cursor <= 0) return { ok: false, reason: 'empty', message: 'nothing to undo' };
      if (dir === 1 && this.cursor >= this.history.length)
        return { ok: false, reason: 'empty', message: 'nothing to redo' };
      const entryIndex = dir === -1 ? this.cursor - 1 : this.cursor;
      const entry = this.history[entryIndex];
      if (!entry) return { ok: false, reason: 'empty', message: 'history boundary reached' };
      const restoring = dir === -1;
      const targetCursor = this.cursor + dir;
      const journalKind = restoring ? 'undo' : 'redo';

      // Validate all source versions before touching any state.
      const source = new Map<string, number>();
      for (const c of entry.changes) {
        const version = restoring ? c.before : c.after;
        source.set(c.key, version);
        if (version > 0 && !(await this.store.getTile(this.projectId, c.key, version))) {
          this.journal.record({
            phase: 'history-failed',
            kind: journalKind,
            commitSeq: entry.seq,
            key: c.key,
            after: version,
            ok: false,
            message: `tile ${c.key}@${version} missing from storage`,
          });
          return {
            ok: false,
            reason: 'storage',
            message: `cannot ${restoring ? 'undo' : 'redo'}: tile ${c.key}@${version} is missing from storage`,
          };
        }
      }

      const nextTiles = new Map(this.tiles);
      for (const c of entry.changes) {
        const version = source.get(c.key) ?? 0;
        if (version === 0) nextTiles.delete(c.key);
        else {
          const [tx, ty] = this.grid.parseKey(c.key);
          nextTiles.set(c.key, { tx, ty, version });
        }
      }

      const manifest: ProjectManifest = {
        schemaVersion: 1,
        projectId: this.projectId,
        seq: this.seq,
        nextVersion: this.nextVersion,
        tiles: serializeTiles(nextTiles, this.grid),
        history: this.history,
        cursor: targetCursor,
        updatedAt: Date.now(),
      };
      try {
        await this.store.putManifest(manifest);
      } catch (e) {
        this.journal.record({
          phase: 'history-failed',
          kind: journalKind,
          commitSeq: entry.seq,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        });
        return { ok: false, reason: 'storage', message: e instanceof Error ? e.message : String(e) };
      }

      const changedKeys = new Set(entry.changes.map((c) => c.key));
      for (const key of changedKeys) this.tileCache.delete(key);
      this.tiles = nextTiles;
      this.cursor = targetCursor;
      this.journal.record({
        phase: journalKind,
        kind: journalKind,
        commitSeq: entry.seq,
        ok: true,
        message: `${changedKeys.size} tile(s) repointed`,
      });
      this.notify(changedKeys, entry.bounds, restoring ? 'undo' : 'redo');
      return { ok: true, entry };
    });
  }

  /**
   * Full-resolution read-back used by export. `out` must be outWidth x rect.h.
   * Only the rows of `rect` are written; tiles are read one at a time, so the
   * caller controls peak memory by choosing a band height. Unpainted pixels get
   * `background` (default fully transparent white).
   */
  async readPixels(
    rect: Rect,
    out: Uint8ClampedArray,
    outWidth: number,
    opts: { background?: readonly [number, number, number, number] } = {}
  ): Promise<Rect> {
    const clipped = this.grid.clipToCanvas(rect);
    if (isEmptyRect(clipped)) return clipped;
    out.fill(0);
    const bg = opts.background ?? [0, 0, 0, 0];
    const range = this.grid.tilesForRect(clipped);
    if (!range) return clipped;
    for (let ty = range.y0; ty <= range.y1; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) {
        const key = this.grid.tileKey(tx, ty);
        const tileRect = this.grid.tileRect(tx, ty);
        const local = intersectRect(clipped, tileRect);
        if (isEmptyRect(local)) continue;
        const pixels = this.tiles.has(key) ? await this.getTileByKey(key) : null;
        const srcW = this.grid.tilePixelWidth(tx);
        const lx = local.x - tileRect.x;
        const ly = local.y - tileRect.y;
        for (let y = 0; y < local.h; y++) {
          for (let x = 0; x < local.w; x++) {
            const dst = ((local.y - clipped.y + y) * outWidth + (local.x - clipped.x + x)) * 4;
            if (!pixels) {
              out[dst] = bg[0];
              out[dst + 1] = bg[1];
              out[dst + 2] = bg[2];
              out[dst + 3] = bg[3];
              continue;
            }
            const src = ((ly + y) * srcW + (lx + x)) * 4;
            out[dst] = pixels[src];
            out[dst + 1] = pixels[src + 1];
            out[dst + 2] = pixels[src + 2];
            out[dst + 3] = pixels[src + 3];
          }
        }
      }
    }
    return clipped;
  }

  /**
   * Compose a not-yet-committed stroke into a scratch buffer for live display.
   * This never touches tiles or the store; the app draws it as a preview layer
   * until commitStroke succeeds, then discards it. If the commit fails the
   * preview is dropped and the canvas shows the prior committed state.
   */
  async renderStrokePreview(
    input: StrokeInput,
    rect: Rect,
    outWidth: number
  ): Promise<Uint8ClampedArray> {
    const clipped = this.grid.clipToCanvas(rect);
    const out = new Uint8ClampedArray(clipped.w * clipped.h * 4);
    if (isEmptyRect(clipped)) return out;
    const renderer = createStrokeRenderer(input, this.grid);
    for (const t of renderer.plan.tiles) {
      const overlay = renderer.renderTile(t);
      if (!hasInk(overlay)) continue;
      const tileRect = this.grid.tileRect(t.tx, t.ty);
      const inter = intersectRect(clipped, {
        x: tileRect.x + t.local.x,
        y: tileRect.y + t.local.y,
        w: t.local.w,
        h: t.local.h,
      });
      if (isEmptyRect(inter)) continue;
      for (let y = 0; y < inter.h; y++) {
        for (let x = 0; x < inter.w; x++) {
          const sx = inter.x - tileRect.x - t.local.x + x;
          const sy = inter.y - tileRect.y - t.local.y + y;
          const so = (sy * t.local.w + sx) * 4;
          const sa = overlay[so + 3];
          if (sa === 0) continue;
          const dx = inter.x - clipped.x + x;
          const dy = inter.y - clipped.y + y;
          const doff = (dy * outWidth + dx) * 4;
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
    return out;
  }

  /** Committed bounds covered by tiles (may be much smaller than the canvas). */
  async paintedBounds(): Promise<Rect | null> {
    if (this.tiles.size === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of this.tiles.values()) {
      const r = this.grid.tileRect(t.tx, t.ty);
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  async rename(name: string): Promise<void> {
    const meta = await this.store.getProject(this.projectId);
    if (!meta) throw new StorageError(`project ${this.projectId} not found`);
    meta.name = name;
    meta.updatedAt = Date.now();
    this.nameValue = name;
    await this.store.updateProject(meta);
  }

  async manifestSnapshot(): Promise<ProjectManifest | null> {
    return this.store.getManifest(this.projectId);
  }

  dispose(): void {
    this.tileCache.clear(true);
  }

  private notify(tiles: Set<string>, bounds: Rect | null, reason: string): void {
    this.onTilesChanged?.({ tiles, bounds, reason });
  }
}

function hasInk(overlay: Uint8ClampedArray): boolean {
  for (let i = 3; i < overlay.length; i += 4) if (overlay[i] !== 0) return true;
  return false;
}

/** Source-over composite of a stroke overlay's local rect onto a full tile. */
export function compositeOverlay(
  dest: Uint8ClampedArray,
  destW: number,
  overlay: Uint8ClampedArray,
  local: Rect
): void {
  for (let y = 0; y < local.h; y++) {
    for (let x = 0; x < local.w; x++) {
      const so = (y * local.w + x) * 4;
      const sa = overlay[so + 3];
      if (sa === 0) continue;
      const doff = ((local.y + y) * destW + (local.x + x)) * 4;
      if (sa === 255) {
        dest[doff] = overlay[so];
        dest[doff + 1] = overlay[so + 1];
        dest[doff + 2] = overlay[so + 2];
        dest[doff + 3] = 255;
        continue;
      }
      const s = sa / 255;
      const d = dest[doff + 3] / 255;
      const outA = s + d * (1 - s);
      const outA8 = Math.round(outA * 255);
      if (outA8 === 0) {
        dest[doff + 3] = 0;
        continue;
      }
      dest[doff] = Math.round((overlay[so] * s + dest[doff] * d * (1 - s)) / outA);
      dest[doff + 1] = Math.round((overlay[so + 1] * s + dest[doff + 1] * d * (1 - s)) / outA);
      dest[doff + 2] = Math.round((overlay[so + 2] * s + dest[doff + 2] * d * (1 - s)) / outA);
      dest[doff + 3] = outA8;
    }
  }
}

function boundsOfEdits(edits: PreparedEdit[], grid: TileGrid): Rect | null {
  let out: Rect | null = null;
  for (const e of edits) {
    const r = grid.tileRect(e.tx, e.ty);
    const a = { x: r.x + e.local.x, y: r.y + e.local.y, w: e.local.w, h: e.local.h };
    if (!out) {
      out = a;
      continue;
    }
    const x0 = Math.min(out.x, a.x);
    const y0 = Math.min(out.y, a.y);
    const x1 = Math.max(out.x + out.w, a.x + a.w);
    const y1 = Math.max(out.y + out.h, a.y + a.h);
    out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return out;
}

function serializeTiles(tiles: Map<string, TileState>, grid: TileGrid): ProjectManifest['tiles'] {
  const out: ProjectManifest['tiles'] = {};
  for (const [key, t] of tiles) {
    out[key] = { v: t.version, bytes: tileBytes(grid.tilePixelWidth(t.tx), grid.tilePixelHeight(t.ty)) };
  }
  return out;
}

function trimOldest(
  entries: HistoryEntry[],
  limit: number
): { entries: HistoryEntry[]; cursor: number; dropped: HistoryEntry[] } {
  if (entries.length <= limit) return { entries, cursor: entries.length, dropped: [] };
  const overflow = entries.length - limit;
  return {
    entries: entries.slice(overflow),
    cursor: entries.length - overflow,
    dropped: entries.slice(0, overflow),
  };
}

export { planStroke };
export type { StrokeInput, StrokePlan };
export type { Rect, BrushStyle };
