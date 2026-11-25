import type { JournalWriter } from "@sondine/api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import { Radio, RadioGroup, RadioLabel } from "@sondine/ui/components/radio-group";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { ModelPanel } from "../models/model-panel";
import { accountLine, problemLine } from "./chat-section";

// « Journal du jour » (ADR 028): the switch, what it does and where it runs;
// who writes it, this Mac, this Mac read again by the user's Claude, or
// their Claude, a choice that sends text off the Mac only once the user
// agreed to what leaves; and the Mac's model, downloaded only when the user
// starts it.

const WRITERS: readonly JournalWriter[] = ["device", "device-checked", "claude"];

const writerLabel = (writer: JournalWriter) =>
  writer === "device"
    ? m.settings_journal_writer_device()
    : writer === "device-checked"
      ? m.settings_journal_writer_checked()
      : m.settings_journal_writer_claude();

const writerDetail = (writer: JournalWriter) =>
  writer === "device"
    ? m.settings_journal_writer_device_detail()
    : writer === "device-checked"
      ? m.settings_journal_writer_checked_detail()
      : m.settings_journal_writer_claude_detail();

export function JournalSection() {
  const queryClient = useQueryClient();
  const day = useQuery(orpc.journal.day.queryOptions({ input: {} }));
  const [confirming, setConfirming] = useState<JournalWriter | null>(null);
  const set = useMutation(
    orpc.journal.settings.mutationOptions({
      onSuccess: () => {
        setConfirming(null);
        void queryClient.invalidateQueries({ queryKey: orpc.journal.key() });
      },
    }),
  );
  const on = day.data?.state.enabled;
  const writer = day.data?.state.writer;
  const usesClaude = writer !== undefined && writer !== "device";
  const claude = useQuery(orpc.journal.claude.queryOptions({ enabled: on === true && usesClaude }));
  const provider = claude.data ?? null;
  const choose = (next: JournalWriter) =>
    next === "device" ? set.mutate({ writer: next }) : setConfirming(next);
  return (
    <div className="flex max-w-[40rem] flex-col gap-s">
      <div className="flex flex-col gap-xs">
        <SwitchLabel>
          <Switch
            checked={on ?? false}
            disabled={on === undefined || set.isPending}
            onCheckedChange={(checked) => set.mutate({ enabled: checked })}
          />
          {m.settings_journal()}
        </SwitchLabel>
        <p className="text-body-s text-cte-text-muted">{m.settings_journal_detail()}</p>
        {set.error === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {errorMessage(set.error)}
          </p>
        )}
      </div>
      {on !== true || writer === undefined ? null : (
        <div className="flex flex-col gap-xs">
          <p className="font-body font-medium text-body-s">{m.settings_journal_writer()}</p>
          <RadioGroup<JournalWriter>
            aria-label={m.settings_journal_writer()}
            value={writer}
            disabled={set.isPending}
            onValueChange={(next) => {
              if (next !== writer) choose(next);
            }}
          >
            {WRITERS.map((option) => (
              <RadioLabel key={option} className="items-start">
                <Radio value={option} className="mt-xxs" />
                <span className="flex flex-col">
                  <span>{writerLabel(option)}</span>
                  <span className="text-body-s text-cte-text-muted">{writerDetail(option)}</span>
                </span>
              </RadioLabel>
            ))}
          </RadioGroup>
          {!usesClaude ? null : (
            <div className="flex flex-col gap-xxs text-body-s">
              {provider === null ? null : (
                <>
                  {accountLine(provider) === null ? null : <p>{accountLine(provider)}</p>}
                  {problemLine(provider) === null ? null : (
                    <p className="text-error">{problemLine(provider)}</p>
                  )}
                </>
              )}
              {claude.error === null ? null : (
                <p role="alert" className="text-error">
                  {errorMessage(claude.error)}
                </p>
              )}
              <div>
                <Button
                  variant="ghost"
                  isPending={claude.isFetching}
                  onClick={() => void claude.refetch()}
                >
                  {m.chat_refresh()}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {on === true && writer !== "claude" ? <ModelPanel role="journal" /> : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogTitle>{m.settings_journal_writer_confirm_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirming === "claude"
              ? m.settings_journal_writer_confirm_claude()
              : m.settings_journal_writer_confirm_checked()}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose>{m.cancel()}</AlertDialogClose>
            <Button
              isPending={set.isPending}
              onClick={() => {
                if (confirming !== null) set.mutate({ writer: confirming });
              }}
            >
              {m.settings_journal_writer_confirm()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
