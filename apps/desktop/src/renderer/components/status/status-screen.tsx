import type {
  HelperConnection,
  HelperProcessState,
  ListeningStatus,
  Permissions,
  Status,
  Track,
} from "@sondine/api";
import { Badge, type BadgeProps } from "@sondine/ui/components/badge";
import { Button } from "@sondine/ui/components/button";
import { Meter, MeterLabel, MeterValue } from "@sondine/ui/components/meter";
import { MicrophoneIcon, PauseIcon, PlayIcon, ShieldIcon, VolumeIcon } from "@sondine/ui/icon";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { pauseEndLabel } from "../../../shared/timed-pause";
import { AnalysisSection } from "./analysis-section";
import { listeningView, type ListeningAction, type ListeningState } from "./listening-view";
import { Section } from "./section";

// Settings ▸ Avancé (ADR 037; the former Status screen): listening state with pause and resume,
// permissions with a grant action, open tracks with their levels from the
// helper's health windows, the transcription queue in detail, and the
// helper's connection. Status comes from the `status.watch` stream; actions
// are oRPC mutations.

type BadgeVariant = NonNullable<BadgeProps["variant"]>;
type PermissionStatus = Permissions["microphone"]["status"];

export function StatusPanel() {
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const connection = status.data?.helper.connection;

  useEffect(() => {
    // Development runs forward the renderer console to main's log.
    if (import.meta.env.DEV && connection !== undefined)
      console.info(`[renderer] status via oRPC: helper ${connection}`);
  }, [connection]);

  if (status.data === undefined) {
    return (
      <p className="text-cte-text-muted">
        {status.isError ? errorMessage(status.error) : m.core_connecting()}
      </p>
    );
  }
  const current = status.data;
  return (
    <div className="flex flex-col gap-xl">
      <ListeningSection listening={current.listening} spool={current.spool} />
      <PermissionsSection permissions={current.permissions} />
      <TracksSection tracks={current.tracks} />
      <AnalysisSection analysis={current.analysis} />
      <HelperSection status={current} />
    </div>
  );
}

const listeningText: Record<ListeningState, () => string> = {
  listening: () => m.listening_listening(),
  paused: () => m.listening_paused(),
  partial: () => m.listening_partial(),
  unknown: () => m.listening_unknown(),
  "pause-unconfirmed": () => m.listening_pause_unconfirmed(),
  held: () => m.listening_control_held(),
  "disk-full": () => m.sidebar_disk_full_detail(),
  "write-error": () => m.listening_write_error(),
};

const listeningBadge: Record<ListeningState, { variant: BadgeVariant; label: () => string }> = {
  listening: { variant: "success", label: () => m.tray_state_listening() },
  paused: { variant: "neutral", label: () => m.tray_state_paused() },
  partial: { variant: "warning", label: () => m.tray_state_partial() },
  unknown: { variant: "neutral", label: () => m.tray_state_connecting() },
  "pause-unconfirmed": { variant: "warning", label: () => m.tray_state_listening() },
  held: { variant: "neutral", label: () => m.listening_control_held() },
  "disk-full": { variant: "error", label: () => m.sidebar_disk_full() },
  "write-error": { variant: "error", label: () => m.tray_state_write_error() },
};

const actionLabel: Record<ListeningAction, () => string> = {
  pause: () => m.listening_pause(),
  "retry-pause": () => m.listening_retry_pause(),
  resume: () => m.listening_resume(),
  lift: () => m.tray_lift(),
};

function ListeningSection({
  listening,
  spool,
}: {
  listening: ListeningStatus;
  spool: Status["spool"];
}) {
  const pause = useMutation(orpc.listening.pause.mutationOptions());
  const resume = useMutation(orpc.listening.resume.mutationOptions());
  const lift = useMutation(orpc.privacy.lift.mutationOptions());
  const view = listeningView(listening, spool);
  const error = pause.error ?? resume.error ?? lift.error;
  const badge = listeningBadge[view.state];
  return (
    <Section title={m.listening_heading()}>
      <div className="flex flex-wrap items-center gap-m">
        <Badge variant={badge.variant}>
          {view.pausedUntilMs === null
            ? badge.label()
            : m.tray_state_paused_until({
                time: pauseEndLabel(view.pausedUntilMs, Date.now(), getLocale()),
              })}
        </Badge>
        <p className="flex-1">{listeningText[view.state]()}</p>
        {view.actions.map((action, index) => {
          const mutation = action === "resume" ? resume : action === "lift" ? lift : pause;
          const run = () => {
            if (action === "resume") resume.mutate({});
            else if (action === "lift")
              for (const hold of listening.holds.filter((h) => !h.lifted))
                lift.mutate({ occurrenceId: hold.occurrenceId });
            else pause.mutate({});
          };
          return (
            <Button
              key={action}
              // Resuming or retrying a pause is the main action; pausing stays quiet.
              variant={index === 0 && action !== "pause" ? "primary" : "secondary"}
              isPending={mutation.isPending}
              onClick={run}
            >
              {action === "resume" ? <PlayIcon /> : <PauseIcon />}
              {actionLabel[action]()}
            </Button>
          );
        })}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-error">
          {errorMessage(error)}
        </p>
      )}
    </Section>
  );
}

const permissionText: Record<PermissionStatus, () => string> = {
  unknown: () => m.permission_unknown(),
  "not-determined": () => m.permission_not_determined(),
  restricted: () => m.permission_restricted(),
  denied: () => m.permission_denied(),
  granted: () => m.permission_granted(),
  "granted-verified": () => m.permission_granted_verified(),
};

