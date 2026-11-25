import type { SQLOutputValue } from "node:sqlite";

export type Row = Record<string, SQLOutputValue>;

export class RowShapeError extends TypeError {
  override readonly name = "RowShapeError";
}

export function int(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new RowShapeError(`Column ${key} is not an integer: ${String(value)}`);
}

export function intOrNull(row: Row, key: string): number | null {
  return row[key] === null ? null : int(row, key);
}

export function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  throw new RowShapeError(`Column ${key} is not a number: ${String(value)}`);
}

export function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  throw new RowShapeError(`Column ${key} is not text: ${String(value)}`);
}

export function strOrNull(row: Row, key: string): string | null {
  return row[key] === null ? null : str(row, key);
}

export function oneOfValues<const T extends string>(
  row: Row,
  key: string,
  values: readonly T[],
): T {
  const value = str(row, key);
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new RowShapeError(`Column ${key} has unexpected value ${value}`);
  return match;
}
