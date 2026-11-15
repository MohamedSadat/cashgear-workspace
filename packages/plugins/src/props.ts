// A block's props as text (`pluginBlock.props`, JSON) and back (INTEGRATIONS.md, Plugin blocks):
// read validates every known prop and keeps every unknown one; a write merges the definition's
// props over what was read, so a newer build's props survive an older build's edit.
import type { BlockDefinition } from './types';

/** The JSON object a block holds, or an empty one for none, text that is not JSON, or not an object. */
export function parseProps(text: string | null | undefined): Record<string, unknown> {
  if (typeof text !== 'string' || !text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A block read by its definition: its props, what it held, and whether this build may write it. */
export interface ReadBlock<Props> {
  props: Props;
  /** Every key the block held, known or not, as it held them. */
  raw: Record<string, unknown>;
  /** The block was last written by a later version of the definition: drawn read-only. */
  newer: boolean;
}

export function readBlock<Props extends object>(
  definition: BlockDefinition<Props>,
  text: string | null | undefined,
  version: number | null | undefined,
): ReadBlock<Props> {
  const raw = parseProps(text);
  return {
    props: definition.props.read(raw),
    raw,
    newer: typeof version === 'number' && version > definition.version,
  };
}

/**
 * The text a write stores: what the block held, with the definition's props over it. A prop set
 * to `undefined` is removed; every key the definition does not know is kept, in its place.
 */
export function writeProps<Props extends object>(
  raw: Readonly<Record<string, unknown>>,
  next: Props,
): string {
  const merged: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return JSON.stringify(merged);
}

// Small readers for definitions' prop schemas: each gives the value when it is of the right kind,
// else the fallback.
export const readString = (value: unknown, fallback: string | null = null): string | null =>
  typeof value === 'string' && value !== '' ? value : fallback;

export function readOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export const readStrings = (value: unknown, max = 100): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v !== ''))].slice(
        0,
        max,
      )
    : [];
