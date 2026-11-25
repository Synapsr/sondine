import type { AudibleTab } from "@sondine/protocol";
import { cut } from "./cut.ts";
import type { Tab, TabChange } from "./extension-api.ts";
import {
  BROWSER_LINE_MAX,
  BROWSER_TABS_MAX,
  BROWSER_TITLE_MAX,
  BROWSER_URL_MAX,
  PAGE_URL,
  TAB_ID_MAX,
} from "./limits.ts";

/**
 * Most bytes of JSON one `tabs` message takes, as `JSON.stringify` counts
 * them: a quarter under the socket's line limit, because the browser's own
 * JSON writer may escape more characters (Chrome writes `<` as `<`).
 */
export const TABS_MESSAGE_BUDGET = (BROWSER_LINE_MAX * 3) / 4;

const encoder = new TextEncoder();

/**
 * The tabs that play sound, as the protocol lists them: heard (audible and
 * not muted), outside private windows, on an http or https page, with the
 * address and title cut to the protocol's limits. Sorted by tab id, so the
 * same tabs always give the same list.
 */
export function audibleTabs(tabs: readonly Tab[]): AudibleTab[] {
  const found = new Map<number, AudibleTab>();
  for (const tab of tabs) {
    const entry = audibleTab(tab);
    if (entry !== null && !found.has(entry.tab)) found.set(entry.tab, entry);
  }
  return fitTabs([...found.values()]);
}

/**
 * A list of audible tabs as one `tabs` message carries it: sorted by tab id,
 * at most `BROWSER_TABS_MAX`, within the message's byte budget.
 */
export function fitTabs(tabs: readonly AudibleTab[]): AudibleTab[] {
  const list = tabs.toSorted((a, b) => a.tab - b.tab).slice(0, BROWSER_TABS_MAX);
  while (list.length > 0 && messageBytes(list) > TABS_MESSAGE_BUDGET) list.pop();
  return list;
}

function audibleTab(tab: Tab): AudibleTab | null {
  if (tab.audible !== true || tab.incognito === true || tab.mutedInfo?.muted === true) return null;
  const { id } = tab;
  if (id === undefined || !Number.isInteger(id) || id < 0 || id > TAB_ID_MAX) return null;
  if (tab.url === undefined) return null;
  const url = cut(tab.url, BROWSER_URL_MAX);
  if (!PAGE_URL.test(url)) return null;
  return { tab: id, url, title: cut(tab.title ?? "", BROWSER_TITLE_MAX) };
}

function messageBytes(tabs: readonly AudibleTab[]): number {
  return encoder.encode(JSON.stringify({ type: "tabs", at: Number.MAX_SAFE_INTEGER, tabs })).length;
}

export function sameTabs(a: readonly AudibleTab[], b: readonly AudibleTab[]): boolean {
  return (
    a.length === b.length &&
    a.every((tab, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        tab.tab === other.tab &&
        tab.url === other.url &&
        tab.title === other.title
      );
    })
  );
}

/**
 * Whether a `tabs.onUpdated` change may change the audible list: a tab
 * starts or stops sound, is muted or discarded, or one that plays (or was
 * listed) changes address or title. Title changes of silent tabs, which some
 * pages make every second, need no new query.
 */
export function tabChangeMatters(
  change: TabChange,
  tab: Tab | undefined,
  listed: boolean,
): boolean {
  if (
    change.audible !== undefined ||
    change.mutedInfo !== undefined ||
    change.discarded !== undefined
  ) {
    return true;
  }
  if (change.url === undefined && change.title === undefined) return false;
  return listed || tab?.audible === true;
}
