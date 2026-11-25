import type { ModelArtifactStatus, ModelPhase, ModelProblemCode, ModelsStatus } from "@sondine/api";
import { asSmallMac, useSmallMac } from "./small-mac";
import { Button } from "@sondine/ui/components/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@sondine/ui/components/collapsible";
import { Progress, ProgressLabel, ProgressValue } from "@sondine/ui/components/progress";
import { CircleCheckIcon, DownloadIcon, FolderIcon, WarningIcon } from "@sondine/ui/icon";
import { useMutation, useQuery } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { formatBytes } from "../../lib/bytes";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { modelView, type ModelAction } from "./model-view";

// The transcription model, the same in the first run and in Settings: what
// it is and what it needs, a copy already on this Mac, choosing a file, a
// download the user starts (its size, the free disk, the license), the
// progress of a job with Cancel, and what went wrong. Status comes from
// `models.watch`; every action is a mutation that answers with the status.

const problemText: Record<ModelProblemCode, () => string> = {
  not_a_file: () => m.model_problem_not_a_file(),
  size_mismatch: () => m.model_problem_size_mismatch(),
  hash_mismatch: () => m.model_problem_hash_mismatch(),
  disk_full: () => m.model_problem_disk_full(),
  network: () => m.model_problem_network(),
  http_status: () => m.model_problem_http_status(),
  redirect_refused: () => m.model_problem_redirect_refused(),
  too_large: () => m.model_problem_too_large(),
  bad_response: () => m.model_problem_bad_response(),
  corrupt: () => m.model_problem_corrupt(),
  io: () => m.model_problem_io(),
};

const busyText: Partial<Record<ModelPhase, () => string>> = {
  importing: () => m.model_importing(),
  downloading: () => m.model_downloading(),
  verifying: () => m.model_verifying(),
};

export function useModels() {
  const smallMac = useSmallMac();
  const models = useQuery(orpc.models.watch.experimental_liveOptions({ retry: true }));
  // Development: seen as a Mac too small for the local model (small-mac.ts).
  return smallMac && models.data !== undefined
    ? { ...models, data: asSmallMac(models.data) }
    : models;
}

/** The models of one role: the transcript's (onboarding, Settings ▸ Modèle) or near-live text's. */
export function ModelPanel({ role = "final" }: { role?: ModelArtifactStatus["role"] }) {
  const models = useModels();
  if (models.data === undefined) {
    return (
      <p className={models.isError ? "text-error" : "text-cte-text-muted"}>
        {models.isError ? errorMessage(models.error) : m.loading()}
      </p>
    );
  }
  const status = models.data;
  return (
    <div className="flex flex-col gap-m">
      {status.artifacts
        .filter((artifact) => artifact.role === role)
        .map((artifact) => (
          <ArtifactPanel key={artifact.artifactId} status={status} artifact={artifact} />
        ))}
    </div>
  );
}