const permissionVariant: Record<PermissionStatus, BadgeVariant> = {
  unknown: "neutral",
  "not-determined": "warning",
  restricted: "error",
  denied: "error",
  granted: "success",
  "granted-verified": "success",
};

function PermissionsSection({ permissions }: { permissions: Status["permissions"] }) {
  return (
    <Section title={m.permissions_heading()}>
      {permissions === null ? (
        <p className="text-cte-text-muted">{m.permissions_waiting()}</p>
      ) : (
        <ul className="flex flex-col gap-s">
          <PermissionRow
            kind="microphone"
            icon={<MicrophoneIcon />}
            label={m.permission_microphone()}
            status={permissions.microphone.status}
          />
          <PermissionRow
            kind="systemAudio"
            icon={<VolumeIcon />}
            label={m.permission_system_audio()}
            status={permissions.systemAudio.status}
          />
        </ul>
      )}
    </Section>
  );
}

function PermissionRow(props: {
  kind: "microphone" | "systemAudio";
  icon: ReactNode;
  label: string;
  status: PermissionStatus;
}) {
  const request = useMutation(orpc.permissions.request.mutationOptions());
  const granted = props.status === "granted" || props.status === "granted-verified";
  return (
    <li className="flex flex-wrap items-center gap-m">
      <span className="flex items-center gap-xs text-cte-text-muted">{props.icon}</span>
      <span className="flex-1">{props.label}</span>
      <Badge variant={permissionVariant[props.status]}>{permissionText[props.status]()}</Badge>
      {granted ? null : (
        <Button
          variant="outline"
          isPending={request.isPending}
          onClick={() => request.mutate({ kind: props.kind })}
        >
          <ShieldIcon />
          {m.permission_grant()}
        </Button>
      )}
      {request.data?.outcome === "opened-settings" ? (
        <p className="w-full text-cte-text-muted">{m.permission_settings_opened()}</p>
      ) : null}
      {request.error === null ? null : (
        <p role="alert" className="w-full text-error">
          {errorMessage(request.error)}
        </p>
      )}
    </li>
  );
}

const streamText: Record<Track["stream"], () => string> = {
  starting: () => m.track_stream_starting(),
  running: () => m.track_stream_running(),
  stalled: () => m.track_stream_stalled(),
  "zero-suspect": () => m.track_stream_zero_suspect(),
};

const streamVariant: Record<Track["stream"], BadgeVariant> = {
  starting: "neutral",
  running: "success",
  stalled: "warning",
  "zero-suspect": "warning",
};

/** dBFS from -60 (silent room) to 0 (full scale), as a 0-100 meter value. */
export function levelPercent(level: number): number {
  return Math.round(Math.min(100, Math.max(0, ((level + 60) / 60) * 100)));
}

function TracksSection({ tracks }: { tracks: readonly Track[] }) {
  return (
    <Section title={m.tracks_heading()}>
      {tracks.length === 0 ? (
        <p className="text-cte-text-muted">{m.tracks_empty()}</p>
      ) : (
        <ul className="flex flex-col gap-m">
          {tracks.map((track) => {
            const name = track.name ?? m.track_system();
            const levelText =
              track.level === null
                ? m.track_level_none()
                : m.track_level({ level: track.level.toFixed(1) });
            return (
              <li key={track.runId} className="flex flex-col gap-xs">
                <div className="flex items-center gap-s">
                  <Badge variant={streamVariant[track.stream]}>{streamText[track.stream]()}</Badge>
                  <span className="truncate font-data text-body-xs text-cte-text-muted">
                    {track.trackKey}
                  </span>
                </div>
                <Meter
                  value={track.level === null ? 0 : levelPercent(track.level)}
                  disabled={track.level === null}
                >
                  <MeterLabel>{name}</MeterLabel>
                  <MeterValue>{() => levelText}</MeterValue>
                </Meter>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

const connectionBadge: Record<HelperConnection, { variant: BadgeVariant; label: () => string }> = {
  connecting: { variant: "neutral", label: () => m.helper_connection_connecting() },
  connected: { variant: "success", label: () => m.helper_connection_connected() },
  disconnected: { variant: "warning", label: () => m.helper_connection_disconnected() },
  incompatible: { variant: "error", label: () => m.helper_connection_incompatible() },
};

const processText: Record<HelperProcessState, () => string> = {
  unknown: () => m.helper_process_unknown(),
  starting: () => m.helper_process_starting(),
  running: () => m.helper_process_running(),
  restarting: () => m.helper_process_restarting(),
  "crash-loop": () => m.helper_process_crash_loop(),
  missing: () => m.helper_process_missing(),
  stopped: () => m.helper_process_stopped(),
};

function HelperSection({ status }: { status: Status }) {
  const helper = status.helper;
  const badge = connectionBadge[helper.connection];
  const time = new Intl.DateTimeFormat(getLocale(), { timeStyle: "medium" });
  const details = [
    processText[helper.process](),
    m.helper_restarts({ count: String(helper.restarts) }),
    helper.version === null ? null : m.helper_version({ version: helper.version }),
    status.lastHealth === null
      ? null
      : m.helper_last_health({ time: time.format(status.lastHealth.atMs) }),
  ].filter((detail) => detail !== null);
  return (
    <Section title={m.helper_heading()}>
      <div className="flex flex-wrap items-center gap-s">
        <Badge variant={badge.variant}>{badge.label()}</Badge>
        <span className="text-cte-text-muted">{details.join(" · ")}</span>
      </div>
      {helper.lastError === null ? null : (
        <p className="font-data text-body-xs text-cte-text-muted">
          {helper.lastError.code}: {helper.lastError.message}
        </p>
      )}
    </Section>
  );
}
