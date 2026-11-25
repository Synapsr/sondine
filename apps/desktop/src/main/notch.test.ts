import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { IslandCall, IslandCard, IslandView } from "../shared/call-island";
import { createNotch, type NotchActions } from "./notch";

/** A helper that records what main wrote, and says what the test makes it say. */
class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly lines: unknown[] = [];
  ended = false;
  killed: string | null = null;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line !== "") this.lines.push(JSON.parse(line));
      }
    });
    this.stdin.on("finish", () => {
      this.ended = true;
    });
  }

  say(event: object): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  /** Exits: its output ends, then `close` comes, as Node orders them. */
  exit(code: number | null = 0, signal: string | null = null): void {
    this.stdout.once("end", () => this.emit("close", code, signal));
    this.stdout.end();
  }

  kill(signal: string): boolean {
    this.killed = signal;
    this.exit(null, signal);
    return true;
  }
}

const view = (patch: Partial<IslandView> = {}): IslandView => ({
  call: null,
  people: [
    {
      personId: 2,
      label: "Marie ?",
      monogram: "M",
      conversations: [{ episodeId: 9, when: "Hier 18:30", words: "On reprend le budget" }],
      none: null,
    },
  ],
  dismiss: { label: "Masquer pour cet appel", callId: 4 },
  card: null,
  openOnHover: true,
  ...patch,
});

/** The same people, for another call of core's. */
const forCall = (callId: number) => view({ dismiss: { label: "Masquer pour cet appel", callId } });

const call = (patch: Partial<IslandCall> = {}): IslandCall => ({
  callId: "discord-1",
  bundleId: "com.hnc.Discord",
  title: "Appel Discord",
  detail: "À l’écoute",
  monogram: "D",
  on: true,
  toggle: "Écouter cet appel",
  announce: true,
  episode: { episodeId: 31, open: "Ouvrir", end: "Terminer" },
  mute: "Ne plus prévenir pour Discord",
  ...patch,
});

const card = (patch: Partial<IslandCard> = {}): IslandCard => ({
  key: "ended:1",
  bundleId: null,
  title: "Appel Discord terminé",
  detail: "32 min enregistrées",
  monogram: "D",
  actions: [
    { action: "open-episode", label: "Ouvrir", episodeId: 31 },
    { action: "end-episode", label: "Terminer", episodeId: 31 },
  ],
  ...patch,
});

/** A view of the call alone, or a card alone. */
const alone = (patch: Partial<IslandView>) => view({ people: [], dismiss: null, ...patch });

