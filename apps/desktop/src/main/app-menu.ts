import type { MenuItemConstructorOptions } from "electron";
import { m } from "../renderer/paraglide/messages.js";
import type { EditCommand } from "../shared/bridge";
import type { TrayLocale } from "./tray-state";

// The application menu, on screen while Sondine is in front. Electron's roles
// bring the action, the shortcut and an English label: each item says its own,
// in the OS locale. No Electron import but its types, so it is unit-tested.

export interface ApplicationMenuOptions {
  edit(command: EditCommand): void;
  /** Adds the View menu: reload and the inspector. */
  readonly development: boolean;
}

/** The View menu in development: reload and the inspector, without the page zoom. */
const developmentViewMenu: MenuItemConstructorOptions = {
  label: "View",
  submenu: [
    { role: "reload" },
    { role: "forceReload" },
    { role: "toggleDevTools" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ],
};

export function applicationMenu(
  locale: TrayLocale,
  { edit, development }: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  const options = { locale };
  return [
    {
      label: m.app_name({}, options),
      submenu: [
        { role: "about", label: m.menu_about({}, options) },
        { type: "separator" },
        { role: "hide", label: m.menu_hide({}, options) },
        { role: "hideOthers", label: m.menu_hide_others({}, options) },
        { role: "unhide", label: m.menu_show_all({}, options) },
        { type: "separator" },
        { role: "quit", label: m.tray_quit({}, options) },
      ],
    },
    {
      role: "editMenu",
      label: m.menu_edit({}, options),
      submenu: [
        {
          label: m.menu_undo({}, options),
          accelerator: "CommandOrControl+Z",
          click: () => edit("undo"),
        },
        {
          label: m.menu_redo({}, options),
          accelerator: "Shift+CommandOrControl+Z",
          click: () => edit("redo"),
        },
        { type: "separator" },
        { role: "cut", label: m.menu_cut({}, options) },
        { role: "copy", label: m.menu_copy({}, options) },
        { role: "paste", label: m.menu_paste({}, options) },
        { role: "pasteAndMatchStyle", label: m.menu_paste_match_style({}, options) },
        { role: "delete", label: m.menu_delete({}, options) },
        { role: "selectAll", label: m.menu_select_all({}, options) },
      ],
    },
    // Development only, without the page zoom: ⌘− and ⌘+ zoom the calendar (ADR 037).
    ...(development ? [developmentViewMenu] : []),
    {
      role: "windowMenu",
      label: m.menu_window({}, options),
      submenu: [
        { role: "minimize", label: m.menu_minimize({}, options) },
        { role: "zoom", label: m.menu_zoom({}, options) },
        { type: "separator" },
        { role: "front", label: m.menu_front({}, options) },
      ],
    },
  ];
}
