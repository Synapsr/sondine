import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import type { ComponentProps } from "react";
import { XIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";
import { Button } from "./button";

// Sondine Toast (gui/components/sondine/toast.md). A fixed bottom-right
// viewport stacks toasts upward with S gaps. Each toast is a popover surface
// (neutral-1 light, neutral-2 dark, M radius and padding) whose contents stack
// with the XS gap; actions align to the end, the close sits in the corner.
// Enter and exit use the large motion curve. Base UI owns the lifecycle,
// announcements, timeouts (paused on hover and focus) and swipe dismissal.

/** Creates a manager for queueing toasts from outside React; pass it to `ToastProvider`. */
export const createToastManager = ToastPrimitive.createToastManager;

/** The toasts of the nearest provider, with `add`, `close`, `update` and `promise`. */
export const useToastManager = ToastPrimitive.useToastManager;

export type ToastObject = ToastPrimitive.Root.ToastObject;

export interface ToastProviderProps extends ToastPrimitive.Provider.Props {
  /** Accessible name of each toast's close button, such as "Fermer". */
  closeLabel: string;
  /** Accessible name of the notification region, such as "Notifications". */
  regionLabel: string;
}

/** Wrap the app once: provides the toast manager and renders the viewport. */
export function ToastProvider({ children, closeLabel, regionLabel, ...props }: ToastProviderProps) {
  return (
    <ToastPrimitive.Provider {...props}>
      {children}
      <ToastPortal>
        <ToastViewport aria-label={regionLabel}>
          <ToastList closeLabel={closeLabel} />
        </ToastViewport>
      </ToastPortal>
    </ToastPrimitive.Provider>
  );
}

export type ToastPortalProps = ToastPrimitive.Portal.Props;

/** Moves the viewport into the theme scope's portal container, or `<body>`. */
export function ToastPortal({ container, ...props }: ToastPortalProps) {
  const portalContainer = usePortalContainer();
  return (
    <ToastPrimitive.Portal
      data-slot="toast-portal"
      container={container ?? portalContainer}
      {...props}
    />
  );
}

export type ToastViewportProps = ToastPrimitive.Viewport.Props;

/** The notification region: fixed L from the bottom-right corner, at most 360px wide. */
export function ToastViewport({ className, ...props }: ToastViewportProps) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={mergeClassName(
        "fixed right-l bottom-l z-50 w-[min(360px,calc(100vw-var(--space-xl)))] outline-none",
        className,
      )}
      {...props}
    />
  );
}

export interface ToastListProps {
  /** Accessible name of each toast's close button. */
  closeLabel: string;
}

/** Renders the provider's toasts with the standard layout. */
export function ToastList({ closeLabel }: ToastListProps) {
  const { toasts } = useToastManager();
  return toasts.map((toast) => <Toast key={toast.id} toast={toast} closeLabel={closeLabel} />);
}

export interface ToastProps extends ToastRootProps {
  /** Accessible name of the close button. */
  closeLabel: string;
}

/**
 * One toast with the standard layout: title, description, the action from
 * `toast.actionProps` (pass `disabled` there to disable it) and a close button.
 */
export function Toast({ toast, closeLabel, ...props }: ToastProps) {
  return (
    <ToastRoot toast={toast} {...props}>
      <ToastContent>
        <ToastTitle />
        <ToastDescription />
        {toast.actionProps === undefined ? null : (
          <ToastActions>
            <ToastAction disabled={toast.actionProps.disabled} />
          </ToastActions>
        )}
        <ToastClose aria-label={closeLabel} />
      </ToastContent>
    </ToastRoot>
  );
}

