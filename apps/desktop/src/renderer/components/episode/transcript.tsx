import type {
  ContextItem,
  EpisodeApp,
  EpisodeDetail,
  EpisodeSpeaker,
  TranscriptSegment,
} from "@sondine/api";
import { cn } from "@sondine/ui";
import { Button, buttonVariants } from "@sondine/ui/components/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@sondine/ui/components/menu";
import { useToastManager } from "@sondine/ui/components/toast";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  PaperclipIcon,
  PenIcon,
  PinIcon,
  PlayIcon,
  ScissorsIcon,
  TrashIcon,
  XIcon,
} from "@sondine/ui/icon";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { isEditorInteraction } from "../../graphical/interaction-boundary";
import { currentMatchClassName, highlightParts, matchClassName } from "../../lib/highlight";
import { clock, voiceName } from "../../lib/labels";
import { formatOffset } from "../../lib/time";
import { voicesByLabel, type Voice } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { useShortcut } from "../../shortcuts/shortcuts-provider";
import { usePlayer, usePlayerState } from "../player/player-provider";
import { AppIcon } from "../shell/app-icon";
import type { PlayerSnapshot } from "../player/player-store";
import { segmentAt, stepSegment, wallAt } from "../player/player-time";
import type { SearchScreenSearch } from "../../routes/search-params";
import {
  groupTurns,
  inSpan,
  matchingSegments,
  mayFollow,
  passageSpan,
  stepMatch,
  type PassageRange,
  type TranscriptTurn,
} from "./transcript-view";
import {
  carriesContext,
  ContextAddPopover,
  contextItemDomId,
  contextName,
  typingIn,
  type useContextAdd,
} from "./context-strip";
import { useDeleteEpisode } from "./episode-menu";
import { SegmentEditor, type EditEnd } from "./segment-editor";
import { VoiceName, VoiceNameStandIn } from "./voice-name";

// The transcript as speaker turns, the app in front on the Mac by a turn
// where it changes (ADR 022). Each segment is a button that plays from its
// start; the one playing is highlighted from the player's time updates,
// and the view scrolls to it only while the user has not scrolled for a few
// seconds. ↑/↓ go to the previous or next segment; Space on a segment plays
// or pauses. With a search, its matches are marked and stepped through. The
// pen beside a segment of the final transcript opens it for correction; the
// scissors start a new episode there (merging the two joins them again).
// Sentences are chosen for deletion by the trash, by selecting text over
// several of them (within one, a selection is left for copying), or by ⌫ on a
// selection or a sentence; ⇧-click extends the choice, the bar takes it to the
// start or the end, and one confirmation erases it for good (the whole
// recording when every sentence is chosen).

/** The scroll container of every screen (app-shell). */
const scroller = () => document.getElementById("main");

function isInView(element: HTMLElement): boolean {
  const container = scroller();
  if (container === null) return true;
  const box = element.getBoundingClientRect();
  const view = container.getBoundingClientRect();
  return box.top >= view.top && box.bottom <= view.bottom;
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/** Sentences chosen for deletion: ⇧-click extends them from the anchor, the first one chosen. */
interface Choice extends PassageRange {
  readonly anchor: number;
}

interface Passage extends Choice {
  /**
   * Chosen on purpose (trash, ⌫, ⇧-click, the bar). A passage only read from
   * a text selection ends when the selection does.
   */
  readonly held: boolean;
}

/** The sentences a text selection reaches by a character at least; null without one. */
function selectedSentences(buttons: ReadonlyMap<number, HTMLElement>): Choice | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const touched = [...buttons]
    .filter(([, button]) => {
      if (!range.intersectsNode(button)) return false;
      const part = document.createRange();
      part.selectNodeContents(button);
      if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
        part.setStart(range.startContainer, range.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
        part.setEnd(range.endContainer, range.endOffset);
      }
      return part.toString().trim() !== "";
    })
    .map(([index]) => index);
  if (touched.length === 0) return null;
  const from = Math.min(...touched);
  const to = Math.max(...touched);
  // ⇧-click then extends from where the selection started, as text does.
  const backward =
    selection.anchorNode !== range.startContainer || selection.anchorOffset !== range.startOffset;
  return { anchor: backward ? to : from, from, to };
}

/** The sentence with the keyboard focus, as a choice of one. */
function focusedSentence(buttons: ReadonlyMap<number, HTMLElement>): Choice | null {
  for (const [index, button] of buttons) {
    if (button === document.activeElement) return { anchor: index, from: index, to: index };
  }
  return null;
}

/** Whether the text selection reaches into an element (a click that ends one is for copying). */
function selectionIn(element: HTMLElement): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.containsNode(element, true);
}

