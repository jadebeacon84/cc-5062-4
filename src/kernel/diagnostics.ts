import type { ProjectManifest, TileStore } from '../store/types';

/**
 * Tile lost-write diagnostics ("瓦片丢写诊断").
 *
 * The diagnostic pass reads only the store — the manifest record and the tile
 * version index — never a document's decoded-tile cache. Conclusions therefore
 * describe the real external storage path, not a resident approximation of it.
 *
 * Two fundamentally different findings are reported separately:
 *
 * - `missingCommitted` / size mismatches: versions the committed manifest (or
 *   its undo history) still roots but the store no longer holds. This is
 *   *committed data loss* — a write the system acknowledged is gone.
 * - `orphanVersions`: versions the store holds that no manifest roots. These
 *   are *uncommitted edits* — remnants of interrupted strokes. They cost disk
 *   but never affect the committed canvas.
 *
 * Every anomaly carries its evidence chain: which manifest slot or history
 * entry (by commit seq) references the version, whether that stroke crossed
 * tile boundaries, and the expected vs actual byte count.
 */

export interface VersionRef {
  /** Where the reference comes from. */
  role: 'current' | 'history-before' | 'history-after';
  /** Commit sequence of the referencing history entry, when applicable. */
  commitSeq?: number;
  /** The referencing stroke touched more than one tile (cross-block stroke). */
  crossBlock: boolean;
  /** Total tiles the referencing stroke touched. */
  strokeTiles?: number;
}

export interface TileAnomaly {
  key: string;
  version: number;
  problem: 'missing' | 'size-mismatch';
  expectedBytes: number | null;
  actualBytes: number | null;
  /**
   * Stage the evidence locates the loss to: the version is rooted by the
   * current committed canvas, or only by the undo payload of some entry.
   */
  stage: 'committed-current' | 'undo-payload';
  referencedBy: VersionRef[];
}

export interface OrphanVersion {
  key: string;
  version: number;
  bytes: number | null;
}

export interface DiagnosticReport {
  projectId: string;
  /** True when no committed reference is broken. Orphans alone do not fail. */
  ok: boolean;
  manifestPresent: boolean;
  manifestSeq: number;
  /** Distinct tile versions rooted by the manifest + history. */
  referencedVersions: number;
  /** Distinct tile versions physically present in the store. */
  storeVersions: number;
  missingCommitted: TileAnomaly[];
  orphanVersions: OrphanVersion[];
  /** Exact totals, valid even when the lists above were capped. */
  totals: { missing: number; corrupt: number; orphan: number };
  /** True when `missingCommitted`/`orphanVersions` were capped for log cost. */
  truncated: boolean;
}

export interface DiagnoseOptions {
  /** Cap on reported anomaly lists; totals stay exact. Defaults to 128. */
  maxAnomalies?: number;
}

interface RefEntry {
  refs: VersionRef[];
  expectedBytes: number | null;
}

