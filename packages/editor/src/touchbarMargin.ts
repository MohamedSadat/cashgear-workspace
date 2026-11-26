// While the touch toolbar (ui/TouchToolbar.tsx) shows, the caret is scrolled into view above it,
// not under it: on a phone a new line typed at a page's foot sat behind the toolbar. ProseMirror
// reads `scrollThreshold` and `scrollMargin` from plugins too; the plugin is always there (registering one later would
// reconfigure the state and rebuild every plugin view, the Yjs binding's included), and the
// toolbar hands it its element while it is drawn.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export interface TouchbarMarginStorage {
  bar: (() => HTMLElement | null) | null;
}

/** The space kept free above the toolbar's top edge. */
const GAP = 8;

/**
 * Where what the person sees ends, in the coordinates `position: fixed` and client rectangles use
 * (the layout viewport's). With `interactive-widget=resizes-content` (index.html) Chrome on Android
 * shrinks the layout viewport above the on-screen keyboard, and this is `innerHeight`. Safari on
 * iOS ignores that key: the layout viewport keeps its height under the keyboard, only the visual
 * viewport shrinks (and moves, `offsetTop`, when Safari scrolls the caret into view), and
 * `innerHeight` is no measure of either then (WebKit bug 191204). The visual viewport is.
 */
export function visualFoot(): number {
  const viewport = window.visualViewport;
  return viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
}

export function touchbarMargin(bar: () => HTMLElement | null | undefined) {
  const element = bar();
  if (!element) return undefined;
  const covered = Math.max(0, visualFoot() - element.getBoundingClientRect().top);
  return { top: 5, left: 5, right: 5, bottom: covered + GAP };
}

export const TouchbarMargin = Extension.create<object, TouchbarMarginStorage>({
  name: 'cgwTouchbarMargin',
  addStorage: () => ({ bar: null }),
  addProseMirrorPlugins() {
    const storage = this.storage;
    const plugin = new Plugin({ key: new PluginKey('cgwTouchbarMargin') });
    // Plugin's constructor copies `props`, which would read a getter once: define them after. The
    // threshold is when ProseMirror scrolls (the caret that near an edge), the margin how far.
    for (const name of ['scrollThreshold', 'scrollMargin'])
      Object.defineProperty(plugin.props, name, {
        enumerable: true,
        get: () => touchbarMargin(() => storage.bar?.()),
      });
    return [plugin];
  },
});
