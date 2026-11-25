import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import { ChevronLeftIcon, ChevronRightIcon, SidebarIcon } from "@sondine/ui/icon";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { m } from "../../paraglide/messages.js";
import { useMediaQuery } from "../../lib/media-query";
import { useAgentPanel } from "../chat/agent-panel-state";
import { NARROW_WINDOW } from "./app-sidebar";
import { ListeningControl } from "./listening-control";

// The window's top band (ADR 037), in place of the hidden title bar: the
// window buttons, back and forward above the screen's start, then listening
// and the agent panel's toggle on the right. Everything else drags the window.

const noDrag = "[-webkit-app-region:no-drag]";
/** On the grey ground, hover a step darker than inside the card. */
const onGround = `${noDrag} p-xs control-hover:bg-neutral-4`;

export function WindowBar() {
  const compact = useMediaQuery(NARROW_WINDOW);
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const agent = useAgentPanel();
  return (
    <div
      className={cn(
        "flex h-[2.75rem] shrink-0 items-center gap-xxs pe-xs [-webkit-app-region:drag]",
        // The sidebar's width, so the arrows sit above the screen's start.
        compact ? "ps-[5.5rem]" : "ps-[15rem]",
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.nav_back()}
        disabled={!canGoBack}
        className={onGround}
        onClick={() => router.history.back()}
      >
        <ChevronLeftIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.nav_forward()}
        className={onGround}
        onClick={() => router.history.forward()}
      >
        <ChevronRightIcon />
      </Button>
      <span className="flex-1" />
      <div className={noDrag}>
        <ListeningControl />
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.nav_ask()}
        aria-pressed={agent.open}
        className={onGround}
        onClick={agent.toggle}
      >
        <SidebarIcon />
      </Button>
    </div>
  );
}
