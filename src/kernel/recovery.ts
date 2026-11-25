import { TiledDocument } from './document';
import { diagnoseProject, DiagnosticReport } from './diagnostics';
import { WriteJournal } from './journal';
import type { HistoryEntry, ProjectManifest, TileStore } from '../store/types';

/**
 * Tile-corruption recovery by transaction replay.
 *
 * Given a store where committed tile versions went missing, recovery:
 *
 * 1. Rolls the manifest back to the **last complete canvas** — the newest
 *    history checkpoint whose every tile version still exists in the store.
 *    That state is exact: it is rebuilt only from versions physically present.
 * 2. Replays the dropped strokes forward from the durable stroke records on
 *    their history entries. Solid-color strokes carry their full style and
 *    replay across any tile boundary. Smudge strokes, which pick ink from the
 *    base image, replay only when their color source is verifiably intact:
 *    a recorded `colorSource` must still be the current revision of that
 *    tile, and legacy position-only records must find ink at their pick
 *    point. Otherwise replay would fabricate a color, so the stroke — and
 *    everything after it, which may depend on its output — is left
 *    **pending for the user** instead of being invented.
 * 3. Re-runs diagnostics on the repaired store and reports the evidence:
 *    tile revisions written, pixels recovered, and the journal event range
 *    that documents the replay.
 */

export interface ReplayedStroke {
  /** Original history sequence of the dropped entry. */
  fromSeq: number;
  /** New commit sequence it was replayed as. */
  toSeq: number;
  tool: 'paint' | 'smudge';
  tiles: number;
  pixels: number;
}

export interface PendingStroke {
  seq: number;
  reason: string;
}

export interface TileRevision {
  key: string;
  before: number;
  after: number;
}

export interface RecoveryResult {
  /** True when the repaired store roots no dangling committed references. */
  ok: boolean;
  /** True when every dropped stroke could be replayed (none left pending). */
  complete: boolean;
  rolledBackToSeq: number;
  replayed: ReplayedStroke[];
  pending: PendingStroke[];
  /** Tile revisions written by the replay, in commit order. */
  tileRevisions: TileRevision[];
  recoveredPixels: number;
  before: DiagnosticReport;
  after: DiagnosticReport;
  /** Journal event ids bracketing the recovery, for evidence correlation. */
  evidence: { journalFrom: number; journalTo: number };
}

export interface RecoverOptions {
  store: TileStore;
  projectId: string;
  journal?: WriteJournal;
  memoryBudgetBytes?: number;
  historyLimit?: number;
}

