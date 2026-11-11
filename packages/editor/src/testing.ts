// A DOM under Node, for the editor's tests (as Phase 0's harness had).
import { JSDOM } from 'jsdom';

export function installDom(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis;
  const names = [
    'window',
    'document',
    'Node',
    'Text',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'MutationObserver',
    'DOMParser',
    'Range',
    'Selection',
    'Event',
    'KeyboardEvent',
    'ClipboardEvent',
    'DragEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = name === 'window' ? win : (win as unknown as Record<string, unknown>)[name];
    if (value === undefined) continue;
    Object.defineProperty(target, name, {
      value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(win) : value,
      configurable: true,
      writable: true,
    });
  }
}

/**
 * Presses a key as a browser would: through ProseMirror's keydown handlers, so a transaction is
 * dispatched exactly as a real keypress dispatches it. (Tiptap's keyboardShortcut command replays
 * the steps of a captured transaction through its own mapping, which drops an insert that follows
 * a delete of the same range.)
 */
export function pressKey(view: import('@tiptap/pm/view').EditorView, name: string): boolean {
  const parts = name.split('-');
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const mac = false;
  const event = new KeyboardEvent('keydown', {
    key: key.length === 1 ? key.toLowerCase() : key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    shiftKey: mods.has('shift'),
    altKey: mods.has('alt'),
    ctrlKey: mods.has('ctrl') || (!mac && mods.has('mod')),
    metaKey: mods.has('meta') || (mac && mods.has('mod')),
    bubbles: true,
    cancelable: true,
  });
  return view.someProp('handleKeyDown', (f) => f(view, event)) ?? false;
}
