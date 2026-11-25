import type { BrowserState, BrowserStatus } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { dayClock } from "../../lib/labels";
import { olderVersion } from "../../lib/version";
import { m } from "../../paraglide/messages.js";
import { AppIcon } from "../shell/app-icon";

// « Navigateurs » (ADR 023): whether Sondine's browser extension may say
// which tab plays sound (off until the user turns it on and adds the
// extension), and the browsers installed here with their link: open or
// not, when the extension last spoke, and whether it is older than the one
// Sondine carries. What Sondine keeps of each site is a private zone
// (Confidentialité, ADR 029).

/** How often the browsers' links read again while Settings is open. */
const REFRESH_MS = 5_000;
/** An extension from 0.2.0 speaks at least every minute while linked; past this it is silent. */
const SILENT_AFTER_MS = 150_000;

/** What a browser's link is doing, in words, and whether that is good news. */
function linkState(browser: BrowserState, nowMs: number): { text: string; live: boolean } {
  const heard = browser.lastHeardAtMs;
  if (browser.links > 0) {
    const linked =
      browser.links > 1
        ? m.settings_browser_links({ count: browser.links })
        : m.settings_browser_linked();
    if (heard === null) return { text: linked, live: true };
    if (nowMs - heard <= SILENT_AFTER_MS) {
      return {
        text: m.settings_browser_heard({ state: linked, when: dayClock(heard, nowMs) }),
        live: true,
      };
    }
    return {
      text: m.settings_browser_silent({ state: linked, when: dayClock(heard, nowMs) }),
      live: false,
    };
  }
  return heard === null
    ? { text: m.settings_browser_unheard(), live: false }
    : { text: m.settings_browser_last_heard({ when: dayClock(heard, nowMs) }), live: false };
}

export function BrowserSection() {
  const queryClient = useQueryClient();
  const status = useQuery({ ...orpc.browser.status.queryOptions(), refetchInterval: REFRESH_MS });
  const store = {
    onSuccess: (next: BrowserStatus) =>
      queryClient.setQueryData(orpc.browser.status.queryKey(), next),
  };
  const setEnabled = useMutation(orpc.browser.setEnabled.mutationOptions(store));
  const show = useMutation(orpc.browser.showExtension.mutationOptions());
  const data = status.data;
  const error = setEnabled.error ?? show.error;
  return (
    <div className="flex max-w-[40rem] flex-col gap-m">
      <div className="flex flex-col gap-xs">
        <SwitchLabel>
          <Switch
            checked={data?.enabled ?? false}
            disabled={data === undefined || !data.available || setEnabled.isPending}
            onCheckedChange={(checked) => setEnabled.mutate({ enabled: checked })}
          />
          {m.settings_browser_switch()}
        </SwitchLabel>
        <p className="text-body-s text-cte-text-muted">
          {data !== undefined && !data.available
            ? m.settings_browser_unavailable()
            : m.settings_browser_detail()}
        </p>
      </div>

      {data === undefined ? (
        <p
          className={status.isError ? "text-body-s text-error" : "text-body-s text-cte-text-muted"}
        >
          {status.isError ? errorMessage(status.error) : m.loading()}
        </p>
      ) : !data.enabled ? null : (
        <>
          <div className="flex flex-col gap-xs">
            {data.browsers.length === 0 ? (
              <p className="text-body-s text-cte-text-muted">{m.settings_browser_none()}</p>
            ) : (
              <ul className="flex flex-col">
                {data.browsers.map((browser) => {
                  // As of the last read, which renders again every few seconds.
                  const state = linkState(browser, status.dataUpdatedAt);
                  const outdated =
                    browser.extension !== null &&
                    data.extension !== null &&
                    olderVersion(browser.extension, data.extension);
                  return (
                    <li key={browser.bundleId} className="flex flex-col gap-xxs py-xs">
                      <div className="flex items-center gap-s">
                        <AppIcon app={{ bundleId: browser.bundleId }} name={browser.name} />
                        <span className="min-w-0 flex-1 truncate">{browser.name}</span>
                        <span
                          className={
                            state.live
                              ? "text-body-xs text-success"
                              : "text-body-xs text-cte-text-muted"
                          }
                        >
                          {state.text}
                        </span>
                      </div>
                      {outdated && browser.extension !== null && data.extension !== null ? (
                        <p className="text-body-xs text-cte-text-muted">
                          {m.settings_browser_outdated({
                            version: browser.extension,
                            browser: browser.name,
                            current: data.extension,
                          })}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-body-s text-cte-text-muted">{m.settings_browser_steps()}</p>
            <p className="text-body-s text-cte-text-muted">{m.settings_browser_access()}</p>
            <Button
              variant="secondary"
              className="self-start"
              isPending={show.isPending}
              onClick={() => show.mutate({})}
            >
              {m.settings_browser_show()}
            </Button>
          </div>
        </>
      )}
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
    </div>
  );
}