/** Lets stream events reach their listeners. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(options: { stopGraceMs?: number } = {}) {
  const helpers: FakeHelper[] = [];
  const logged: { event: string; fields: object | undefined }[] = [];
  const actions: NotchActions = {
    openEpisode: vi.fn(),
    openPerson: vi.fn(),
    dismissCall: vi.fn(),
    setCall: vi.fn(),
    muteCall: vi.fn(),
    endEpisode: vi.fn(),
    resume: vi.fn(),
    cardDone: vi.fn(),
  };
  const icons = new Map<string, string>();
  const onAvailable = vi.fn();
  const notch = createNotch({
    binary:
      "/Applications/Sondine.app/Contents/Helpers/Sondine Notch.app/Contents/MacOS/sondine-notch",
    actions,
    icon: (bundleId) => icons.get(bundleId) ?? null,
    onAvailable,
    log: (event, fields) => logged.push({ event, fields }),
    // The fake stands in for the parts of a child process main uses.
    spawn: () => {
      const helper = new FakeHelper();
      helpers.push(helper);
      return helper as unknown as ChildProcess;
    },
    ...options,
  });
  return { notch, helpers, logged, actions, icons, onAvailable };
}

describe("the notch helper", () => {
  it("starts with the first view, numbers each new one, and skips repeats", async () => {
    const { notch, helpers } = setup();
    notch.update(view());
    notch.update(view());
    notch.update(view({ dismiss: { label: "Hide for this call", callId: 4 } }));
    await settle();
    expect(helpers).toHaveLength(1);
    expect(helpers[0]?.lines).toEqual([
      {
        type: "show",
        view: 1,
        call: null,
        people: [
          {
            personId: 2,
            label: "Marie ?",
            monogram: "M",
            conversations: [{ episodeId: 9, when: "Hier 18:30", words: "On reprend le budget" }],
            none: null,
          },
        ],
        dismiss: { label: "Masquer pour cet appel", callId: 4 },
        card: null,
        openOnHover: true,
      },
      expect.objectContaining({ view: 2, dismiss: { label: "Hide for this call", callId: 4 } }),
    ]);
  });

  it("acts on a click on the view it shows, and on nothing else", async () => {
    const { notch, helpers, actions } = setup();
    notch.update(view());
    await settle();
    const helper = helpers[0]!;
    helper.say({ type: "open-episode", view: 1, episodeId: 9 });
    helper.say({ type: "open-person", view: 1, personId: 2 });
    helper.say({ type: "dismiss", view: 1, callId: 4 });
    // An id the view does not hold, a replaced view, a malformed line.
    helper.say({ type: "open-episode", view: 1, episodeId: 10 });
    notch.update(view({ openOnHover: false }));
    helper.say({ type: "open-person", view: 1, personId: 2 });
    helper.stdout.write("{not json}\n");
    await settle();
    expect(actions.openEpisode).toHaveBeenCalledTimes(1);
    expect(actions.openEpisode).toHaveBeenCalledWith(9);
    expect(actions.openPerson).toHaveBeenCalledTimes(1);
    expect(actions.dismissCall).toHaveBeenCalledWith(4);
  });

  it("hides by closing stdin, ignores clicks after, and starts again for the next call", async () => {
    const { notch, helpers, actions } = setup();
    notch.update(view());
    await settle();
    notch.update(null);
    await settle();
    expect(helpers[0]?.ended).toBe(true);
    helpers[0]?.say({ type: "dismiss", view: 1, callId: 4 });
    await settle();
    expect(actions.dismissCall).not.toHaveBeenCalled();
    helpers[0]?.exit(0);
    notch.update(forCall(5));
    await settle();
    expect(helpers).toHaveLength(2);
    expect(helpers[1]?.lines).toEqual([expect.objectContaining({ view: 2 })]);
  });

  it("waits for the displays to change after the helper found no notch", async () => {
    const { notch, helpers } = setup();
    notch.update(view());
    await settle();
    // Its last words, right before it exits.
    helpers[0]?.say({ type: "no-notch" });
    helpers[0]?.exit(0);
    await settle();
    notch.update(forCall(5));
    expect(helpers).toHaveLength(1);
    notch.screensChanged();
    expect(helpers).toHaveLength(2);
  });

  it("looks for the notch again when the displays changed during its last moments", async () => {
    const { notch, helpers } = setup();
    notch.update(view());
    await settle();
    helpers[0]?.say({ type: "no-notch" });
    await settle();
    // The lid opens while that helper is still exiting.
    notch.screensChanged();
    helpers[0]?.exit(0);
    await settle();
    expect(helpers).toHaveLength(2);
    expect(helpers[1]?.lines).toEqual([expect.objectContaining({ type: "show" })]);
  });

  it("starts the next helper only once the one hidden has exited", async () => {
    const { notch, helpers } = setup();
    notch.update(view());
    await settle();
    notch.update(null);
    notch.update(forCall(5));
    await settle();
    expect(helpers).toHaveLength(1);
    helpers[0]?.exit(0);
    await settle();
    expect(helpers).toHaveLength(2);
    expect(helpers[1]?.lines).toEqual([
      expect.objectContaining({ dismiss: expect.objectContaining({ callId: 5 }) }),
    ]);
  });

  it("hides rather than leave an old view up when a new one cannot be sent", async () => {
    const { notch, helpers, actions, logged } = setup();
    notch.update(view());
    await settle();
    notch.update(view({ dismiss: { label: "", callId: 4 } }));
    await settle();
    expect(helpers[0]?.ended).toBe(true);
    helpers[0]?.say({ type: "dismiss", view: 1, callId: 4 });
    await settle();
    expect(actions.dismissCall).not.toHaveBeenCalled();
    expect(logged.map((entry) => entry.event)).toContain("notch.bad-view");
    helpers[0]?.exit(0);
    await settle();
    expect(helpers).toHaveLength(1);
  });

  it("does not start a failed helper again during the same call", async () => {
    const { notch, helpers, logged } = setup();
    notch.update(view());
    await settle();
    helpers[0]?.exit(1);
    await settle();
    notch.update(view({ openOnHover: false }));
    expect(helpers).toHaveLength(1);
    notch.update(forCall(5));
    expect(helpers).toHaveLength(2);
    expect(logged.map((entry) => entry.event)).toContain("notch.failed");
    // Events and categories only.
    expect(JSON.stringify(logged)).not.toMatch(/Marie|budget|Masquer/u);
  });

  it("kills a helper that does not exit once closed, and waits for it at stop", async () => {
    const { notch, helpers } = setup({ stopGraceMs: 10 });
    notch.update(view());
    await settle();
    await notch.stop();
    expect(helpers[0]?.ended).toBe(true);
    expect(helpers[0]?.killed).toBe("SIGKILL");
    notch.update(forCall(6));
    expect(helpers).toHaveLength(1);
  });

  it("carries the call's switch and buttons, and acts only on those it shows", async () => {
    const { notch, helpers, actions } = setup();
    notch.update(view({ call: call() }));
    await settle();
    const helper = helpers[0]!;
    expect(helper.lines).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({ callId: "discord-1", on: true, announce: true }),
        people: [expect.objectContaining({ personId: 2 })],
      }),
    ]);
    helper.say({ type: "toggle", view: 1, callId: "discord-1", on: false });
    helper.say({ type: "end-episode", view: 1, episodeId: 31 });
    helper.say({ type: "open-episode", view: 1, episodeId: 31 });
    helper.say({ type: "mute", view: 1, callId: "discord-1" });
    // Already so, another call, another recording, a card it does not show.
    helper.say({ type: "toggle", view: 1, callId: "discord-1", on: true });
    helper.say({ type: "toggle", view: 1, callId: "zoom-1", on: false });
    helper.say({ type: "end-episode", view: 1, episodeId: 32 });
    helper.say({ type: "resume", view: 1 });
    helper.say({ type: "done", view: 1, key: "ended:1" });
    await settle();
    expect(actions.setCall).toHaveBeenCalledTimes(1);
    expect(actions.setCall).toHaveBeenCalledWith("discord-1", false);
    expect(actions.endEpisode).toHaveBeenCalledTimes(1);
    expect(actions.openEpisode).toHaveBeenCalledWith(31);
    expect(actions.muteCall).toHaveBeenCalledWith("discord-1");
    expect(actions.resume).not.toHaveBeenCalled();
    expect(actions.cardDone).not.toHaveBeenCalled();
  });

  it("announces a call once, whatever helper shows it", async () => {
    const { notch, helpers } = setup();
    notch.update(alone({ call: call() }));
    await settle();
    expect(notch.said("discord-1")).toBe(false);
    helpers[0]?.say({ type: "ready" });
    await settle();
    expect(notch.said("discord-1")).toBe(true);
    notch.update(alone({ call: call({ on: false }) }));
    await settle();
    const announced = (helper: FakeHelper) =>
      helper.lines.map((line) => (line as { call: { announce: boolean } }).call.announce);
    expect(announced(helpers[0]!)).toEqual([true, false]);
    notch.update(null);
    helpers[0]?.exit(0);
    await settle();
    notch.update(alone({ call: call() }));
    await settle();
    expect(announced(helpers[1]!)).toEqual([false]);
  });

  it("sends the icon once it is known", async () => {
    const { notch, helpers, icons } = setup();
    notch.update(alone({ call: call() }));
    icons.set("com.hnc.Discord", "iVBORw0KGgo=");
    notch.update(alone({ call: call() }));
    await settle();
    expect(helpers[0]?.lines).toEqual([
      expect.objectContaining({ call: expect.objectContaining({ icon: null }) }),
      expect.objectContaining({ call: expect.objectContaining({ icon: "iVBORw0KGgo=" }) }),
    ]);
  });

  it("acts on a card's buttons and hears when it is done", async () => {
    const { notch, helpers, actions } = setup();
    notch.update(alone({ card: card() }));
    await settle();
    helpers[0]?.say({ type: "end-episode", view: 1, episodeId: 31 });
    await settle();
    // Its icon comes while its time runs out: it is done all the same.
    notch.update(alone({ card: card({ detail: "33 min enregistrées" }) }));
    helpers[0]?.say({ type: "done", view: 1, key: "ended:1" });
    await settle();
    expect(actions.endEpisode).toHaveBeenCalledWith(31);
    expect(actions.cardDone).toHaveBeenCalledWith("ended:1");
    notch.update(
      alone({
        card: card({
          key: "paused:1",
          actions: [{ action: "resume", label: "Reprendre l’écoute", episodeId: null }],
        }),
      }),
    );
    await settle();
    helpers[0]?.say({ type: "resume", view: 3 });
    await settle();
    expect(actions.resume).toHaveBeenCalledTimes(1);
  });

  it("says whether the island is there, so a notification may stand in", async () => {
    const { notch, helpers, onAvailable } = setup();
    expect(notch.available()).toBeNull();
    notch.update(alone({ call: call() }));
    await settle();
    expect(notch.available()).toBeNull();
    helpers[0]?.say({ type: "ready" });
    await settle();
    expect(notch.available()).toBe(true);
    expect(onAvailable).toHaveBeenCalledTimes(1);
    helpers[0]?.exit(1);
    await settle();
    expect(notch.available()).toBe(false);
    expect(onAvailable).toHaveBeenCalledTimes(2);
    // Another call: it may work again.
    notch.update(alone({ call: call({ callId: "discord-2" }) }));
    await settle();
    expect(notch.available()).toBeNull();
    helpers[1]?.say({ type: "no-notch" });
    helpers[1]?.exit(0);
    await settle();
    expect(notch.available()).toBe(false);
  });
});
