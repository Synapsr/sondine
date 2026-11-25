import { Badge } from "@sondine/ui/components/badge";
import { Button } from "@sondine/ui/components/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@sondine/ui/components/popover";
import { waitingForOf, waitReasonText } from "../../../shared/queue-line";
import type { RequestView } from "../../lib/request-view";
import { m } from "../../paraglide/messages.js";

// A request's state in one word on its row (« En attente », « Échec »), and
// the why, with what can be done, in a popover.

export function waitingText(cause: Extract<RequestView, { kind: "waiting" }>["cause"]): string {
  switch (cause.kind) {
    case "reasons": {
      const reason = waitReasonText(cause.analysis, cause.episode);
      return reason === null ? m.request_waiting_starting() : m.request_waiting_reason({ reason });
    }
    case "after-running":
      return m.request_waiting_after_running();
    case "behind":
      return m.request_waiting_behind();
    case "starting":
      return m.request_waiting_starting();
  }
}

export function failureText(failure: string | null): string {
  switch (failure) {
    case "invalid_output":
      return m.request_failed_invalid_output();
    case "model_limit":
      return m.request_failed_model_limit();
    case "audio_unavailable":
      return m.request_failed_audio();
    default:
      return m.request_failed_other();
  }
}

const roomReasons = new Set(["memory", "swap"]);

export function RequestState({
  view,
  onRetry,
  retrying,
}: {
  view: RequestView;
  onRetry: () => void;
  retrying: boolean;
}) {
  const waiting = view.kind === "waiting";
  const room =
    waiting &&
    view.cause.kind === "reasons" &&
    waitingForOf(view.cause.analysis, view.cause.episode).some((reason) => roomReasons.has(reason));
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        closeDelay={150}
        render={<button type="button" className="corner-full focus-ring" />}
      >
        <Badge variant={waiting ? "neutral" : "error"}>
          {waiting ? m.request_waiting() : m.request_failed()}
        </Badge>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[18rem] gap-s">
        <PopoverTitle>
          {waiting ? m.request_waiting_title() : m.request_failed_title()}
        </PopoverTitle>
        <PopoverDescription>
          {waiting ? waitingText(view.cause) : failureText(view.failure)}
          {room ? ` ${m.request_hint_memory()}` : null}
        </PopoverDescription>
        {view.kind === "failed" && view.failure !== "audio_unavailable" ? (
          <Button variant="secondary" isPending={retrying} onClick={onRetry}>
            {m.request_retry()}
          </Button>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
