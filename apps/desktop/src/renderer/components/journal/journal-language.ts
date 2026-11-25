import type { JournalDay } from "@sondine/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { orpc } from "../../core/orpc";
import { useLocale } from "../../i18n/locale";

/** New journal lines are written in the window's language: core is told once when it differs. */
export function useJournalLanguage(data: JournalDay | undefined) {
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const asked = useRef<string | null>(null);
  const { mutate } = useMutation(
    orpc.journal.settings.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.journal.key() }),
    }),
  );
  const current = data?.state.language;
  useEffect(() => {
    if (current === undefined || current === locale || asked.current === locale) return;
    asked.current = locale;
    mutate({ language: locale });
  }, [current, locale, mutate]);
}
