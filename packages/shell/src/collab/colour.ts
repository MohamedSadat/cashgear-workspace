// Presence colours (contract section 4): one of eight theme tokens, `--cgw-presence-1` … `-8`
// (collab.css, light and dark), chosen by a stable hash of the person's id, so a person has the
// same colour on every device and in every session. Never from a message.

export const PRESENCE_COLOURS = 8;

/** 1 to 8: FNV-1a over the id's UTF-16 code units, stable and well spread over random ids. */
export function colourIndex(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % PRESENCE_COLOURS) + 1;
}

/** The person's colour as a CSS value the editor's cursors and the avatars draw with. */
export const colourOf = (userId: string) => `var(--cgw-presence-${colourIndex(userId)})`;

const ARABIC = /\p{Script=Arabic}/u;

/** The first character of a word as drawn (a letter with its marks), upper-cased. */
function firstOf(word: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Segmenter
    ? (new Segmenter(undefined, { granularity: 'grapheme' }).segment(word)[Symbol.iterator]().next()
        .value?.segment ?? '')
    : (Array.from(word)[0] ?? '');
  return first.toLocaleUpperCase();
}

/**
 * The avatar's letters: the first of the first and last words ("Ada Lovelace" → "AL"). A name in
 * Arabic script takes one letter: two Arabic letters side by side join into a word.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = firstOf(words[0]);
  if (words.length === 1 || ARABIC.test(name)) return first;
  return first + firstOf(words[words.length - 1]);
}