export function Transcript({
  detail,
  adding,
  onDropped,
  q,
  results,
  initialWallMs,
  onCloseSearch,
  onEpisodeDeleted,
}: {
  detail: EpisodeDetail;
  /** Adding context: « Ajouter du contexte ici », and drops on a sentence (ADR 024). */
  adding: ReturnType<typeof useContextAdd>;
  /** A drop on a sentence ended the page's drag. */
  onDropped: () => void;
  q: string | undefined;
  /** The search screen's state, for « Résultats » in the match bar. */
  results: SearchScreenSearch;
  /** Where the user arrived (a search hit's time): shown first. */
  initialWallMs: number | undefined;
  onCloseSearch: () => void;
  /** A deleted passage held everything said: the recording is gone. */
  onEpisodeDeleted: () => void;
}) {
  const player = usePlayer();
  const episodeId = detail.episode.id;
  const segments = detail.segments;
  const voices = useMemo(() => voicesByLabel(detail.speakers), [detail.speakers]);
  const turns = useMemo(() => groupTurns(segments, voices, { byApp: true }), [segments, voices]);
  const matches = useMemo(() => matchingSegments(segments), [segments]);
  /** The context pinned to each sentence, by segment id. */
  const pinned = useMemo(
    () =>
      Map.groupBy(
        detail.context.filter((item) => item.segmentId !== null),
        (item) => item.segmentId ?? 0,
      ),
    [detail.context],
  );
  const [matchPosition, setMatchPosition] = useState(-1);
  /** The segment being corrected, by index; playback stops being followed meanwhile. */
  const [editing, setEditing] = useState<number | null>(null);
  const runId = detail.analysis?.runId;
  const editTarget = useMemo(
    () => (runId === undefined ? null : { episodeId, runId }),
    [episodeId, runId],
  );
  const split = useSplit();
  const openPage = useMutation(orpc.episodes.openPage.mutationOptions());
  const [passage, setPassage] = useState<Passage | null>(null);
  const removePassage = useDeletePassage(
    episodeId,
    () => {
      setPassage(null);
    },
    onEpisodeDeleted,
  );
  const removeEpisode = useDeleteEpisode(episodeId, onEpisodeDeleted);
  // A new transcript (or this one, shorter) ends the choice.
  useEffect(() => setPassage(null), [segments]);
  const choose = (index: number, extend: boolean) =>
    setPassage((current) =>
      current !== null && extend
        ? {
            anchor: current.anchor,
            from: Math.min(current.anchor, index),
            to: Math.max(current.anchor, index),
            held: true,
          }
        : { anchor: index, from: index, to: index, held: true },
    );
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const bar = useRef<HTMLDivElement>(null);
  const barCancel = useRef<HTMLButtonElement>(null);
  /** Chosen from the keyboard: the bar takes the focus, on « Annuler ». */
  const focusBar = () => requestAnimationFrame(() => barCancel.current?.focus());
  /** Cancelled from the bar's focus: back to the sentence the passage started from. */
  const cancelPassage = () => {
    const anchor = passage?.anchor;
    if (anchor !== undefined && bar.current?.contains(document.activeElement)) {
      buttons.current.get(anchor)?.focus({ preventScroll: true });
    }
    setPassage(null);
  };
  useEffect(() => {
    if (passage === null) return;
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") cancelPassage();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [passage]);

  const deletable = detail.episode.state === "closed";
  /** A ⇧-click on a sentence extended the passage during this press. */
  const extendedByClick = useRef(false);
  // Text selected over several sentences chooses them, read once the mouse is
  // released; within one sentence it is left alone. Such a choice ends with
  // its selection, unless the user takes it up in the bar.
  useEffect(() => {
    if (!deletable) return;
    /** The selection moved during this press: a drag, a double-click, a ⇧-click. */
    let moved = false;
    const pressed = () => {
      moved = false;
      extendedByClick.current = false;
    };
    const changed = () => {
      moved = true;
      if (window.getSelection()?.isCollapsed ?? true) {
        setPassage((current) => (current?.held === false ? null : current));
      }
    };
    const released = () => {
      if (!moved) return;
      // After the browser's own release and the click: a click inside a
      // selection collapses it, a ⇧-click on a sentence extends the passage itself.
      setTimeout(() => {
        if (extendedByClick.current) return;
        const chosen = selectedSentences(buttons.current);
        if (chosen === null || chosen.from === chosen.to) return;
        setPassage({ ...chosen, held: false });
      });
    };
    document.addEventListener("mousedown", pressed);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("mouseup", released);
    return () => {
      document.removeEventListener("mousedown", pressed);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("mouseup", released);
    };
  }, [deletable]);
  // ⌫ chooses the sentences selected, or the one with the focus; the bar still confirms.
  useEffect(() => {
    if (!deletable) return;
    const erase = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.shiftKey || typingIn(event.target) || isEditorInteraction(event)) return;
      const chosen = selectedSentences(buttons.current) ?? focusedSentence(buttons.current);
      if (chosen === null) return;
      event.preventDefault();
      setPassage({ ...chosen, held: true });
      focusBar();
    };
    window.addEventListener("keydown", erase);
    return () => window.removeEventListener("keydown", erase);
  }, [deletable]);

  const playingIndex = usePlayerState(
    useCallback(
      (snapshot: PlayerSnapshot) =>
        snapshot.episodeId === episodeId &&
        snapshot.timeline !== null &&
        snapshot.status !== "error"
          ? segmentAt(segments, wallAt(snapshot.seconds, snapshot.timeline))
          : -1,
      [episodeId, segments],
    ),
  );

  const lastUserScroll = useRef<number | null>(null);
  const scrollTo = useCallback(
    (
      index: number,
      { focus = false, instant = false }: { focus?: boolean; instant?: boolean } = {},
    ) => {
      const button = buttons.current.get(index);
      if (button === undefined) return;
      if (!isInView(button))
        button.scrollIntoView({ block: "center", behavior: instant ? "auto" : scrollBehavior() });
      if (focus) button.focus({ preventScroll: true });
    },
    [],
  );

  // The user scrolling takes over from following playback for a few seconds.
  useEffect(() => {
    const container = scroller();
    if (container === null) return;
    const scrolled = () => {
      lastUserScroll.current = Date.now();
    };
    const keyScrolled = (event: globalThis.KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) scrolled();
    };
    container.addEventListener("wheel", scrolled, { passive: true });
    container.addEventListener("touchmove", scrolled, { passive: true });
    container.addEventListener("keydown", keyScrolled);
    // Dragging the scrollbar: a press on the container itself, not on its content.
    const pressed = (event: PointerEvent) => {
      if (event.target === container) scrolled();
    };
    container.addEventListener("pointerdown", pressed);
    return () => {
      container.removeEventListener("wheel", scrolled);
      container.removeEventListener("touchmove", scrolled);
      container.removeEventListener("keydown", keyScrolled);
      container.removeEventListener("pointerdown", pressed);
    };
  }, []);

  // Follow the segment playing, unless the user is reading elsewhere.
  useEffect(() => {
    if (editing !== null) return;
    if (playingIndex >= 0 && mayFollow(Date.now(), lastUserScroll.current)) scrollTo(playingIndex);
  }, [playingIndex, scrollTo, editing]);

  const endEditing = (index: number, end: EditEnd) => {
    setEditing(null);
    // Back on the segment after Enter or Escape; a click elsewhere keeps its own focus.
    if (end === "key") requestAnimationFrame(() => buttons.current.get(index)?.focus());
  };

  // On arrival: the segment at the hit's time, or the first match.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || segments.length === 0) return;
    arrived.current = true;
    if (initialWallMs !== undefined) {
      const index = segmentAt(segments, initialWallMs);
      const target = index >= 0 ? index : stepSegment(segments, initialWallMs, 1);
      if (target >= 0) scrollTo(target, { instant: true });
      const position = matches.indexOf(target);
      if (position >= 0) setMatchPosition(position);
    } else if (matches[0] !== undefined) {
      setMatchPosition(0);
      scrollTo(matches[0], { instant: true });
    }
  }, [segments, matches, initialWallMs, scrollTo]);

  /** A click or Enter plays from the segment; ↑/↓ while paused only move there. */
  const goToSegment = (index: number, play: boolean) => {
    const segment = segments[index];
    if (segment === undefined) return;
    if (play || player.getSnapshot().episodeId !== episodeId)
      void player.play(episodeId, segment.startMs);
    else player.seekToWall(segment.startMs);
    lastUserScroll.current = null;
    scrollTo(index);
  };

  const step = (direction: -1 | 1) => {
    const snapshot = player.getSnapshot();
    const loaded = snapshot.episodeId === episodeId && snapshot.timeline !== null;
    const playing = snapshot.status === "playing" || snapshot.status === "loading";
    const index = loaded
      ? stepSegment(segments, wallAt(snapshot.seconds, snapshot.timeline), direction)
      : direction === 1
        ? 0
        : -1;
    if (index >= 0) goToSegment(index, playing);
  };
  useShortcut("player.previous", () => step(-1), { enabled: segments.length > 0 });
  useShortcut("player.next", () => step(1), { enabled: segments.length > 0 });

  const stepToMatch = (direction: -1 | 1) => {
    const next = stepMatch(matchPosition, matches.length, direction);
    setMatchPosition(next);
    const index = matches[next];
    if (index !== undefined) {
      lastUserScroll.current = Date.now();
      scrollTo(index, { focus: true });
    }
  };

  const onSegmentKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== " " || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
      return;
    // Space plays or pauses, as everywhere else; Enter plays from the segment.
    event.preventDefault();
    if (player.getSnapshot().episodeId === episodeId) player.toggle();
    else goToSegment(index, true);
  };

  const episodeStart = detail.episode.startedAtMs;
  const currentMatch = matches[matchPosition] ?? -1;
  // What « Supprimer » takes: every sentence said during the passage's span.
  const span = useMemo(
    () => (passage === null ? null : passageSpan(segments, passage)),
    [segments, passage],
  );
  const taken = span === null ? 0 : segments.filter((segment) => inSpan(segment, span)).length;
  const whole = taken > 0 && taken === segments.length;
  // A phone recording or an imported file stays whole (ADR 032).
  const splittable =
    detail.episode.state === "closed" && !detail.tracks.some((track) => track.kind === "phone");
  // Every row calls back through one object that never changes, so a row
  // renders again only when what it shows changes (ADR 037: a long call
  // scrolls smoothly), never on the screen's other updates.
  const handlers = {
    play(index: number, event: MouseEvent<HTMLButtonElement>) {
      if (passage !== null && event.shiftKey) {
        extendedByClick.current = true;
        choose(index, true);
      } else if (!selectionIn(event.currentTarget)) {
        goToSegment(index, true);
      }
    },
    key: onSegmentKey,
    register(index: number, button: HTMLButtonElement | null) {
      if (button === null) buttons.current.delete(index);
      else buttons.current.set(index, button);
    },
    edit: (index: number) => setEditing(index),
    endEdit: endEditing,
    playFrom: (index: number) => goToSegment(index, true),
    split: (atMs: number) => split.mutate({ episodeId, atMs }),
    openPage: (segmentId: number) => openPage.mutate({ episodeId, segmentId }),
    remove(index: number, extend: boolean) {
      choose(index, extend);
      focusBar();
    },
    drop(event: DragEvent<HTMLDivElement>, segmentId: number) {
      onDropped();
      adding.drop(event, segmentId);
    },
  };
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const actions = useMemo<RowActions>(
    () => ({
      play: (index, event) => latest.current.play(index, event),
      key: (event, index) => latest.current.key(event, index),
      register: (index, button) => latest.current.register(index, button),
      edit: (index) => latest.current.edit(index),
      endEdit: (index, end) => latest.current.endEdit(index, end),
      playFrom: (index) => latest.current.playFrom(index),
      split: (atMs) => latest.current.split(atMs),
      openPage: (segmentId) => latest.current.openPage(segmentId),
      remove: (index, extend) => latest.current.remove(index, extend),
      drop: (event, segmentId) => latest.current.drop(event, segmentId),
    }),
    [],
  );
  const splitPendingAt = split.isPending ? split.variables.atMs : null;
  return (
    <AddingContext value={adding}>
      {q === undefined ? null : (
        <MatchBar
          q={q}
          results={results}
          count={matches.length}
          position={matchPosition}
          onStep={stepToMatch}
          onClose={onCloseSearch}
        />
      )}
      {turns.length === 0 ? null : (
        <ol
          aria-label={m.episode_transcript()}
          className="flex flex-col gap-s"
          // Selected text is for choosing and copying: dragged, it would pin itself as context.
          onDragStart={(event) => event.preventDefault()}
        >
          {turns.map((turn) => {
            const within = (index: number) => (turn.segments.includes(index) ? index : -1);
            const first = segments[turn.segments[0] ?? -1];
            const last = segments[turn.segments.at(-1) ?? -1];
            const chosenSpan =
              span !== null &&
              first !== undefined &&
              last !== undefined &&
              first.startMs < span.endMs &&
              turn.segments.some((index) => {
                const segment = segments[index];
                return segment !== undefined && inSpan(segment, span);
              })
                ? span
                : null;
            return (
              <TurnRow
                key={turn.key}
                turn={turn}
                segments={segments}
                speaker={speakerOf(detail, turn)}
                runId={detail.recognized ? (runId ?? null) : null}
                episodeId={episodeId}
                episodeStart={episodeStart}
                playing={within(playingIndex)}
                currentMatch={within(currentMatch)}
                span={chosenSpan}
                editing={editing === null ? null : within(editing)}
                editTarget={editTarget}
                pinned={pinned}
                deletable={deletable}
                splittable={splittable}
                splitPendingAt={splitPendingAt}
                actions={actions}
              />
            );
          })}
        </ol>
      )}
      {passage === null || span === null ? null : (
        <PassageBar
          ref={bar}
          cancelRef={barCancel}
          count={taken}
          whole={whole}
          from={formatOffset(span.startMs - episodeStart)}
          to={formatOffset(span.endMs - episodeStart)}
          onFromStart={
            passage.from > 0 && !whole
              ? () => setPassage((current) => current && { ...current, from: 0, held: true })
              : undefined
          }
          onToEnd={
            passage.to < segments.length - 1 && !whole
              ? () =>
                  setPassage(
                    (current) => current && { ...current, to: segments.length - 1, held: true },
                  )
              : undefined
          }
          pending={removePassage.isPending || removeEpisode.isPending}
          error={removePassage.error ?? removeEpisode.error}
          onHold={() => setPassage((current) => current && { ...current, held: true })}
          onCancel={cancelPassage}
          onDelete={() =>
            whole
              ? removeEpisode.mutate({ episodeId })
              : removePassage.mutate({ episodeId, fromMs: span.startMs, toMs: span.endMs })
          }
        />
      )}
    </AddingContext>
  );
}