export async function diagnoseProject(
  store: TileStore,
  projectId: string,
  opts: DiagnoseOptions = {}
): Promise<DiagnosticReport> {
  const maxAnomalies = Math.max(1, opts.maxAnomalies ?? 128);
  const manifest = await store.getManifest(projectId);
  const versions = await store.listTileVersions(projectId);
  const present = new Set<string>();
  for (const v of versions) present.add(`${v.key}@${v.version}`);
  const storeVersionCount = versions.length;

  const referenced = new Map<string, RefEntry>();
  const strokeOf = new Map<string, { commitSeq: number; tiles: number }>();
  if (manifest) {
    for (const h of manifest.history) {
      for (const c of h.changes) {
        strokeOf.set(`${c.key}@${c.after}`, { commitSeq: h.seq, tiles: h.tilesTouched });
      }
    }
    const addRef = (key: string, version: number, ref: VersionRef, bytes: number | null) => {
      if (version <= 0) return;
      const id = `${key}@${version}`;
      let e = referenced.get(id);
      if (!e) {
        e = { refs: [], expectedBytes: bytes };
        referenced.set(id, e);
      }
      e.refs.push(ref);
      if (e.expectedBytes == null && bytes != null) e.expectedBytes = bytes;
    };
    for (const [key, t] of Object.entries(manifest.tiles)) {
      const stroke = strokeOf.get(`${key}@${t.v}`);
      addRef(key, t.v, {
        role: 'current',
        commitSeq: stroke?.commitSeq,
        crossBlock: (stroke?.tiles ?? 1) > 1,
        strokeTiles: stroke?.tiles,
      }, t.bytes);
    }
    for (const h of manifest.history) {
      const crossBlock = h.tilesTouched > 1 || h.changes.length > 1;
      for (const c of h.changes) {
        addRef(c.key, c.before, {
          role: 'history-before',
          commitSeq: h.seq,
          crossBlock,
          strokeTiles: h.tilesTouched,
        }, null);
        addRef(c.key, c.after, {
          role: 'history-after',
          commitSeq: h.seq,
          crossBlock,
          strokeTiles: h.tilesTouched,
        }, c.bytes);
      }
    }
  }

  const missing: TileAnomaly[] = [];
  const orphans: OrphanVersion[] = [];
  let missingTotal = 0;
  let corruptTotal = 0;

  for (const [id, ref] of referenced) {
    const at = id.lastIndexOf('@');
    const key = id.slice(0, at);
    const version = Number(id.slice(at + 1));
    const actualBytes = await probeVersion(store, projectId, key, version);
    const stage: TileAnomaly['stage'] = ref.refs.some((r) => r.role === 'current')
      ? 'committed-current'
      : 'undo-payload';
    if (actualBytes == null) {
      missingTotal++;
      if (missing.length < maxAnomalies) {
        missing.push({
          key,
          version,
          problem: 'missing',
          expectedBytes: ref.expectedBytes,
          actualBytes: null,
          stage,
          referencedBy: ref.refs,
        });
      }
    } else if (ref.expectedBytes != null && actualBytes !== ref.expectedBytes) {
      corruptTotal++;
      if (missing.length < maxAnomalies) {
        missing.push({
          key,
          version,
          problem: 'size-mismatch',
          expectedBytes: ref.expectedBytes,
          actualBytes,
          stage,
          referencedBy: ref.refs,
        });
      }
    }
    present.delete(id);
  }

  let orphanTotal = 0;
  for (const id of present) {
    orphanTotal++;
    if (orphans.length < maxAnomalies) {
      const at = id.lastIndexOf('@');
      orphans.push({ key: id.slice(0, at), version: Number(id.slice(at + 1)), bytes: null });
    }
  }

  return {
    projectId,
    ok: missingTotal === 0 && corruptTotal === 0,
    manifestPresent: manifest != null,
    manifestSeq: manifest?.seq ?? 0,
    referencedVersions: referenced.size,
    storeVersions: storeVersionCount,
    missingCommitted: missing,
    orphanVersions: orphans,
    totals: { missing: missingTotal, corrupt: corruptTotal, orphan: orphanTotal },
    truncated: missingTotal + corruptTotal > maxAnomalies || orphanTotal > maxAnomalies,
  };
}

/** Byte length of a stored version, or null when absent. */
async function probeVersion(
  store: TileStore,
  projectId: string,
  key: string,
  version: number
): Promise<number | null> {
  if (store.statTile) return store.statTile(projectId, key, version);
  const bytes = await store.getTile(projectId, key, version);
  return bytes ? bytes.byteLength : null;
}

/**
 * Summarize a manifest's committed tile roots for logging without dumping the
 * whole record: count and total bytes only.
 */
export function manifestSummary(manifest: ProjectManifest | null): { tiles: number; bytes: number } {
  if (!manifest) return { tiles: 0, bytes: 0 };
  let bytes = 0;
  let tiles = 0;
  for (const t of Object.values(manifest.tiles)) {
    tiles++;
    bytes += t.bytes;
  }
  return { tiles, bytes };
}
