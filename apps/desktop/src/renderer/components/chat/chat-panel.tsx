import type {
  ChatChoice,
  ChatDiscussion,
  ChatDiscussionSummary,
  ChatFailure,
  ChatFocus,
  ChatMessage,
  ChatProvider,
  ChatToolUse,
} from "@sondine/api";
import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  EllipsisIcon,
  LockIcon,
  LoaderIcon,
  PlusIcon,
  SparkleIcon,
  StopIcon,
  XIcon,
} from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { clock, dayTitle, longDate } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { useAgentPanel } from "./agent-panel-state";
import { AnswerText } from "./answer-text";
import { initialChoice, ModelPicker } from "./model-picker";

// The agent panel (ADR 027, ADR 037): Téo asks, an agent of his own
// subscription answers from what Sondine recorded, reading it through
// Sondine's tools only. It opens beside any screen (⌘J, « Demander »), on the
// conversation, day or person there: a chip says where it starts, and the
// agent still reads everything else. The discussion open with each read the
// agent made, and the box to write in with the model to use; past
// discussions, a new one and deleting one are in its « ⋯ ». Nothing is sent
// before Téo sends a message.

/** The provider's company, which receives what leaves. */
const COMPANY: Readonly<Record<ChatProvider["id"], string>> = { claude: "Anthropic" };

function failureText(failure: ChatFailure): string {
  switch (failure.code) {
    case "signed-out":
      return m.chat_failure_signed_out();
    case "usage-limit":
      return m.chat_failure_usage_limit();
    case "context-full":
      return m.chat_failure_context_full();
    case "unavailable":
      return m.chat_failure_unavailable();
    case "crashed":
      return m.chat_failure_crashed();
    case "refused-tool":
      return m.chat_failure_refused_tool();
    case "protocol":
      return m.chat_failure_protocol();
  }
}

function providerProblem(provider: ChatProvider): string | null {
  switch (provider.state) {
    case "ready":
      return null;
    case "missing":
      return m.chat_provider_missing();
    case "signed-out":
      return m.chat_provider_signed_out();
    case "unsupported":
      return m.chat_provider_unsupported();
    case "failed":
      return m.chat_provider_failed();
  }
}

function toolLabel(tool: ChatToolUse): string {
  switch (tool.tool) {
    case "search_transcripts":
      return m.chat_tool_search({ query: tool.query ?? "…" });
    case "get_episode":
      return m.chat_tool_episode();
    case "list_episodes":
      return m.chat_tool_episodes();
    case "get_day_overview":
      return m.chat_tool_day();
    case "list_people":
      return m.chat_tool_people();
    case "get_person":
      return m.chat_tool_person();
    case "get_context_item":
      return m.chat_tool_context();
    case "get_status":
      return m.chat_tool_status();
    case "get_journal":
      return m.chat_tool_journal();
    case "list_commitments":
      return m.chat_tool_commitments();
    default:
      return m.chat_tool_other({ tool: tool.tool });
  }
}