/**
 * The passage chosen: how many sentences and when, why it is final, taking it
 * to the start or the end, and the one confirmation. Every sentence chosen
 * reads as the recording's own deletion.
 */
function PassageBar({
  ref,
  cancelRef,
  count,
  whole,
  from,
  to,
  onFromStart,
  onToEnd,
  pending,
  error,
  onHold,
  onCancel,
  onDelete,
}: {
  ref: RefObject<HTMLDivElement | null>;
  /** « Annuler », focused when the keyboard chose the passage. */
  cancelRef: RefObject<HTMLButtonElement | null>;
  count: number;
  whole: boolean;
  /** Offsets into the recording, as the transcript shows them. */
  from: string;
  to: string;
  /** Absent when the passage already starts or ends there. */
  onFromStart: (() => void) | undefined;
  onToEnd: (() => void) | undefined;
  pending: boolean;
  error: Error | null;
  /** The user touched the bar: the choice no longer follows the text selection. */
  onHold: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const title = whole
    ? m.episode_delete_title()
    : count === 1
      ? m.passage_confirm_one()
      : m.passage_confirm_many({ count });
  const explanation = useId();
  return (
    <div
      ref={ref}
      className="sticky -bottom-xl z-10 -mb-l bg-cte-canvas pt-xs pb-xl"
      onPointerDownCapture={onHold}
    >
      <div
        role="alertdialog"
        aria-label={title}
        aria-describedby={explanation}
        className="flex flex-wrap items-center gap-s corner-m bg-neutral-2 py-xs ps-m pe-xs shadow-m"
      >
        {/* The text keeps a readable width; the buttons go under it in a narrow window. */}
        <div className="flex min-w-0 grow basis-[16rem] flex-col">
          <p className="font-body font-medium">{title}</p>
          <p id={explanation} className="text-body-s text-cte-text-muted">
            {whole ? m.episode_delete_description() : m.passage_explain({ from, to })}
          </p>
          {error === null ? null : (
            <p role="alert" className="text-body-s text-error">
              {errorMessage(error)}
            </p>
          )}
        </div>
        <div className="ms-auto flex flex-wrap justify-end gap-s">
          {onFromStart === undefined ? null : (
            <Button variant="ghost" onClick={onFromStart}>
              {m.passage_from_start()}
            </Button>
          )}
          {onToEnd === undefined ? null : (
            <Button variant="ghost" onClick={onToEnd}>
              {m.passage_to_end()}
            </Button>
          )}
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
            {m.cancel()}
          </Button>
          <Button variant="danger" isPending={pending} onClick={onDelete}>
            {m.passage_delete()}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** « Supprimer » : the passage goes for good; the window reads again what is left. */
function useDeletePassage(episodeId: number, onDone: () => void, onEpisodeDeleted: () => void) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const player = usePlayer();
  return useMutation(
    orpc.episodes.deletePassage.mutationOptions({
      onSuccess: async (result) => {
        // Its audio may be in the player's buffer: nothing more of it plays.
        if (player.getSnapshot().episodeId === episodeId) void player.revalidate();
        onDone();
        toasts.add({ title: m.passage_deleted() });
        if (result.episodeDeleted) {
          queryClient.removeQueries({ queryKey: orpc.episodes.get.key() });
          onEpisodeDeleted();
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.people.key() }),
        ]);
      },
    }),
  );
}

