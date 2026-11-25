export { mergeClassName } from "./lib/class-name";
export { cn } from "./lib/cn";
export { largeTransition, popupScale, pressDistance, smallTransition } from "./lib/motion";
export {
  PortalContainer,
  PortalDestination,
  ThemeScope,
  usePortalContainer,
} from "./theme/portal-container";
export type {
  PortalContainerProps,
  PortalDestinationProps,
  ThemeScopeProps,
} from "./theme/portal-container";
export {
  applyResolvedTheme,
  createThemeController,
  isTheme,
  THEMES,
} from "./theme/theme-controller";
export type {
  ColorSchemeQuery,
  ResolvedTheme,
  Theme,
  ThemeController,
  ThemeControllerOptions,
  ThemeSnapshot,
  ThemeStorage,
  ThemeTarget,
} from "./theme/theme-controller";
export { ThemeProvider, useTheme } from "./theme/theme-provider";
export type { ThemeContextValue, ThemeProviderProps } from "./theme/theme-provider";
export { createLocalStorageThemeStorage, createMemoryThemeStorage } from "./theme/theme-storage";