export async function recoverProject(opts: RecoverOptions): Promise<RecoveryResult> {
  const { store, projectId } = opts;
  const journal = opts.journal ?? new WriteJournal();
  const journalFrom = journal.snapshot().totalEvents + 1;

  const meta = await store.getProject(projectId);
  if (!meta) throw new Error(`project ${projectId} not found`);
  const before = await diagnoseProject(store, projectId);
  const manifest = await store.getManifest(projectId);

  const empty = (after: DiagnosticReport): RecoveryResult => ({
    ok: after.ok,
    complete: true,
    rolledBackToSeq: manifest?.seq ?? 0,
    replayed: [],
    pending: [],
    tileRevisions: [],
    recoveredPixels: 0,
    before,
    after,
    evidence: { journalFrom, journalTo: journal.snapshot().totalEvents },
  });

  if (!manifest) return empty(before);
  if (before.ok) return empty(before);

  // Newest checkpoint whose full canvas state is physically present.
  const present = new Set<string>();
  for (const v of await store.listTileVersions(projectId)) present.add(`${v.key}@${v.version}`);
  const applied = manifest.history.slice(0, Math.min(manifest.cursor, manifest.history.length));
  let checkpoint = 0;
  for (let i = 0; i < applied.length; i++) {
    const e = applied[i];
    let complete = true;
    for (const c of e.changes) {
      if (c.after > 0 && !present.has(`${c.key}@${c.after}`)) {
        complete = false;
        break;
      }
    }
    if (!complete) break;
    checkpoint = i + 1;
  }
  const rolledBackToSeq = checkpoint === 0 ? 0 : applied[checkpoint - 1].seq;

  // Rebuild the checkpoint tile roots by replaying the manifest's own change
  // records (no pixel reads needed — versions are immutable pointers).
  const tiles: ProjectManifest['tiles'] = {};
  const tileBytesOf = (key: string): number => {
    const [tx, ty] = key.split(',').map(Number);
    const w = Math.min(meta.tileSize, meta.width - tx * meta.tileSize);
    const h = Math.min(meta.tileSize, meta.height - ty * meta.tileSize);
    return w * h * 4;
  };
  for (let i = 0; i < checkpoint; i++) {
    for (const c of applied[i].changes) {
      if (c.after === 0) delete tiles[c.key];
      else tiles[c.key] = { v: c.after, bytes: c.bytes || tileBytesOf(c.key) };
    }
  }

  const repaired: ProjectManifest = {
    schemaVersion: 1,
    projectId,
    seq: manifest.seq,
    nextVersion: manifest.nextVersion,
    tiles,
    history: applied.slice(0, checkpoint),
    cursor: checkpoint,
    updatedAt: Date.now(),
  };
  await store.putManifest(repaired);

  // Replay the dropped strokes onto the rolled-back canvas.
  const doc = await TiledDocument.open({
    store,
    width: meta.width,
    height: meta.height,
    tileSize: meta.tileSize,
    projectId,
    memoryBudgetBytes: opts.memoryBudgetBytes,
    historyLimit: opts.historyLimit ?? Math.max(64, manifest.history.length + 8),
    journal,
  });

  const replayed: ReplayedStroke[] = [];
  const pending: PendingStroke[] = [];
  const tileRevisions: TileRevision[] = [];
  let recoveredPixels = 0;
  const dropped = applied.slice(checkpoint);

  for (const entry of dropped) {
    const reason = await tryReplay(doc, entry);
    if (reason !== null) {
      pending.push({ seq: entry.seq, reason });
      // Everything after a pending stroke may depend on its output; leave the
      // rest to the user rather than replaying onto a fabricated base.
      for (const rest of dropped.slice(dropped.indexOf(entry) + 1)) {
        pending.push({ seq: rest.seq, reason: `blocked by pending stroke #${entry.seq}` });
      }
      break;
    }
  }

  doc.dispose();
  const after = await diagnoseProject(store, projectId);
  return {
    ok: after.ok,
    complete: pending.length === 0,
    rolledBackToSeq,
    replayed,
    pending,
    tileRevisions,
    recoveredPixels,
    before,
    after,
    evidence: { journalFrom, journalTo: journal.snapshot().totalEvents },
  };

  async function tryReplay(doc: TiledDocument, entry: HistoryEntry): Promise<string | null> {
    const rec = entry.stroke;
    if (!rec || rec.points.length === 0) return 'no replayable stroke record';
    const style = rec.style;
    if (rec.tool === 'paint') {
      if (!style) return 'paint stroke missing its style';
      const res = await doc.commitStroke({ id: `recover-${entry.seq}`, points: rec.points, style });
      if (!res.ok) return `replay commit failed: ${res.error?.message ?? 'unknown'}`;
      collect(entry, res.entry, 'paint');
      return null;
    }
    // Smudge: the ink color comes from the base image, so the base must be
    // verifiably the one the original stroke sampled.
    if (rec.colorSource) {
      const src = rec.colorSource;
      const current = doc.tileVersion(src.key);
      if (current !== src.version) {
        // The revision moved (an earlier stroke was replayed and rewrote the
        // tile). The source is still faithful if the pixel at the recorded
        // pick point is exactly the recorded color; anything else means the
        // pre-modification neighbor is gone and replay would invent a color.
        const sample = await doc.sampleColor(src.x, src.y);
        const same =
          sample &&
          sample.rgba[0] === src.rgba[0] &&
          sample.rgba[1] === src.rgba[1] &&
          sample.rgba[2] === src.rgba[2] &&
          sample.rgba[3] === src.rgba[3];
        if (!same) {
          return (
            `color source ${src.key} is at revision ${current} (recorded ${src.version}) ` +
            `and the pick pixel no longer matches; pre-modification neighbor lost`
          );
        }
      }
      if (!style) return 'smudge stroke missing its resolved style';
      const res = await doc.commitStroke({ id: `recover-${entry.seq}`, points: rec.points, style });
      if (!res.ok) return `replay commit failed: ${res.error?.message ?? 'unknown'}`;
      collect(entry, res.entry, 'smudge');
      return null;
    }
    // Legacy record: positions only. Re-derive the color by sampling the
    // reconstructed canvas exactly where the original stroke started. The
    // brush geometry must come from the record — inventing a radius would be
    // as much a fabrication as inventing a color.
    if (!style) return 'legacy smudge record lacks brush geometry';
    const res = await doc.commitStroke({
      id: `recover-${entry.seq}`,
      points: rec.points,
      style: { ...style, color: [0, 0, 0, 0], mode: 'smudge' },
    });
    if (!res.ok) return `replay commit failed: ${res.error?.message ?? 'unknown'}`;
    if (res.tilesTouched === 0 && entry.changes.length > 0) {
      // The original stroke had ink, but the reconstructed canvas offers none
      // at its pick point: the pre-modification neighbor is gone. Replaying
      // would fabricate the stroke's color.
      return 'legacy smudge color source lost (pick point is blank in the restored canvas)';
    }
    if (res.tilesTouched === 0) {
      // The original was itself a no-op (blank pick point); replaying it as a
      // no-op is faithful.
      replayed.push({ fromSeq: entry.seq, toSeq: entry.seq, tool: 'smudge', tiles: 0, pixels: 0 });
      return null;
    }
    collect(entry, res.entry, 'smudge');
    return null;
  }

  function collect(
    from: HistoryEntry,
    entry: HistoryEntry | undefined,
    tool: 'paint' | 'smudge'
  ): void {
    if (!entry) return;
    replayed.push({
      fromSeq: from.seq,
      toSeq: entry.seq,
      tool,
      tiles: entry.tilesTouched,
      pixels: entry.pixelsAffected,
    });
    recoveredPixels += entry.pixelsAffected;
    for (const c of entry.changes) tileRevisions.push({ key: c.key, before: c.before, after: c.after });
  }
}
