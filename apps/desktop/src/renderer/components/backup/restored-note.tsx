import { Button } from "@sondine/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from "@sondine/ui/components/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { useLocale } from "../../i18n/locale";
import { m } from "../../paraglide/messages.js";
import { useBackupStatus } from "./backup-dialogs";
import { applyRendererPrefs } from "./backup-prefs";

// After a restore (ADR 048), once: the window takes back its own settings
// (language, appearance, shortcuts), then a note says what came back and
// what is left to do: listening stays paused until « Reprendre l'écoute »,
// models are downloaded again on a click, macOS may ask its permissions
// again, and a phone paired with the old Mac should be revoked on one of the
// two if that Mac still runs.

export function RestoredNote() {
  const { locale } = useLocale();
  const status = useBackupStatus();
  const queryClient = useQueryClient();
  const restored = status.data?.restored ?? null;
  const resume = useMutation(orpc.listening.resume.mutationOptions());
  const download = useMutation(orpc.models.download.mutationOptions());
  const close = useMutation(
    orpc.backup.closeNote.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.backup.key() }),
    }),
  );

  useEffect(() => {
    if (restored !== null && applyRendererPrefs(restored.prefs)) window.location.reload();
  }, [restored]);

  if (restored === null) return null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" });
  const error = resume.error ?? download.error ?? close.error;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close.mutate({}))}>
      <DialogPopup className="w-[min(32rem,calc(100vw-var(--space-xl)))]">
        <DialogTitle>{m.backup_restored_title()}</DialogTitle>
        <DialogDescription>
          {m.backup_restored_detail({ date: date.format(restored.createdAtMs) })}
        </DialogDescription>
        <ul className="flex list-disc flex-col gap-xs ps-l text-body-s">
          <li>{m.backup_restored_paused()}</li>
          <li>{m.backup_restored_permissions()}</li>
          <li>{m.backup_restored_phones()}</li>
        </ul>
        {restored.missingModels.length === 0 ? null : (
          <div className="flex flex-col gap-xs">
            <p className="text-body-s">{m.backup_restored_models()}</p>
            {restored.missingModels.map((model) => (
              <div key={model.artifactId} className="flex items-center gap-s">
                <span className="min-w-0 flex-1 truncate text-body-s">{model.displayName}</span>
                <Button
                  variant="secondary"
                  isPending={
                    download.isPending && download.variables.artifactId === model.artifactId
                  }
                  onClick={() => download.mutate({ artifactId: model.artifactId })}
                >
                  {m.backup_restored_download()}
                </Button>
              </div>
            ))}
          </div>
        )}
        {error === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {errorMessage(error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" isPending={close.isPending} onClick={() => close.mutate({})}>
            {m.backup_restored_later()}
          </Button>
          <Button
            isPending={resume.isPending}
            onClick={() => resume.mutate({}, { onSuccess: () => close.mutate({}) })}
          >
            {m.backup_restored_resume()}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