function ArtifactPanel({
  status,
  artifact,
}: {
  status: ModelsStatus;
  artifact: ModelArtifactStatus;
}) {
  const locale = getLocale();
  const view = modelView(status, artifact);
  const size = formatBytes(artifact.sizeBytes, locale);
  const input = { artifactId: artifact.artifactId };
  const importFound = useMutation(orpc.models.import.mutationOptions());
  const pick = useMutation(orpc.models.pick.mutationOptions());
  const download = useMutation(orpc.models.download.mutationOptions());
  const cancel = useMutation(orpc.models.cancel.mutationOptions());
  const error = importFound.error ?? pick.error ?? download.error ?? cancel.error;
  const remaining = Math.max(0, artifact.sizeBytes - artifact.partialBytes);

  const actionButton = (action: ModelAction, main: boolean) => {
    const variant = main ? "primary" : "secondary";
    switch (action) {
      case "import-found":
        return (
          <Button
            key={action}
            variant={variant}
            isPending={importFound.isPending}
            onClick={() => importFound.mutate(input)}
          >
            {m.model_import_found()}
          </Button>
        );
      case "pick":
        return (
          <Button
            key={action}
            variant={main ? "primary" : "ghost"}
            isPending={pick.isPending}
            onClick={() => pick.mutate(input)}
          >
            <FolderIcon />
            {m.model_pick()}
          </Button>
        );
      case "download":
      case "resume":
        return (
          <Button
            key={action}
            variant={main ? "primary" : "ghost"}
            disabled={view.missingDiskBytes > 0}
            isPending={download.isPending}
            onClick={() => download.mutate(input)}
          >
            <DownloadIcon />
            {action === "resume"
              ? m.model_resume({ size: formatBytes(remaining, locale) })
              : m.model_download({ size })}
          </Button>
        );
      case "cancel":
        return (
          <Button
            key={action}
            variant="secondary"
            isPending={cancel.isPending}
            onClick={() => cancel.mutate({ ...input, discard: false })}
          >
            {m.model_cancel()}
          </Button>
        );
      case "discard":
        return (
          <Button
            key={action}
            variant="ghost"
            isPending={cancel.isPending}
            onClick={() => cancel.mutate({ ...input, discard: true })}
          >
            {m.model_discard({ size: formatBytes(artifact.partialBytes, locale) })}
          </Button>
        );
    }
  };

  const offersDownload = view.actions.includes("download") || view.actions.includes("resume");
  const [first, ...others] = view.actions;
  const foundFirst = first === "import-found" && others.length > 0;
  const downloadNote = offersDownload ? (
    <p className="text-body-xs text-cte-text-muted">
      {view.missingDiskBytes > 0
        ? m.model_disk_short({
            needed: formatBytes(artifact.downloadNeedsBytes, locale),
            free: formatBytes(status.freeDiskBytes, locale),
          })
        : m.model_download_note({ free: formatBytes(status.freeDiskBytes, locale) })}
    </p>
  ) : null;
  return (
    <section aria-label={artifact.displayName} className="flex flex-col gap-s">
      <div className="flex flex-col gap-s corner-m bg-neutral-2 p-m">
        <div className="flex flex-col">
          <p className="font-body font-medium">{artifact.displayName}</p>
          <p className="text-body-xs text-cte-text-muted">
            {m.model_requirements({
              size,
              memory: formatBytes(artifact.minimumMemoryBytes, locale, { binary: true }),
              mac: formatBytes(status.memoryBytes, locale, { binary: true }),
            })}
          </p>
        </div>
        {view.lowMemory ? (
          <p className="flex items-start gap-xs text-body-xs">
            <WarningIcon aria-hidden className="mt-xxs shrink-0 text-cte-text-muted" />
            {m.model_low_memory()}
          </p>
        ) : null}
        {artifact.found !== null && !view.ready ? (
          <div className="flex flex-col">
            <p className="flex items-center gap-xxs text-body-xs text-cte-text-muted">
              <FolderIcon aria-hidden />
              {m.model_found()}
            </p>
            <p className="font-data text-body-xs break-all">{artifact.found.path}</p>
            <p className="text-body-xs text-cte-text-muted">
              {artifact.found.clones ? m.model_import_clones() : m.model_import_copies({ size })}
            </p>
          </div>
        ) : null}
        {view.busy ? (
          <Progress value={artifact.progress === null ? null : Math.round(artifact.progress * 100)}>
            <ProgressLabel>
              {/* A 19 GB download reads better in bytes than in percent alone. */}
              {artifact.phase === "downloading" && artifact.progress !== null
                ? m.model_downloading_bytes({
                    done: formatBytes(artifact.sizeBytes * artifact.progress, locale),
                    size,
                  })
                : busyText[artifact.phase]?.()}
            </ProgressLabel>
            <ProgressValue />
          </Progress>
        ) : null}
        {view.ready ? (
          <p className="flex items-center gap-xs">
            <CircleCheckIcon aria-hidden className="text-success" />
            {m.model_ready()}
          </p>
        ) : null}
        {artifact.phase === "failed" && artifact.problem !== null ? (
          <p role="alert" className="text-error">
            {problemText[artifact.problem.code]()}
          </p>
        ) : null}
        {artifact.partialBytes > 0 && !view.busy ? (
          <p className="text-body-xs text-cte-text-muted">
            {m.model_partial({
              done: formatBytes(artifact.partialBytes, locale),
              size,
            })}
          </p>
        ) : null}
      </div>
      {/* A copy on this Mac is the obvious choice: the rest waits under « Autres options ». */}
      {foundFirst ? (
        <div className="flex flex-col items-start gap-s">
          {actionButton("import-found", true)}
          <Collapsible>
            <CollapsibleTrigger className="text-body-s text-cte-text-muted">
              {m.model_other_options()}
            </CollapsibleTrigger>
            <CollapsiblePanel className="flex flex-col gap-s pt-xs">
              <div className="flex flex-wrap items-center gap-xs">
                {others.map((action) => actionButton(action, false))}
              </div>
              {downloadNote}
            </CollapsiblePanel>
          </Collapsible>
        </div>
      ) : (
        <>
          {view.actions.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-xs">
              {view.actions.map((action, index) => actionButton(action, index === 0))}
            </div>
          )}
          {downloadNote}
        </>
      )}
      <p className="text-body-xs text-cte-text-muted">
        {m.model_license({ name: artifact.license.name })}{" "}
        {/* Main opens this pinned page in the default browser, never in Sondine. */}
        <a
          href={artifact.license.url}
          target="_blank"
          rel="noreferrer"
          className="corner-xs font-body font-medium underline underline-offset-4 focus-ring"
        >
          {m.model_license_link()}
        </a>
      </p>
      {pick.data?.outcome === "busy" ? (
        <p className="text-body-xs text-cte-text-muted">{m.model_pick_busy()}</p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-error">
          {errorMessage(error)}
        </p>
      )}
    </section>
  );
}
