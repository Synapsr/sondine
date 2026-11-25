import type { UpdateBlock, UpdateProblem, UpdatesStatus, UpdateWait } from "@sondine/api";
import {
  automaticUpdates,
  earlierUpdateCheck,
  lastUpdateAnswer,
  lastUpdateAsk,
  recordUpdateAnswer,
  recordUpdateAsk,
  recordUpdatedNote,
  recordUpdateInstalling,
  recordUpdateRefused,
  setAutomaticUpdates,
  updatedNote,
  updateInstalling,
  updateRefused,
  type Database,
} from "@sondine/db";
import { UpdateFeed } from "../../shared/updates";
import { availableRelease, type ReleaseAnswer } from "./update-check";

// The rules of updates (ADR 002, ADR 045). With the user's yes, Sondine asks
// GitHub at most every other day, across launches; with the yes to install,
// it downloads the newer version, checks it, and hands it to main once nothing
// would be cut. A check the user starts runs whatever the answer. Nothing here
// reaches the network, the disk or main: `UpdateManagerDeps` does.

const HOUR_MS = 3_600_000;
/** An answered check waits this long before the next. */
export const ASK_EVERY_MS = 48 * HOUR_MS;
/** No connection: nothing was asked of GitHub, so it tries again sooner. */
export const RETRY_MS = 6 * HOUR_MS;

/** How often the rules are looked at: while a download or an install is due, and otherwise. */
export const BUSY_LOOK_MS = 30_000;
export const IDLE_LOOK_MS = HOUR_MS;
/** The user asked for the install: what would be cut is looked at often. */
export const ASKED_LOOK_MS = 2_000;

/** The network as macOS describes it; only `free` lets a download run. */
export type NetworkKind = "free" | "metered" | "offline" | "unknown";

export class UpdateFailure extends Error {
  override readonly name = "UpdateFailure";
  constructor(
    readonly problem: UpdateProblem,
    /** The same archive would fail the same way: not tried again on its own. */
    readonly final: boolean,
    detail: string,
  ) {
    super(detail);
  }
}

export interface UpdateManagerDeps {
  readonly db: Database;
  /** This app's version. */
  readonly current: string;
  readonly blocked: UpdateBlock | null;
  readonly ask: (signal: AbortSignal) => Promise<ReleaseAnswer>;
  readonly network: () => Promise<NetworkKind>;
  /**
   * Downloads (resumed), unpacks and checks `feed`'s archive; returns once
   * the app is ready to install. Throws `UpdateFailure`, or on an abort.
   */
  readonly prepare: (
    feed: UpdateFeed,
    onProgress: (phase: "downloading" | "verifying", progress: number | null) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Whether `feed`'s app is ready on disk from an earlier run. */
  readonly prepared: (feed: UpdateFeed) => Promise<boolean>;
  /** Checks the ready app again; throws `UpdateFailure`. */
  readonly recheck: (feed: UpdateFeed) => Promise<void>;
  /** Deletes what was downloaded and unpacked, but `keep`'s. */
  readonly prune: (keep: UpdateFeed | null) => Promise<void>;
  /** What installing now would cut; empty when nothing. */
  readonly waitingFor: () => Promise<UpdateWait[]>;
  /** Main stops Sondine, replaces the app and starts it again. */
  readonly install: (feed: UpdateFeed) => void;
  readonly onStatus: (status: UpdatesStatus) => void;
  /** The check failed (ADR 042). */
  readonly onFailed?: (problem: "network" | "bad_response") => void;
  readonly now: () => number;
  readonly log: (
    event: string,
    fields: Readonly<Record<string, string | boolean | number>>,
  ) => void;
}

export class UpdateManager {
  private status: UpdatesStatus;
  private checking: Promise<UpdatesStatus> | null = null;
  private looking: Promise<void> | null = null;
  private feed: UpdateFeed | null;
  /** What was found, or made, ready; another answer may name another archive since. */
  private ready: UpdateFeed | null = null;
  /** Stops the download going on; null when none is. */
  private download: AbortController | null = null;
  /** The last download failed in a way that may pass: the next look waits (nextLookMs). */
  private failed = false;
  private handedOver = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Closing core stops a request and a download, and nothing is written after. */
  private readonly closing = new AbortController();

