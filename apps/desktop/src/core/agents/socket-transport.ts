import type { Socket } from "node:net";
import {
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";

// One agent session's MCP stream over the agent socket, after the hello: one
// JSON-RPC message per line, both ways (the stdio framing, which the relay
// copies as is). The policy sees every message before the MCP server does
// and every message before the agent does, so access, deletions and the call
// log are decided at the edge, whatever the server does in between. The
// transport owns the socket: closing it ends the socket too.

/** A message from the agent the policy answers itself, without the server. */
export interface PolicyReply {
  readonly reply: JSONRPCMessage;
  /** End the session once the reply is written. */
  readonly thenClose: boolean;
}

export interface TransportPolicy {
  /** Null passes the message on to the MCP server. */
  readonly inbound: (message: JSONRPCMessage) => PolicyReply | null;
  /** The message to write instead (often the same one). */
  readonly outbound: (message: JSONRPCMessage) => PolicyReply;
}

/** One message from an agent may not be larger. */
export const MAX_INBOUND_BYTES = 1 << 20;
/** An agent that leaves more than this unread is dropped. */
export const MAX_UNREAD_BYTES = 8 << 20;
/** How long a closing socket may take to flush before it is destroyed. */
const CLOSE_GRACE_MS = 1_000;

export class SocketTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  readonly #socket: Socket;
  readonly #initial: Buffer;
  readonly #policy: TransportPolicy;
  readonly #buffer = new ReadBuffer({ maxBufferSize: MAX_INBOUND_BYTES });
  #closing = false;
  #closed = false;

  /** `initial`: bytes that arrived with the hello, already part of the stream. */
  constructor(socket: Socket, initial: Buffer, policy: TransportPolicy) {
    this.#socket = socket;
    this.#initial = initial;
    this.#policy = policy;
  }

  async start(): Promise<void> {
    this.#socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#socket.on("error", (error) => this.onerror?.(error));
    this.#socket.on("close", () => this.#finish());
    if (this.#initial.length > 0) this.#receive(this.#initial);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closing) return;
    const answer = this.#policy.outbound(message);
    this.#write(answer.reply);
    if (answer.thenClose) await this.close();
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#socket.end();
    setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS).unref();
    this.#finish();
  }

  #receive(chunk: Buffer): void {
    if (this.#closing) return;
    try {
      this.#buffer.append(chunk);
      for (
        let message = this.#buffer.readMessage();
        message !== null;
        message = this.#buffer.readMessage()
      ) {
        const answer = this.#policy.inbound(message);
        if (answer === null) {
          this.onmessage?.(message);
          continue;
        }
        this.#write(answer.reply);
        if (answer.thenClose) {
          void this.close();
          return;
        }
      }
    } catch (error) {
      // An oversized or malformed message ends the session.
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }
  }

  #write(message: JSONRPCMessage): void {
    if (this.#socket.destroyed) return;
    if (this.#socket.writableLength > MAX_UNREAD_BYTES) {
      this.onerror?.(new Error("the agent stopped reading"));
      this.#socket.destroy();
      this.#finish();
      return;
    }
    this.#socket.write(serializeMessage(message));
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    this.#buffer.clear();
    this.onclose?.();
  }
}
