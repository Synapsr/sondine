import { USAGE_EXAMPLE, type UsageReport } from "@sondine/protocol";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// The anonymous statistics (ADR 042): the question, asked once (the first
// run, or the sidebar on an install that had none), with two equal buttons;
// the switch in Settings; and the report exactly as it leaves.

export function useUsage() {
  return useQuery(orpc.usage.get.queryOptions());
}

export function useShareUsage() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.usage.setSharing.mutationOptions({
      onSuccess: (status) => queryClient.setQueryData(orpc.usage.get.queryKey(), status),
    }),
  );
}

/** « Voir ce qui est envoyé »: today's report so far and those waiting, or an example without a yes. */
export function SentReports({ className }: { className?: string }) {
  const usage = useUsage();
  const status = usage.data;
  const reports =
    status === undefined
      ? []
      : [...status.waiting, ...(status.today === null ? [] : [status.today])];
  const example = reports.length === 0;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) void usage.refetch();
      }}
    >
      <DialogTrigger
        render={
          <button
            type="button"
            className={cn(
              "corner-xs text-body-s underline underline-offset-4 focus-ring",
              className,
            )}
          />
        }
      >
        {m.usage_see()}
      </DialogTrigger>
      <DialogPopup className="w-[min(32rem,calc(100vw-var(--space-xl)))]">
        <DialogTitle>{example ? m.usage_example() : m.usage_see()}</DialogTitle>
        {(example ? [USAGE_EXAMPLE] : reports).map((report) => (
          <Report key={report.id} report={report} />
        ))}
        <DialogFooter>
          <DialogClose>{m.usage_close()}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Report({ report }: { report: UsageReport }) {
  return (
    <pre className="max-h-[60vh] shrink-0 overflow-y-auto corner-s bg-neutral-2 p-s font-data text-body-xs whitespace-pre-wrap select-text">
      {JSON.stringify(report, null, 2)}
    </pre>
  );
}

/** The two answers, the same size and weight. */
export function UsageAnswers({
  onAnswered,
  className,
}: {
  onAnswered?: () => void;
  className?: string;
}) {
  const share = useShareUsage();
  const answer = (yes: boolean) =>
    share.mutate({ share: yes }, onAnswered === undefined ? {} : { onSuccess: onAnswered });
  return (
    <>
      <div className={cn("grid grid-cols-2 gap-xs", className)}>
        <Button variant="secondary" disabled={share.isPending} onClick={() => answer(false)}>
          {m.usage_no()}
        </Button>
        <Button variant="secondary" disabled={share.isPending} onClick={() => answer(true)}>
          {m.usage_yes()}
        </Button>
      </div>
      {share.error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(share.error)}
        </p>
      )}
    </>
  );
}

/** Asked once, in the sidebar, of an install that had no first run to ask it. */
export function SidebarQuestion() {
  const usage = useUsage();
  if (usage.data?.answer !== null) return null;
  return (
    <section
      aria-label={m.usage_title()}
      className="flex flex-col gap-xs corner-s bg-cte-canvas p-s ring-[1px] ring-neutral-4"
    >
      <h2 className="font-body font-medium text-body-s">{m.usage_question()}</h2>
      <p className="text-body-xs text-cte-text-muted">{m.usage_what()}</p>
      <SentReports className="self-start text-body-xs text-cte-text-muted" />
      <UsageAnswers />
    </section>
  );
}

/** Settings ▸ Confidentialité. */
export function UsageSection() {
  const usage = useUsage();
  const share = useShareUsage();
  const error = usage.error ?? share.error;
  return (
    <div className="flex max-w-[40rem] flex-col gap-xs">
      <SwitchLabel>
        <Switch
          checked={usage.data?.answer === "yes"}
          disabled={usage.data === undefined || share.isPending}
          onCheckedChange={(checked) => share.mutate({ share: checked })}
        />
        {m.usage_share()}
      </SwitchLabel>
      <p className="text-body-s text-cte-text-muted">
        {m.usage_what()}
        {usage.data?.sends === false ? ` ${m.usage_not_this_build()}` : null}
      </p>
      <SentReports className="self-start" />
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
    </div>
  );
}