  constructor(private readonly deps: UpdateManagerDeps) {
    const { db, current } = deps;
    const answered = lastUpdateAnswer(db);
    const parsed = UpdateFeed.safeParse(answered?.feed);
    this.feed = parsed.success && parsed.data.version === answered?.version ? parsed.data : null;
    this.settleInstall();
    const refused = updateRefused(db);
    const available = availableRelease(answered?.version ?? null, current);
    this.status = {
      automatic: automaticUpdates(db),
      searches: this.searches(),
      blocked: deps.blocked,
      current,
      available,
      phase: "idle",
      progress: null,
      waitingFor: [],
      requested: false,
      checkedAtMs: answered?.answeredAtMs ?? null,
      problem:
        refused !== null && refused.version === available?.version
          ? problemOf(refused.problem)
          : null,
      updated: updatedNote(db),
    };
    deps.onStatus(this.status);
    // What an earlier version left, a refused one, and the app the last update replaced.
    void deps.prune(this.due()).catch(() => undefined);
  }

  /** The earlier run handed a version to main: this start says how it went. */
  private settleInstall(): void {
    const { db, current, now, log } = this.deps;
    const installing = updateInstalling(db);
    if (installing === null) return;
    recordUpdateInstalling(db, null, now());
    if (installing.to === current) {
      recordUpdatedNote(db, current, now());
      log("updates.installed", { from: installing.from, to: current });
      return;
    }
    // Not the version handed over: it was not replaced, or someone put the earlier one back.
    if (this.feed?.version === installing.to) this.refuse(this.feed, "install");
    log("updates.not-installed", { to: installing.to, current });
  }

  private searches(): boolean {
    const answer = automaticUpdates(this.deps.db);
    return answer ?? earlierUpdateCheck(this.deps.db);
  }

  private refuse(feed: UpdateFeed, problem: UpdateProblem): void {
    recordUpdateRefused(
      this.deps.db,
      { version: feed.version, sha256: feed.archive.sha256, problem },
      this.deps.now(),
    );
  }

  /** Looks now, then at the rhythm the state asks for, until `close`. */
  start(firstLookMs: number): void {
    this.schedule(firstLookMs);
  }

