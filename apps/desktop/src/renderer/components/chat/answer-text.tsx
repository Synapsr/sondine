import { Link } from "@tanstack/react-router";
import { Fragment, useMemo, type ReactNode } from "react";
import { parseAnswer, type Inline } from "./answer-markdown";

// An agent's answer on screen (ADR 027): the small Markdown of
// answer-markdown.ts, as React elements only. A link to a conversation opens
// it at its time; any other address is shown, never followed.

const linkClassName = "corner-xs underline underline-offset-4 focus-ring";

function InlineNodes({ nodes }: { nodes: readonly Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "strong":
        return (
          <strong key={index} className="font-medium">
            <InlineNodes nodes={node.children} />
          </strong>
        );
      case "em":
        return (
          <em key={index}>
            <InlineNodes nodes={node.children} />
          </em>
        );
      case "code":
        return (
          <code key={index} className="corner-xs bg-neutral-3 px-xxs font-data text-body-xs">
            {node.text}
          </code>
        );
      case "episode":
        return (
          <Link
            key={index}
            to="/episode/$id"
            params={{ id: String(node.episodeId) }}
            search={node.atMs === null ? {} : { t: node.atMs }}
            className={linkClassName}
          >
            <InlineNodes nodes={node.children} />
          </Link>
        );
      case "link":
        return (
          <Fragment key={index}>
            <InlineNodes nodes={node.children} />
            <span className="text-cte-text-muted"> ({node.url})</span>
          </Fragment>
        );
    }
  });
}

export function AnswerText({ text }: { text: string }) {
  const blocks = useMemo(() => parseAnswer(text), [text]);
  return (
    <div className="flex flex-col gap-s">
      {blocks.map((block, index) =>
        block.kind === "paragraph" ? (
          <p key={index}>
            {block.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex === 0 ? null : <br />}
                <InlineNodes nodes={line} />
              </Fragment>
            ))}
          </p>
        ) : block.ordered ? (
          <ol key={index} className="flex list-decimal flex-col gap-xxs ps-l">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <InlineNodes nodes={item} />
              </li>
            ))}
          </ol>
        ) : (
          <ul key={index} className="flex list-disc flex-col gap-xxs ps-l">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <InlineNodes nodes={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
