import { Button } from "@sondine/ui/components/button";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { errorMessage, orpc, queryClient } from "../core/orpc";
import { m } from "../paraglide/messages.js";
import { ChatRedirect } from "../components/chat/chat-redirect";
import { EpisodeScreen } from "../components/episode/episode-screen";
import { CommitmentsScreen } from "../components/journal/commitments-screen";
import { CalendarScreen } from "../components/calendar/calendar-screen";
import { PeopleScreen } from "../components/people/people-screen";
import { PersonScreen } from "../components/people/person-screen";
import { PlayerProvider } from "../components/player/player-provider";
import { SearchScreen } from "../components/search/search-screen";
import { SettingsPageScreen, SettingsScreen } from "../components/settings/settings-screen";
import { AppShell } from "../components/shell/app-shell";
import { TodayScreen } from "../components/today/today-screen";
import { WelcomeScreen } from "../components/welcome/welcome-screen";
import {
  CalendarSearch,
  ChatSearch,
  EpisodeSearch,
  JournalSearch,
  pageOfTab,
  SearchScreenSearch,
  SettingsPage,
  SettingsSearch,
  TodaySearch,
} from "./search-params";

// Code-based route tree. The window loads one HTML file, so routes live in
// the hash and survive a reload. Until the first run is completed every
// route leads to it (architecture §11); an install that captured before the
// first run existed is marked done by core and never sees it.

function Connecting() {
  return <p className="p-xl text-cte-text-muted">{m.core_connecting()}</p>;
}

function RouteError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-start gap-s p-xl">
      <p role="alert" className="text-error">
        {errorMessage(error)}
      </p>
      <Button variant="secondary" onClick={() => void router.invalidate()}>
        {m.retry()}
      </Button>
    </div>
  );
}

/** Pages of development builds, shown before the first run is done too. */
const DEVELOPMENT_PATHS = new Set(["/design-system", "/notch-lab"]);

const rootRoute = createRootRoute({
  beforeLoad: async ({ location }) => {
    const onboarding = await queryClient.ensureQueryData({
      ...orpc.onboarding.get.queryOptions(),
      retry: 3,
    });
    const welcome = location.pathname === "/welcome";
    if (!onboarding.completed && !welcome && !DEVELOPMENT_PATHS.has(location.pathname))
      throw redirect({ to: "/welcome" });
    if (onboarding.completed && welcome) throw redirect({ to: "/" });
  },
  component: () => (
    <PlayerProvider>
      <Outlet />
    </PlayerProvider>
  ),
  pendingComponent: Connecting,
  errorComponent: RouteError,
});

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  component: WelcomeScreen,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
});

const todayRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  validateSearch: TodaySearch,
  component: TodayScreen,
});

// The Journal screen joined Today (ADR 037); its links land there, on their day,
// for one release.
const journalRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/journal",
  validateSearch: JournalSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/", search: search.day === undefined ? {} : { day: search.day } });
  },
});

const episodeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/episode/$id",
  validateSearch: EpisodeSearch,
  component: EpisodeScreen,
});

const searchRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/search",
  validateSearch: SearchScreenSearch,
  component: SearchScreen,
});

const peopleRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/people",
  component: PeopleScreen,
});

const personRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/people/$personId",
  component: PersonScreen,
});

const chatRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/chat",
  validateSearch: ChatSearch,
  component: ChatRedirect,
});

// Imported files are listed in Search under « Importé » (ADR 037, Téo,
// 2026-11-19); old links land there.
const importsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/imports",
  beforeLoad: () => {
    throw redirect({ to: "/search", search: { contexts: ["imported"] } });
  },
});

const calendarRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/calendar",
  validateSearch: CalendarSearch,
  component: CalendarScreen,
});

const commitmentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/commitments",
  component: CommitmentsScreen,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  validateSearch: SettingsSearch,
  // Settings had tabs before its pages (ADR 037): an old link opens the page.
  beforeLoad: ({ search }) => {
    if (search.tab !== undefined) {
      throw redirect({ to: "/settings/$page", params: { page: pageOfTab(search.tab) } });
    }
  },
  component: SettingsScreen,
});

const settingsPageRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings/$page",
  params: {
    parse: ({ page }) => ({ page: SettingsPage.parse(page) }),
    stringify: ({ page }) => ({ page }),
  },
  // An unknown section opens Settings.
  onError: () => {
    throw redirect({ to: "/settings" });
  },
  component: SettingsPageScreen,
});

// The Status screen became Settings ▸ Avancé (ADR 037); its links land there for one release.
const statusRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/status",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$page", params: { page: "advanced" } });
  },
});

// Development only: production builds fold `import.meta.env.DEV` to false, so
// the design system page and its chunk are left out and the path redirects home.
const designSystemRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/design-system",
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw redirect({ to: "/" });
  },
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import("./design-system-route"), "DesignSystemRoute")
    : () => null,
});

// Development only, as above: the island's flows on the real notch.
const notchLabRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/notch-lab",
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw redirect({ to: "/" });
  },
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import("./notch-lab-route"), "NotchLabRoute")
    : () => null,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    welcomeRoute,
    shellRoute.addChildren([
      todayRoute,
      journalRoute,
      episodeRoute,
      searchRoute,
      peopleRoute,
      personRoute,
      chatRoute,
      importsRoute,
      commitmentsRoute,
      calendarRoute,
      settingsRoute,
      settingsPageRoute,
      statusRoute,
      designSystemRoute,
      notchLabRoute,
    ]),
  ]),
  history: createHashHistory(),
  defaultPreload: false,
  defaultPendingMs: 300,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