function ToolLine({ tool }: { tool: ChatToolUse }) {
  const today = dayOf(Date.now());
  return (
    <li className="flex items-center gap-xxs">
      {tool.state === "running" ? (
        <LoaderIcon className="animate-spin motion-reduce:animate-none" />
      ) : null}
      <span className="min-w-0 truncate">
        {toolLabel(tool)}
        {tool.day === null ? null : ` · ${dayTitle(tool.day, today)}`}
        {tool.results === null || tool.tool !== "search_transcripts"
          ? null
          : ` · ${m.chat_tool_results({ count: tool.results })}`}
        {tool.state === "failed" ? (
          <span className="text-error"> · {m.chat_tool_failed()}</span>
        ) : null}
      </span>
      {tool.episodeId === null ? null : (
        <Link
          to="/episode/$id"
          params={{ id: String(tool.episodeId) }}
          className="shrink-0 corner-xs underline underline-offset-4 focus-ring"
        >
          {m.chat_open()}
        </Link>
      )}
    </li>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="max-w-[85%] self-end corner-m bg-neutral-3 px-m py-s whitespace-pre-wrap">
        {message.text}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-xs">
      {message.tools.length === 0 ? null : (
        <ul className="flex flex-col gap-xxs text-body-s text-cte-text-muted">
          {message.tools.map((tool) => (
            <ToolLine key={tool.id} tool={tool} />
          ))}
        </ul>
      )}
      {message.text === "" ? null : <AnswerText text={message.text} />}
      {message.streaming && message.text === "" ? (
        <p className="flex items-center gap-xxs text-body-s text-cte-text-muted">
          <LoaderIcon className="animate-spin motion-reduce:animate-none" />
          {m.chat_answering()}
        </p>
      ) : null}
      {message.stopped ? (
        <p className="text-body-s text-cte-text-muted">{m.chat_stopped()}</p>
      ) : null}
      {message.failure === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {failureText(message.failure)}
        </p>
      )}
    </div>
  );
}

