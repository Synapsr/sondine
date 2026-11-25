import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { XIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";
import { Button, type ButtonProps } from "./button";

// Sondine Dialog (gui/components/sondine/dialog.md). The trigger, action and
// close parts reference Button (outline, primary, ghost), so they render it.
// The surface edge is a ring at the theme's border width (0 in this theme),
// composed with the m elevation; it has no bevel overlay.
//
// The surface and backdrop name a different token per mode, picked from the
// nearest theme scope.

/** Surface, backdrop and text classes. Alert dialog resolves the same values. */
export const dialogClassNames = {
  backdrop: cn(
    "fixed inset-0 bg-[color:light-dark(var(--neutral-10-transparent),var(--neutral-1-transparent))]",
    "transition-opacity duration-motion-large ease-motion-large",
    "data-starting-style:opacity-0 data-ending-style:opacity-0",
  ),
  popup: cn(
    "group/dialog-popup fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
    "flex w-[min(400px,calc(100vw-var(--space-xl)))] max-h-[calc(100dvh-var(--space-xl))] flex-col gap-s overflow-y-auto",
    "corner-m bg-[color:light-dark(var(--neutral-1),var(--neutral-2))] p-l text-neutral-10",
    "font-body font-regular text-body-s",
    "ring-s ring-neutral-4-transparent shadow-m outline-none",
    "transition-[opacity,scale] duration-motion-large ease-motion-large",
    "data-starting-style:opacity-0 data-ending-style:opacity-0",
    "motion-safe:data-starting-style:scale-(--motion-popup-scale) motion-safe:data-ending-style:scale-(--motion-popup-scale)",
  ),
  /**
   * `side="end"`: a drawer along the window's inline-end edge, full height
   * with the window's margin, sliding in from that edge (Téo, 2026-11-19).
   */
  drawer: cn(
    "group/dialog-popup fixed inset-y-xs end-xs",
    "flex w-[min(26rem,calc(100vw-var(--space-xl)))] flex-col gap-s overflow-y-auto",
    "corner-l bg-[color:light-dark(var(--neutral-1),var(--neutral-2))] p-l text-neutral-10",
    "font-body font-regular text-body-s",
    "ring-s ring-neutral-4-transparent shadow-m outline-none",
    "transition-[opacity,translate] duration-motion-large ease-motion-large",
    "data-starting-style:opacity-0 data-ending-style:opacity-0",
    "motion-safe:data-starting-style:translate-x-[2rem] motion-safe:data-ending-style:translate-x-[2rem]",
  ),
  title: cn(
    "font-body font-medium text-body-m text-neutral-10",
    "data-disabled:text-neutral-6",
    // Leaves room for the corner close control when the popup has one.
    "group-has-[[data-slot=dialog-corner-close]]/dialog-popup:pe-xl",
  ),
  description: cn(
    "font-body font-regular text-body-s text-neutral-7",
    "data-disabled:text-neutral-6",
  ),
  footer: "mt-xs flex flex-wrap items-center justify-end gap-xs",
} as const;

export type DialogProps = DialogPrimitive.Root.Props;

/** Groups the parts of a modal dialog. Renders no element. */
export const Dialog: typeof DialogPrimitive.Root = DialogPrimitive.Root;

/** Connects a dialog to triggers rendered outside of it. */
export const createDialogHandle: typeof DialogPrimitive.createHandle = DialogPrimitive.createHandle;

export interface DialogTriggerProps
  extends DialogPrimitive.Trigger.Props, Pick<ButtonProps, "variant" | "size"> {}

/** Opens the dialog. An outline Button unless `variant` or `render` says otherwise. */
export function DialogTrigger({ variant = "outline", size, render, ...props }: DialogTriggerProps) {
  return (
    <DialogPrimitive.Trigger
      data-slot="dialog-trigger"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export interface DialogPopupProps extends DialogPrimitive.Popup.Props {
  /** Portal options. The container defaults to the current theme scope's portal container. */
  portalProps?: DialogPrimitive.Portal.Props | undefined;
  /** Centered (the default), or a drawer along the inline-end edge. */
  side?: "center" | "end" | undefined;
}

/** The surface, centered or as a drawer, with its portal and backdrop. */
export function DialogPopup({
  className,
  portalProps,
  side = "center",
  ...props
}: DialogPopupProps) {
  const container = usePortalContainer();
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal" container={container} {...portalProps}>
      <DialogPrimitive.Backdrop data-slot="dialog-backdrop" className={dialogClassNames.backdrop} />
      <DialogPrimitive.Popup
        data-slot="dialog-popup"
        data-side={side}
        className={mergeClassName(
          side === "end" ? dialogClassNames.drawer : dialogClassNames.popup,
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

export interface DialogTitleProps extends DialogPrimitive.Title.Props {
  /** Dims the title when the dialog's content is unavailable. */
  disabled?: boolean | undefined;
}

/** Labels the dialog. */
export function DialogTitle({ className, disabled = false, ...props }: DialogTitleProps) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      data-disabled={disabled ? "" : undefined}
      className={mergeClassName(dialogClassNames.title, className)}
      {...props}
    />
  );
}

export interface DialogDescriptionProps extends DialogPrimitive.Description.Props {
  /** Dims the description when the dialog's content is unavailable. */
  disabled?: boolean | undefined;
}

/** Describes the dialog. */
export function DialogDescription({
  className,
  disabled = false,
  ...props
}: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      data-disabled={disabled ? "" : undefined}
      className={mergeClassName(dialogClassNames.description, className)}
      {...props}
    />
  );
}

export type DialogFooterProps = ComponentProps<"div">;

/** Holds the actions, aligned to the end, wrapping when needed. */
export function DialogFooter({ className, ...props }: DialogFooterProps) {
  return (
    <div data-slot="dialog-footer" className={cn(dialogClassNames.footer, className)} {...props} />
  );
}

export interface DialogCloseProps
  extends DialogPrimitive.Close.Props, Pick<ButtonProps, "variant" | "size"> {}

/** Closes the dialog. A ghost Button unless `variant` or `render` says otherwise. */
export function DialogClose({ variant = "ghost", size, render, ...props }: DialogCloseProps) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export interface DialogCornerCloseProps extends Omit<DialogPrimitive.Close.Props, "children"> {
  /** Accessible name of the icon-only control, for example "Fermer". */
  "aria-label": string;
}

/** Icon-only ghost close control in the popup's top inline-end corner. */
export function DialogCornerClose({ className, ...props }: DialogCornerCloseProps) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-corner-close"
      className={mergeClassName("absolute top-s end-s", className)}
      render={<Button variant="ghost" size="icon" />}
      {...props}
    >
      <XIcon />
    </DialogPrimitive.Close>
  );
}

export type DialogActionProps = ButtonProps;

/** The dialog's configured action: a primary Button that does not close the dialog by itself. */
export function DialogAction(props: DialogActionProps) {
  return <Button data-slot="dialog-action" {...props} />;
}
