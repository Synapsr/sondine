import * as z from "zod";
import { BrowserAnswer, BrowserHello, BrowserMessage } from "./browser-messages";
import { PROTOCOL_VERSION, SPOOL_FORMAT_VERSION } from "./constants";
import { ControlMessage } from "./control-messages";
import { HelperEvent } from "./helper-events";
import { ManifestRecord } from "./manifest";
import { NotchCommand, NotchEvent } from "./notch-messages";
import { PHONE_RECORDING_HEADER_VERSION, PhoneRecordingHeader } from "./phone-recording";
import { PHONE_MEMORY_SCHEMAS } from "./phone-memory";
import { PHONE_SYNC_SCHEMAS, PHONE_SYNC_VERSION } from "./phone-sync";
import { protocolRegistry } from "./registry";

const GENERATED_NOTE =
  "Generated from packages/protocol/src by `pnpm --filter @sondine/protocol run gen`. Do not edit.";

const documents = [
  {
    file: "control-message.json",
    title: "Sondine helper control message",
    description: `One JSON line sent by core to sondine-audio, protocol ${PROTOCOL_VERSION}.`,
    id: `urn:sondine:protocol:${PROTOCOL_VERSION}:control-message`,
    schema: ControlMessage,
  },
  {
    file: "helper-event.json",
    title: "Sondine helper event",
    description: `One JSON line sent by sondine-audio to core, protocol ${PROTOCOL_VERSION}.`,
    id: `urn:sondine:protocol:${PROTOCOL_VERSION}:helper-event`,
    schema: HelperEvent,
  },
  {
    file: "manifest-record.json",
    title: "Sondine spool manifest record",
    description: `One JSON line of a spool manifest, format version ${SPOOL_FORMAT_VERSION}.`,
    id: `urn:sondine:spool:${SPOOL_FORMAT_VERSION}:manifest-record`,
    schema: ManifestRecord,
  },
  {
    file: "browser-message.json",
    title: "Sondine browser extension message",
    description:
      "One native message from Sondine's browser extension, one JSON line on core's browser socket.",
    id: "urn:sondine:browser:1:browser-message",
    schema: BrowserMessage,
  },
  {
    file: "browser-handshake.json",
    title: "Sondine browser relay handshake",
    description: "The relay's hello to core, or core's answer to it.",
    id: "urn:sondine:browser:1:browser-handshake",
    schema: z.union([BrowserHello, BrowserAnswer]),
  },
  {
    file: "notch-command.json",
    title: "Sondine notch command",
    description: "One JSON line main sends sondine-notch: what the notch shows during a call.",
    id: "urn:sondine:notch:1:notch-command",
    schema: NotchCommand,
  },
  {
    file: "notch-event.json",
    title: "Sondine notch event",
    description: "One JSON line sondine-notch sends main: what the user clicked.",
    id: "urn:sondine:notch:1:notch-event",
    schema: NotchEvent,
  },
  {
    file: "phone-recording-header.json",
    title: "Sondine phone recording header",
    description:
      "The JSON the iPhone app writes in a recording's comment tag, before its first sample (ADR 032).",
    id: `urn:sondine:phone:${PHONE_RECORDING_HEADER_VERSION}:recording-header`,
    schema: PhoneRecordingHeader,
  },
  {
    file: "phone-sync.json",
    title: "Sondine phone sync messages",
    description:
      "Every JSON body the iPhone app and the Mac exchange, the pairing QR and the relay's hello, as `$defs` (ADR 008).",
    id: `urn:sondine:phone:${PHONE_SYNC_VERSION}:sync`,
    schema: z.union(Object.values(PHONE_SYNC_SCHEMAS)),
  },
  {
    file: "phone-memory.json",
    title: "Sondine phone memory reads",
    description:
      "The JSON bodies of the phone's live reads of the Mac's memory: search, a day, its journal, the open commitments and a conversation's text, as `$defs` (ADR 008, M5.4).",
    id: `urn:sondine:phone:${PHONE_SYNC_VERSION}:memory`,
    schema: z.union(Object.values(PHONE_MEMORY_SCHEMAS)),
  },
] as const;

export type JsonSchemaDocument = Record<string, unknown>;

/**
 * Builds every JSON Schema file of `schemas/`, keyed by file name. The schemas
 * describe the wire form (`io: "input"`), so clocks are decimal strings.
 * Cross-field rules (ranges, uniqueness, consistency) are not expressible in
 * JSON Schema; the fixtures and the zod schemas carry them.
 */
export function buildJsonSchemaFiles(): Record<string, JsonSchemaDocument> {
  const files: Record<string, JsonSchemaDocument> = {};
  for (const document of documents) {
    const generated = z.toJSONSchema(document.schema, {
      target: "draft-2020-12",
      io: "input",
      metadata: protocolRegistry,
      unrepresentable: "throw",
    });
    const { $schema, ...rest } = generated;
    files[document.file] = {
      $schema,
      $id: document.id,
      $comment: GENERATED_NOTE,
      title: document.title,
      description: document.description,
      ...rest,
    };
  }
  return files;
}
