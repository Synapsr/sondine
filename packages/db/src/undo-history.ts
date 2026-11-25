import { transaction, type Database } from "./database";
import {
  captureUndo,
  restoreUndo,
  widenSnapshot,
  type UndoRefusal,
  type UndoScope,
  type UndoSnapshot,
} from "./undo";

// The window's ⌘Z history, held by core in memory (undo.ts): the edits the
// user made in this session, newest last, and those undone since, ready for
// ⇧⌘Z. A new edit drops what could be redone; a deletion forgets everything,
// since captures hold transcript text and an id may come back as another
// episode or person. Ending an ongoing episode (ADR 044) is no capture, since
// speech goes on arriving: it is kept as how to take it back and redo it.

export type UndoAction =
  | "split"
  | "merge"
  | "kind"
  | "text"
  | "name"
  | "refusal"
  | "people-merge"
  | "context"
  | "voice-merge"
  | "end";

export type UndoStep =
  | { readonly outcome: "nothing" }
  | {
      readonly outcome: "undone" | "redone";
      readonly action: UndoAction;
      /** Episodes this step took away: a window showing one opens a `kept` one. */
      readonly removed: readonly number[];
      readonly kept: readonly number[];
      /** People this step took away (a merge redone): a page showing one opens a `keptPeople` one. */
      readonly removedPeople: readonly number[];
      readonly keptPeople: readonly number[];
    }
  | { readonly outcome: "refused"; readonly action: UndoAction; readonly reason: UndoRefusal };

/** What a step of an operation did. */
export type OperationStep =
  | { readonly ok: true; readonly removed: readonly number[]; readonly kept: readonly number[] }
  | { readonly ok: false; readonly reason: UndoRefusal };

/** An edit undone and redone by doing, not by restoring a capture. */
export interface UndoOperation {
  readonly action: UndoAction;
  undo(nowMs: number): OperationStep;
  redo(nowMs: number): OperationStep;
}

interface Capture {
  readonly action: UndoAction;
  readonly before: UndoSnapshot;
  readonly after: UndoSnapshot;
}

type Entry = Capture | UndoOperation;

/** Edits kept for ⌘Z. */
export const UNDO_LIMIT = 50;

export class UndoHistory {
  readonly #db: Database;
  readonly #onRelease: () => void;
  #undos: Entry[] = [];
  #redos: Entry[] = [];

  /**
   * `onRelease` runs whenever steps leave the history (the limit, a new edit
   * dropping what could be redone, a refused step, `clear`): a context file
   * only a step held may go then (ADR 024).
   */
  constructor(db: Database, options: { readonly onRelease?: () => void } = {}) {
    this.#db = db;
    this.#onRelease = options.onRelease ?? (() => {});
  }

  /** The context files (SHA-256) the steps could bring back. */
  heldFiles(): Set<string> {
    const held = new Set<string>();
    for (const entry of [...this.#undos, ...this.#redos]) {
      if ("undo" in entry) continue;
      for (const snapshot of [entry.before, entry.after]) {
        for (const item of snapshot.context)
          if (item.fileSha256 !== null) held.add(item.fileSha256);
      }
    }
    return held;
  }

  /**
   * Runs one edit and keeps it for ⌘Z. `scope` is what it may change;
   * `created` names what it made (a split's episode, a new person). An edit
   * that changed nothing (refused, or a no-op) is not kept.
   */
  track<T>(
    action: UndoAction,
    scope: UndoScope,
    edit: () => T,
    created?: (result: T) => {
      readonly episodeIds?: readonly number[];
      readonly personIds?: readonly number[];
    },
  ): T {
    const db = this.#db;
    return transaction(db, () => {
      const start = captureUndo(db, scope);
      const result = edit();
      const made = created?.(result) ?? {};
      const before = widenSnapshot(start, {
        episodeIds: made.episodeIds ?? [],
        personIds: made.personIds ?? [],
      });
      const after = captureUndo(db, before.scope, start.window);
      if (after.print !== before.print) {
        this.record({ action, before, after });
      }
      return result;
    });
  }

  /** Keeps an edit made outside `track`. */
  record(entry: Capture | UndoOperation): void {
    this.#undos.push(entry);
    const dropped = this.#redos.length > 0 || this.#undos.length > UNDO_LIMIT;
    if (this.#undos.length > UNDO_LIMIT) this.#undos.shift();
    this.#redos = [];
    if (dropped) this.#onRelease();
  }

  #operate(entry: UndoOperation, way: "undo" | "redo", nowMs: number): UndoStep {
    const done = entry[way](nowMs);
    const { action } = entry;
    if (!done.ok) {
      this.#onRelease();
      return { outcome: "refused", action, reason: done.reason };
    }
    (way === "undo" ? this.#redos : this.#undos).push(entry);
    const { removed, kept } = done;
    const outcome = way === "undo" ? "undone" : "redone";
    return { outcome, action, removed, kept, removedPeople: [], keptPeople: [] };
  }

  undo(nowMs: number): UndoStep {
    const entry = this.#undos.pop();
    if (entry === undefined) return { outcome: "nothing" };
    if ("undo" in entry) return this.#operate(entry, "undo", nowMs);
    const restored = restoreUndo(this.#db, {
      target: entry.before,
      expected: entry.after.print,
      nowMs,
    });
    if (!restored.ok) {
      this.#onRelease();
      return { outcome: "refused", action: entry.action, reason: restored.reason };
    }
    this.#redos.push({ ...entry, before: restored.snapshot });
    return {
      outcome: "undone",
      action: entry.action,
      removed: restored.removed,
      kept: restored.kept,
      removedPeople: restored.removedPeople,
      keptPeople: restored.keptPeople,
    };
  }

  redo(nowMs: number): UndoStep {
    const entry = this.#redos.pop();
    if (entry === undefined) return { outcome: "nothing" };
    if ("undo" in entry) return this.#operate(entry, "redo", nowMs);
    const restored = restoreUndo(this.#db, {
      target: entry.after,
      expected: entry.before.print,
      nowMs,
    });
    if (!restored.ok) {
      this.#onRelease();
      return { outcome: "refused", action: entry.action, reason: restored.reason };
    }
    this.#undos.push({ ...entry, after: restored.snapshot });
    return {
      outcome: "redone",
      action: entry.action,
      removed: restored.removed,
      kept: restored.kept,
      removedPeople: restored.removedPeople,
      keptPeople: restored.keptPeople,
    };
  }

  /** Forgets every edit, after a deletion. */
  clear(): void {
    const had = this.#undos.length + this.#redos.length > 0;
    this.#undos = [];
    this.#redos = [];
    if (had) this.#onRelease();
  }
}
