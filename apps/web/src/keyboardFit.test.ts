import { describe, expect, it } from 'vitest';
import { fitAboveKeyboard } from './keyboardFit';

/** A window whose visual viewport the test moves, and a root that keeps its inline style. */
function scene(layout = 812) {
  const viewport = Object.assign(new EventTarget(), { height: layout, offsetTop: 0, scale: 1 });
  const style = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => style.set(name, value),
      removeProperty: (name: string) => style.delete(name),
    },
    contains: () => false,
  } as unknown as HTMLElement;
  const view = {
    visualViewport: viewport,
    document: { documentElement: { clientHeight: layout }, activeElement: null },
  } as unknown as Window;
  const move = (to: Partial<{ height: number; offsetTop: number; scale: number }>) => {
    Object.assign(viewport, to);
    viewport.dispatchEvent(new Event('height' in to || 'scale' in to ? 'resize' : 'scroll'));
  };
  return { root, view, style, move };
}

describe('fitAboveKeyboard', () => {
  it('sets nothing where the two viewports are one', () => {
    const { root, view, style, move } = scene();
    fitAboveKeyboard(root, view);
    expect(style.size).toBe(0);
    // Chrome on Android under its keyboard: the layout viewport shrinks too.
    (view.document.documentElement as { clientHeight: number }).clientHeight = 420;
    move({ height: 420 });
    expect(style.size).toBe(0);
  });

  it('fits the root to the visual viewport under a keyboard, follows it, and lets go', () => {
    const { root, view, style, move } = scene();
    fitAboveKeyboard(root, view);
    move({ height: 420 });
    expect(Object.fromEntries(style)).toEqual({
      position: 'fixed',
      left: '0',
      right: '0',
      top: '0px',
      height: '420px',
    });
    // Safari moves the visual viewport down to show the caret.
    move({ offsetTop: 240 });
    expect(style.get('top')).toBe('240px');
    // Its suggestions shown: a shorter keyboard.
    move({ height: 460 });
    expect(style.get('height')).toBe('460px');
    move({ height: 812, offsetTop: 0 });
    expect(style.size).toBe(0);
  });

  it('leaves a pinch zoom alone', () => {
    const { root, view, style, move } = scene();
    fitAboveKeyboard(root, view);
    move({ height: 406, scale: 2 });
    expect(style.size).toBe(0);
  });

  it('a fractional height is not a keyboard', () => {
    const { root, view, style, move } = scene();
    fitAboveKeyboard(root, view);
    move({ height: 811.5 });
    expect(style.size).toBe(0);
  });

  it('undoes the fit and stops following when ended', () => {
    const { root, view, style, move } = scene();
    const end = fitAboveKeyboard(root, view);
    move({ height: 420 });
    end();
    expect(style.size).toBe(0);
    move({ height: 400 });
    expect(style.size).toBe(0);
  });

  it('does nothing without a visual viewport', () => {
    const { root, style } = scene();
    fitAboveKeyboard(root, { document: {} } as unknown as Window)();
    expect(style.size).toBe(0);
  });
});
