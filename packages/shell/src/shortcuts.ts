// Keyboard shortcuts through `event.code`, as Sheet does, so a chord means the same key on an
// Arabic layout as on an English one. "Mod" is Ctrl, or Cmd on a Mac.
//   'Mod+KeyK', 'Mod+Shift+KeyL', 'Alt+Shift+ArrowUp', 'Mod+Backslash'

export interface Chord {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function parseShortcut(shortcut: string): Chord {
  const parts = shortcut.split('+');
  const code = parts.pop();
  if (!code) throw new Error(`Empty shortcut: ${shortcut}`);
  const chord: Chord = { mod: false, shift: false, alt: false, code };
  for (const part of parts) {
    if (part === 'Mod') chord.mod = true;
    else if (part === 'Shift') chord.shift = true;
    else if (part === 'Alt') chord.alt = true;
    else throw new Error(`Unknown modifier "${part}" in ${shortcut}`);
  }
  return chord;
}

type KeyEventLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

export function matchesShortcut(event: KeyEventLike, shortcut: string, mac = isMac()): boolean {
  const chord = parseShortcut(shortcut);
  const mod = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  return (
    event.code === chord.code &&
    mod === chord.mod &&
    !other &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt
  );
}

const keyNames: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backslash: '\\',
  Slash: '/',
  Period: '.',
  Comma: ',',
  BracketLeft: '[',
  BracketRight: ']',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Del',
  Space: 'Space',
  Tab: 'Tab',
};

/** How a shortcut is written in menus: "Ctrl+Shift+K", or "⌘⇧K" on a Mac. */
export function formatShortcut(shortcut: string, mac = isMac()): string {
  const chord = parseShortcut(shortcut);
  const key =
    keyNames[chord.code] ??
    chord.code
      .replace(/^Key/, '')
      .replace(/^Digit/, '')
      .replace(/^Numpad/, '');
  if (mac) return `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${key}`;
  return [chord.mod && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', key]
    .filter(Boolean)
    .join('+');
}
