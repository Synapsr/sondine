import type { UpdateBlock, UpdatesStatus, UpdateWait } from "@sondine/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDb, type TempDb } from "../../../test/capture-fixture";
import { releasePage, type UpdateFeed } from "../../shared/updates";
import type { ReleaseAnswer } from "./update-check";
import {
  ASK_EVERY_MS,
  RETRY_MS,
  UpdateFailure,
  UpdateManager,
  type NetworkKind,
} from "./update-manager";

const feedOf = (version: string, sha256 = "a".repeat(64)): UpdateFeed => ({
  format: "sondine-update",
  formatVersion: 1,
  version,
  minimumMacos: "27.0",
  archive: { sizeBytes: 100, sha256 },
});

let temp: TempDb;
let now: number;
let asks: number;
let answer: ReleaseAnswer;
let network: NetworkKind;
let waits: UpdateWait[];
let prepared: Set<string>;
let downloads: string[];
let prepare: (signal: AbortSignal) => Promise<void>;
let recheck: () => Promise<void>;
let installs: string[];
let pruned: (string | null)[];
let statuses: UpdatesStatus[];
let managers: UpdateManager[];
let failed: string[];
/** Answers held back; null answers at once. */
let askNetwork: (() => Promise<NetworkKind>) | null;
let askPrepared: (() => Promise<boolean>) | null;
let networkAsked: number;
let preparedAsked: number;

beforeEach(() => {
  temp = tempDb();
  now = Date.UTC(2026, 10, 25, 12);
  asks = 0;
  answer = { ok: true, feed: feedOf("0.8.0") };
  network = "free";
  waits = [];
  prepared = new Set();
  downloads = [];
  prepare = async () => undefined;
  recheck = async () => undefined;
  installs = [];
  pruned = [];
  statuses = [];
  managers = [];
  failed = [];
  askNetwork = null;
  askPrepared = null;
  networkAsked = 0;
  preparedAsked = 0;
});
afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
  temp.cleanup();
});

function manager(options: { current?: string; blocked?: UpdateBlock | null } = {}) {
  const created = new UpdateManager({
    db: temp.db,
    current: options.current ?? "0.7.0",
    blocked: options.blocked ?? null,
    ask: async () => {
      asks += 1;
      return answer;
    },
    network: () => {
      networkAsked += 1;
      return askNetwork === null ? Promise.resolve(network) : askNetwork();
    },
    prepare: async (feed, onProgress, signal) => {
      downloads.push(feed.version);
      onProgress("downloading", 0.5);
      await prepare(signal);
      prepared.add(feed.version);
    },
    prepared: async (feed) => {
      preparedAsked += 1;
      return askPrepared === null ? prepared.has(feed.version) : askPrepared();
    },
    recheck: () => recheck(),
    prune: async (keep) => {
      pruned.push(keep?.version ?? null);
      for (const version of prepared) if (version !== keep?.version) prepared.delete(version);
    },
    waitingFor: async () => waits,
    install: (feed) => installs.push(feed.version),
    onStatus: (status) => statuses.push(status),
    onFailed: (problem) => failed.push(problem),
    now: () => now,
    log: () => undefined,
  });
  managers.push(created);
  return created;
}
const last = () => {
  const status = statuses.at(-1);
  if (status === undefined) throw new Error("no status");
  return status;
};
/** The yes, its check, and one look. */
async function saidYes(options: Parameters<typeof manager>[0] = {}) {
  const updates = manager(options);
  updates.setAutomatic(true);
  await updates.check();
  await updates.look();
  return updates;
}

