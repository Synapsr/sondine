import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type { ComponentProps } from "react";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";
import { Button, type ButtonProps } from "./button";
import { dialogClassNames } from "./dialog";

// Sondine Alert dialog (gui/components/sondine/alert-dialog.md). Its surface,
// backdrop and text resolve to the Dialog values, so it reuses them. Unlike a
// dialog, it stays open on outside presses (Base UI), its cancel control is
// an outline Button and the confirm action is explicit.

export type AlertDialogProps = AlertDialogPrimitive.Root.Props;

/** Groups the parts of an alert dialog. Always modal. Renders no element. */
export const AlertDialog: typeof AlertDialogPrimitive.Root = AlertDialogPrimitive.Root;

/** Connects an alert dialog to triggers rendered outside of it. */
export const createAlertDialogHandle: typeof AlertDialogPrimitive.createHandle =
  AlertDialogPrimitive.createHandle;

export interface AlertDialogTriggerProps
  extends AlertDialogPrimitive.Trigger.Props, Pick<ButtonProps, "variant" | "size"> {}

/** Opens the alert dialog. An outline Button unless `variant` or `render` says otherwise. */
export function AlertDialogTrigger({
  variant = "outline",
  size,
  render,
  ...props
}: AlertDialogTriggerProps) {
  return (
    <AlertDialogPrimitive.Trigger
      data-slot="alert-dialog-trigger"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export interface AlertDialogPopupProps extends AlertDialogPrimitive.Popup.Props {
  /** Portal options. The container defaults to the current theme scope's portal container. */
  portalProps?: AlertDialogPrimitive.Portal.Props | undefined;
}

/** The centered surface, with its portal and backdrop. */
export function AlertDialogPopup({ className, portalProps, ...props }: AlertDialogPopupProps) {
  const container = usePortalContainer();
  return (
    <AlertDialogPrimitive.Portal
      data-slot="alert-dialog-portal"
      container={container}
      {...portalProps}
    >
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-backdrop"
        className={dialogClassNames.backdrop}
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-popup"
        className={mergeClassName(dialogClassNames.popup, className)}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

export interface AlertDialogTitleProps extends AlertDialogPrimitive.Title.Props {
  /** Dims the title when the alert's content is unavailable. */
  disabled?: boolean | undefined;
}

/** Labels the alert dialog. */
export function AlertDialogTitle({ className, disabled = false, ...props }: AlertDialogTitleProps) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      data-disabled={disabled ? "" : undefined}
      className={mergeClassName(dialogClassNames.title, className)}
      {...props}
    />
  );
}

export interface AlertDialogDescriptionProps extends AlertDialogPrimitive.Description.Props {
  /** Dims the description when the alert's content is unavailable. */
  disabled?: boolean | undefined;
}

/** Describes what confirming will do. */
export function AlertDialogDescription({
  className,
  disabled = false,
  ...props
}: AlertDialogDescriptionProps) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      data-disabled={disabled ? "" : undefined}
      className={mergeClassName(dialogClassNames.description, className)}
      {...props}
    />
  );
}

export type AlertDialogFooterProps = ComponentProps<"div">;

/** Holds the cancel and confirm actions, aligned to the end, wrapping when needed. */
export function AlertDialogFooter({ className, ...props }: AlertDialogFooterProps) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(dialogClassNames.footer, className)}
      {...props}
    />
  );
}

export interface AlertDialogCloseProps
  extends AlertDialogPrimitive.Close.Props, Pick<ButtonProps, "variant" | "size"> {}

/** Cancels and closes the alert dialog. An outline Button unless `variant` or `render` says otherwise. */
export function AlertDialogClose({
  variant = "outline",
  size,
  render,
  ...props
}: AlertDialogCloseProps) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-close"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export type AlertDialogActionProps = ButtonProps;

/**
 * The confirm action: a primary Button that does not close the alert by
 * itself, so it can stay pending while the work runs.
 */
export function AlertDialogAction(props: AlertDialogActionProps) {
  return <Button data-slot="alert-dialog-action" {...props} />;
}
