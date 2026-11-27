import type {
  BackupExportResult,
  BackupInspectResult,
  BackupOperation,
  BackupRestoreResult,
  BackupSummaryView,
} from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { Checkbox, CheckboxLabel } from "@sondine/ui/components/checkbox";
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
import { Progress } from "@sondine/ui/components/progress";
import { Radio, RadioGroup, RadioLabel } from "@sondine/ui/components/radio-group";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { useLocale } from "../../i18n/locale";
import { formatBytes } from "../../lib/bytes";
import { m } from "../../paraglide/messages.js";
import { generatePassphrase, readRendererPrefs } from "./backup-prefs";

// The backup's two dialogs (ADR 048). « Exporter une sauvegarde »: with the
// audio or not, with a passphrase (the default) or, chosen explicitly,
// without one; then a save panel, and the progress with « Annuler ».
// « Restaurer une sauvegarde »: an open panel, the passphrase if it has one,
// what it holds, then « Remplacer » (in Settings, after saying what is kept
// aside) and the progress; Sondine relaunches on it.

const MIN_PASSPHRASE = 12;
const popupClassName = "w-[min(32rem,calc(100vw-var(--space-xl)))]";

export function useBackupStatus() {
  return useQuery(orpc.backup.watch.experimental_liveOptions({ retry: true }));
}

function percentOf(operation: BackupOperation): number | null {
  if (operation.kind === "idle" || operation.totalBytes === 0) return null;
  return Math.min(100, Math.round((operation.doneBytes / operation.totalBytes) * 100));
}

function OperationProgress({ operation, label }: { operation: BackupOperation; label: string }) {
  return <Progress aria-label={label} value={percentOf(operation)} />;
}