describe("consent", () => {
  it("asks nothing without a yes, and says so", async () => {
    const updates = manager();
    await updates.look();
    expect(asks).toBe(0);
    expect(last()).toMatchObject({ automatic: null, searches: false });
  });

  it("keeps an earlier yes to the check alone, without downloading", async () => {
    temp.db
      .statement(
        "INSERT INTO settings (key, value, updated_at_ms) VALUES ('updates.check', 'true', 0)",
      )
      .run();
    const updates = manager();
    expect(last()).toMatchObject({ automatic: null, searches: true });
    await updates.look();
    expect(asks).toBe(1);
    expect(last().available).toEqual({ version: "0.8.0", url: releasePage("0.8.0") });
    expect(downloads).toEqual([]);
    // A no covers both: one setting.
    updates.setAutomatic(false);
    expect(last()).toMatchObject({ automatic: false, searches: false });
    now += ASK_EVERY_MS;
    await updates.look();
    expect(asks).toBe(1);
  });

  it("checks when the user asks, whatever the answer, and downloads nothing", async () => {
    const updates = manager();
    updates.setAutomatic(false);
    await updates.check();
    await updates.look();
    expect(asks).toBe(1);
    expect(last().available?.version).toBe("0.8.0");
    expect(downloads).toEqual([]);
  });

  it("stops a download and drops what is ready once the user says no", async () => {
    let stopped = false;
    const updates = manager();
    prepare = (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          stopped = true;
          reject(signal.reason as Error);
        });
      });
    updates.setAutomatic(true);
    await updates.check();
    const looking = updates.look();
    await vi.waitFor(() => expect(last().phase).toBe("downloading"));
    updates.setAutomatic(false);
    await looking;
    expect(stopped).toBe(true);
    expect(last()).toMatchObject({ phase: "idle", automatic: false, problem: null });
    expect(pruned.at(-1)).toBeNull();
  });

  it.each(["development", "unreleased", "test-copy", "move"] as const)(
    "never downloads where it may not replace itself (%s)",
    async (blocked) => {
      await saidYes({ blocked });
      expect(last()).toMatchObject({ blocked, available: { version: "0.8.0" }, phase: "idle" });
      expect(downloads).toEqual([]);
    },
  );
});

describe("rhythm", () => {
  it("asks at most every other day, across launches", async () => {
    const updates = await saidYes();
    expect(asks).toBe(1);
    now += ASK_EVERY_MS - 1;
    await updates.look();
    await manager().look();
    expect(asks).toBe(1);
    now += 1;
    await manager().look();
    expect(asks).toBe(2);
  });

  it("tries again after six hours without a connection, as GitHub was not asked", async () => {
    answer = { ok: false, problem: "network" };
    await saidYes();
    expect(last().problem).toBe("network");
    now += RETRY_MS - 1;
    await manager().look();
    expect(asks).toBe(1);
    now += 1;
    await manager().look();
    expect(asks).toBe(2);
  });

  it("waits the two days after a refusal, and counts it as the statistics know it", async () => {
    answer = { ok: false, problem: "refused" };
    await saidYes();
    expect(last().problem).toBe("refused");
    expect(failed).toEqual(["bad_response"]);
    now += RETRY_MS;
    await manager().look();
    expect(asks).toBe(1);
  });

  it("goes on after the clock was set back", async () => {
    waits = ["in-use"];
    const updates = await saidYes();
    now -= 10 * ASK_EVERY_MS;
    await updates.look();
    expect(asks).toBe(2);
  });

  it("keeps a newer release shown after a relaunch, and drops it once installed", async () => {
    await manager().check();
    manager();
    expect(last().available?.version).toBe("0.8.0");
    manager({ current: "0.8.0" });
    expect(last().available).toBeNull();
    expect(last().checkedAtMs).toBe(now);
    expect(asks).toBe(1);
  });
});

