import type {
  AgentApp,
  AgentAppConnectResult,
  AgentAppId,
  AgentAppProblem,
  AgentCallEntry,
  AgentCreateResult,
  AgentRevokeResult,
  AgentsStatus,
  AgentSummary,
} from "@sondine/api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from "@sondine/ui/components/dialog";
import { Field, FieldLabel } from "@sondine/ui/components/field";
import { Input } from "@sondine/ui/components/input";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@sondine/ui/components/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { dayClock, dayTitle } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";

// Settings ▸ Agents (ADR 011): whether agents may read Sondine (off until the
// user agrees to what that means), the agents connected with their own key,
// and what each one read. Connecting an app found on this Mac writes Sondine's
// server into the app's own file; Claude Code and Codex get a command, any
// other app the server to paste. Each says first where what the agent reads
// goes, and the key it holds is shown once.

/** The command-line agents Sondine gives a command for, and whose model reads. */
const COMMAND_CLIENTS = [
  { name: "Claude Code", provider: "Anthropic" },
  { name: "Codex", provider: "OpenAI" },
] as const;
type CommandClient = (typeof COMMAND_CLIENTS)[number];

/** Whose model an app Sondine writes into sends its reads to, when that is one company. */
const APP_PROVIDERS: Record<AgentAppId, string | null> = {
  grok: "xAI",
  claude: "Anthropic",
  cursor: null,
};

type Target =
  | { readonly kind: "app"; readonly app: AgentApp }
  | { readonly kind: "command"; readonly client: CommandClient }
  | { readonly kind: "other" };

type Outcome =
  | { readonly kind: "app"; readonly result: AgentAppConnectResult }
  | { readonly kind: "key"; readonly result: AgentCreateResult };

/** How often the list and the log read again while Settings is open. */
const REFRESH_MS = 5_000;

function agentState(agent: AgentSummary): string {
  if (agent.revokedAtMs !== null) return m.agents_revoked();
  if (agent.connected) return m.agents_connected();
  return agent.lastUsedAtMs === null
    ? m.agents_never_used()
    : m.agents_last_used({ when: dayClock(agent.lastUsedAtMs) });
}

function problemText(problem: AgentAppProblem, path: string): string {
  switch (problem) {
    case "unreadable":
      return m.agents_app_problem_unreadable({ path });
    case "taken":
      return m.agents_app_problem_taken({ path });
    case "unsafe":
      return m.agents_app_problem_unsafe({ path });
    case "unwritable":
      return m.agents_app_problem_unwritable({ path });
  }
}

/** What a call read, in words, with what it was about when that still exists. */
function CallSubject({ call }: { call: AgentCallEntry }) {
  const muted = "text-cte-text-muted";
  const link = "corner-xs underline underline-offset-4 focus-ring";
  switch (call.tool) {
    case "search_transcripts":
      return (
        <>
          {m.agents_read_search({ words: call.words ?? 0 })}
          {call.results === null ? null : (
            <span className={muted}> · {m.agents_read_results({ count: call.results })}</span>
          )}
        </>
      );
    case "get_episode":
      return (
        <>
          {m.agents_read_episode()}
          <span className={muted}> · </span>
          {call.episodeId === null || call.episodeStartedAtMs === null ? (
            <span className={muted}>{m.agents_deleted_since()}</span>
          ) : (
            <Link to="/episode/$id" params={{ id: String(call.episodeId) }} className={link}>
              {dayClock(call.episodeStartedAtMs)}
            </Link>
          )}
        </>
      );
    case "get_day_overview":
    case "list_episodes":
      return (
        <>
          {m.agents_read_day()}
          {call.day === null ? null : (
            <span className={muted}> · {dayTitle(call.day, dayOf(Date.now()))}</span>
          )}
        </>
      );
    case "list_people":
      return <>{m.agents_read_people()}</>;
    case "get_person":
      return (
        <>
          {m.agents_read_person()}
          <span className={muted}> · </span>
          {call.personId === null || call.personName === null ? (
            <span className={muted}>{m.agents_deleted_since()}</span>
          ) : (
            <Link
              to="/people/$personId"
              params={{ personId: String(call.personId) }}
              className={link}
            >
              {call.personName}
            </Link>
          )}
        </>
      );
    case "get_status":
      return <>{m.agents_read_status()}</>;
    default:
      return <>{m.agents_read_other({ tool: call.tool })}</>;
  }
}

