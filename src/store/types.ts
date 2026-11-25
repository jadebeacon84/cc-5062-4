import type { Rect } from '../kernel/geometry';

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

export interface HistoryEntry {
  id: string;
  seq: number;
  kind: 'stroke' | 'edit';
  createdAt: number;
  bounds: Rect | null;
  changes: TileChange[];
  tilesTouched: number;
  pixelsAffected: number;
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

  /** Optional fault-injection / instrumentation seam used by tests. */
  writeHook?: TileWriteHook;
}

export interface StoreCapabilities {
  kind: string;
  persistent: boolean;
}
