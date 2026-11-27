import type {
  EpisodeContext,
  EpisodeSize,
  SearchEpisode,
  SearchHit,
  SearchInput,
} from "@sondine/api";
import { ImportedList } from "../imports/imported-list";
import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import { Toggle } from "@sondine/ui/components/toggle";
import { Input } from "@sondine/ui/components/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import { ChevronDownIcon, ChevronRightIcon, InfoIcon, XIcon } from "@sondine/ui/icon";
import { tagKey } from "@sondine/core/tags";
import { TagManager } from "./tag-manager";
import { SearchMenu } from "./search-menu";
import { keepPreviousData, skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { highlightParts, matchClassName } from "../../lib/highlight";
import { clock, contextLabel, dayTitle, sizeLabel, timeRange, voiceName } from "../../lib/labels";
import { isRecognized, voiceOf } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { filtersOf, type SearchPeriod, type SearchScreenSearch } from "../../routes/search-params";
import { focusSearchField, SEARCH_FIELD_ID } from "./search-field";
import { groupByDay, isFiltered, nextOffset, searchInput } from "./search-view";
import { AppIcon, EpisodeAppIcon } from "../shell/app-icon";
import { screenClassName, titleClassName } from "../shell/screen";

// Search (`/search`): the field (⌘K from anywhere), filters by period, size
// and context, and by the app that was in front (ADR 022), then the matches
// grouped by day and episode, newest first.
// Everything is searched by default, media and traces included. A hit opens
// its conversation at that second, playing, with the search highlighted.
// The query and filters live in the URL, so Back returns to the same results.

const route = getRouteApi("/shell/search");

const DEBOUNCE_MS = 250;
const ALL = "all";
/** « Tous les tags »: a value no tag can have (a tag holds no control character, ADR 039). */
const ANY_TAG = "\u0000";

const periods: readonly { value: SearchPeriod | typeof ALL; label: () => string }[] = [
  { value: ALL, label: () => m.search_period_all() },
  { value: "today", label: () => m.day_today() },
  { value: "7d", label: () => m.search_period_7d() },
  { value: "30d", label: () => m.search_period_30d() },
];

const sizes: readonly { value: EpisodeSize; label: () => string }[] = [
  { value: "conversation", label: () => m.search_size_conversations() },
  { value: "moment", label: () => m.search_size_moments() },
  { value: "trace", label: () => m.search_size_traces() },
];

const contexts: readonly { value: EpisodeContext; label: () => string }[] = [
  { value: "call", label: () => m.episode_context_call() },
  { value: "in_person", label: () => m.episode_context_in_person() },
  { value: "media", label: () => m.episode_context_media() },
  { value: "mixed", label: () => m.episode_context_mixed() },
  { value: "dictation", label: () => m.episode_context_dictation() },
  { value: "imported", label: () => m.episode_context_imported() },
];

export function SearchScreen() {
  const params = route.useSearch();
  const navigate = route.useNavigate();
  const [text, setText] = useState(params.q ?? "");

  // The URL follows the field once typing pauses (and the field follows the URL on Back).
  useEffect(() => setText(params.q ?? ""), [params.q]);
  useEffect(() => {
    const next = text.trim() === "" ? undefined : text;
    if (next === params.q) return;
    const timer = setTimeout(
      () => void navigate({ search: (previous) => ({ ...previous, q: next }), replace: true }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [text, params.q, navigate]);

  const setFilters = (patch: Partial<SearchScreenSearch>) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });

  const first = searchInput(params, dayOf(Date.now()), 0);
  const results = useSearchResults(first);
  const total = first === null ? 0 : (results.data?.pages[0]?.total ?? 0);
  return (
    <div className={screenClassName}>
      <div className="flex items-center gap-s">
        <h1 className={cn(titleClassName, "min-w-0 flex-1")}>{m.nav_search()}</h1>
        {first === null || total === 0 ? null : <SearchMenu input={first} />}
      </div>
      <div className="flex flex-col gap-s">
        {/* How many it found, at the field's end before the button that clears it
            (Téo, 2026-11-27); the results' status says it to a screen reader. */}
        <div className="relative">
          <Input
            id={SEARCH_FIELD_ID}
            type="search"
            autoFocus
            aria-label={m.search_label()}
            placeholder={m.search_placeholder()}
            // WebKit's own clear button gives way to ours, after the count;
            // long words stop before both.
            className={cn(
              "[&::-webkit-search-cancel-button]:appearance-none",
              total > 0 ? "pe-[16rem]" : text === "" ? null : "pe-xxl",
            )}
            value={text}
            onValueChange={(value) => setText(value)}
          />
          <div className="absolute inset-y-zero end-xs flex items-center gap-xs">
            {total === 0 ? null : (
              <span aria-hidden className="text-body-s text-cte-text-muted">
                {m.search_total({ count: total })}
              </span>
            )}
            {text === "" ? null : (
              <Button
                variant="ghost"
                size="icon-s"
                aria-label={m.search_clear()}
                onClick={() => {
                  setText("");
                  focusSearchField();
                }}
              >
                <XIcon />
              </Button>
            )}
          </div>
        </div>
        <SearchFilters params={params} onChange={setFilters} />
      </div>
      <Results
        params={params}
        first={first}
        results={results}
        onClearFilters={() => setFilters(noFilters)}
      />
    </div>
  );
}

/** A filter chip (ADR 037): a hairline at rest, ink when it narrows. */
const chip = (active: boolean) =>
  cn("corner-full px-s py-xxs ring-[1px]", active ? "ring-neutral-10" : "ring-neutral-4");

const noFilters = {
  period: undefined,
  sizes: undefined,
  contexts: undefined,
  app: undefined,
  tag: undefined,
};

/**
 * One row: the period, then size and context in one menu, the app that was in
 * front, and a reset once one narrows.
 */
function SearchFilters({
  params,
  onChange,
}: {
  params: SearchScreenSearch;
  onChange: (patch: Partial<SearchScreenSearch>) => void;
}) {
  const period = params.period ?? ALL;
  const chosenSizes = params.sizes ?? [];
  const chosenContexts = params.contexts ?? [];
  const narrowed = chosenSizes.length + chosenContexts.length;
  const toggle = <T,>(list: readonly T[], value: T, on: boolean): T[] | undefined => {
    const next = on ? [...list, value] : list.filter((item) => item !== value);
    return next.length === 0 ? undefined : next;
  };
  const imported = chosenContexts.includes("imported");
  return (
    <div className="flex flex-wrap items-center gap-xs">
      <Menu>
        <MenuTrigger variant="ghost" className={chip(period !== ALL)}>
          {period === ALL
            ? m.search_period_any()
            : periods.find((option) => option.value === period)?.label()}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuRadioGroup
            value={period}
            onValueChange={(value) => {
              const chosen = periods.find((option) => option.value === value)?.value;
              onChange({ period: chosen === undefined || chosen === ALL ? undefined : chosen });
            }}
          >
            {periods.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label()}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger variant="ghost" className={chip(narrowed > 0)}>
          {narrowed === 0 ? m.search_filters() : m.search_filters_count({ count: narrowed })}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel>{m.search_size()}</MenuGroupLabel>
            {sizes.map((option) => (
              <MenuCheckboxItem
                key={option.value}
                checked={chosenSizes.includes(option.value)}
                onCheckedChange={(on) => onChange({ sizes: toggle(chosenSizes, option.value, on) })}
              >
                {option.label()}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>{m.search_context()}</MenuGroupLabel>
            {contexts.map((option) => (
              <MenuCheckboxItem
                key={option.value}
                checked={chosenContexts.includes(option.value)}
                onCheckedChange={(on) =>
                  onChange({ contexts: toggle(chosenContexts, option.value, on) })
                }
              >
                {option.label()}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      <TagFilter tag={params.tag} onChange={(tag) => onChange({ tag })} />
      <AppFilter app={params.app} onChange={(app) => onChange({ app })} />
      <Toggle
        pressed={imported}
        onPressedChange={(on) => onChange({ contexts: toggle(chosenContexts, "imported", on) })}
        className={chip(imported)}
      >
        {m.episode_context_imported()}
      </Toggle>
      {isFiltered(params) ? (
        <Button variant="ghost" onClick={() => onChange(noFilters)}>
          {m.search_reset()}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One tag (ADR 039), the latest used first, and « Gérer les tags… » last;
 * hidden until a tag exists.
 */
function TagFilter({
  tag,
  onChange,
}: {
  tag: string | undefined;
  onChange: (tag: string | undefined) => void;
}) {
  const [managing, setManaging] = useState(false);
  const tags = useQuery(orpc.tags.list.queryOptions()).data?.tags ?? [];
  if (tags.length === 0 && tag === undefined) return null;
  // The URL may spell it another way (« idees »): the tag's own name shows.
  const chosen =
    tag === undefined
      ? undefined
      : (tags.find((option) => tagKey(option.name) === tagKey(tag))?.name ?? tag);
  return (
    <>
      <Menu>
        <MenuTrigger variant="ghost" className={chip(tag !== undefined)}>
          {chosen === undefined ? m.search_tag_any() : `# ${chosen}`}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel>{m.search_tag()}</MenuGroupLabel>
            <MenuRadioGroup
              value={chosen ?? ANY_TAG}
              onValueChange={(value) =>
                onChange(tags.find((option) => option.name === value)?.name)
              }
            >
              <MenuRadioItem value={ANY_TAG}>{m.search_tag_any()}</MenuRadioItem>
              {tags.map((option) => (
                <MenuRadioItem
                  key={option.id}
                  value={option.name}
                  detail={option.recordings === 0 ? undefined : option.recordings}
                >
                  {option.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => setManaging(true)}>{m.tags_manage()}</MenuItem>
        </MenuPopup>
      </Menu>
      <TagManager
        open={managing}
        onOpenChange={setManaging}
        onRenamed={(from, to) => {
          if (chosen !== undefined && tagKey(chosen) === tagKey(from)) onChange(to);
        }}
        onDeleted={(name) => {
          if (chosen !== undefined && tagKey(chosen) === tagKey(name)) onChange(undefined);
        }}
      />
    </>
  );
}

/**
 * « Pendant que j’étais dans… »: the apps something was said in, the latest
 * first; hidden until Sondine has noted one.
 */
function AppFilter({
  app,
  onChange,
}: {
  app: string | undefined;
  onChange: (app: string | undefined) => void;
}) {
  const apps = useQuery(orpc.search.foregroundApps.queryOptions()).data?.apps ?? [];
  const chosen = apps.find((option) => option.bundleId === app);
  if (apps.length === 0 && app === undefined) return null;
  return (
    <Menu>
      <MenuTrigger variant="ghost" className={chip(app !== undefined)}>
        {app === undefined ? (
          m.search_app_any()
        ) : (
          <>
            <AppIcon app={{ bundleId: app }} name={chosen?.name ?? app} />
            {m.search_app_in({ app: chosen?.name ?? app })}
          </>
        )}
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>{m.search_app()}</MenuGroupLabel>
          <MenuRadioGroup
            value={app ?? ALL}
            onValueChange={(value) =>
              onChange(apps.find((option) => option.bundleId === value)?.bundleId)
            }
          >
            <MenuRadioItem value={ALL}>{m.search_app_all()}</MenuRadioItem>
            {apps.map((option) => (
              <MenuRadioItem key={option.bundleId} value={option.bundleId} label={option.name}>
                <span className="flex items-center gap-xs">
                  <AppIcon app={{ bundleId: option.bundleId }} name={option.name} />
                  {option.name}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The search's pages, loaded as the list scrolls; nothing before a word. */
function useSearchResults(first: SearchInput | null) {
  return useInfiniteQuery(
    orpc.search.query.infiniteOptions({
      input: first === null ? skipToken : (offset: number) => ({ ...first, offset }),
      initialPageParam: 0,
      getNextPageParam: (page, pages) =>
        nextOffset(
          pages.reduce((count, loaded) => count + loaded.episodes.length, 0),
          page.total,
        ),
      placeholderData: keepPreviousData,
    }),
  );
}

function Results({
  params,
  first,
  results,
  onClearFilters,
}: {
  params: SearchScreenSearch;
  first: SearchInput | null;
  results: ReturnType<typeof useSearchResults>;
  onClearFilters: () => void;
}) {
  const today = dayOf(Date.now());
  if (first === null) {
    // Before a word: what the search does; with one letter: that it needs one more.
    const typed = params.q?.trim() ?? "";
    // « Importé » alone: the imported files, to find one or add one.
    if (typed === "" && params.contexts?.includes("imported") === true) return <ImportedList />;
    return (
      <p className="text-cte-text-muted">
        {typed === "" ? m.search_hint() : m.search_more_letters()}
      </p>
    );
  }
  if (results.data === undefined) {
    return results.isError ? (
      <p role="alert" className="text-error">
        {errorMessage(results.error)}
      </p>
    ) : null;
  }
  const [firstPage] = results.data.pages;
  const episodes = results.data.pages.flatMap((page) => page.episodes);
  const total = firstPage?.total ?? 0;
  const untranscribed = firstPage?.untranscribed ?? 0;
  const days = groupByDay(episodes);
  return (
    <section
      aria-label={m.search_results()}
      aria-busy={results.isFetching}
      className="-mt-xs flex flex-col gap-l"
    >
      {total === 0 ? (
        <NoMatch params={params} onClearFilters={onClearFilters} />
      ) : (
        // The count shows at the field's end; a screen reader hears it here.
        <p role="status" className="sr-only">
          {m.search_total({ count: total })}
        </p>
      )}
      {/* What the search cannot see yet, next to what it found. */}
      {untranscribed === 0 ? null : (
        <p className="flex items-center gap-xs text-body-s text-cte-text-muted">
          <InfoIcon aria-hidden className="shrink-0" />
          {m.search_untranscribed({ count: untranscribed })}
        </p>
      )}
      {days.map((day) => (
        <section key={day.day} aria-labelledby={`day-${day.day}`} className="flex flex-col gap-s">
          <h2 id={`day-${day.day}`} className="font-body font-medium text-body-m">
            {dayTitle(day.day, today)}
          </h2>
          <ul className="flex flex-col gap-m">
            {day.episodes.map((match) => (
              <EpisodeResult
                key={match.episode.id}
                match={match}
                q={first.text}
                filters={filtersOf(params)}
              />
            ))}
          </ul>
        </section>
      ))}
      {results.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          isPending={results.isFetchingNextPage}
          onClick={() => void results.fetchNextPage()}
        >
          {m.show_more()}
        </Button>
      ) : null}
    </section>
  );
}

/** No match: says so, and offers the search without filters when it finds something. */
function NoMatch({
  params,
  onClearFilters,
}: {
  params: SearchScreenSearch;
  onClearFilters: () => void;
}) {
  const filtered = isFiltered(params);
  const broad = searchInput({ q: params.q }, dayOf(Date.now()), 0);
  const unfiltered = useQuery(
    orpc.search.query.queryOptions({
      input: filtered && broad !== null ? { ...broad, limit: 1 } : skipToken,
    }),
  );
  const found = unfiltered.data?.total ?? 0;
  return (
    <div className="flex flex-col items-start gap-s">
      <p role="status">
        {(params.q?.trim() ?? "") === "" && params.tag !== undefined
          ? m.search_tag_none({ tag: params.tag })
          : m.search_no_match({ q: params.q?.trim() ?? "" })}
      </p>
      {filtered && found > 0 ? (
        <Button variant="secondary" onClick={onClearFilters}>
          {m.search_without_filters({ count: found })}
        </Button>
      ) : null}
    </div>
  );
}

type Filters = ReturnType<typeof filtersOf>;

function EpisodeResult({
  match,
  q,
  filters,
}: {
  match: SearchEpisode;
  q: string | undefined;
  filters: Filters;
}) {
  const { episode } = match;
  const kind = [
    sizeLabel(episode.size),
    contextLabel(episode),
    ...episode.tags.map((tag) => `# ${tag}`),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-col gap-xxs">
      <Link
        to="/episode/$id"
        params={{ id: String(episode.id) }}
        search={{ q, ...filters }}
        className="flex w-fit items-center gap-xs corner-xs focus-ring"
      >
        <span className="font-body font-medium tabular-nums">
          {timeRange(episode.startedAtMs, episode.endedAtMs)}
        </span>
        <span className="flex items-center gap-xxs text-cte-text-muted">
          <EpisodeAppIcon episode={episode} />
          {kind}
        </span>
        {match.hitCount > match.hits.length ? (
          <span className="text-body-xs text-cte-text-muted">
            {m.search_hit_count({ count: match.hitCount })}
          </span>
        ) : null}
        <ChevronRightIcon aria-hidden className="text-cte-text-muted" />
      </Link>
      {match.hits.length === 0 && episode.firstWords !== null ? (
        <p className="line-clamp-2 text-cte-text-muted">{episode.firstWords}</p>
      ) : null}
      <ul className="flex flex-col">
        {match.hits.map((hit) => (
          <HitRow
            key={hit.segmentId}
            hit={hit}
            episodeId={episode.id}
            selfOrdinal={match.selfOrdinal}
            q={q}
            filters={filters}
          />
        ))}
        {match.contextHits.map((hit) => (
          <li key={`context-${hit.itemId}`}>
            <Link
              to="/episode/$id"
              params={{ id: String(episode.id) }}
              search={{ q, ...filters }}
              className={cn(
                "grid grid-cols-[4.5rem_5rem_minmax(0,1fr)] items-baseline gap-s focus-ring",
                "corner-s px-xs py-xs",
                "control-hover:bg-neutral-3",
              )}
            >
              <span />
              <span className="truncate font-body font-medium text-body-xs">
                {m.search_context_hit()}
              </span>
              <span className="line-clamp-2">
                <Highlighted text={hit.text} highlights={hit.highlights} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Text with the ranges the search matched marked. */
function Highlighted({ text, highlights }: Pick<SearchHit, "text" | "highlights">) {
  return highlightParts(text, highlights).map((part, index) =>
    part.match ? (
      <mark key={index} className={cn("font-medium", matchClassName)}>
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

function HitRow({
  hit,
  episodeId,
  selfOrdinal,
  q,
  filters,
}: {
  hit: SearchHit;
  episodeId: number;
  selfOrdinal: number | null;
  q: string | undefined;
  filters: Filters;
}) {
  const voice = voiceOf(hit.speakerOrdinal, hit.self, selfOrdinal, hit.person, hit.recognized);
  return (
    <li>
      <Link
        to="/episode/$id"
        params={{ id: String(episodeId) }}
        search={{ q, t: hit.startMs, ...filters }}
        className={cn(
          "grid grid-cols-[4.5rem_5rem_minmax(0,1fr)] items-baseline gap-s focus-ring",
          // The hover fill reaches past the text, which lines up with the headings.
          "-mx-xs corner-s px-xs py-xs",
          "control-hover:bg-neutral-3",
        )}
      >
        <span className="font-data text-body-xs tabular-nums text-cte-text-muted">
          {clock(hit.startMs)}
        </span>
        <span
          title={isRecognized(voice) ? m.voice_recognized() : undefined}
          className="truncate font-body font-medium text-body-xs"
        >
          {voice.kind === "unknown" ? "" : voiceName(voice)}
        </span>
        <span>
          <Highlighted text={hit.text} highlights={hit.highlights} />
        </span>
      </Link>
    </li>
  );
}