  private schedule(ms: number): void {
    if (this.closing.signal.aborted) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.look().then(() => this.schedule(this.nextLookMs()));
    }, ms);
    this.timer.unref?.();
  }

  private nextLookMs(): number {
    if (this.handedOver) return IDLE_LOOK_MS;
    // A download that fails asks GitHub again an hour later, not at each look.
    if (this.failed) return IDLE_LOOK_MS;
    if (this.status.requested) return ASKED_LOOK_MS;
    return this.due() === null ? IDLE_LOOK_MS : BUSY_LOOK_MS;
  }

  setAutomatic(automatic: boolean): UpdatesStatus {
    setAutomaticUpdates(this.deps.db, automatic, this.deps.now());
    this.deps.log("updates.automatic-set", { automatic });
    this.publish({ automatic, searches: this.searches() });
    // An answer from before 0.8.0 names a version, not its archive: asked again.
    if (automatic && this.feed === null) void this.check();
    else if (automatic) this.schedule(0);
    else {
      this.download?.abort();
      this.publish({ phase: "idle", progress: null, waitingFor: [], requested: false });
      void this.deps.prune(null).catch(() => undefined);
    }
    return this.status;
  }

  /** Asks now; a check already asking is joined. Also tries again what Sondine refused. */
  async check(): Promise<UpdatesStatus> {
    recordUpdateRefused(this.deps.db, null, this.deps.now());
    const status = await this.ask();
    if (this.due() !== null) this.schedule(0);
    return status;
  }

  /** Installs a ready update as soon as nothing is cut, without waiting for an idle Mac. */
  install(): UpdatesStatus {
    if (this.status.phase !== "ready") return this.status;
    this.deps.log("updates.install-asked", {});
    this.publish({ requested: true });
    // After this call is answered: it would be an action going on.
    this.schedule(50);
    return this.status;
  }

  closeNote(): UpdatesStatus {
    recordUpdatedNote(this.deps.db, null, this.deps.now());
    return this.publish({ updated: null });
  }

  /** Main could not install: nothing was replaced, Sondine goes on. */
  installFailed(): void {
    if (!this.handedOver) return;
    this.handedOver = false;
    recordUpdateInstalling(this.deps.db, null, this.deps.now());
    if (this.feed !== null) this.refuse(this.feed, "install");
    this.publish({ phase: "idle", waitingFor: [], requested: false, problem: "install" });
    void this.deps.prune(null).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closing.abort();
    this.download?.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    await this.checking?.catch(() => undefined);
    await this.looking?.catch(() => undefined);
  }

  /** The release to download or install now; null when there is none. */
  private due(): UpdateFeed | null {
    const { feed, status } = this;
    if (feed === null || status.available?.version !== feed.version) return null;
    if (status.automatic !== true || this.deps.blocked !== null) return null;
    const refused = updateRefused(this.deps.db);
    if (refused?.version === feed.version && refused.sha256 === feed.archive.sha256) return null;
    return feed;
  }

  /** One look at the rules; a look going on is joined. */
  look(): Promise<void> {
    this.looking ??= this.run()
      .catch((error: unknown) =>
        this.deps.log("updates.look-failed", {
          error: error instanceof Error ? error.name : "unknown",
        }),
      )
      .finally(() => {
        this.looking = null;
      });
    return this.looking;
  }

  private async run(): Promise<void> {
    if (this.closing.signal.aborted || this.handedOver) return;
    if (this.status.searches && this.askDue()) await this.ask();
    const feed = this.due();
    if (feed === null || this.closing.signal.aborted) return;
    if (this.status.phase !== "ready" || this.ready !== feed) {
      const found = await this.deps.prepared(feed);
      // The answer, or the user's, may have changed meanwhile.
      if (this.due() !== feed || this.closing.signal.aborted) return;
      if (found) this.markReady(feed);
      else if (!(await this.fetchAndCheck(feed))) return;
    }
    await this.installWhenQuiet(feed);
  }

  private askDue(): boolean {
    const asked = lastUpdateAsk(this.deps.db);
    const since = asked === null ? Number.POSITIVE_INFINITY : this.deps.now() - asked;
    // A clock set back does not stop the checks.
    return since < 0 || since >= ASK_EVERY_MS;
  }

  /** Downloads and checks; whether the app is ready. */
  private async fetchAndCheck(feed: UpdateFeed): Promise<boolean> {
    // Before the first wait: a no meanwhile stops it.
    const controller = new AbortController();
    this.download = controller;
    const signal = AbortSignal.any([controller.signal, this.closing.signal]);
    // Not over a metered network, and not while a call needs it.
    const free =
      (await this.deps.network()) === "free" && !(await this.deps.waitingFor()).includes("call");
    if (!free || signal.aborted || this.due() !== feed) {
      this.download = null;
      return false;
    }
    const watch = setInterval(() => {
      void Promise.all([this.deps.network(), this.deps.waitingFor()])
        .then(([network, waits]) => {
          // What is downloaded stays, and goes on at a later look.
          if ((network !== "free" && network !== "unknown") || waits.includes("call"))
            controller.abort();
        })
        .catch(() => undefined);
    }, BUSY_LOOK_MS);
    watch.unref?.();
    this.failed = false;
    this.publish({ phase: "downloading", progress: 0, problem: null });
    try {
      await this.deps.prepare(
        feed,
        (phase, progress) => {
          if (!signal.aborted) this.publish({ phase, progress });
        },
        signal,
      );
      if (signal.aborted) throw signal.reason;
      this.markReady(feed);
      return true;
    } catch (error) {
      if (this.closing.signal.aborted) return false;
      if (signal.aborted) {
        this.publish({ phase: "idle", progress: null });
        return false;
      }
      const failure = error instanceof UpdateFailure ? error : null;
      const problem = failure?.problem ?? "corrupt";
      this.deps.log("updates.download-failed", {
        problem,
        final: failure?.final ?? false,
        detail: (error instanceof Error ? error.message : "").slice(0, 300),
      });
      if (failure?.final === true) {
        this.refuse(feed, problem);
        await this.deps.prune(null).catch(() => undefined);
      } else this.failed = true;
      this.publish({ phase: "idle", progress: null, problem });
      return false;
    } finally {
      clearInterval(watch);
      this.download = null;
    }
  }

  private markReady(feed: UpdateFeed): void {
    this.ready = feed;
    this.failed = false;
    this.publish({ phase: "ready", progress: null });
    this.deps.log("updates.ready", { version: feed.version });
  }

  private async installWhenQuiet(feed: UpdateFeed): Promise<void> {
    if ((await this.quiet()).length > 0) return;
    try {
      await this.deps.recheck(feed);
    } catch (error) {
      if (this.closing.signal.aborted) return;
      const problem = error instanceof UpdateFailure ? error.problem : "corrupt";
      this.deps.log("updates.recheck-failed", { problem });
      this.refuse(feed, problem);
      this.publish({ phase: "idle", waitingFor: [], requested: false, problem });
      await this.deps.prune(null).catch(() => undefined);
      return;
    }
    // Nothing started while the app was checked again, and the yes still holds.
    if ((await this.quiet()).length > 0 || this.closing.signal.aborted || this.due() !== feed)
      return;
    const { db, current, now } = this.deps;
    this.handedOver = true;
    recordUpdateInstalling(db, { from: current, to: feed.version }, now());
    this.publish({ phase: "installing", waitingFor: [] });
    this.deps.log("updates.installing", { from: current, to: feed.version });
    this.deps.install(feed);
  }

  private async quiet(): Promise<UpdateWait[]> {
    const waits = (await this.deps.waitingFor()).filter(
      (wait) => wait !== "in-use" || !this.status.requested,
    );
    if (this.status.phase === "ready" && waits.join() !== this.status.waitingFor.join())
      this.publish({ waitingFor: waits });
    return waits;
  }

  private ask(): Promise<UpdatesStatus> {
    this.checking ??= this.request().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async request(): Promise<UpdatesStatus> {
    const { db, now, current } = this.deps;
    recordUpdateAsk(db, now());
    const before = this.status.phase;
    if (before === "idle") this.publish({ phase: "checking" });
    const answer = await this.deps
      .ask(this.closing.signal)
      .catch((): ReleaseAnswer => ({ ok: false, problem: "network" }));
    if (this.closing.signal.aborted) return this.status;
    // A download or a ready update went on meanwhile: its phase is kept.
    const phase = this.status.phase === "checking" ? "idle" : this.status.phase;
    if (!answer.ok) {
      // Nothing was asked of GitHub: the next check comes sooner.
      if (answer.problem === "network") recordUpdateAsk(db, now() - ASK_EVERY_MS + RETRY_MS);
      // The closed list of the statistics knows two (ADR 042): a refusal was a bad response before.
      this.deps.onFailed?.(answer.problem === "network" ? "network" : "bad_response");
      this.deps.log("updates.checked", { ok: false, problem: answer.problem });
      return this.publish({ phase, problem: answer.problem });
    }
    const { feed } = answer;
    recordUpdateAnswer(db, { version: feed.version, answeredAtMs: now(), feed });
    const available = availableRelease(feed.version, current);
    const same =
      this.feed?.version === feed.version && this.feed.archive.sha256 === feed.archive.sha256;
    if (!same) this.feed = feed;
    this.deps.log("updates.checked", { ok: true, available: available?.version ?? "" });
    const refused = updateRefused(db);
    const status = this.publish({
      phase: same ? phase : "idle",
      progress: same ? this.status.progress : null,
      available,
      checkedAtMs: now(),
      waitingFor: same ? this.status.waitingFor : [],
      requested: same && this.status.requested,
      problem:
        refused !== null && refused.version === available?.version
          ? problemOf(refused.problem)
          : null,
    });
    if (!same) {
      // Another version is the newest: what was got of the one before goes.
      this.download?.abort();
      await this.deps.prune(available === null ? null : feed).catch(() => undefined);
    }
    return status;
  }

  private publish(next: Partial<UpdatesStatus>): UpdatesStatus {
    this.status = { ...this.status, ...next };
    if (!this.closing.signal.aborted) this.deps.onStatus(this.status);
    return this.status;
  }
}

const PROBLEMS: readonly UpdateProblem[] = [
  "disk_full",
  "corrupt",
  "signature",
  "notarization",
  "macos",
  "version",
  "install",
];

/** A stored problem; one this version does not know says the install failed. */
const problemOf = (stored: string): UpdateProblem =>
  PROBLEMS.find((problem) => problem === stored) ?? "install";