describe("download and install", () => {
  it("downloads, checks again, and hands over once nothing would be cut", async () => {
    waits = ["conversation", "in-use"];
    const updates = await saidYes();
    expect(downloads).toEqual(["0.8.0"]);
    expect(last()).toMatchObject({ phase: "ready", waitingFor: ["conversation", "in-use"] });
    expect(installs).toEqual([]);
    waits = [];
    await updates.look();
    expect(installs).toEqual(["0.8.0"]);
    expect(last().phase).toBe("installing");
    // Once: main is stopping Sondine.
    await updates.look();
    expect(installs).toEqual(["0.8.0"]);
    expect(downloads).toEqual(["0.8.0"]);
  });

  it.each(["metered", "offline", "unknown"] as const)(
    "does not download over a %s network",
    async (kind) => {
      network = kind;
      const updates = await saidYes();
      expect(downloads).toEqual([]);
      network = "free";
      await updates.look();
      expect(downloads).toEqual(["0.8.0"]);
    },
  );

  it("does not download during a call", async () => {
    waits = ["call"];
    await saidYes();
    expect(downloads).toEqual([]);
  });

  it("stops a download when the network becomes metered, and goes on later", async () => {
    vi.useFakeTimers();
    try {
      const updates = manager();
      updates.setAutomatic(true);
      await updates.check();
      prepare = (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason as Error));
        });
      const looking = updates.look();
      await vi.advanceTimersByTimeAsync(1);
      expect(last().phase).toBe("downloading");
      network = "metered";
      await vi.advanceTimersByTimeAsync(30_000);
      await looking;
      expect(last()).toMatchObject({ phase: "idle", problem: null });
      network = "free";
      prepare = async () => undefined;
      await updates.look();
      expect(downloads).toEqual(["0.8.0", "0.8.0"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds a ready update again after a relaunch", async () => {
    waits = ["in-use"];
    await saidYes();
    const relaunched = manager();
    await relaunched.look();
    expect(last().phase).toBe("ready");
    expect(downloads).toEqual(["0.8.0"]);
  });

  it("« Redémarrer et mettre à jour » skips the idle wait only", async () => {
    waits = ["call", "in-use"];
    const updates = manager();
    updates.setAutomatic(true);
    prepared.add("0.8.0");
    await updates.check();
    await updates.look();
    expect(updates.install().requested).toBe(true);
    await updates.look();
    expect(installs).toEqual([]);
    expect(last().waitingFor).toEqual(["call"]);
    waits = ["in-use"];
    await updates.look();
    expect(installs).toEqual(["0.8.0"]);
  });

  it("the button does nothing before an update is ready", () => {
    const updates = manager();
    expect(updates.install()).toMatchObject({ requested: false, phase: "idle" });
  });

  it("does not install when something starts while the app is checked again", async () => {
    const updates = manager();
    updates.setAutomatic(true);
    await updates.check();
    recheck = async () => {
      waits = ["call"];
    };
    await updates.look();
    expect(installs).toEqual([]);
    expect(last()).toMatchObject({ phase: "ready", waitingFor: ["call"] });
  });

  it("drops a ready version once a newer one, or none, is the latest", async () => {
    waits = ["in-use"];
    const updates = await saidYes();
    expect(last().phase).toBe("ready");
    answer = { ok: true, feed: feedOf("0.8.1", "b".repeat(64)) };
    await updates.check();
    expect(pruned.at(-1)).toBe("0.8.1");
    await updates.look();
    expect(downloads).toEqual(["0.8.0", "0.8.1"]);
    // 0.8.1 was withdrawn: an older version is never installed.
    answer = { ok: true, feed: feedOf("0.6.0") };
    await updates.check();
    waits = [];
    await updates.look();
    expect(installs).toEqual([]);
    expect(last()).toMatchObject({ available: null, phase: "idle" });
    expect(pruned.at(-1)).toBeNull();
  });
});

describe("while it waits", () => {
  it("a no during the first questions starts no download", async () => {
    const updates = manager();
    updates.setAutomatic(true);
    await updates.check();
    let answerNetwork: (kind: NetworkKind) => void = () => undefined;
    askNetwork = () => new Promise((resolve) => (answerNetwork = resolve));
    const looking = updates.look();
    await vi.waitFor(() => expect(networkAsked).toBe(1));
    updates.setAutomatic(false);
    answerNetwork("free");
    await looking;
    expect(downloads).toEqual([]);
    expect(last()).toMatchObject({ phase: "idle", automatic: false });
  });

  it("another answer meanwhile never makes its archive ready", async () => {
    const updates = manager();
    updates.setAutomatic(true);
    await updates.check();
    prepared.add("0.8.0");
    let found: (value: boolean) => void = () => undefined;
    askPrepared = () => new Promise((resolve) => (found = resolve));
    const looking = updates.look();
    await vi.waitFor(() => expect(preparedAsked).toBe(1));
    answer = { ok: true, feed: feedOf("0.8.1", "b".repeat(64)) };
    await updates.check();
    found(true);
    await looking;
    expect(last()).toMatchObject({ phase: "idle", available: { version: "0.8.1" } });
    askPrepared = null;
    waits = ["in-use"];
    await updates.look();
    expect(downloads).toEqual(["0.8.1"]);
    expect(last().phase).toBe("ready");
  });
});