function exportProblem(result: BackupExportResult, locale: string): string | null {
  switch (result.outcome) {
    case "saved":
    case "cancelled":
      return null;
    case "stale":
      return m.backup_export_stale();
    case "no-space":
      return m.backup_no_space({
        needed: formatBytes(result.neededBytes ?? 0, locale),
        free: formatBytes(result.freeBytes ?? 0, locale),
      });
    case "busy":
      return m.backup_busy();
    case "failed":
      return m.backup_export_failed();
  }
}

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className={popupClassName}>
        {open ? <ExportForm onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function ExportForm({ onClose }: { onClose: () => void }) {
  const { locale } = useLocale();
  const status = useBackupStatus();
  const [includeAudio, setIncludeAudio] = useState(true);
  const [protection, setProtection] = useState<"passphrase" | "none">("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [shown, setShown] = useState(false);
  const run = useMutation(orpc.backup.export.mutationOptions());
  const cancel = useMutation(orpc.backup.cancel.mutationOptions());
  const estimate = status.data?.estimate;
  const operation = status.data?.operation ?? { kind: "idle" };
  const exporting = run.isPending || operation.kind === "exporting";

  const tooShort = protection === "passphrase" && passphrase.length < MIN_PASSPHRASE;
  const mismatch = protection === "passphrase" && !shown && passphrase !== confirmation;
  const ready = !tooShort && !mismatch;

  if (run.data?.outcome === "saved") {
    return (
      <>
        <DialogTitle>{m.backup_export_saved_title()}</DialogTitle>
        <DialogDescription>
          {m.backup_export_saved({ size: formatBytes(run.data.bytes ?? 0, locale) })}
        </DialogDescription>
        {protection === "passphrase" ? (
          <p className="text-body-s text-cte-text-muted">{m.backup_export_keep_passphrase()}</p>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose}>{m.backup_done()}</Button>
        </DialogFooter>
      </>
    );
  }

  const problem = run.data === undefined ? null : exportProblem(run.data, locale);
  return (
    <>
      <DialogTitle>{m.backup_export_title()}</DialogTitle>
      <DialogDescription>{m.backup_export_what()}</DialogDescription>
      {exporting ? (
        <div className="flex flex-col gap-s">
          <OperationProgress operation={operation} label={m.backup_export_progress()} />
          <p className="text-body-s text-cte-text-muted">{m.backup_export_progress_detail()}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-l">
          <CheckboxLabel className="items-start">
            <Checkbox
              className="mt-xxs"
              checked={includeAudio}
              onCheckedChange={(checked) => setIncludeAudio(checked)}
            />
            <span className="flex flex-col">
              <span>
                {estimate === undefined
                  ? m.backup_include_audio()
                  : m.backup_include_audio_size({ size: formatBytes(estimate.audioBytes, locale) })}
              </span>
              <span className="text-body-s text-cte-text-muted">
                {m.backup_include_audio_detail()}
              </span>
            </span>
          </CheckboxLabel>
          <RadioGroup<"passphrase" | "none">
            aria-label={m.backup_protection()}
            value={protection}
            onValueChange={(next) => setProtection(next)}
          >
            <RadioLabel className="items-start">
              <Radio value="passphrase" className="mt-xxs" />
              <span className="flex flex-col">
                <span>{m.backup_with_passphrase()}</span>
                <span className="text-body-s text-cte-text-muted">
                  {m.backup_with_passphrase_detail()}
                </span>
              </span>
            </RadioLabel>
            <RadioLabel className="items-start">
              <Radio value="none" className="mt-xxs" />
              <span className="flex flex-col">
                <span>{m.backup_without_passphrase()}</span>
                <span className="text-body-s text-cte-text-muted">
                  {m.backup_without_passphrase_detail()}
                </span>
              </span>
            </RadioLabel>
          </RadioGroup>
          {protection === "none" ? (
            <p role="note" className="corner-s bg-neutral-2 p-s text-body-s text-warning">
              {m.backup_without_passphrase_warning()}
            </p>
          ) : (
            <div className="flex flex-col gap-s">
              <Field className="items-stretch">
                <FieldLabel>{m.backup_passphrase()}</FieldLabel>
                <Input
                  type={shown ? "text" : "password"}
                  value={passphrase}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </Field>
              {shown ? null : (
                <Field className="items-stretch">
                  <FieldLabel>{m.backup_passphrase_again()}</FieldLabel>
                  <Input
                    type="password"
                    value={confirmation}
                    autoComplete="new-password"
                    spellCheck={false}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </Field>
              )}
              <div className="flex items-center gap-s">
                <Button
                  variant="secondary"
                  onClick={() => {
                    const generated = generatePassphrase();
                    setPassphrase(generated);
                    setConfirmation(generated);
                    setShown(true);
                  }}
                >
                  {m.backup_generate()}
                </Button>
                <span className="text-body-s text-cte-text-muted">
                  {passphrase.length > 0 && tooShort
                    ? m.backup_passphrase_short({ count: String(MIN_PASSPHRASE) })
                    : passphrase.length > 0 && mismatch && confirmation.length > 0
                      ? m.backup_passphrase_mismatch()
                      : m.backup_passphrase_lost()}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {problem}
        </p>
      )}
      {run.error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(run.error)}
        </p>
      )}
      <DialogFooter>
        {exporting ? (
          <Button variant="secondary" onClick={() => cancel.mutate({})}>
            {m.cancel()}
          </Button>
        ) : (
          <>
            <DialogClose>{m.cancel()}</DialogClose>
            <Button
              disabled={!ready}
              onClick={() =>
                run.mutate({
                  includeAudio,
                  passphrase: protection === "none" ? null : passphrase,
                  prefs: readRendererPrefs(),
                })
              }
            >
              {m.backup_export_choose()}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function refusalMessage(outcome: BackupInspectResult["outcome"] | BackupRestoreResult["outcome"]) {
  switch (outcome) {
    case "wrong-passphrase":
      return m.backup_wrong_passphrase();
    case "not-a-backup":
      return m.backup_not_a_backup();
    case "damaged":
      return m.backup_damaged();
    case "newer":
    case "unsupported":
      return m.backup_newer();
    case "busy":
      return m.backup_busy();
    case "failed":
      return m.backup_restore_failed();
    default:
      return null;
  }
}

function SummaryList({ summary }: { summary: BackupSummaryView }) {
  const { locale } = useLocale();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" });
  const hours = summary.audioMs / 3_600_000;
  const rows: [string, string][] = [
    [m.backup_summary_made(), date.format(summary.createdAtMs)],
    [m.backup_summary_mac(), summary.macName],
    [m.backup_summary_version(), summary.appVersion],
    [m.backup_summary_conversations(), new Intl.NumberFormat(locale).format(summary.episodes)],
    [m.backup_summary_people(), new Intl.NumberFormat(locale).format(summary.people)],
    [
      m.backup_summary_audio(),
      summary.includeAudio
        ? m.backup_summary_hours({
            hours: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(hours),
          })
        : m.backup_summary_no_audio(),
    ],
    [m.backup_summary_size(), formatBytes(summary.bytes, locale)],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-m gap-y-xxs text-body-s">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-cte-text-muted">{label}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * `replaces`: Settings, where data exists; it says what is kept aside. The
 * first run has nothing to replace.
 */
export function RestoreDialog({
  open,
  replaces,
  onClose,
}: {
  open: boolean;
  replaces: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className={popupClassName}>
        {open ? <RestoreFlow replaces={replaces} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function RestoreFlow({ replaces }: { replaces: boolean }) {
  const { locale } = useLocale();
  const status = useBackupStatus();
  const choose = useMutation(orpc.backup.choose.mutationOptions());
  const inspect = useMutation(orpc.backup.inspect.mutationOptions());
  const restore = useMutation(orpc.backup.restore.mutationOptions());
  const cancel = useMutation(orpc.backup.cancel.mutationOptions());
  const [passphrase, setPassphrase] = useState("");
  const operation = status.data?.operation ?? { kind: "idle" };
  const chosen = choose.data?.outcome === "chosen" ? choose.data : null;
  const inspected = inspect.data;
  const secret = chosen?.protected === true ? passphrase : null;

  const pick = () =>
    choose.mutate(
      {},
      {
        onSuccess: (result) => {
          inspect.reset();
          restore.reset();
          setPassphrase("");
          // A backup without a passphrase shows what it holds at once.
          if (result.outcome === "chosen" && !result.protected)
            inspect.mutate({ passphrase: null });
        },
      },
    );

  if (
    restore.isPending ||
    operation.kind === "restoring" ||
    restore.data?.outcome === "restarting"
  ) {
    const restarting = restore.data?.outcome === "restarting";
    return (
      <>
        <DialogTitle>{m.backup_restore_title()}</DialogTitle>
        <DialogDescription>
          {restarting ? m.backup_restore_restarting() : m.backup_restore_progress_detail()}
        </DialogDescription>
        <OperationProgress
          operation={restarting ? { kind: "restoring", doneBytes: 1, totalBytes: 1 } : operation}
          label={m.backup_restore_progress()}
        />
        {restarting ? null : (
          <DialogFooter>
            <Button variant="secondary" onClick={() => cancel.mutate({})}>
              {m.cancel()}
            </Button>
          </DialogFooter>
        )}
      </>
    );
  }

  const chooseProblem =
    choose.data === undefined ||
    choose.data.outcome === "chosen" ||
    choose.data.outcome === "cancelled"
      ? null
      : refusalMessage(choose.data.outcome);
  const inspectProblem =
    inspected === undefined || inspected.outcome === "ok"
      ? null
      : inspected.outcome === "no-space"
        ? m.backup_no_space({
            needed: formatBytes(inspected.neededBytes ?? 0, locale),
            free: formatBytes(inspected.freeBytes ?? 0, locale),
          })
        : refusalMessage(inspected.outcome);
  const restoreProblem =
    restore.data === undefined || restore.data.outcome === "cancelled"
      ? null
      : restore.data.outcome === "no-space"
        ? m.backup_no_space_short()
        : refusalMessage(restore.data.outcome);
  const problem = chooseProblem ?? inspectProblem ?? restoreProblem;
  const error = choose.error ?? inspect.error ?? restore.error;

  return (
    <>
      <DialogTitle>{m.backup_restore_title()}</DialogTitle>
      <DialogDescription>
        {replaces ? m.backup_restore_what_replace() : m.backup_restore_what_first()}
      </DialogDescription>
      <div className="flex items-center gap-s">
        <Button variant="secondary" isPending={choose.isPending} onClick={pick}>
          {chosen === null ? m.backup_restore_choose() : m.backup_restore_choose_other()}
        </Button>
        {chosen === null ? null : (
          <span className="min-w-0 truncate text-body-s text-cte-text-muted">
            {chosen.fileName}
          </span>
        )}
      </div>
      {chosen !== null && chosen.protected && inspected?.outcome !== "ok" ? (
        <form
          className="flex items-end gap-s"
          onSubmit={(event) => {
            event.preventDefault();
            if (passphrase.length > 0) inspect.mutate({ passphrase });
          }}
        >
          <Field className="min-w-0 flex-1 items-stretch">
            <FieldLabel>{m.backup_passphrase()}</FieldLabel>
            <Input
              type="password"
              value={passphrase}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
          <Button type="submit" isPending={inspect.isPending} disabled={passphrase.length === 0}>
            {m.backup_restore_open()}
          </Button>
        </form>
      ) : null}
      {inspected?.summary === null || inspected?.summary === undefined ? null : (
        <SummaryList summary={inspected.summary} />
      )}
      {inspected?.outcome === "ok" && replaces ? (
        <p className="corner-s bg-neutral-2 p-s text-body-s">
          {m.backup_restore_replace_warning()}
        </p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {problem}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
      <DialogFooter>
        <DialogClose>{m.cancel()}</DialogClose>
        <Button
          variant={replaces ? "danger" : "primary"}
          disabled={inspected?.outcome !== "ok"}
          onClick={() => restore.mutate({ passphrase: secret })}
        >
          {replaces ? m.backup_restore_replace() : m.backup_restore_confirm()}
        </Button>
      </DialogFooter>
    </>
  );
}
