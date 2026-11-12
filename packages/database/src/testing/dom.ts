// A browser for the component tests: jsdom's window as the globals React and the CashGear
// controls read, with the few things jsdom lacks (ResizeObserver, layout sizes) stood in for.
import { JSDOM } from 'jsdom';

export function installDom(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const dom = new JSDOM('<!doctype html><html lang="en" dir="ltr"><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/',
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const target = globalThis as unknown as Record<string, unknown>;
  // Events must be jsdom's own (Node has an `Event` of its own that jsdom refuses).
  const events =
    /^(Event|CustomEvent|UIEvent|FocusEvent|InputEvent|KeyboardEvent|MouseEvent|PointerEvent|WheelEvent)$/;
  const names = Object.getOwnPropertyNames(win).filter(
    (name) =>
      (events.test(name) || !(name in globalThis)) &&
      !name.startsWith('_') &&
      (/^[A-Z]/.test(name) ||
        [
          'window',
          'document',
          'navigator',
          'getComputedStyle',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'matchMedia',
          'getSelection',
          'localStorage',
        ].includes(name)),
  );
  for (const name of ['window', 'document', 'navigator', ...names]) {
    const value = name === 'window' ? win : (win as unknown as Record<string, unknown>)[name];
    if (value === undefined) continue;
    Object.defineProperty(target, name, {
      value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(win) : value,
      configurable: true,
      writable: true,
    });
  }
  if (!(win as unknown as Record<string, unknown>).PointerEvent) {
    class PointerEventStub extends win.MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (win as unknown as Record<string, unknown>).PointerEvent = PointerEventStub;
    target.PointerEvent = PointerEventStub;
  }
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  target.ResizeObserver = ResizeObserverStub;
  (win as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  if (!win.matchMedia)
    (win as unknown as Record<string, unknown>).matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
  target.matchMedia = win.matchMedia;
  // The table's grid measures its height: jsdom lays nothing out, so give it one.
  Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).getAttribute('role') === 'grid' ? 600 : 0;
    },
  });
  win.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  if (!win.HTMLElement.prototype.setPointerCapture) {
    win.HTMLElement.prototype.setPointerCapture = function setPointerCapture() {};
    win.HTMLElement.prototype.releasePointerCapture = function releasePointerCapture() {};
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