describe("refusals", () => {
  const refusal = (problem: "signature" | "corrupt" | "notarization") => async () => {
    throw new UpdateFailure(problem, true, "no");
  };

  it("does not download a refused archive again on its own, until the user asks", async () => {
    prepare = refusal("signature");
    const updates = await saidYes();
    expect(last()).toMatchObject({ phase: "idle", problem: "signature" });
    expect(pruned.at(-1)).toBeNull();
    await updates.look();
    now += ASK_EVERY_MS;
    await updates.look();
    await manager().look();
    expect(last().problem).toBe("signature");
    expect(downloads).toEqual(["0.8.0"]);
    expect(installs).toEqual([]);
    prepare = async () => undefined;
    const again = manager();
    await again.check();
    await again.look();
    expect(downloads).toEqual(["0.8.0", "0.8.0"]);
    expect(installs).toEqual(["0.8.0"]);
  });

  it("downloads another archive of the same version", async () => {
    prepare = refusal("corrupt");
    await saidYes();
    prepare = async () => undefined;
    answer = { ok: true, feed: feedOf("0.8.0", "c".repeat(64)) };
    now += ASK_EVERY_MS;
    await manager().look();
    expect(downloads).toEqual(["0.8.0", "0.8.0"]);
  });

  it("tries again alone after what may pass", async () => {
    prepare = async () => {
      throw new UpdateFailure("disk_full", false, "no");
    };
    const updates = await saidYes();
    expect(last().problem).toBe("disk_full");
    prepare = async () => undefined;
    await updates.look();
    expect(installs).toEqual(["0.8.0"]);
    expect(last().problem).toBeNull();
  });

  it("asks for a download that failed again an hour later, or when the user asks", async () => {
    vi.useFakeTimers();
    try {
      prepare = async () => {
        throw new UpdateFailure("refused", false, "the server answered HTTP 404");
      };
      const updates = manager();
      updates.setAutomatic(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(downloads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(59 * 60_000);
      expect(downloads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(downloads).toHaveLength(2);
      await updates.check();
      await vi.advanceTimersByTimeAsync(10);
      expect(downloads).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a newer version that failed no sooner because a restart was asked for", async () => {
    vi.useFakeTimers();
    try {
      waits = ["call"];
      const updates = manager();
      prepared.add("0.8.0");
      updates.setAutomatic(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(updates.install().requested).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      waits = [];
      downloads = [];
      // A newer one comes, and GitHub refuses its archive.
      answer = { ok: true, feed: feedOf("0.8.1") };
      prepare = async () => {
        throw new UpdateFailure("refused", false, "the server answered HTTP 403");
      };
      waits = ["call"];
      await updates.check();
      waits = [];
      await vi.advanceTimersByTimeAsync(50 * 60_000);
      expect(downloads.filter((version) => version === "0.8.1").length).toBe(1);
      expect(last().requested).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs nothing when the last check fails", async () => {
    recheck = refusal("notarization");
    await saidYes();
    expect(installs).toEqual([]);
    expect(last()).toMatchObject({ phase: "idle", problem: "notarization" });
    expect(pruned.at(-1)).toBeNull();
  });
});

describe("after", () => {
  it("says the update once, until the note is closed", async () => {
    await saidYes();
    const updated = manager({ current: "0.8.0" });
    expect(last()).toMatchObject({ updated: "0.8.0", available: null, problem: null });
    manager({ current: "0.8.0" });
    expect(last().updated).toBe("0.8.0");
    updated.closeNote();
    manager({ current: "0.8.0" });
    expect(last().updated).toBeNull();
  });

  it("says a version that did not come, and does not try it again alone", async () => {
    await saidYes();
    expect(installs).toEqual(["0.8.0"]);
    const same = manager();
    expect(last()).toMatchObject({ updated: null, problem: "install" });
    expect(pruned.at(-1)).toBeNull();
    await same.look();
    expect(installs).toEqual(["0.8.0"]);
  });

  it("goes on when main cannot replace the app", async () => {
    const updates = await saidYes();
    updates.installFailed();
    expect(last()).toMatchObject({ phase: "idle", problem: "install" });
    await updates.look();
    expect(installs).toEqual(["0.8.0"]);
    manager();
    expect(last().updated).toBeNull();
  });

  it("says nothing of a version the user installed by hand", () => {
    manager({ current: "0.8.0" });
    expect(last().updated).toBeNull();
  });
});

describe("closing", () => {
  it("writes nothing once core is closing", async () => {
    let release: (value: ReleaseAnswer) => void = () => undefined;
    const updates = new UpdateManager({
      db: temp.db,
      current: "0.7.0",
      blocked: null,
      ask: () => new Promise((resolve) => (release = resolve)),
      network: async () => "free",
      prepare: async () => undefined,
      prepared: async () => false,
      recheck: async () => undefined,
      prune: async () => undefined,
      waitingFor: async () => [],
      install: () => undefined,
      onStatus: (status) => statuses.push(status),
      now: () => now,
      log: () => undefined,
    });
    const asked = updates.check();
    const closed = updates.close();
    release(answer);
    await Promise.all([asked, closed]);
    expect(last().available).toBeNull();
    manager();
    expect(last().checkedAtMs).toBeNull();
  });
});
