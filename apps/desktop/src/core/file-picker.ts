import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import type { ClipboardContent, PickPurpose } from "../shared/core-messages";
import { MainChannel } from "./main-channel";

// Open panels for core (a model file, an audio file to import, files for a
// conversation's context) and the clipboard: main owns OS dialogs and the
// pasteboard, so core asks (`pick-file`, `pick-files`, `read-clipboard`) and
// main answers with the chosen paths or what the clipboard holds. Paths
// never go through the window.

export interface PickRequest {
  readonly purpose: PickPurpose;
  /** What the panel asks for, for its message and filter. */
  readonly label: string;
  readonly extensions: readonly string[];
}

export interface FilePickerService {
  /** The path the user chose; null when the panel was closed or left open too long. */
  pick(request: PickRequest): Promise<string | null>;
  /** Main's answer to `pick-file`. */
  receive(requestId: string, path: string | null): void;
  /** Any files, up to 20, for a conversation's context (ADR 024); none when the panel was closed. */
  pickFiles(): Promise<string[]>;
  receiveFiles(requestId: string, paths: readonly string[]): void;
  /** What the clipboard holds; null when main could not read it. */
  readClipboard(): Promise<ClipboardContent | null>;
  receiveClipboard(requestId: string, content: ClipboardContent | null): void;
}

export class FilePicker extends Context.Service<FilePicker, FilePickerService>()(
  "sondine/core/FilePicker",
) {}

/** An open panel left open this long counts as closed (10 min). */
export const filePickerLayer = (options: { readonly timeoutMs?: number } = {}) =>
  Layer.effect(
    FilePicker,
    Effect.gen(function* () {
      const main = yield* MainChannel;
      const timeoutMs = options.timeoutMs ?? 10 * 60_000;
      const waiting = new Map<string, (path: string | null) => void>();
      const waitingFiles = new Map<string, (paths: readonly string[]) => void>();
      const waitingClipboard = new Map<string, (content: ClipboardContent | null) => void>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const answer of waiting.values()) answer(null);
          for (const answer of waitingFiles.values()) answer([]);
          for (const answer of waitingClipboard.values()) answer(null);
        }),
      );
      /** One request to main, answered once (or by `fallback` after the timeout). */
      const ask = <A>(
        pending: Map<string, (value: A) => void>,
        fallback: A,
        limitMs: number,
        send: (requestId: string) => void,
      ) =>
        new Promise<A>((resolve) => {
          const requestId = randomUUID();
          const timer = setTimeout(() => answer(fallback), limitMs);
          const answer = (value: A) => {
            clearTimeout(timer);
            pending.delete(requestId);
            resolve(value);
          };
          pending.set(requestId, answer);
          send(requestId);
        });
      return FilePicker.of({
        pick: (request) =>
          new Promise((resolve) => {
            const requestId = randomUUID();
            const timer = setTimeout(() => answer(null), timeoutMs);
            const answer = (path: string | null) => {
              clearTimeout(timer);
              waiting.delete(requestId);
              resolve(path);
            };
            waiting.set(requestId, answer);
            main.post({
              type: "pick-file",
              requestId,
              purpose: request.purpose,
              label: request.label,
              extensions: [...request.extensions],
            });
          }),
        receive: (requestId, path) => waiting.get(requestId)?.(path),
        pickFiles: () =>
          ask<readonly string[]>(waitingFiles, [], timeoutMs, (requestId) =>
            main.post({ type: "pick-files", requestId }),
          ).then((paths) => [...paths]),
        receiveFiles: (requestId, paths) => waitingFiles.get(requestId)?.(paths),
        readClipboard: () =>
          ask<ClipboardContent | null>(waitingClipboard, null, 10_000, (requestId) =>
            main.post({ type: "read-clipboard", requestId }),
          ),
        receiveClipboard: (requestId, content) => waitingClipboard.get(requestId)?.(content),
      });
    }),
  );