/** A segment's paperclip and « ⋯ », shown while the pointer is over it or one has focus. */
const segmentAction =
  "mt-xxs shrink-0 text-cte-text-muted opacity-0 group-hover/segment:opacity-100 focus-visible:opacity-100";

/** « Séparer ici »: the episode ends before the segment, a new one starts with it. */
function useSplit() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toasts = useToastManager();
  return useMutation(
    orpc.episodes.split.mutationOptions({
      onSuccess: async (result) => {
        toasts.add({
          title: m.episode_split_done(),
          actionProps: {
            children: m.episode_split_open(),
            onClick: () =>
              void navigate({ to: "/episode/$id", params: { id: String(result.newEpisodeId) } }),
          },
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        ]);
      },
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
}

/** Brings a pinned item's entry in the « Contexte » strip into view. */
function showContextItem(itemId: number | undefined) {
  if (itemId === undefined) return;
  const entry = document.getElementById(contextItemDomId(itemId));
  if (entry === null) return;
  entry.scrollIntoView({ block: "nearest" });
  entry.focus({ preventScroll: true });
}

function SegmentButton({
  segment,
  playing,
  currentMatch,
  chosen,
  offset,
  register,
  onPlay,
  onKeyDown,
}: {
  segment: TranscriptSegment;
  playing: boolean;
  currentMatch: boolean;
  /** In the passage chosen for deletion. */
  chosen: boolean;
  offset: string;
  register: (button: HTMLButtonElement | null) => void;
  onPlay: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={register}
      data-segment-id={segment.id}
      type="button"
      aria-current={playing ? "time" : undefined}
      aria-description={
        segment.edited
          ? `${m.episode_segment_play({ time: offset })} · ${m.episode_segment_edited()}`
          : m.episode_segment_play({ time: offset })
      }
      onClick={onPlay}
      onKeyDown={onKeyDown}
      className={cn(
        // Its text selects like text (a button's would not), for copying and choosing.
        "-mx-xs min-w-0 flex-1 corner-s text-left select-text",
        "font-body font-regular text-body-m text-cte-text",
        "transition-[background-color] duration-motion ease-motion motion-reduce:transition-none",
        "focus-ring control-hover:bg-neutral-3",
        playing && "bg-neutral-3 control-hover:bg-neutral-3",
        chosen &&
          "bg-error-transparent line-through decoration-error control-hover:bg-error-transparent",
      )}
    >
      {/* The padding is the text's: a drag that starts there selects too. */}
      <span className="block px-xs py-xxs">
        {highlightParts(segment.text, segment.highlights).map((part, index) =>
          part.match ? (
            <mark
              key={index}
              className={cn("font-medium", currentMatch ? currentMatchClassName : matchClassName)}
            >
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </span>
    </button>
  );
}

function MatchBar({
  q,
  results,
  count,
  position,
  onStep,
  onClose,
}: {
  q: string;
  results: SearchScreenSearch;
  count: number;
  position: number;
  onStep: (direction: -1 | 1) => void;
  onClose: () => void;
}) {
  return (
    // The canvas above the bar hides the transcript scrolling under the page's top padding.
    <div className="sticky -top-xl z-10 -mt-l bg-cte-canvas pt-xl pb-xs">
      <div className="flex items-center gap-s corner-m bg-neutral-2 py-xxs ps-m pe-xxs shadow-m">
        <Link
          to="/search"
          search={results}
          className={cn(
            "flex shrink-0 items-center gap-xxs focus-ring",
            "corner-xs",
            "font-body font-medium text-body-s",
            "text-cte-text-muted",
            "control-hover:text-cte-text",
          )}
        >
          <ChevronLeftIcon />
          {m.episode_back_to_results()}
        </Link>
        <p role="status" className="min-w-0 flex-1 truncate">
          {count === 0 ? m.episode_no_match({ q }) : m.episode_matches({ count, q })}
        </p>
        {count === 0 ? null : (
          <>
            <span className="shrink-0 text-body-xs tabular-nums text-cte-text-muted">
              {position < 0
                ? null
                : m.episode_match_position({
                    position: String(position + 1),
                    count: String(count),
                  })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.episode_match_previous()}
              onClick={() => onStep(-1)}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.episode_match_next()}
              onClick={() => onStep(1)}
            >
              <ChevronDownIcon />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon" aria-label={m.episode_match_close()} onClick={onClose}>
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

/** The app in front on the Mac when a turn was said, where it changes: its icon, named on hover. */
function SaidIn({ app }: { app: EpisodeApp }) {
  const label = m.episode_said_in({ app: app.name });
  return (
    <span title={label} className="mt-xxs inline-flex">
      <AppIcon app={{ bundleId: app.bundleId }} name={app.name} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** What every row of the transcript calls back, through one object that never changes. */
interface RowActions {
  play(index: number, event: MouseEvent<HTMLButtonElement>): void;
  key(event: KeyboardEvent<HTMLButtonElement>, index: number): void;
  register(index: number, button: HTMLButtonElement | null): void;
  edit(index: number): void;
  endEdit(index: number, end: EditEnd): void;
  playFrom(index: number): void;
  split(atMs: number): void;
  openPage(segmentId: number): void;
  /** « Supprimer » from a sentence's menu; ⇧ extends the passage. */
  remove(index: number, extend: boolean): void;
  drop(event: DragEvent<HTMLDivElement>, segmentId: number): void;
}

/** Adding context, read only by the paperclips a pointer or the focus reached. */
const AddingContext = createContext<ReturnType<typeof useContextAdd> | null>(null);

const NO_MARKS: readonly ContextItem[] = [];

/** The named voice of a turn: its first sentence's speaker. */
function speakerOf(detail: EpisodeDetail, turn: TranscriptTurn): EpisodeSpeaker | null {
  const label = detail.segments[turn.segments[0] ?? -1]?.speakerLabel ?? null;
  return label === null ? null : (detail.speakers.find((s) => s.label === label) ?? null);
}

/**
 * One speaker turn. Its menus, paperclips and voice popover mount once the
 * pointer or the focus reaches it (« armed »): a two-hour call has thousands
 * of sentences, and each closed menu still costs its components. Until then
 * the same buttons stand in, looking the same; the focus that arrived on one
 * moves to the real control in its place.
 */
const TurnRow = memo(function TurnRow({
  turn,
  segments,
  speaker,
  runId,
  episodeId,
  episodeStart,
  playing,
  currentMatch,
  span,
  editing,
  editTarget,
  pinned,
  deletable,
  splittable,
  splitPendingAt,
  actions,
}: {
  turn: TranscriptTurn;
  segments: readonly TranscriptSegment[];
  speaker: EpisodeSpeaker | null;
  /** The transcript whose voices may be named here; null where they are not. */
  runId: number | null;
  episodeId: number;
  episodeStart: number;
  /** The sentence playing, by index, when it is in this turn; -1 otherwise. */
  playing: number;
  currentMatch: number;
  /** The passage chosen for deletion, when it reaches this turn. */
  span: { readonly startMs: number; readonly endMs: number } | null;
  editing: number | null;
  editTarget: { readonly episodeId: number; readonly runId: number } | null;
  pinned: ReadonlyMap<number, readonly ContextItem[]>;
  deletable: boolean;
  splittable: boolean;
  splitPendingAt: number | null;
  actions: RowActions;
}) {
  const [armed, setArmed] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  /** Which of the row's buttons had the focus when it armed, to give it back. */
  const refocus = useRef(-1);
  useLayoutEffect(() => {
    if (!armed || refocus.current < 0) return;
    row.current?.querySelectorAll("button").item(refocus.current)?.focus({ preventScroll: true });
    refocus.current = -1;
  }, [armed]);
  const holdsPlaying = playing >= 0;
  return (
    <li
      ref={row}
      className="grid grid-cols-[6rem_minmax(0,1fr)] gap-m"
      onPointerEnter={armed ? undefined : () => setArmed(true)}
      onFocusCapture={
        armed
          ? undefined
          : (event) => {
              const focused: EventTarget = event.target;
              const buttons = [...(row.current?.querySelectorAll("button") ?? [])];
              refocus.current =
                focused instanceof HTMLButtonElement ? buttons.indexOf(focused) : -1;
              setArmed(true);
            }
      }
    >
      <div className="flex flex-col items-start pt-xs">
        <TurnVoice
          voice={turn.voice}
          speaker={speaker}
          runId={runId}
          episodeId={episodeId}
          armed={armed}
        />
        {/* Into the recording here; the clock time (as search shows it) on hover. */}
        <span
          title={clock(turn.startMs)}
          className={cn(
            "font-data text-body-xs tabular-nums",
            holdsPlaying ? "font-medium text-cte-text" : "text-cte-text-muted",
          )}
        >
          {formatOffset(turn.startMs - episodeStart)}
        </span>
        {turn.app === null ? null : <SaidIn app={turn.app} />}
      </div>
      <div className="flex min-w-0 flex-col">
        {turn.segments.map((index) => {
          const segment = segments[index];
          if (segment === undefined) return null;
          if (editing === index && editTarget !== null) {
            return (
              <SegmentEditor
                key={segment.id}
                target={editTarget}
                segment={segment}
                onDone={(end) => actions.endEdit(index, end)}
              />
            );
          }
          return (
            <SegmentRow
              key={segment.id}
              segment={segment}
              index={index}
              episodeId={episodeId}
              offset={formatOffset(segment.startMs - episodeStart)}
              playing={index === playing}
              currentMatch={index === currentMatch}
              chosen={span !== null && inSpan(segment, span)}
              marks={pinned.get(segment.id) ?? NO_MARKS}
              editable={editTarget !== null}
              splittable={splittable && segment.startMs > episodeStart}
              deletable={deletable}
              splitting={splitPendingAt === segment.startMs}
              armed={armed}
              actions={actions}
            />
          );
        })}
      </div>
    </li>
  );
});

const SegmentRow = memo(function SegmentRow({
  segment,
  index,
  episodeId,
  offset,
  playing,
  currentMatch,
  chosen,
  marks,
  editable,
  splittable,
  deletable,
  splitting,
  armed,
  actions,
}: {
  segment: TranscriptSegment;
  index: number;
  episodeId: number;
  offset: string;
  playing: boolean;
  currentMatch: boolean;
  chosen: boolean;
  /** The context pinned to the sentence. */
  marks: readonly ContextItem[];
  editable: boolean;
  splittable: boolean;
  deletable: boolean;
  /** « Séparer ici » is under way at this sentence. */
  splitting: boolean;
  armed: boolean;
  actions: RowActions;
}) {
  return (
    <div
      className="group/segment flex items-start gap-xxs"
      onDragOver={(event) => {
        if (!carriesContext(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        // Dropped on a sentence: pinned there, not to the whole conversation.
        event.preventDefault();
        event.stopPropagation();
        actions.drop(event, segment.id);
      }}
    >
      <SegmentButton
        segment={segment}
        playing={playing}
        currentMatch={currentMatch}
        offset={offset}
        register={(button) => actions.register(index, button)}
        chosen={chosen}
        onPlay={(event) => actions.play(index, event)}
        onKeyDown={(event) => actions.key(event, index)}
      />
      {marks.length === 0 ? null : (
        <Button
          variant="ghost"
          size="icon-s"
          aria-label={m.context_marker()}
          title={marks.map(contextName).join(", ")}
          className="mt-xxs shrink-0 text-cte-text-muted"
          onClick={() => showContextItem(marks[0]?.id)}
        >
          <PinIcon />
        </Button>
      )}
      {armed ? (
        <SegmentAdd episodeId={episodeId} segmentId={segment.id} />
      ) : (
        <StandIn label={m.context_add_here()}>
          <PaperclipIcon />
        </StandIn>
      )}
      {armed ? (
        /* The sentence's own actions in one « ⋯ » (ADR 037). */
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-s"
                aria-label={m.episode_segment_more()}
                className={segmentAction}
                isPending={splitting}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem icon={<PlayIcon />} onClick={() => actions.playFrom(index)}>
              {m.episode_segment_play()}
            </MenuItem>
            {/* Where the page's video was then (YouTube, ADR 023): open it there. */}
            {segment.mediaMs === null ? null : (
              <MenuItem icon={<ExternalLinkIcon />} onClick={() => actions.openPage(segment.id)}>
                {m.episode_segment_open_at({ time: formatOffset(segment.mediaMs) })}
              </MenuItem>
            )}
            {editable ? (
              <MenuItem icon={<PenIcon />} onClick={() => actions.edit(index)}>
                {m.episode_segment_edit()}
              </MenuItem>
            ) : null}
            {splittable ? (
              <MenuItem icon={<ScissorsIcon />} onClick={() => actions.split(segment.startMs)}>
                {m.episode_segment_split()}
              </MenuItem>
            ) : null}
            {deletable ? (
              <>
                <MenuSeparator />
                <MenuItem
                  variant="danger"
                  icon={<TrashIcon />}
                  onClick={(event) => actions.remove(index, event.shiftKey)}
                >
                  {m.episode_segment_delete()}
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : (
        <StandIn label={m.episode_segment_more()} menu>
          <EllipsisIcon />
        </StandIn>
      )}
    </div>
  );
});

/** « Ajouter du contexte ici », on a sentence. */
function SegmentAdd({ episodeId, segmentId }: { episodeId: number; segmentId: number }) {
  const adding = use(AddingContext);
  if (adding === null) return null;
  return (
    <ContextAddPopover
      episodeId={episodeId}
      segmentId={segmentId}
      adding={adding}
      trigger={<PaperclipIcon />}
      size="icon-s"
      className={segmentAction}
    />
  );
}

/** A sentence's action as it looks before its row is armed: the same small ghost button. */
function StandIn({
  label,
  menu = false,
  children,
}: {
  label: string;
  menu?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-slot="button"
      aria-label={label}
      aria-haspopup={menu ? "menu" : "dialog"}
      className={cn(buttonVariants({ variant: "ghost", size: "icon-s" }), segmentAction)}
    >
      <span data-slot="button-label" className="inline-flex items-center gap-xs">
        {children}
      </span>
    </button>
  );
}

/**
 * The voice of a turn, named on click where voices may be recognised; Sondine's
 * guess reads « Marie ? » and is answered from it. Before its row is armed,
 * the same name stands in.
 */
function TurnVoice({
  voice,
  speaker,
  runId,
  episodeId,
  armed,
}: {
  voice: Voice;
  speaker: EpisodeSpeaker | null;
  runId: number | null;
  episodeId: number;
  armed: boolean;
}) {
  if (speaker === null || runId === null) {
    return <span className="font-body font-medium text-body-xs">{voiceName(voice)}</span>;
  }
  const entry = { label: speaker.label, voice, voicedMs: speaker.voicedMs };
  if (!armed) {
    return (
      <VoiceNameStandIn
        entry={entry}
        person={speaker.person}
        recognized={speaker.recognized}
        suggestion={speaker.suggestion}
        compact
      />
    );
  }
  return (
    <VoiceName
      // A new transcript is a new voice, even under the same label.
      key={`${runId}:${speaker.label}`}
      entry={entry}
      episodeId={episodeId}
      runId={runId}
      person={speaker.person}
      recognized={speaker.recognized}
      suggestion={speaker.suggestion}
      compact
    />
  );
}
