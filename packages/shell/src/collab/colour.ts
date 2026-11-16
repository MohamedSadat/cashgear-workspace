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

/**
 * A person's avatar colours for the library's `CgAvatar` (Track U7): their colour, and the text
 * that holds contrast on it in each theme (white in the light theme, the page's dark in the dark).
 */
export const avatarColours = (userId: string) => ({
  color: colourOf(userId),
  textColor: 'var(--cgw-presence-text)',
});
