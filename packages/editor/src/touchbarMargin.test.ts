// The touch toolbar's scroll margin: the caret is scrolled into view above the docked toolbar while
// it is drawn, and ProseMirror's default margin applies when it is not.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { build, documentSchema, writeJSON, CONTENT } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { touchbarMargin } = await import('./touchbarMargin');
type Storage = import('./touchbarMargin').TouchbarMarginStorage;

const barAt = (top: number) =>
  ({ getBoundingClientRect: () => ({ top }) }) as unknown as HTMLElement;

describe('the touch toolbar scroll margin', () => {
  it('keeps the space the toolbar covers, and a gap, free at the foot', () => {
    const covered = window.innerHeight - 52;
    expect(touchbarMargin(() => barAt(covered))).toEqual({
      top: 5,
      left: 5,
      right: 5,
      bottom: 60,
    });
    expect(touchbarMargin(() => null)).toBeUndefined();
  });

  // Safari on iOS keeps the layout viewport's height under its keyboard: what is seen ends at the
  // visual viewport's foot, and `innerHeight` is no measure of it.
  it('measures what the toolbar covers against the visual viewport where there is one', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { offsetTop: 200, height: 420 },
    });
    try {
      expect(touchbarMargin(() => barAt(570))?.bottom).toBe(50 + 8);
      expect(touchbarMargin(() => barAt(700))?.bottom).toBe(8);
    } finally {
      delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });

  it('is read by the editor only while the toolbar hands it its element', () => {
    const doc = new Y.Doc();
    writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), build.docOf(build.paragraph('a')));
    const be = createBlockEditor({
      element: document.createElement('div'),
      fragment: doc.getXmlFragment(CONTENT),
    });
    editors.push(be);
    const view = be.editor.view;
    const storage = (be.editor.storage as unknown as Record<string, Storage>).cgwTouchbarMargin;
    const props = () => [view.someProp('scrollThreshold'), view.someProp('scrollMargin')];
    expect(props()).toEqual([undefined, undefined]);
    storage.bar = () => barAt(window.innerHeight - 40);
    const kept = { top: 5, left: 5, right: 5, bottom: 48 };
    expect(props()).toEqual([kept, kept]);
    storage.bar = null;
    expect(props()).toEqual([undefined, undefined]);
  });
});
