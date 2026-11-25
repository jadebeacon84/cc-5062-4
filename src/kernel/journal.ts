/**
 * Canvas write tracking ("执行证据链").
 *
 * Every durability-relevant step of the kernel — stroke commit begin, each
 * staged tile version, the manifest swap, publication, rollback, undo/redo,
 * garbage collection and reloads — is recorded here exactly once, at the
 * moment the real operation completed (or failed). Nothing is inferred after
 * the fact: an event exists only if the operation it describes actually ran,
 * so the journal cannot report a write that never happened.
 *
 * Log cost is bounded by construction: the event list is a ring buffer of
 * fixed capacity, while lifetime counters (events per phase, bytes staged,
 * bytes manifested, failures) are exact regardless of capacity. When the
 * ring overflows, `droppedEvents` grows so a reader can tell detail was
 * truncated without losing the totals.
 */

export type JournalPhase =
  | 'begin' // commit started (lock held)
  | 'color-source' // smudge stroke resolved its ink color from the canvas
  | 'staging' // one tile version durably written
  | 'staging-failed' // a tile write failed; commit will roll back
  | 'before-manifest' // all tiles staged, about to swap the manifest
  | 'manifest' // manifest atomically replaced (stroke is now committed)
  | 'publish' // in-memory state published to match the durable manifest
  | 'rollback' // commit aborted; staged versions deleted again
  | 'gc-delete' // unreachable tile version collected
  | 'undo'
  | 'redo'
  | 'history-failed' // undo/redo rejected (missing payload or store error)
  | 'reload'; // manifest re-read from the store

export type JournalKind = 'stroke' | 'edit' | 'undo' | 'redo' | 'reload' | 'gc';

export interface WriteEvent {
  /** Monotonic event id, unique within this journal. */
  seq: number;
  at: number;
  phase: JournalPhase;
  kind: JournalKind;
  /** Document-level commit sequence this event belongs to, when known. */
  commitSeq?: number;
  /** Tile key for tile-scoped events. */
  key?: string;
  /** Tile revision before/after the operation, when applicable. */
  before?: number;
  after?: number;
  bytes?: number;
  /** Picked color for 'color-source' events. */
  rgba?: readonly [number, number, number, number];
  ok?: boolean;
  message?: string;
}

export interface JournalSnapshot {
  capacity: number;
  /** Events currently retained (oldest first). */
  retained: number;
  /** Events discarded because the ring was full. */
  droppedEvents: number;
  /** Exact lifetime count of recorded events, including dropped ones. */
  totalEvents: number;
  /** Exact lifetime counts per phase. */
  phases: Record<string, number>;
  /** Exact lifetime counts per kind. */
  kinds: Record<string, number>;
  bytesStaged: number;
  bytesManifested: number;
  failures: number;
}

export class WriteJournal {
  private events: WriteEvent[] = [];
  private nextSeq = 1;
  private dropped = 0;
  private readonly phaseCounts = new Map<string, number>();
  private readonly kindCounts = new Map<string, number>();
  private stagedBytes = 0;
  private manifestBytes = 0;
  private failureCount = 0;
  private listener: ((e: WriteEvent) => void) | null = null;

  constructor(private readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('journal capacity must be >= 1');
  }

  /** Optional sink (UI feed). Called synchronously for every recorded event. */
  onEvent(fn: ((e: WriteEvent) => void) | null): void {
    this.listener = fn;
  }

  record(e: Omit<WriteEvent, 'seq' | 'at'> & { at?: number }): WriteEvent {
    const event: WriteEvent = { ...e, seq: this.nextSeq++, at: e.at ?? Date.now() };
    this.phaseCounts.set(event.phase, (this.phaseCounts.get(event.phase) ?? 0) + 1);
    this.kindCounts.set(event.kind, (this.kindCounts.get(event.kind) ?? 0) + 1);
    if (event.phase === 'staging') this.stagedBytes += event.bytes ?? 0;
    if (event.phase === 'manifest') this.manifestBytes += event.bytes ?? 0;
    if (event.ok === false) this.failureCount++;
    this.events.push(event);
    if (this.events.length > this.capacity) {
      const overflow = this.events.length - this.capacity;
      this.events.splice(0, overflow);
      this.dropped += overflow;
    }
    this.listener?.(event);
    return event;
  }

  /** Newest-first view of retained events, capped at `n`. */
  recent(n = 32): WriteEvent[] {
    const out: WriteEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < n; i--) out.push(this.events[i]);
    return out;
  }

  /** Oldest-first retained events (the surviving window of the evidence chain). */
  retained(): WriteEvent[] {
    return this.events.slice();
  }

  snapshot(): JournalSnapshot {
    return {
      capacity: this.capacity,
      retained: this.events.length,
      droppedEvents: this.dropped,
      totalEvents: this.nextSeq - 1,
      phases: Object.fromEntries(this.phaseCounts),
      kinds: Object.fromEntries(this.kindCounts),
      bytesStaged: this.stagedBytes,
      bytesManifested: this.manifestBytes,
      failures: this.failureCount,
    };
  }

  clear(): void {
    this.events = [];
    this.dropped = 0;
  }
}
