import { Button } from "@sondine/ui/components/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { useLocale } from "../../i18n/locale";
import { formatBytes } from "../../lib/bytes";
import { m } from "../../paraglide/messages.js";
import { ExportDialog, RestoreDialog, useBackupStatus } from "../backup/backup-dialogs";

// Settings ▸ Données (ADR 048): what Sondine keeps on this Mac, a whole
// backup in one file, its restore, and the data a restore set aside.

export function DataSection() {
  const { locale } = useLocale();
  const status = useBackupStatus();
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation(
    orpc.backup.deletePrevious.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.backup.key() });
        setDeleting(false);
      },
    }),
  );
  const estimate = status.data?.estimate;
  const previous = status.data?.previous ?? null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" });

  return (
    <div className="flex flex-col gap-l">
      {estimate === undefined ? null : (
        <p className="text-body-s text-cte-text-muted">
          {m.backup_sizes({
            database: formatBytes(estimate.databaseBytes, locale),
            audio: formatBytes(estimate.audioBytes, locale),
            context: formatBytes(estimate.contextBytes, locale),
          })}
        </p>
      )}
      <section className="flex flex-col gap-s">
        <h2 className="font-body font-medium text-body-m">{m.backup_export_title()}</h2>
        <p className="text-body-s text-cte-text-muted">{m.backup_export_intro()}</p>
        <Button variant="secondary" className="self-start" onClick={() => setExporting(true)}>
          {m.backup_export_open()}
        </Button>
      </section>
      <section className="flex flex-col gap-s">
        <h2 className="font-body font-medium text-body-m">{m.backup_restore_title()}</h2>
        <p className="text-body-s text-cte-text-muted">{m.backup_restore_intro()}</p>
        <Button variant="secondary" className="self-start" onClick={() => setRestoring(true)}>
          {m.backup_restore_open_dialog()}
        </Button>
      </section>
      {previous === null ? null : (
        <section className="flex flex-col gap-s">
          <h2 className="font-body font-medium text-body-m">{m.backup_previous_title()}</h2>
          <p className="text-body-s text-cte-text-muted">
            {m.backup_previous_detail({
              date: date.format(previous.restoredAtMs),
              size: formatBytes(previous.bytes, locale),
            })}
          </p>
          <Button variant="secondary" className="self-start" onClick={() => setDeleting(true)}>
            {m.backup_previous_delete()}
          </Button>
        </section>
      )}
      <ExportDialog open={exporting} onClose={() => setExporting(false)} />
      <RestoreDialog open={restoring} replaces onClose={() => setRestoring(false)} />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogPopup>
          <AlertDialogTitle>{m.backup_previous_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.backup_previous_delete_detail()}</AlertDialogDescription>
          {remove.error === null ? null : (
            <p role="alert" className="text-body-s text-error">
              {errorMessage(remove.error)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogClose>{m.cancel()}</AlertDialogClose>
            <Button variant="danger" isPending={remove.isPending} onClick={() => remove.mutate({})}>
              {m.backup_previous_delete()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
