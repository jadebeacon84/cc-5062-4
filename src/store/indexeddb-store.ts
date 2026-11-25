import type {
  ProjectManifest,
  ProjectMeta,
  TileStore,
  TileVersionKey,
  TileWriteHook,
} from './types';

const DB_NAME = 'huge-canvas';
const DB_VERSION = 1;
const STORE_META = 'projects';
const STORE_MANIFEST = 'manifests';
const STORE_TILES = 'tiles';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * IndexedDB-backed tile store.
 *
 * Durability: a stroke's tiles go into individual `put` calls (immutable
 * versions keyed by `${key}@${version}`), then the whole manifest is replaced in
 * a single readwrite transaction. Browsers commit an IDB transaction atomically,
 * so after a reload the manifest either excludes the new stroke (old state) or
 * includes all of it — there is no interleaved state. Orphan tile versions that
 * a crash left unrooted are unreachable and swept on demand.
 */
export class IndexedDbTileStore implements TileStore {
  writeHook?: TileWriteHook;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(STORE_MANIFEST)) db.createObjectStore(STORE_MANIFEST, { keyPath: 'projectId' });
          if (!db.objectStoreNames.contains(STORE_TILES)) db.createObjectStore(STORE_TILES);
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error ?? new Error('failed to open IndexedDB'));
      });
    }
    return this.dbPromise;
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_META, 'readonly');
    const all = await req(tx.objectStore(STORE_META).getAll() as IDBRequest<ProjectMeta[]>);
    await txDone(tx);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createProject(meta: ProjectMeta): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put(meta);
    await txDone(tx);
  }

  async getProject(id: string): Promise<ProjectMeta | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_META, 'readonly');
    const v = await req(tx.objectStore(STORE_META).get(id) as IDBRequest<ProjectMeta | undefined>);
    await txDone(tx);
    return v ?? null;
  }

  async updateProject(meta: ProjectMeta): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put(meta);
    await txDone(tx);
  }

  async deleteProject(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([STORE_META, STORE_MANIFEST, STORE_TILES], 'readwrite');
    tx.objectStore(STORE_META).delete(id);
    tx.objectStore(STORE_MANIFEST).delete(id);
    // Sweep this project's tile versions using the index-free key prefix.
    const tiles = tx.objectStore(STORE_TILES);
    const cursorReq = tiles.openKeyCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const k = String(cursor.key);
      if (k.startsWith(`${id}/`)) tiles.delete(k);
      cursor.continue();
    };
    await txDone(tx);
  }

  async getManifest(projectId: string): Promise<ProjectManifest | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_MANIFEST, 'readonly');
    const v = await req(tx.objectStore(STORE_MANIFEST).get(projectId) as IDBRequest<ProjectManifest | undefined>);
    await txDone(tx);
    return v ?? null;
  }

  async putManifest(manifest: ProjectManifest): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_MANIFEST, 'readwrite');
    tx.objectStore(STORE_MANIFEST).put(manifest);
    await txDone(tx);
  }

  async getTile(projectId: string, key: string, version: number): Promise<Uint8Array | null> {
    const db = await this.db();
    const tx = db.transaction(STORE_TILES, 'readonly');
    const v = await req(
      tx.objectStore(STORE_TILES).get(`${projectId}/${key}@${version}`) as IDBRequest<ArrayBuffer | undefined>
    );
    await txDone(tx);
    return v ? new Uint8Array(v) : null;
  }

  async putTile(projectId: string, key: string, version: number, pixels: Uint8Array): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_TILES, 'readwrite');
    const copy = pixels.slice();
    tx.objectStore(STORE_TILES).put(copy.buffer, `${projectId}/${key}@${version}`);
    await txDone(tx);
  }

  async deleteTile(projectId: string, key: string, version: number): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_TILES, 'readwrite');
    tx.objectStore(STORE_TILES).delete(`${projectId}/${key}@${version}`);
    await txDone(tx);
  }

  async listTileVersions(projectId: string): Promise<TileVersionKey[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_TILES, 'readonly');
    const keys = await req(tx.objectStore(STORE_TILES).getAllKeys() as IDBRequest<IDBValidKey[]>);
    await txDone(tx);
    const prefix = `${projectId}/`;
    const out: TileVersionKey[] = [];
    for (const k of keys) {
      const s = String(k);
      if (!s.startsWith(prefix)) continue;
      const body = s.slice(prefix.length);
      const at = body.lastIndexOf('@');
      out.push({ key: body.slice(0, at), version: Number(body.slice(at + 1)) });
    }
    return out;
  }

  /** Storage footprint estimate, for the UI status line. */
  async estimateBytes(): Promise<{ usage: number; quota: number } | null> {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  }

  /** Remove unrooted tile versions left by interrupted commits. */
  async sweepOrphans(projectId: string): Promise<number> {
    const manifest = await this.getManifest(projectId);
    const live = new Set<string>();
    if (manifest) {
      for (const [key, t] of Object.entries(manifest.tiles)) live.add(`${key}@${t.v}`);
      for (const h of manifest.history) {
        for (const c of h.changes) {
          if (c.before > 0) live.add(`${c.key}@${c.before}`);
          if (c.after > 0) live.add(`${c.key}@${c.after}`);
        }
      }
    }
    const all = await this.listTileVersions(projectId);
    let removed = 0;
    for (const t of all) {
      if (!live.has(`${t.key}@${t.version}`)) {
        await this.deleteTile(projectId, t.key, t.version);
        removed++;
      }
    }
    return removed;
  }
}
