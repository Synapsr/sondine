import { createConnection, type Socket } from "node:net";
import {
  ControlMessage,
  createJsonLinesDecoder,
  encodeJsonLine,
  HelperEvent,
  type JsonLineError,
} from "@sondine/protocol";

// One connection to `sondine-audio`'s Unix socket, speaking the JSON-lines
// protocol of @sondine/protocol. Reconnecting is the caller's job.

export interface HelperSocketHandlers {
  onEvent(event: HelperEvent): void;
  /** A line that is not a valid helper event; the connection stays open. */
  onDecodeError(error: JsonLineError, line: number): void;
  onClose(error: Error | undefined): void;
}

export interface HelperSocket {
  /** Validates and writes one control message; throws when it does not encode. */
  send(message: ControlMessage): void;
  /** Stops reading: the helper's writes wait in the kernel and in its own buffers. */
  pause(): void;
  resume(): void;
  close(): void;
}

export class HelperEncodeError extends Error {
  override readonly name = "HelperEncodeError";
}

export function openHelperSocket(
  path: string,
  handlers: HelperSocketHandlers,
): { connected: Promise<HelperSocket>; cancel(): void } {
  const socket: Socket = createConnection({ path });
  const decoder = createJsonLinesDecoder(HelperEvent);
  let open = false;
  let closed = false;

  const helperSocket: HelperSocket = {
    send(message) {
      const encoded = encodeJsonLine(ControlMessage, message);
      if (!encoded.ok) {
        throw new HelperEncodeError(`${message.type}: ${encoded.error.message}`);
      }
      socket.write(encoded.line);
    },
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    close() {
      if (!closed) socket.end();
      // A peer that never closes its side must not hold the connection.
      setTimeout(() => socket.destroy(), 1_000).unref();
    },
  };

  const connected = new Promise<HelperSocket>((resolve, reject) => {
    socket.once("connect", () => {
      open = true;
      resolve(helperSocket);
    });
    socket.on("data", (chunk: Buffer) => {
      for (const result of decoder.push(chunk)) {
        if (result.ok) handlers.onEvent(result.value);
        else handlers.onDecodeError(result.error, result.line);
      }
    });
    let failure: Error | undefined;
    socket.on("error", (error) => {
      failure = error;
      if (!open) reject(error);
    });
    socket.once("close", () => {
      closed = true;
      if (!open) {
        reject(failure ?? new Error("helper socket closed before connecting"));
        return;
      }
      for (const result of decoder.end()) {
        if (!result.ok) handlers.onDecodeError(result.error, result.line);
      }
      handlers.onClose(failure);
    });
  });

  return { connected, cancel: () => socket.destroy() };
}
