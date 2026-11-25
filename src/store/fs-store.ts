import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ProjectManifest,
  ProjectMeta,
  TileStore,
  TileVersionKey,
  TileWriteHook,
} from './types';

/**
 * Durable file-system store. Layout:
 *   <root>/projects/<id>/project.json        – metadata
 *   <root>/projects/<id>/manifest.json       – committed tile roots + history
 *   <root>/projects/<id>/tiles/<key>@<ver>.bin
 *
 * A commit writes every new tile file, fsyncs it, then replaces manifest.json
 * via write-temp + fsync + rename. rename(2) is atomic on POSIX, so a crash
 * observes either the previous manifest (stroke absent) or the new one (stroke
 * wholly present). Tiles that the old manifest referenced stay until the new
 * manifest is durable, so there is no window where a live version is deleted.
 */
export class FsTileStore implements TileStore {
  writeHook?: TileWriteHook;
  constructor(private readonly root: string) {}

  private projectDir(id: string): string {
    return path.join(this.root, 'projects', id);
  }

  private tileDir(id: string): string {
    return path.join(this.projectDir(id), 'tiles');
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const dir = path.join(this.root, 'projects');
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const metas: ProjectMeta[] = [];
    for (const id of entries) {
      try {
        metas.push(JSON.parse(await fs.readFile(path.join(dir, id, 'project.json'), 'utf8')));
      } catch {
        /* incomplete project dir from a crash before first manifest */
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createProject(meta: ProjectMeta): Promise<void> {
    await fs.mkdir(this.tileDir(meta.id), { recursive: true });
    await this.atomicWriteJson(path.join(this.projectDir(meta.id), 'project.json'), meta);
  }

  async getProject(id: string): Promise<ProjectMeta | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.projectDir(id), 'project.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async updateProject(meta: ProjectMeta): Promise<void> {
    await this.atomicWriteJson(path.join(this.projectDir(meta.id), 'project.json'), meta);
  }

  async deleteProject(id: string): Promise<void> {
    await fs.rm(this.projectDir(id), { recursive: true, force: true });
  }

  async getManifest(projectId: string): Promise<ProjectManifest | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.projectDir(projectId), 'manifest.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async putManifest(manifest: ProjectManifest): Promise<void> {
    await this.atomicWriteJson(path.join(this.projectDir(manifest.projectId), 'manifest.json'), manifest);
  }

  async getTile(projectId: string, key: string, version: number): Promise<Uint8Array | null> {
    try {
      const buf = await fs.readFile(this.tilePath(projectId, key, version));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async statTile(projectId: string, key: string, version: number): Promise<number | null> {
    try {
      const st = await fs.stat(this.tilePath(projectId, key, version));
      return st.size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async putTile(projectId: string, key: string, version: number, pixels: Uint8Array): Promise<void> {
    const file = this.tilePath(projectId, key, version);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(pixels);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  }

  async deleteTile(projectId: string, key: string, version: number): Promise<void> {
    await fs.rm(this.tilePath(projectId, key, version), { force: true });
  }

  async listTileVersions(projectId: string): Promise<TileVersionKey[]> {
    // Tiles are nested one level per tx (see tilePath); walk the tree.
    const out: TileVersionKey[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(path.join(this.tileDir(projectId), rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const child = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) {
          await walk(child);
          continue;
        }
        if (!e.name.endsWith('.bin')) continue;
        const base = e.name.slice(0, -4);
        const at = base.lastIndexOf('@');
        out.push({ key: base.slice(0, at), version: Number(base.slice(at + 1)) });
      }
    };
    await walk('');
    return out;
  }

  private tilePath(projectId: string, key: string, version: number): string {
    // Keys are `${tx},${ty}`; nested one level per tx to avoid huge directories.
    const [tx] = key.split(',');
    return path.join(this.tileDir(projectId), tx, `${key}@${version}.bin`);
  }

  private async atomicWriteJson(file: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(data));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    // Also fsync the directory so the rename itself is durable.
    try {
      const dh = await fs.open(path.dirname(file), 'r');
      await dh.sync().catch(() => {});
      await dh.close();
    } catch {
      /* directories may not be openable for fsync on some platforms */
    }
  }

  /** Bytes on disk for a project's tile versions. */
  async diskUsage(projectId: string): Promise<number> {
    const versions = await this.listTileVersions(projectId);
    let n = 0;
    for (const v of versions) {
      try {
        n += (await fs.stat(this.tilePath(projectId, v.key, v.version))).size;
      } catch {
        /* deleted concurrently */
      }
    }
    return n;
  }
}
