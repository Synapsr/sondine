import { type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

const literal = (value: string): SQL => {
  if (!/^[a-z_]+$/.test(value)) throw new Error(`Unsafe enum literal: ${value}`);
  return sql.raw(`'${value}'`);
};

/** `column IN ('a', 'b', …)` with inlined literals, for CHECK constraints. */
export const oneOf = (column: AnySQLiteColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.join(values.map(literal), sql`, `)})`;
