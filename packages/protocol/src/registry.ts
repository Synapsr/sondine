import * as z from "zod";

export interface ProtocolMeta {
  id?: string;
  title?: string;
  description?: string;
}

/**
 * Metadata for JSON Schema export. A private registry keeps protocol ids out
 * of zod's global registry, which other packages share.
 */
export const protocolRegistry = z.registry<ProtocolMeta>();

/**
 * Registers a schema that becomes a named `$defs` entry in the JSON Schemas.
 * Pass a fresh instance: the registry is keyed by instance.
 */
export function named<T extends z.ZodType>(id: string, description: string, schema: T): T {
  protocolRegistry.add(schema, { id, description });
  return schema;
}

/**
 * Returns a copy of `schema` carrying a field-level description. The copy is
 * inlined in JSON Schema, so the shared original keeps its own `$defs` entry.
 */
export function described<T extends z.ZodType>(description: string, schema: T): T {
  const copy = schema.clone();
  protocolRegistry.add(copy, { description });
  return copy;
}