// Toasts sit at the bottom of the viewport and move up by the height of the
// toasts in front plus one S gap each. Base UI writes its swipe drag to the
// inline transform, so the stack offset must be a transform too.
const rootClassName = cn(
  "group/toast absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full select-none",
  "corner-m bg-neutral-1 text-neutral-10 shadow-m ring-s ring-neutral-4-transparent dark:bg-neutral-2",
  "font-body font-regular text-body-s",
  "focus-ring",
  "[--toast-stack-gap:var(--space-s)]",
  "[--toast-stack-y:calc(-1*(var(--toast-offset-y)+var(--toast-index)*var(--toast-stack-gap)))]",
  "[--toast-translate-x:var(--toast-swipe-movement-x)]",
  "[--toast-translate-y:calc(var(--toast-stack-y)+var(--toast-swipe-movement-y))]",
  "transform-[translateX(var(--toast-translate-x))_translateY(var(--toast-translate-y))]",
  "transition-[transform,opacity] duration-motion-large ease-motion-large motion-reduce:transition-opacity",
  // Bridges the gap below each toast so hovering across the stack keeps it paused.
  "after:absolute after:inset-x-0 after:top-full after:h-[calc(var(--toast-stack-gap)+1px)]",
  "data-limited:opacity-0 data-starting-style:opacity-0 data-ending-style:opacity-0",
  // Enters from below the screen edge; leaves to the right, or along the swipe.
  "motion-safe:data-starting-style:[--toast-translate-y:calc(100%+var(--space-l))]",
  "motion-safe:data-ending-style:not-data-swipe-direction:[--toast-translate-x:calc(100%+var(--space-l))]",
  "motion-safe:data-ending-style:data-[swipe-direction=right]:[--toast-translate-x:calc(var(--toast-swipe-movement-x)+100%+var(--space-l))]",
  "motion-safe:data-ending-style:data-[swipe-direction=left]:[--toast-translate-x:calc(var(--toast-swipe-movement-x)-100%-var(--space-l))]",
  "motion-safe:data-ending-style:data-[swipe-direction=down]:[--toast-translate-y:calc(var(--toast-stack-y)+var(--toast-swipe-movement-y)+100%+var(--space-l))]",
  "motion-safe:data-ending-style:data-[swipe-direction=up]:[--toast-translate-y:calc(var(--toast-stack-y)+var(--toast-swipe-movement-y)-100%-var(--space-l))]",
);

export type ToastRootProps = ToastPrimitive.Root.Props;

/** The toast surface; owns swipe dismissal and the stack position. */
export function ToastRoot({ className, ...props }: ToastRootProps) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={mergeClassName(rootClassName, className)}
      {...props}
    />
  );
}

export type ToastContentProps = ToastPrimitive.Content.Props;

/** Stacks the toast's title, description and actions with the XS gap inside M padding. */
export function ToastContent({ className, ...props }: ToastContentProps) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={mergeClassName("flex flex-col gap-xs p-m", className)}
      {...props}
    />
  );
}

export type ToastTitleProps = ToastPrimitive.Title.Props;

/**
 * Defaults to `toast.title`. Keeps XL clear of the corner close button;
 * `data-disabled` switches to the disabled color.
 */
export function ToastTitle({ className, ...props }: ToastTitleProps) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={mergeClassName(
        cn(
          "m-zero text-neutral-10 font-body font-medium text-body-s",
          "group-has-[[data-slot=toast-close]]/toast:pe-xl",
          "data-disabled:text-neutral-6",
        ),
        className,
      )}
      {...props}
    />
  );
}

export type ToastDescriptionProps = ToastPrimitive.Description.Props;

/** Defaults to `toast.description`; `data-disabled` switches to the disabled color. */
export function ToastDescription({ className, ...props }: ToastDescriptionProps) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={mergeClassName(
        "m-zero text-neutral-7 font-body font-regular text-body-s data-disabled:text-neutral-6",
        className,
      )}
      {...props}
    />
  );
}

export type ToastActionsProps = ComponentProps<"div">;

/** Aligns the toast's actions to the end with the XS gap. */
export function ToastActions({ className, ...props }: ToastActionsProps) {
  return (
    <div
      data-slot="toast-actions"
      className={cn("flex items-center justify-end gap-xs", className)}
      {...props}
    />
  );
}

export type ToastActionProps = ToastPrimitive.Action.Props;

/**
 * A secondary Button. `toast.actionProps` supplies its label and handler and
 * takes precedence over children; it renders nothing without a label.
 */
export function ToastAction({ render, ...props }: ToastActionProps) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render ?? <Button variant="secondary" />}
      {...props}
    />
  );
}

export type ToastCloseProps = ToastPrimitive.Close.Props;

/**
 * An icon-only ghost Button, S from the top-right corner. Needs `aria-label`;
 * shows an X unless given children.
 */
export function ToastClose({ className, render, children, ...props }: ToastCloseProps) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={mergeClassName("absolute end-s top-s", className)}
      render={render ?? <Button variant="ghost" size="icon" />}
      {...props}
    >
      {children ?? <XIcon />}
    </ToastPrimitive.Close>
  );
}