/** The panel's « ⋯ »: a new discussion, the past ones, and deleting the one open. */
function HistoryMenu({
  discussions,
  current,
  erased,
}: {
  discussions: readonly ChatDiscussionSummary[];
  current: number | null;
  erased: number;
}) {
  const agent = useAgentPanel();
  const queryClient = useQueryClient();
  const remove = useMutation(
    orpc.chat.remove.mutationOptions({
      // Every copy of the discussion the window holds goes with it.
      onSuccess: () => queryClient.removeQueries({ queryKey: orpc.chat.watch.key() }),
    }),
  );
  const today = dayOf(Date.now());
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.chat_list_label()}
            isPending={remove.isPending}
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="w-[18rem]">
        <MenuItem icon={<PlusIcon />} onClick={() => agent.show(null)}>
          {m.chat_new()}
        </MenuItem>
        {discussions.length === 0 ? null : (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{m.chat_list_label()}</MenuGroupLabel>
              {discussions.map((discussion) => (
                <MenuItem
                  key={discussion.id}
                  onClick={() => agent.show(discussion.id)}
                  className={discussion.id === current ? "bg-neutral-3" : undefined}
                  shortcut={
                    dayOf(discussion.updatedAtMs) === today
                      ? clock(discussion.updatedAtMs)
                      : dayTitle(dayOf(discussion.updatedAtMs), today)
                  }
                >
                  <span className="truncate">{discussion.title}</span>
                </MenuItem>
              ))}
            </MenuGroup>
          </>
        )}
        {erased === 0 ? null : (
          <p className="px-s py-xxs text-body-xs text-cte-text-muted">
            {m.chat_erased({ count: erased })}
          </p>
        )}
        {current === null ? null : (
          <>
            <MenuSeparator />
            <MenuItem
              variant="danger"
              onClick={() =>
                remove.mutate({ discussionId: current }, { onSuccess: () => agent.show(null) })
              }
            >
              {m.chat_remove()}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

function Composer({
  provider,
  lastChoice,
  discussionId,
  running,
  canRead,
  focus,
}: {
  provider: ChatProvider;
  lastChoice: ChatChoice | null;
  discussionId: number | null;
  running: boolean;
  canRead: boolean;
  focus: ChatFocus | null;
}) {
  const agent = useAgentPanel();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<ChatChoice | null>(null);
  const choice = picked ?? initialChoice(provider, lastChoice);
  const send = useMutation(orpc.chat.send.mutationOptions());
  const stop = useMutation(orpc.chat.stop.mutationOptions());
  const problem = canRead ? providerProblem(provider) : m.chat_no_relay();
  const ready = problem === null && choice !== null;

  const submit = () => {
    const message = text.trim();
    if (!ready || message === "" || running || send.isPending) return;
    setText("");
    send.mutate(
      { discussionId, text: message, choice, focus, limited: agent.newLimited },
      {
        onSuccess: (result) => {
          // Core keeps this choice for next time; the status says so without asking again.
          queryClient.setQueryData(orpc.chat.status.queryKey(), (previous) =>
            previous === undefined ? previous : { ...previous, choice },
          );
          if (result.discussionId !== discussionId) agent.show(result.discussionId);
        },
        onError: () => setText(message),
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-xs">
      {problem === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {problem}
        </p>
      )}
      <div className="flex flex-col gap-xs corner-m bg-neutral-2 p-s ring-s ring-neutral-4">
        <textarea
          // The panel opens to write (ADR 037).
          autoFocus
          aria-label={m.chat_placeholder()}
          placeholder={m.chat_placeholder()}
          value={text}
          maxLength={20_000}
          disabled={!ready}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "field-sizing-content max-h-[40vh] min-h-(--line-m)",
            "px-xs py-xxs",
            "text-body-m",
            "resize-none bg-transparent text-cte-text",
            "placeholder:text-cte-text-muted focus:outline-none",
          )}
        />
        <div className="flex items-center gap-xs">
          {choice === null ? null : (
            <ModelPicker
              provider={provider}
              choice={choice}
              onChange={setPicked}
              disabled={!ready || running}
            />
          )}
          <span className="flex-1" />
          {running ? (
            <Button
              variant="secondary"
              size="icon"
              aria-label={m.chat_stop()}
              isPending={stop.isPending}
              onClick={() => {
                if (discussionId !== null) stop.mutate({ discussionId });
              }}
            >
              <StopIcon />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label={m.chat_send()}
              disabled={!ready || text.trim() === ""}
              isPending={send.isPending}
              onClick={submit}
            >
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </div>
      <p className="px-s text-body-xs text-cte-text-muted">
        {m.chat_leaves({ provider: COMPANY[provider.id] })}
      </p>
      {send.error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(send.error)}
        </p>
      )}
    </div>
  );
}

export function ChatPanel() {
  const agent = useAgentPanel();
  const queryClient = useQueryClient();
  const status = useQuery(orpc.chat.status.queryOptions());
  const enabled = status.data?.enabled === true;
  const discussionId = agent.discussionId;
  const view = useQuery(
    orpc.chat.watch.experimental_liveOptions({
      input: { discussionId },
      retry: true,
      enabled,
    }),
  );
  const refresh = useMutation({
    mutationFn: () => orpc.chat.status.call({ refresh: true }),
    onSuccess: (next) => queryClient.setQueryData(orpc.chat.status.queryKey(), next),
  });
  const thread = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const discussion = view.data?.discussion ?? null;

  // Follow the answer while Téo is at the bottom of the thread.
  useEffect(() => {
    const element = thread.current;
    if (element !== null && stuck.current) element.scrollTop = element.scrollHeight;
  }, [view.data?.revision]);

  const provider = status.data?.providers?.[0] ?? null;
  const running = discussion?.running === true;

  return (
    <aside
      aria-label={m.nav_ask()}
      className="mb-xs me-xs flex w-[24rem] shrink-0 flex-col gap-m corner-l bg-cte-canvas p-m ring-[1px] ring-neutral-4"
    >
      <div className="flex items-center gap-xxs">
        <FocusChip discussion={discussion} />
        <span className="flex-1" />
        {enabled ? (
          <HistoryMenu
            discussions={view.data?.discussions ?? []}
            current={discussion?.id ?? null}
            erased={view.data?.erased ?? 0}
          />
        ) : null}
        <Button variant="ghost" size="icon" aria-label={m.close()} onClick={agent.close}>
          <XIcon />
        </Button>
      </div>
      {status.error === null ? null : (
        <p role="alert" className="text-error">
          {errorMessage(status.error)}
        </p>
      )}
      {status.data === undefined ? null : !enabled ? (
        <div className="flex flex-col items-start gap-s">
          <p className="text-cte-text-muted">{m.chat_off()}</p>
          <Button
            variant="secondary"
            render={<Link to="/settings/$page" params={{ page: "agents" }} />}
          >
            {m.chat_open_settings()}
          </Button>
        </div>
      ) : provider === null ? (
        <p className="flex items-center gap-xxs text-cte-text-muted">
          <LoaderIcon className="animate-spin motion-reduce:animate-none" />
          {m.chat_checking()}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-m">
          <div
            ref={thread}
            onScroll={(event) => {
              const element = event.currentTarget;
              stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
            className="flex min-h-0 flex-1 flex-col gap-l overflow-y-auto"
          >
            {(discussion?.messages ?? []).map((message) => (
              <Message key={message.id} message={message} />
            ))}
          </div>
          <Composer
            key={discussion?.id ?? "new"}
            provider={provider}
            lastChoice={
              discussion === null
                ? status.data.choice
                : {
                    provider: discussion.provider,
                    model: discussion.model,
                    effort: discussion.effort,
                  }
            }
            discussionId={discussion?.id ?? null}
            running={running}
            canRead={status.data.canRead}
            focus={discussion === null ? agent.screenFocus : discussion.focus}
          />
          {provider.state === "ready" ? null : (
            <div>
              <Button
                variant="ghost"
                isPending={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                {m.chat_refresh()}
              </Button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * Where the discussion starts: « Cette conversation », « Ce jour », a person,
 * or « Tout ». Its menu limits the agent to it (ADR 037); a lock says so.
 */
function FocusChip({ discussion }: { discussion: ChatDiscussion | null }) {
  const agent = useAgentPanel();
  const setLimited = useMutation(orpc.chat.setLimited.mutationOptions());
  // A discussion keeps the focus it started on; a new one takes the screen's.
  const focus = discussion === null ? agent.screenFocus : discussion.focus;
  const limited =
    discussion === null
      ? agent.newLimited
      : setLimited.isPending
        ? setLimited.variables.limited
        : discussion.limited;
  const onLimited = (next: boolean) =>
    discussion === null
      ? agent.setNewLimited(next)
      : setLimited.mutate({ discussionId: discussion.id, limited: next });
  const person = useQuery({
    ...orpc.people.get.queryOptions({
      input: { personId: focus?.kind === "person" ? focus.personId : 0 },
    }),
    enabled: focus?.kind === "person",
  });
  const label =
    focus === null
      ? m.agent_focus_all()
      : focus.kind === "episode"
        ? m.agent_focus_episode()
        : focus.kind === "day"
          ? focus.day === dayOf(Date.now())
            ? m.agent_focus_today()
            : longDate(focus.day, dayOf(Date.now()))
          : (person.data?.summary.person.name ?? m.agent_focus_person());
  const chip =
    "inline-flex min-w-0 items-center gap-xxs corner-full bg-neutral-3 px-s py-xxs font-medium text-body-s";
  if (focus === null) {
    return (
      <span className={chip}>
        <SparkleIcon className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<button type="button" className={cn(chip, "focus-ring")} />}>
        {limited ? <LockIcon className="shrink-0" /> : <SparkleIcon className="shrink-0" />}
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="shrink-0 text-cte-text-muted" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-[18rem]">
        {/* The item says what it does on a second line, aligned with its label. */}
        <MenuCheckboxItem
          checked={limited}
          onCheckedChange={onLimited}
          label={m.agent_limit({ focus: label })}
        >
          <span className="flex flex-col gap-xxs py-xxs">
            <span>{m.agent_limit({ focus: label })}</span>
            <span className="text-body-xs text-cte-text-muted">
              {limited ? m.agent_limit_on() : m.agent_limit_off()}
            </span>
          </span>
        </MenuCheckboxItem>
        {setLimited.error === null ? null : (
          <p role="alert" className="px-s pb-xxs text-body-xs text-error">
            {errorMessage(setLimited.error)}
          </p>
        )}
      </MenuPopup>
    </Menu>
  );
}
