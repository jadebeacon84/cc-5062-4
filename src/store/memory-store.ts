import type {
  ProjectManifest,
  ProjectMeta,
  TileStore,
  TileVersionKey,
  TileWriteHook,
} from './types';

/**
 * In-memory store. It deliberately returns copies on read/write so a caller
 * cannot mutate previously "committed" bytes, mirroring a durable store. This
 * is the reference implementation used by the kernel tests; the browser uses
 * IndexedDB and the server export uses files.
 */
export class MemoryTileStore implements TileStore {
  writeHook?: TileWriteHook;
  private readonly projects = new Map<string, ProjectMeta>();
  private readonly manifests = new Map<string, ProjectManifest>();
  private readonly tiles = new Map<string, Map<string, Uint8Array>>();
  /** Number of successful writes; lets tests assert on persistence activity. */
  writes = 0;

  async listProjects(): Promise<ProjectMeta[]> {
    return [...this.projects.values()].map((p) => ({ ...p }));
  }

  async createProject(meta: ProjectMeta): Promise<void> {
    this.projects.set(meta.id, { ...meta });
    this.tiles.set(meta.id, this.tiles.get(meta.id) ?? new Map());
  }

  async getProject(id: string): Promise<ProjectMeta | null> {
    const p = this.projects.get(id);
    return p ? { ...p } : null;
  }

  async updateProject(meta: ProjectMeta): Promise<void> {
    this.projects.set(meta.id, { ...meta });
  }

  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
    this.manifests.delete(id);
    this.tiles.delete(id);
  }

  async getManifest(projectId: string): Promise<ProjectManifest | null> {
    const m = this.manifests.get(projectId);
    return m ? structuredClone(m) : null;
  }

  async putManifest(manifest: ProjectManifest): Promise<void> {
    this.manifests.set(manifest.projectId, structuredClone(manifest));
    this.writes++;
  }

  async getTile(projectId: string, key: string, version: number): Promise<Uint8Array | null> {
    const t = this.tiles.get(projectId)?.get(versionKey(key, version));
    return t ? t.slice() : null;
  }

  async statTile(projectId: string, key: string, version: number): Promise<number | null> {
    const t = this.tiles.get(projectId)?.get(versionKey(key, version));
    return t ? t.byteLength : null;
  }

  async putTile(projectId: string, key: string, version: number, pixels: Uint8Array): Promise<void> {
    let map = this.tiles.get(projectId);
    if (!map) {
      map = new Map();
      this.tiles.set(projectId, map);
    }
    map.set(versionKey(key, version), pixels.slice());
    this.writes++;
  }

  async deleteTile(projectId: string, key: string, version: number): Promise<void> {
    this.tiles.get(projectId)?.delete(versionKey(key, version));
  }

  async listTileVersions(projectId: string): Promise<TileVersionKey[]> {
    const map = this.tiles.get(projectId);
    if (!map) return [];
    return [...map.keys()].map((s) => {
      const at = s.lastIndexOf('@');
      return { key: s.slice(0, at), version: Number(s.slice(at + 1)) };
    });
  }

  /** Test helpers. */
  tileCount(projectId: string): number {
    return this.tiles.get(projectId)?.size ?? 0;
  }

  totalTileBytes(projectId: string): number {
    let n = 0;
    for (const b of this.tiles.get(projectId)?.values() ?? []) n += b.byteLength;
    return n;
  }
}

function versionKey(key: string, version: number): string {
  return `${key}@${version}`;
}
