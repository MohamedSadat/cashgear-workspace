// A DOM for running the editor under Node (fuzz and scenario tests).
import { JSDOM } from 'jsdom';

export function installDom(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const names = [
    'window',
    'document',
    'Node',
    'Text',
    'Element',
    'HTMLElement',
    'MutationObserver',
    'DOMParser',
    'Range',
    'Selection',
    'Event',
    'KeyboardEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = name === 'window' ? win : (win as unknown as Record<string, unknown>)[name];
    Object.defineProperty(target, name, {
      value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(win) : value,
      configurable: true,
      writable: true,
    });
  }
}
