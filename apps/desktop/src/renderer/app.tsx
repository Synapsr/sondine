import { CSPProvider } from "@base-ui/react/csp-provider";
import { createLocalStorageThemeStorage, ThemeProvider } from "@sondine/ui";
import { ToastProvider } from "@sondine/ui/components/toast";
import { TooltipProvider } from "@sondine/ui/components/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { queryClient } from "./core/orpc";
import { EditorRoot } from "./graphical/editor-root";
import { LocaleProvider, useLocale } from "./i18n/locale";
import { m } from "./paraglide/messages.js";
import { router } from "./routes/router";
import { ShortcutsProvider, shortcutPlatform } from "./shortcuts/shortcuts-provider";

const themeStorage = createLocalStorageThemeStorage();

/** Toasts and tooltips for the whole app; the toast labels follow the language. */
function Overlays({ children }: { children: ReactNode }) {
  useLocale();
  return (
    <ToastProvider closeLabel={m.toast_close()} regionLabel={m.toast_region_label()}>
      <TooltipProvider>{children}</TooltipProvider>
    </ToastProvider>
  );
}

export function App() {
  return (
    // The CSP allows no inline <style>; Base UI must style through classes.
    <CSPProvider disableStyleElements>
      <ThemeProvider storage={themeStorage}>
        <QueryClientProvider client={queryClient}>
          {/* Graphical's theme editor beside the app, in development only. */}
          <EditorRoot>
            <ShortcutsProvider platform={shortcutPlatform(window.sondine.info.platform)}>
              <LocaleProvider>
                <Overlays>
                  <RouterProvider router={router} />
                </Overlays>
              </LocaleProvider>
            </ShortcutsProvider>
          </EditorRoot>
        </QueryClientProvider>
      </ThemeProvider>
    </CSPProvider>
  );
}