/** Text that holds a key, selectable and copied in one click. */
function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col items-end gap-xs">
      <pre className="w-full overflow-x-auto corner-s bg-neutral-2 p-s font-data text-body-xs whitespace-pre-wrap break-all select-all">
        {text}
      </pre>
      <Button
        variant="secondary"
        onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      >
        {copied ? m.agents_copied() : m.agents_copy()}
      </Button>
    </div>
  );
}

function targetName(target: Target, other: string): string {
  switch (target.kind) {
    case "app":
      return target.app.name;
    case "command":
      return target.client.name;
    case "other":
      return other.trim() === "" ? m.agents_other() : other.trim();
  }
}

/** What connecting does, and where what the agent reads goes, before any key exists. */
function Consent({
  target,
  name,
  setName,
  pending,
  error,
  onConnect,
}: {
  target: Target;
  name: string;
  setName: (name: string) => void;
  pending: boolean;
  error: unknown;
  onConnect: () => void;
}) {
  const provider =
    target.kind === "app"
      ? APP_PROVIDERS[target.app.id]
      : target.kind === "command"
        ? target.client.provider
        : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (target.kind !== "other" || name.trim() !== "") onConnect();
  };
  return (
    <form onSubmit={submit} className="contents">
      <DialogTitle>{m.agents_connect({ name: targetName(target, "") })}</DialogTitle>
      <DialogDescription>
        {target.kind === "app"
          ? m.agents_consent_app({ name: target.app.name, path: target.app.path })
          : target.kind === "command"
            ? m.agents_consent_command({ name: target.client.name })
            : m.agents_consent_other()}
      </DialogDescription>
      <p className="text-body-s text-cte-text-muted">
        {m.agents_consent_reads()}{" "}
        {provider === null
          ? m.agents_consent_leaves()
          : m.agents_consent_leaves_provider({ provider })}
      </p>
      {target.kind !== "app" || target.app.sharedWith.length === 0 ? null : (
        <p className="text-body-s text-cte-text-muted">
          {m.agents_consent_shared({ apps: target.app.sharedWith.join(", ") })}
        </p>
      )}
      {target.kind === "other" ? (
        <Field>
          <FieldLabel>{m.agents_app_name()}</FieldLabel>
          <Input
            autoFocus
            maxLength={60}
            placeholder={m.agents_app_name_placeholder()}
            value={name}
            onValueChange={(value) => setName(value)}
          />
        </Field>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
      <DialogFooter>
        <DialogClose>{m.cancel()}</DialogClose>
        <Button
          type="submit"
          isPending={pending}
          disabled={target.kind === "other" && name.trim() === ""}
        >
          {target.kind === "app" ? m.agents_connect_button() : m.agents_create_key()}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** What Sondine wrote, or the key to set up by hand. */
function Result({
  target,
  outcome,
  name,
  onDone,
}: {
  target: Target;
  outcome: Outcome;
  name: string;
  onDone: () => void;
}) {
  const footer = (
    <DialogFooter>
      <Button onClick={onDone}>{m.agents_done()}</Button>
    </DialogFooter>
  );
  if (outcome.kind === "app") {
    const { result } = outcome;
    if (!result.ok) {
      return (
        <>
          <DialogTitle>{m.agents_app_not_connected_title({ name })}</DialogTitle>
          <DialogDescription>
            {problemText(result.problem, result.path)} {m.agents_app_untouched()}
          </DialogDescription>
          {footer}
        </>
      );
    }
    return (
      <>
        <DialogTitle>{m.agents_app_connected_title({ name })}</DialogTitle>
        <DialogDescription>
          {m.agents_app_written({ server: result.serverName, path: result.path })}
          {result.backupPath === null
            ? null
            : ` ${m.agents_app_backup({ path: result.backupPath })}`}
        </DialogDescription>
        {result.replaces === null ? null : (
          <p className="text-body-s text-cte-text-muted">
            {m.agents_app_replaces({ name, path: result.replaces })}
          </p>
        )}
        <p className="text-body-s text-cte-text-muted">{m.agents_app_reload({ name })}</p>
        {footer}
      </>
    );
  }
  const setup = outcome.result.setup;
  return (
    <>
      <DialogTitle>{m.agents_connect({ name })}</DialogTitle>
      {setup === null ? (
        <DialogDescription>{m.agents_no_relay()}</DialogDescription>
      ) : target.kind === "command" ? (
        <>
          <DialogDescription>{m.agents_command_description({ name })}</DialogDescription>
          <CopyBlock text={target.client.name === "Codex" ? setup.codex : setup.claudeCode} />
        </>
      ) : (
        <>
          <DialogDescription>{m.agents_other_description()}</DialogDescription>
          <Tabs defaultValue="json">
            <TabsList>
              <TabsTab value="json">JSON</TabsTab>
              <TabsTab value="toml">TOML</TabsTab>
            </TabsList>
            <TabsPanel value="json">
              <CopyBlock text={setup.json} />
            </TabsPanel>
            <TabsPanel value="toml">
              <CopyBlock text={setup.toml} />
            </TabsPanel>
          </Tabs>
        </>
      )}
      {footer}
    </>
  );
}

function ConnectDialog({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [name, setName] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.agents.key() });
  const connectApp = useMutation(orpc.agents.connectApp.mutationOptions({ onSettled: refresh }));
  const create = useMutation(orpc.agents.create.mutationOptions({ onSettled: refresh }));
  const close = () => {
    setOutcome(null);
    setName("");
    connectApp.reset();
    create.reset();
    onClose();
  };
  const connect = () => {
    if (target === null) return;
    if (target.kind === "app") {
      connectApp.mutate(
        { app: target.app.id },
        { onSuccess: (result) => setOutcome({ kind: "app", result }) },
      );
    } else {
      create.mutate(
        { name: targetName(target, name) },
        { onSuccess: (result) => setOutcome({ kind: "key", result }) },
      );
    }
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup>
        {target === null ? null : outcome === null ? (
          <Consent
            target={target}
            name={name}
            setName={setName}
            pending={connectApp.isPending || create.isPending}
            error={connectApp.error ?? create.error}
            onConnect={connect}
          />
        ) : (
          <Result
            target={target}
            outcome={outcome}
            name={targetName(target, name)}
            onDone={close}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ConnectRow({
  name,
  hint,
  disabled = false,
  onConnect,
}: {
  name: string;
  hint: string;
  disabled?: boolean;
  onConnect: () => void;
}) {
  return (
    <li className="flex items-center gap-m py-xs">
      <span className="font-body font-medium">{name}</span>
      <span className="min-w-0 flex-1 truncate text-body-s text-cte-text-muted">{hint}</span>
      <Button variant="ghost" disabled={disabled} onClick={onConnect}>
        {m.agents_connect_button()}
      </Button>
    </li>
  );
}

/** What revoking did to the apps' files. */
function RevokeNote({ note }: { note: AgentRevokeResult }) {
  if (note.removedFrom.length === 0 && note.failed.length === 0) return null;
  return (
    <div className="flex flex-col gap-xxs text-body-s">
      {note.removedFrom.length === 0 ? null : (
        <p className="text-cte-text-muted">
          {m.agents_removed_from({ path: note.removedFrom.join(", ") })}
        </p>
      )}
      {note.failed.map((failure) => (
        <p key={failure.path} role="alert" className="text-error">
          {m.agents_remove_failed({ path: failure.path })}
        </p>
      ))}
    </div>
  );
}

export function AgentsSection() {
  const queryClient = useQueryClient();
  const status = useQuery({ ...orpc.agents.status.queryOptions(), refetchInterval: REFRESH_MS });
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [revokeNote, setRevokeNote] = useState<AgentRevokeResult | null>(null);
  const store = (next: AgentsStatus) =>
    queryClient.setQueryData(orpc.agents.status.queryKey(), next);
  const setEnabled = useMutation(
    orpc.agents.setEnabled.mutationOptions({
      onSuccess: (next) => {
        store(next);
        setConfirming(false);
      },
    }),
  );
  const revoke = useMutation(
    orpc.agents.revoke.mutationOptions({
      onSuccess: (result) => {
        store(result.status);
        setRevokeNote(result);
      },
    }),
  );
  const remove = useMutation(orpc.agents.remove.mutationOptions({ onSuccess: store }));
  const data = status.data;
  const enabled = data?.enabled;
  const error = status.error ?? setEnabled.error ?? revoke.error ?? remove.error;
  /** The app whose file holds each agent's key. */
  const appOf = new Map(
    (data?.apps ?? []).flatMap((app) =>
      app.agentId === null ? [] : [[app.agentId, app] as const],
    ),
  );
  /** Names that already have a key with access: no second key is offered for them. */
  const connectedNames = new Set(
    (data?.agents ?? []).filter((agent) => agent.revokedAtMs === null).map((agent) => agent.name),
  );
  const open = (next: Target) => {
    setRevokeNote(null);
    setTarget(next);
  };

  return (
    <div className="flex max-w-[40rem] flex-col gap-m">
      <div className="flex flex-col gap-xs">
        <SwitchLabel>
          <Switch
            checked={enabled ?? false}
            disabled={enabled === undefined || setEnabled.isPending}
            onCheckedChange={(checked) =>
              checked ? setConfirming(true) : setEnabled.mutate({ enabled: false })
            }
          />
          {m.agents_access()}
        </SwitchLabel>
        {enabled === undefined ? null : (
          <p className="text-body-s text-cte-text-muted">
            {enabled ? m.agents_access_on() : m.agents_access_off()}
          </p>
        )}
      </div>

      {/* Agents and their reads stay listed with access off, so a key can still be revoked. */}
      {data === undefined || (!enabled && data.agents.length === 0) ? null : (
        <>
          {data.agents.length === 0 ? null : (
            <ul className="flex flex-col">
              {data.agents.map((agent) => (
                <li key={agent.id} className="flex items-center gap-m py-xs">
                  <span className="font-body font-medium">{agent.name}</span>
                  <span className="min-w-0 flex-1 truncate text-body-s text-cte-text-muted">
                    {agentState(agent)}
                    {appOf.has(agent.id) ? ` · ${appOf.get(agent.id)?.path ?? ""}` : null}
                  </span>
                  {agent.revokedAtMs === null ? (
                    <Button
                      variant="ghost"
                      isPending={revoke.isPending && revoke.variables?.agentId === agent.id}
                      onClick={() => revoke.mutate({ agentId: agent.id })}
                    >
                      {m.agents_revoke()}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      isPending={remove.isPending && remove.variables?.agentId === agent.id}
                      onClick={() => remove.mutate({ agentId: agent.id })}
                    >
                      {m.agents_remove()}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {revokeNote === null ? null : <RevokeNote note={revokeNote} />}
          {!enabled ? null : data.relayPath === null ? (
            <p className="text-body-s text-cte-text-muted">{m.agents_no_relay()}</p>
          ) : (
            <section className="flex flex-col gap-xs">
              <h3 className="font-body font-medium">{m.agents_connect_title()}</h3>
              <ul className="flex flex-col">
                {data.apps
                  .filter((app) => app.agentId === null)
                  .map((app) => (
                    <ConnectRow
                      key={app.id}
                      name={app.name}
                      hint={
                        app.problem === null
                          ? m.agents_app_writes({ path: app.path })
                          : problemText(app.problem, app.path)
                      }
                      disabled={app.problem !== null}
                      onConnect={() => open({ kind: "app", app })}
                    />
                  ))}
                {COMMAND_CLIENTS.filter((client) => !connectedNames.has(client.name)).map(
                  (client) => (
                    <ConnectRow
                      key={client.name}
                      name={client.name}
                      hint={m.agents_command_hint()}
                      onConnect={() => open({ kind: "command", client })}
                    />
                  ),
                )}
                <ConnectRow
                  name={m.agents_other()}
                  hint={m.agents_other_hint()}
                  onConnect={() => open({ kind: "other" })}
                />
              </ul>
            </section>
          )}
          <section className="flex flex-col gap-xs">
            <h3 className="font-body font-medium">{m.agents_log_title()}</h3>
            {data.calls.length === 0 ? (
              <p className="text-body-s text-cte-text-muted">{m.agents_log_empty()}</p>
            ) : (
              <ul className="flex flex-col gap-xxs text-body-s">
                {data.calls.map((call) => (
                  <li key={call.id} className="flex items-baseline gap-s">
                    <span className="shrink-0 font-data tabular-nums text-cte-text-muted">
                      {dayClock(call.atMs)}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium">{call.agentName}</span>{" "}
                      <CallSubject call={call} />
                      {call.outcome === "ok" ? null : (
                        <span className="text-error">
                          {" "}
                          · {call.outcome === "refused" ? m.agents_refused() : m.agents_failed()}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogTitle>{m.agents_confirm_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.agents_confirm_description()}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose>{m.cancel()}</AlertDialogClose>
            <Button
              isPending={setEnabled.isPending}
              onClick={() => setEnabled.mutate({ enabled: true })}
            >
              {m.agents_confirm()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <ConnectDialog target={target} onClose={() => setTarget(null)} />
    </div>
  );
}
