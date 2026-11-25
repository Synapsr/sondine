import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesignSystemPage } from "../src/design-system/design-system-page";
import { isTheme } from "../src/theme/theme-controller";
import { ThemeProvider } from "../src/theme/theme-provider";
import {
  createLocalStorageThemeStorage,
  createMemoryThemeStorage,
} from "../src/theme/theme-storage";

// ?theme=light|dark|system pins the mode without touching the saved choice (screenshots).
const requested = new URLSearchParams(window.location.search).get("theme");
const storage = isTheme(requested)
  ? createMemoryThemeStorage(requested)
  : createLocalStorageThemeStorage("sondine.ui-playground.theme");

const root = document.getElementById("root");
if (root === null) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider storage={storage}>
      <DesignSystemPage />
    </ThemeProvider>
  </StrictMode>,
);
