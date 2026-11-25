import type {
  PrivacyDurationResult,
  PrivacyStatus,
  PrivacyZone,
  RecordingType,
  ScheduleWindow,
  ZoneOutcome,
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
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@sondine/ui/components/collapsible";
import { Input } from "@sondine/ui/components/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import { Switch } from "@sondine/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@sondine/ui/components/toggle-group";
import {
  ChevronDownIcon,
  ClockIcon,
  GlobeIcon,
  LockIcon,
  MoonIcon,
  PhoneIcon,
  PlusIcon,
  VideoIcon,
  WifiIcon,
} from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { AppIcon } from "../shell/app-icon";

// Settings ▸ « Confidentialité » (ADR 029). By default Sondine keeps
// everything; each private zone takes something away; zones add up. One
// line for the default (audio by type, folded), then the zones: an icon, the
// situation and what it means, what the zone keeps (a menu), and a switch.
// « Ajouter une zone » adds an app, a site, the network the Mac is on, or
// hours. A duration change that would delete or expire something now says
// how much first.

const TYPES: readonly { type: RecordingType; label: () => string }[] = [
  { type: "calls", label: () => m.privacy_type_calls() },
  { type: "conversations", label: () => m.privacy_type_conversations() },
  { type: "moments", label: () => m.privacy_type_moments() },
  { type: "traces", label: () => m.privacy_type_traces() },
  { type: "media", label: () => m.privacy_type_media() },
  { type: "dictations", label: () => m.privacy_type_dictations() },
];

const AUDIO_DAYS: readonly number[] = [1, 7, 30, 90, 365];
const DELETE_DAYS: readonly (number | null)[] = [null, 1, 7, 30, 365];

const OUTCOMES: readonly { outcome: ZoneOutcome; label: () => string }[] = [
  { outcome: "nothing", label: () => m.privacy_outcome_nothing() },
  { outcome: "text_only", label: () => m.privacy_outcome_text_only() },
  { outcome: "audio_only", label: () => m.privacy_outcome_audio_only() },
  { outcome: "delete_week", label: () => m.privacy_outcome_delete_week() },
  { outcome: "delete_day", label: () => m.privacy_outcome_delete_day() },
];

const outcomeLabel = (outcome: ZoneOutcome) =>
  OUTCOMES.find((choice) => choice.outcome === outcome)?.label() ?? outcome;

function daysLabel(days: number | null): string {
  if (days === null) return m.privacy_never();
  if (days === 365) return m.privacy_year();
  return m.privacy_days({ count: days });
}

/** Monday first, in the app's language: « L M M J V S D ». */
function weekdays(): { day: number; short: string; long: string }[] {
  const narrow = new Intl.DateTimeFormat(getLocale(), { weekday: "narrow" });
  const long = new Intl.DateTimeFormat(getLocale(), { weekday: "long" });
  // 2026-11-09 is a Monday.
  return [1, 2, 3, 4, 5, 6, 0].map((day) => {
    const date = new Date(2026, 10, 9 + ((day + 6) % 7));
    return { day, short: narrow.format(date), long: long.format(date) };
  });
}

const minuteText = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

const textMinute = (text: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (match === null) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute < 1440 ? minute : null;
};

/** « Tous les jours, 23:00 – 07:00 ». */
function hoursLabel(windows: readonly ScheduleWindow[]): string {
  return windows
    .map((window) => {
      const days = [...window.days].toSorted();
      const which =
        days.length === 7
          ? m.privacy_every_day()
          : days.join() === "1,2,3,4,5"
            ? m.privacy_weekdays()
            : days.join() === "0,6"
              ? m.privacy_weekend()
              : weekdays()
                  .filter((entry) => days.includes(entry.day))
                  .map((entry) => entry.long)
                  .join(", ");
      return `${which}, ${minuteText(window.startMinute)} – ${minuteText(window.endMinute)}`;
    })
    .join(" · ");
}

/** A zone as an episode or Settings shows it. */
export type ZoneLike = Pick<PrivacyZone, "id" | "outcome" | "situation">;

export function zoneTitle(zone: ZoneLike): string {
  const situation = zone.situation;
  switch (situation.kind) {
    case "app":
      return situation.name;
    case "site":
      return situation.site;
    case "media_sites":
      return m.privacy_media_sites();
    case "network":
      return situation.name;
    case "hours":
      return zone.id === "night" ? m.privacy_night() : situation.name;
    case "calls":
      return m.privacy_calls();
    case "screen":
      return m.privacy_screen();
  }
}

/** What the outcome does here: held at capture where it can be, else deleted at the end. */
export function outcomeDetail(zone: ZoneLike): string {
  switch (zone.outcome) {
    case "nothing":
      return zone.situation.kind === "site" || zone.situation.kind === "media_sites"
        ? m.privacy_detail_dropped()
        : m.privacy_detail_not_recorded();
    case "text_only":
      return m.privacy_detail_text_only();
    case "audio_only":
      return m.privacy_detail_audio_only();
    case "delete_week":
      return m.privacy_detail_delete_week();
    case "delete_day":
      return m.privacy_detail_delete_day();
  }
}

function situationDetail(zone: PrivacyZone, browserLink: boolean): ReactNode {
  const situation = zone.situation;
  switch (situation.kind) {
    case "app":
      return m.privacy_app_detail();
    case "site":
      return browserLink ? null : m.privacy_site_needs_link();
    case "media_sites": {
      const leftOut = situation.sites.filter((site) => !site.kept);
      if (leftOut.length === 0) return m.privacy_all_kept();
      const names = leftOut.slice(0, 2).map((site) => site.site.split(".")[0] ?? site.site);
      const shown = names.map((name) => name.charAt(0).toUpperCase() + name.slice(1)).join(", ");
      return leftOut.length > 2
        ? m.privacy_and_others({ names: shown, count: leftOut.length - 2 })
        : shown;
    }
    case "network":
      return situation.here ? (
        <>
          {m.privacy_network_detail()} ·{" "}
          <span className="text-success">{m.privacy_network_here()}</span>
        </>
      ) : (
        m.privacy_network_detail()
      );
    case "hours":
      return hoursLabel(situation.windows);
    case "calls":
      return m.privacy_calls_detail();
    case "screen":
      return m.privacy_screen_detail();
  }
}

function ZoneIcon({ zone }: { zone: PrivacyZone }) {
  const situation = zone.situation;
  const box = "flex size-l shrink-0 items-center justify-center text-body-m text-cte-text-muted";
  switch (situation.kind) {
    case "app":
      return <AppIcon app={{ bundleId: situation.bundleId }} name={situation.name} />;
    case "site":
      return <GlobeIcon className={box} />;
    case "media_sites":
      return <VideoIcon className={box} />;
    case "network":
      return <WifiIcon className={box} />;
    case "hours":
      return zone.id === "night" ? <MoonIcon className={box} /> : <ClockIcon className={box} />;
    case "calls":
      return <PhoneIcon className={box} />;
    case "screen":
      return <LockIcon className={box} />;
  }
}

type Editing =
  | { readonly kind: "site" }
  | { readonly kind: "network" }
  | { readonly kind: "hours"; readonly zoneId: string | null }
  | { readonly kind: "rename"; readonly zoneId: string }
  | null;

export function PrivacySection() {
  const queryClient = useQueryClient();
  const status = useQuery(orpc.privacy.status.queryOptions());
  const store = {
    onSuccess: (next: PrivacyStatus) =>
      queryClient.setQueryData(orpc.privacy.status.queryKey(), next),
  };
  const addZone = useMutation(orpc.privacy.addZone.mutationOptions(store));
  const updateZone = useMutation(orpc.privacy.updateZone.mutationOptions(store));
  const removeZone = useMutation(orpc.privacy.removeZone.mutationOptions(store));
  const setMediaSite = useMutation(orpc.privacy.setMediaSite.mutationOptions(store));
  const [confirming, setConfirming] = useState<{
    readonly input: {
      type: RecordingType;
      audioDays?: number | undefined;
      deleteDays?: number | null | undefined;
    };
    readonly result: PrivacyDurationResult;
  } | null>(null);
  const setDuration = useMutation(
    orpc.privacy.setDuration.mutationOptions({
      onSuccess: (result, input) => {
        queryClient.setQueryData(orpc.privacy.status.queryKey(), result.status);
        if (!result.applied) {
          const { confirm: _confirm, ...rest } = input;
          setConfirming({ input: rest, result });
        } else {
          setConfirming(null);
          void queryClient.invalidateQueries({ queryKey: orpc.episodes.key() });
        }
      },
    }),
  );
  const [editing, setEditing] = useState<Editing>(null);
  const data = status.data;
  const error =
    addZone.error ??
    updateZone.error ??
    removeZone.error ??
    setMediaSite.error ??
    setDuration.error;

  if (data === undefined) {
    return (
      <p className={status.isError ? "text-body-s text-error" : "text-body-s text-cte-text-muted"}>
        {status.isError ? errorMessage(status.error) : m.loading()}
      </p>
    );
  }

  const audio = Object.values(data.durations.audioDays);
  const min = Math.min(...audio);
  const max = Math.max(...audio);
  const pickApp = async () => {
    const picked = await window.sondine?.pickApp();
    if (picked === null || picked === undefined) return;
    addZone.mutate({ kind: "app", bundleId: picked.bundleId, name: picked.name });
  };

  return (
    <div className="flex max-w-[40rem] flex-col gap-m">
      <p className="text-body-s text-cte-text-muted">{m.settings_privacy_intro()}</p>

      <Collapsible>
        <div className="flex flex-col gap-xxs">
          <h3 className="font-body font-medium">{m.settings_privacy_default()}</h3>
          <CollapsibleTrigger className="py-zero text-cte-text-muted">
            {min === max
              ? m.settings_privacy_default_same({ days: min })
              : m.settings_privacy_default_range({ min, max })}
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-s gap-y-xs">
            <span />
            <span className="text-body-xs text-cte-text-muted">{m.settings_privacy_audio()}</span>
            <span className="text-body-xs text-cte-text-muted">
              {m.settings_privacy_delete_after()}
            </span>
            {TYPES.map(({ type, label }) => (
              <TypeRow
                key={type}
                label={label()}
                audioDays={data.durations.audioDays[type] ?? 30}
                deleteDays={data.durations.deleteDays[type] ?? null}
                pending={setDuration.isPending}
                onAudio={(days) => setDuration.mutate({ type, audioDays: days, confirm: false })}
                onDelete={(days) => setDuration.mutate({ type, deleteDays: days, confirm: false })}
              />
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>

      <div className="flex flex-col gap-xxs">
        <h3 className="font-body font-medium">{m.settings_privacy_zones()}</h3>
        <ul className="flex flex-col">
          {data.zones.map((zone) => (
            <ZoneRow
              key={zone.id}
              zone={zone}
              browserLink={data.browserLink}
              pending={updateZone.isPending || removeZone.isPending}
              onOutcome={(outcome) => updateZone.mutate({ id: zone.id, outcome })}
              onSwitch={(on) => updateZone.mutate({ id: zone.id, on })}
              onRemove={() => removeZone.mutate({ id: zone.id })}
              onEditHours={() => setEditing({ kind: "hours", zoneId: zone.id })}
              onRename={() => setEditing({ kind: "rename", zoneId: zone.id })}
              onMediaSite={(site, kept) => setMediaSite.mutate({ site, kept })}
            />
          ))}
        </ul>

        {editing === null ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="secondary"
                  className="mt-xs self-start"
                  isPending={addZone.isPending}
                />
              }
            >
              <PlusIcon />
              {m.privacy_add()}
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuSubmenu>
                <MenuSubmenuTrigger>{m.privacy_add_app()}</MenuSubmenuTrigger>
                <MenuSubmenuPopup>
                  {data.appsHeard.slice(0, 12).map((app) => (
                    <MenuItem
                      key={app.bundleId}
                      onClick={() => addZone.mutate({ kind: "app", bundleId: app.bundleId })}
                    >
                      {app.name}
                    </MenuItem>
                  ))}
                  {data.appsHeard.length === 0 ? null : <MenuSeparator />}
                  <MenuItem onClick={() => void pickApp()}>{m.privacy_add_other_app()}</MenuItem>
                </MenuSubmenuPopup>
              </MenuSubmenu>
              <MenuItem onClick={() => setEditing({ kind: "site" })}>
                {m.privacy_add_site()}
              </MenuItem>
              {data.networkHere ? (
                <MenuItem onClick={() => setEditing({ kind: "network" })}>
                  <span className="flex flex-col">
                    <span>{m.privacy_add_network()}</span>
                    <span className="text-body-xs text-cte-text-muted">
                      {m.privacy_add_network_hint()}
                    </span>
                  </span>
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => setEditing({ kind: "hours", zoneId: null })}>
                {m.privacy_add_hours()}
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : editing.kind === "site" ? (
          <NameForm
            label={m.privacy_site_label()}
            placeholder={m.privacy_site_placeholder()}
            maxLength={2048}
            pending={addZone.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(site) =>
              addZone.mutate({ kind: "site", site }, { onSuccess: () => setEditing(null) })
            }
          />
        ) : editing.kind === "network" ? (
          <NameForm
            label={m.privacy_name_label()}
            placeholder={m.privacy_network_placeholder()}
            maxLength={80}
            pending={addZone.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(name) =>
              addZone.mutate({ kind: "network", name }, { onSuccess: () => setEditing(null) })
            }
          />
        ) : editing.kind === "rename" ? (
          <NameForm
            label={m.privacy_name_label()}
            placeholder={m.privacy_network_placeholder()}
            maxLength={80}
            initial={zoneTitleById(data, editing.zoneId)}
            pending={updateZone.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(name) =>
              updateZone.mutate({ id: editing.zoneId, name }, { onSuccess: () => setEditing(null) })
            }
          />
        ) : (
          <HoursForm
            zone={
              editing.zoneId === null
                ? null
                : (data.zones.find((zone) => zone.id === editing.zoneId) ?? null)
            }
            pending={addZone.isPending || updateZone.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(name, windows) =>
              editing.zoneId === null
                ? addZone.mutate(
                    { kind: "hours", name, windows },
                    { onSuccess: () => setEditing(null) },
                  )
                : updateZone.mutate(
                    {
                      id: editing.zoneId,
                      windows,
                      ...(editing.zoneId === "night" ? {} : { name }),
                    },
                    { onSuccess: () => setEditing(null) },
                  )
            }
          />
        )}
      </div>

      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => open || setConfirming(null)}>
        <AlertDialogPopup>
          <AlertDialogTitle>{m.privacy_confirm_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {[
              confirming !== null && confirming.result.deletes > 0
                ? m.privacy_confirm_deletes({ count: confirming.result.deletes })
                : null,
              confirming !== null && confirming.result.silences > 0
                ? m.privacy_confirm_silences({ count: confirming.result.silences })
                : null,
            ]
              .filter((line) => line !== null)
              .join(" ")}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose>{m.privacy_cancel()}</AlertDialogClose>
            <Button
              variant="danger"
              isPending={setDuration.isPending}
              onClick={() =>
                confirming !== null && setDuration.mutate({ ...confirming.input, confirm: true })
              }
            >
              {m.privacy_confirm_apply()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function zoneTitleById(data: PrivacyStatus, id: string): string {
  const zone = data.zones.find((candidate) => candidate.id === id);
  return zone === undefined ? "" : zoneTitle(zone);
}

function TypeRow({
  label,
  audioDays,
  deleteDays,
  pending,
  onAudio,
  onDelete,
}: {
  label: string;
  audioDays: number;
  deleteDays: number | null;
  pending: boolean;
  onAudio: (days: number) => void;
  onDelete: (days: number | null) => void;
}) {
  return (
    <>
      <span>{label}</span>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              disabled={pending}
              aria-label={m.privacy_type_audio_label({ type: label })}
            />
          }
        >
          {daysLabel(audioDays)}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup
            value={String(audioDays)}
            onValueChange={(value) => onAudio(Number(value))}
          >
            {AUDIO_DAYS.map((days) => (
              <MenuRadioItem key={days} value={String(days)}>
                {daysLabel(days)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              disabled={pending}
              aria-label={m.privacy_type_delete_label({ type: label })}
            />
          }
        >
          <span className={deleteDays === null ? "text-cte-text-muted" : undefined}>
            {daysLabel(deleteDays)}
          </span>
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup
            value={deleteDays === null ? "never" : String(deleteDays)}
            onValueChange={(value) => onDelete(value === "never" ? null : Number(value))}
          >
            {DELETE_DAYS.map((days) => (
              <MenuRadioItem key={String(days)} value={days === null ? "never" : String(days)}>
                {daysLabel(days)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </>
  );
}

function ZoneRow({
  zone,
  browserLink,
  pending,
  onOutcome,
  onSwitch,
  onRemove,
  onEditHours,
  onRename,
  onMediaSite,
}: {
  zone: PrivacyZone;
  browserLink: boolean;
  pending: boolean;
  onOutcome: (outcome: ZoneOutcome) => void;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
  onEditHours: () => void;
  onRename: () => void;
  onMediaSite: (site: string, kept: boolean) => void;
}) {
  const title = zoneTitle(zone);
  const situation = situationDetail(zone, browserLink);
  const detail = (
    <span className="text-body-xs text-cte-text-muted">
      {situation}
      {situation === null ? null : " · "}
      {outcomeDetail(zone)}
    </span>
  );
  const sites = zone.situation.kind === "media_sites" ? zone.situation.sites : null;
  return (
    <li className="flex flex-col gap-xs py-xs">
      {/* At the top, so the icon, menu and switch stay by the title when the sites unfold. */}
      <div className="flex items-start gap-s">
        <ZoneIcon zone={zone} />
        {sites === null ? (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{title}</span>
            {detail}
          </span>
        ) : (
          <Collapsible className="min-w-0 flex-1">
            <CollapsibleTrigger className="py-zero font-regular">
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{title}</span>
                {detail}
              </span>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <ul className="flex flex-col">
                {sites.map((site) => (
                  <li key={site.site} className="flex items-center gap-s py-xxs">
                    <span className="min-w-0 flex-1 truncate">{site.site}</span>
                    <Switch
                      aria-label={m.privacy_media_site_in_zone({ site: site.site })}
                      checked={!site.kept}
                      onCheckedChange={(leftOut) => onMediaSite(site.site, !leftOut)}
                    />
                  </li>
                ))}
              </ul>
            </CollapsiblePanel>
          </Collapsible>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                disabled={pending || !zone.on}
                aria-label={m.privacy_zone_outcome({ name: title })}
              />
            }
          >
            {outcomeLabel(zone.outcome)}
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuRadioGroup
              value={zone.outcome}
              onValueChange={(value) => {
                const outcome = OUTCOMES.find((choice) => choice.outcome === value)?.outcome;
                if (outcome !== undefined) onOutcome(outcome);
              }}
            >
              {OUTCOMES.map((choice) => (
                <MenuRadioItem key={choice.outcome} value={choice.outcome}>
                  {choice.label()}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {zone.situation.kind === "hours" ||
            zone.situation.kind === "network" ||
            !zone.builtin ? (
              <MenuSeparator />
            ) : null}
            {zone.situation.kind === "hours" ? (
              <MenuItem onClick={onEditHours}>{m.privacy_zone_edit_hours()}</MenuItem>
            ) : null}
            {zone.situation.kind === "network" ? (
              <MenuItem onClick={onRename}>{m.privacy_zone_rename()}</MenuItem>
            ) : null}
            {zone.builtin ? null : (
              <MenuItem onClick={onRemove}>{m.privacy_zone_remove()}</MenuItem>
            )}
          </MenuPopup>
        </Menu>
        <Switch
          aria-label={m.privacy_zone_switch({ name: title })}
          checked={zone.on}
          disabled={pending}
          onCheckedChange={onSwitch}
        />
      </div>
    </li>
  );
}

function NameForm({
  label,
  placeholder,
  maxLength,
  initial = "",
  pending,
  onCancel,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  maxLength: number;
  initial?: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() !== "") onSubmit(value.trim());
  };
  return (
    <form onSubmit={submit} className="mt-xs flex items-center gap-xs">
      <Input
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        value={value}
        onValueChange={(next) => setValue(next)}
        className="max-w-[20rem]"
      />
      <Button type="submit" variant="secondary" isPending={pending}>
        {m.privacy_save()}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        {m.privacy_cancel()}
      </Button>
    </form>
  );
}

function HoursForm({
  zone,
  pending,
  onCancel,
  onSubmit,
}: {
  zone: PrivacyZone | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string, windows: ScheduleWindow[]) => void;
}) {
  const current = zone?.situation.kind === "hours" ? zone.situation : null;
  const first = current?.windows[0];
  const [name, setName] = useState(current?.name ?? "");
  const [days, setDays] = useState<string[]>((first?.days ?? [1, 2, 3, 4, 5]).map(String));
  const [from, setFrom] = useState(minuteText(first?.startMinute ?? 19 * 60));
  const [to, setTo] = useState(minuteText(first?.endMinute ?? 23 * 60));
  const named = zone?.id === "night" || name.trim() !== "";
  const start = textMinute(from);
  const end = textMinute(to);
  const valid = named && days.length > 0 && start !== null && end !== null && start !== end;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || start === null || end === null) return;
    onSubmit(name.trim() === "" ? (current?.name ?? "") : name.trim(), [
      { days: days.map(Number), startMinute: start, endMinute: end === 0 ? 1440 : end },
    ]);
  };
  return (
    <form onSubmit={submit} className="mt-xs flex flex-col gap-xs corner-s bg-neutral-2 p-s">
      {zone?.id === "night" ? null : (
        <Input
          autoFocus
          aria-label={m.privacy_name_label()}
          placeholder={m.privacy_hours_placeholder()}
          maxLength={80}
          value={name}
          onValueChange={(next) => setName(next)}
          className="max-w-[20rem]"
        />
      )}
      <ToggleGroup<string> multiple value={days} onValueChange={(next) => setDays(next)}>
        {weekdays().map((entry) => (
          <ToggleGroupItem<string>
            key={entry.day}
            value={String(entry.day)}
            aria-label={entry.long}
          >
            {entry.short}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex items-center gap-xs">
        <span className="text-body-s text-cte-text-muted">{m.privacy_hours_from()}</span>
        <Input
          type="time"
          aria-label={m.privacy_hours_from()}
          value={from}
          onValueChange={(next) => setFrom(next)}
          className="w-[8rem]"
        />
        <span className="text-body-s text-cte-text-muted">{m.privacy_hours_to()}</span>
        <Input
          type="time"
          aria-label={m.privacy_hours_to()}
          value={to}
          onValueChange={(next) => setTo(next)}
          className="w-[8rem]"
        />
      </div>
      <div className="flex items-center gap-xs">
        <Button type="submit" variant="secondary" disabled={!valid} isPending={pending}>
          {m.privacy_save()}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {m.privacy_cancel()}
        </Button>
      </div>
    </form>
  );
}
