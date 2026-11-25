import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useAgentPanel } from "./agent-panel-state";

// The Discussion screen became the agent panel (ADR 037). For one release a
// link to `/chat` opens the panel, on its discussion, over Today.

const route = getRouteApi("/shell/chat");

export function ChatRedirect() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const agent = useAgentPanel();
  const discussionId = search.d ?? null;
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    agent.show(discussionId);
    void navigate({ to: "/", replace: true });
  }, [agent, discussionId, navigate]);
  return null;
}
