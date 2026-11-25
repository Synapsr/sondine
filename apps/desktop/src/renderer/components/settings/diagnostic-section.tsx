import { Button } from "@sondine/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@sondine/ui/components/dialog";
import { cn } from "@sondine/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CONTACT_EMAIL, contactMail, ISSUES_PAGE } from "../../../shared/contact";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// « Envoyer un diagnostic » (Settings ▸ Avancé, ADR 042): the whole text on
// screen, an optional note, then a mail in the user's own app, or a copy.
// Sondine sends nothing, whatever the answer about statistics.

const boxClassName = cn(
  "corner-s bg-neutral-2 p-s text-cte-text ring-s ring-neutral-4",
  "resize-none focus-ring",
);

export function DiagnosticSection() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger variant="secondary" className="self-start">
        {m.diagnostic_send()}
      </DialogTrigger>
      <DialogPopup className="w-[min(36rem,calc(100vw-var(--space-xl)))]">
        {open ? <Diagnostic /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function Diagnostic() {
  // Read once when the dialog opens: what is on screen is what leaves.
  const report = useQuery({
    ...orpc.diagnostics.report.queryOptions(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const text = report.data?.text ?? "";
  const body = note.trim() === "" ? text : `${note.trim()}\n\n${text}`;
  return (
    <>
      <DialogTitle>{m.diagnostic_title()}</DialogTitle>
      <DialogDescription>{m.diagnostic_what({ email: CONTACT_EMAIL })}</DialogDescription>
      <textarea
        aria-label={m.diagnostic_note()}
        placeholder={m.diagnostic_note()}
        value={note}
        maxLength={4_000}
        rows={3}
        onChange={(event) => {
          setNote(event.target.value);
          setCopied(false);
        }}
        className={boxClassName}
      />
      {report.error === null ? (
        <pre className="max-h-[40vh] overflow-y-auto corner-s bg-neutral-2 p-s font-data text-body-xs whitespace-pre-wrap select-text">
          {report.data === undefined ? m.loading() : text}
        </pre>
      ) : (
        <p role="alert" className="text-error">
          {errorMessage(report.error)}
        </p>
      )}
      <p className="text-body-s text-cte-text-muted">
        <a
          href={ISSUES_PAGE}
          target="_blank"
          rel="noreferrer"
          className="corner-xs underline underline-offset-4 focus-ring"
        >
          {m.diagnostic_issue()}
        </a>
      </p>
      <DialogFooter>
        <Button
          variant="secondary"
          disabled={report.data === undefined}
          onClick={() => void navigator.clipboard.writeText(body).then(() => setCopied(true))}
        >
          {copied ? m.agents_copied() : m.agents_copy()}
        </Button>
        <Button
          disabled={report.data === undefined}
          nativeButton={false}
          render={
            <a href={contactMail(m.diagnostic_subject(), body)} target="_blank" rel="noreferrer" />
          }
        >
          {m.diagnostic_mail()}
        </Button>
      </DialogFooter>
    </>
  );
}
