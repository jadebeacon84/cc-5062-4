import type { Rect } from '../kernel/geometry';
import type { BrushStyle } from '../kernel/brush';

export interface ProjectMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  tileSize: number;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
}

export interface ManifestTile {
  /** Monotonic immutable version stored in the tile store. 0 means "no tile". */
  v: number;
  /** Encoded pixel byte length, used for sanity checks and stats. */
  bytes: number;
}

export interface TileChange {
  key: string;
  before: number;
  after: number;
  bytes: number;
}

/**
 * Durable, replayable record of one stroke, stored on its history entry. This
 * is the transaction log the recovery replay rebuilds from.
 *
 * - 'paint' strokes carry the full style (color included): they replay
 *   anywhere, across any tile boundary.
 * - 'smudge' strokes pick their ink color from the base image. New records
 *   carry the resolved `colorSource` (tile revision + sampled rgba), so a
 *   replay can verify the pre-modification neighbor still exists. Legacy
 *   records (`colorSource` and `style` absent) only record positions; they
 *   can only be replayed faithfully when the canvas state they sampled from
 *   is still reconstructible.
 */
export interface StrokeRecord {
  tool: 'paint' | 'smudge';
  points: { x: number; y: number }[];
  /** Full style for 'paint'; resolved style (picked color) for new 'smudge'. */
  style?: BrushStyle;
  colorSource?: {
    key: string;
    version: number;
    x: number;
    y: number;
    rgba: readonly [number, number, number, number];
  };
}

export interface HistoryEntry {
  id: string;
  seq: number;
  kind: 'stroke' | 'edit';
  createdAt: number;
  bounds: Rect | null;
  changes: TileChange[];
  tilesTouched: number;
  pixelsAffected: number;
  /** Replay payload; absent for composite edits and pre-journal history. */
  stroke?: StrokeRecord;
}

export interface ProjectManifest {
  schemaVersion: 1;
  projectId: string;
  /** Monotonic stroke/transaction sequence. */
  seq: number;
  nextVersion: number;
  tiles: Record<string, ManifestTile>;
  history: HistoryEntry[];
  /** Number of history entries currently applied (undo pointer). */
  cursor: number;
  updatedAt: number;
}

export interface TileVersionKey {
  key: string;
  version: number;
}

export interface TileWriteHook {
  (info: { projectId: string; key: string; version: number; bytes: number; phase: 'staging' | 'manifest' }):
    | void
    | Promise<void>;
}

/**
 * Persistent tile store. Tile versions are immutable; a commit only becomes
 * visible when its manifest is written, which is a single atomic record write.
 * This is what guarantees a reload can never observe a half-finished stroke.
 */
export interface TileStore {
  listProjects(): Promise<ProjectMeta[]>;
  createProject(meta: ProjectMeta): Promise<void>;
  getProject(id: string): Promise<ProjectMeta | null>;
  updateProject(meta: ProjectMeta): Promise<void>;
  deleteProject(id: string): Promise<void>;

  getManifest(projectId: string): Promise<ProjectManifest | null>;
  putManifest(manifest: ProjectManifest): Promise<void>;

  getTile(projectId: string, key: string, version: number): Promise<Uint8Array | null>;
  putTile(projectId: string, key: string, version: number, pixels: Uint8Array): Promise<void>;
  deleteTile(projectId: string, key: string, version: number): Promise<void>;
  listTileVersions(projectId: string): Promise<TileVersionKey[]>;

  /**
   * Optional cheap existence/size probe. Diagnostics prefer this over
   * `getTile` so verifying a version does not download its pixels; stores
   * that cannot stat (e.g. IndexedDB) simply omit it and diagnostics fall
   * back to a real read.
   */
  statTile?(projectId: string, key: string, version: number): Promise<number | null>;

  /** Optional fault-injection / instrumentation seam used by tests. */
  writeHook?: TileWriteHook;
}

export interface StoreCapabilities {
  kind: string;
  persistent: boolean;
}
