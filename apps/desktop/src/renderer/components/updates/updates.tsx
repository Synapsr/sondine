import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@sondine/ui/components/dialog";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { AnswerText } from "../chat/answer-text";
import { asksForUpdates, updateView } from "./update-view";

// Updates (ADR 045): the question, asked once (the first run, or the sidebar),
// with two equal buttons; the switch in Settings with what is going on; and
// the note once Sondine was updated.

declare const RELEASE_NOTES: string | undefined;

/** This version's section of the CHANGELOG, as the build put it in (electron.vite.config.ts). */
const releaseNotes = typeof RELEASE_NOTES === "string" ? RELEASE_NOTES : "";

export function useUpdates() {
  return useQuery(orpc.status.watch.experimental_liveOptions({ retry: true })).data?.updates;
}

/** The two answers, the same size and weight. */
export function UpdateAnswers({
  onAnswered,
  className,
}: {
  onAnswered?: () => void;
  className?: string;
}) {
  const set = useMutation(orpc.updates.setAutomatic.mutationOptions());
  const answer = (automatic: boolean) =>
    set.mutate({ automatic }, onAnswered === undefined ? {} : { onSuccess: onAnswered });
  return (
    <>
      <div className={cn("grid grid-cols-2 gap-xs", className)}>
        <Button variant="secondary" disabled={set.isPending} onClick={() => answer(false)}>
          {m.update_no()}
        </Button>
        <Button variant="secondary" disabled={set.isPending} onClick={() => answer(true)}>
          {m.update_yes()}
        </Button>
      </div>
      {set.error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(set.error)}
        </p>
      )}
    </>
  );
}

const cardClassName = "flex flex-col gap-xs corner-s bg-cte-canvas p-s ring-[1px] ring-neutral-4";

/** Asked once, in the sidebar, of an install that had no first run to ask it. */
export function SidebarUpdateQuestion() {
  const updates = useUpdates();
  if (!asksForUpdates(updates)) return null;
  return (
    <section aria-label={m.settings_updates_title()} className={cardClassName}>
      <h2 className="font-body font-medium text-body-s">{m.update_question()}</h2>
      <p className="text-body-xs text-cte-text-muted">{m.update_what()}</p>
      <UpdateAnswers />
    </section>
  );
}

/** « Sondine a été mise à jour », until the user closes it. */
export function SidebarUpdateNote() {
  const updates = useUpdates();
  const close = useMutation(orpc.updates.closeNote.mutationOptions());
  const version = updates?.updated ?? null;
  if (version === null) return null;
  return (
    <section aria-label={m.settings_updates_title()} className={cardClassName}>
      <p className="text-body-s">{m.update_done({ version })}</p>
      <div className="flex flex-wrap items-center gap-xs">
        {releaseNotes === "" ? null : <WhatsNew version={version} />}
        <Button
          variant="ghost"
          className="ms-auto"
          disabled={close.isPending}
          onClick={() => close.mutate({})}
        >
          {m.update_close()}
        </Button>
      </div>
    </section>
  );
}

function WhatsNew({ version }: { version: string }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            className="corner-xs text-body-s underline underline-offset-4 focus-ring"
          />
        }
      >
        {m.update_news()}
      </DialogTrigger>
      <DialogPopup className="w-[min(36rem,calc(100vw-var(--space-xl)))]">
        <DialogTitle>{m.update_news_title({ version })}</DialogTitle>
        <div className="max-h-[60vh] overflow-y-auto select-text">
          <AnswerText text={releaseNotes} />
        </div>
        <DialogFooter>
          <DialogClose>{m.update_close()}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Settings ▸ Général ▸ Mises à jour. */
export function UpdatesSection() {
  const updates = useUpdates();
  const set = useMutation(orpc.updates.setAutomatic.mutationOptions());
  const check = useMutation(orpc.updates.check.mutationOptions());
  const install = useMutation(orpc.updates.install.mutationOptions());
  const view = updates === undefined ? null : updateView(updates);
  const error = set.error ?? check.error ?? install.error;
  return (
    <div className="flex max-w-[40rem] flex-col gap-xs">
      <SwitchLabel>
        <Switch
          checked={updates?.automatic === true}
          disabled={updates === undefined || set.isPending}
          onCheckedChange={(checked) => set.mutate({ automatic: checked })}
        />
        {m.settings_updates()}
      </SwitchLabel>
      <p className="text-body-s text-cte-text-muted">
        {m.update_what()}
        {updates?.automatic === null && updates.searches ? ` ${m.update_search_only()}` : null}
      </p>
      {updates === undefined || view === null ? null : (
        <>
          {view.blocked === null ? null : <p className="text-body-s">{view.blocked}</p>}
          <div className="flex flex-wrap items-center gap-s">
            <span className="text-body-s">{view.state}</span>
            {updates.available === null ? null : (
              // Main opens the release page in the default browser, never in Sondine.
              <a
                href={updates.available.url}
                target="_blank"
                rel="noreferrer"
                className="corner-xs font-body font-medium text-body-s underline underline-offset-4 focus-ring"
              >
                {m.settings_updates_download()}
              </a>
            )}
            {view.installable ? (
              <Button isPending={install.isPending} onClick={() => install.mutate({})}>
                {m.update_install()}
              </Button>
            ) : null}
            <Button
              variant="outline"
              isPending={updates.phase === "checking" || check.isPending}
              onClick={() => check.mutate({})}
            >
              {m.settings_updates_check()}
            </Button>
          </div>
          {view.problem === null ? null : (
            <p role="alert" className="text-body-s text-error">
              {view.problem}
            </p>
          )}
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
