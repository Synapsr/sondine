import type { UpdateBlock, UpdateProblem, UpdatesStatus, UpdateWait } from "@sondine/api";
import { clock } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";

// What Settings says of updates (ADR 045), in one line.

const waitText: Record<UpdateWait, (version: string) => string> = {
  call: (version) => m.update_wait_call({ version }),
  dictation: (version) => m.update_wait_dictation({ version }),
  conversation: (version) => m.update_wait_conversation({ version }),
  transcription: (version) => m.update_wait_transcription({ version }),
  sync: (version) => m.update_wait_sync({ version }),
  task: (version) => m.update_wait_task({ version }),
  "in-use": (version) => m.update_wait_in_use({ version }),
};

const problemText: Record<UpdateProblem, () => string> = {
  network: () => m.update_problem_network(),
  refused: () => m.update_problem_refused(),
  bad_response: () => m.update_problem_bad_response(),
  disk_full: () => m.update_problem_disk_full(),
  corrupt: () => m.update_problem_corrupt(),
  signature: () => m.update_problem_signature(),
  notarization: () => m.update_problem_notarization(),
  macos: () => m.update_problem_macos(),
  version: () => m.update_problem_version(),
  install: () => m.update_problem_install(),
};

const blockText: Record<UpdateBlock, () => string> = {
  move: () => m.update_blocked_move(),
  "test-copy": () => m.update_blocked_test_copy(),
  unreleased: () => m.update_blocked_unreleased(),
  development: () => m.update_blocked_development(),
};

export interface UpdateView {
  readonly state: string;
  /** The last check or install failed; null when nothing did. */
  readonly problem: string | null;
  /** Why this app does not update itself; said once the user wants it to. */
  readonly blocked: string | null;
  /** « Redémarrer et mettre à jour »: a ready update not asked for yet. */
  readonly installable: boolean;
}

export function updateView(updates: UpdatesStatus): UpdateView {
  return {
    state: stateText(updates),
    problem: updates.problem === null ? null : problemText[updates.problem](),
    blocked:
      updates.blocked === null || updates.automatic === false ? null : blockText[updates.blocked](),
    installable: updates.phase === "ready" && !updates.requested,
  };
}

function stateText(updates: UpdatesStatus): string {
  const version = updates.available?.version;
  if (version === undefined) {
    return updates.checkedAtMs !== null && updates.problem === null
      ? m.settings_updates_current({
          version: updates.current,
          time: clock(updates.checkedAtMs),
        })
      : m.settings_updates_version({ version: updates.current });
  }
  switch (updates.phase) {
    case "downloading":
      return m.update_downloading({
        version,
        percent: String(Math.floor((updates.progress ?? 0) * 100)),
      });
    case "verifying":
      return m.update_verifying({ version });
    case "installing":
      return m.update_installing({ version });
    case "ready": {
      const wait = updates.waitingFor[0];
      return wait === undefined ? m.update_ready({ version }) : waitText[wait](version);
    }
    case "idle":
    case "checking":
      return m.settings_updates_available({ version });
  }
}

/** The one question (ADR 045): not answered yet, where a yes would do something. */
export const asksForUpdates = (updates: UpdatesStatus | undefined): boolean =>
  updates !== undefined && updates.automatic === null && updates.blocked === null;
