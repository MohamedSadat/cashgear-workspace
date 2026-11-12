// Property and option ids (Phase 4 contracts, section 1): 8 characters of base 62, unique within
// their database or property; the title property's id is `title`. Ids the user makes are random;
// the options a type change or an import needs are derived (`derivedOption`), so the planner and
// the server make the same ones without talking to each other.
import type { Id } from '../ids';
import { DIGITS } from '../order';
import { sha256, utf8 } from './hash';
import { TITLE_PROPERTY, type OptionColour, type OptionId, type PropertyId } from './types';

const ID_LENGTH = 8;
const BASE62_ID = /^[0-9A-Za-z]{8}$/;

function randomId(): string {
  let id = '';
  const bytes = new Uint8Array(16);
  while (id.length < ID_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    // 248 = 4 × 62: bytes above it are dropped so every digit is equally likely.
    for (const byte of bytes) if (byte < 248 && id.length < ID_LENGTH) id += DIGITS[byte % 62];
  }
  return id;
}

export const newPropertyId = (): PropertyId => randomId();
export const newOptionId = (): OptionId => randomId();

export const isPropertyId = (value: unknown): value is PropertyId =>
  value === TITLE_PROPERTY || (typeof value === 'string' && BASE62_ID.test(value));
export const isOptionId = (value: unknown): value is OptionId =>
  typeof value === 'string' && BASE62_ID.test(value);

/** The colours a derived option is given, picked by its hash. */
export const OPTION_COLOURS: readonly OptionColour[] = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
];

/**
 * The id and colour of an option made for `name` by a type change or an import: SHA-256 of the
 * UTF-8 of `databaseId NUL propertyId NUL name` (then `NUL attempt` from attempt 1 while the id is
 * taken in the property); the id is bytes 0 to 7, each mod 62, as base-62 digits
 * (`0-9A-Za-z`); the colour is byte 8 mod 9 in `OPTION_COLOURS`.
 */
export function derivedOption(
  databaseId: Id,
  propertyId: PropertyId,
  name: string,
  taken: ReadonlySet<OptionId> = new Set(),
): { id: OptionId; colour: OptionColour } {
  for (let attempt = 0; ; attempt++) {
    const parts = [databaseId, propertyId, name];
    if (attempt > 0) parts.push(String(attempt));
    const hash = sha256(utf8(parts.join('\u0000')));
    let id = '';
    for (let i = 0; i < ID_LENGTH; i++) id += DIGITS[hash[i] % 62];
    if (!taken.has(id)) return { id, colour: OPTION_COLOURS[hash[8] % OPTION_COLOURS.length] };
  }
}
