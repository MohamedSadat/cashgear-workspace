// The app's frame kept above an on-screen keyboard where the browser leaves the page under it.
//
// index.html asks for `interactive-widget=resizes-content`, so Chrome on Android shrinks the layout
// viewport above the keyboard, and the frame with it (#root at 100%, shell.css): the top bar stays
// at the top and the page area scrolls above the keyboard. Safari on iOS ignores that key. There the
// layout viewport keeps its height under the keyboard and only the visual viewport shrinks. Safari
// then moves the visual viewport down the layout viewport (`offsetTop`) to show the caret, and so
// does ProseMirror once the page area has scrolled all it can (it scrolls the window by
// `scrollBy`). The top bar left the screen (reported from an iPhone on 2026-11-26).
//
// So the root is fitted to the visual viewport while that is shorter than the layout viewport at a
// scale of 1 (a keyboard, not a pinch zoom): fixed from its `offsetTop`, at its height, followed on
// its `resize` and `scroll`, as Chrome resizes the frame. Fixed, the root is also where ProseMirror's
// scroll into view stops: it no longer scrolls the window. It is placed by `top`, not a transform,
// which would make the root the containing block of the fixed things inside it (the touch toolbar).
// Where the two viewports are one (Android, desktops) nothing is set. The default and what only an
// iPhone can confirm: docs/DECISIONS.md, "The frame fitted above iOS's keyboard".

/** What the fit sets on the root, and clears. */
const FITTED = ['position', 'left', 'right', 'top', 'height'] as const;

/** Under this much shorter, the two viewports are one (fractional heights). */
const SAME = 1;

/** A box's top and bottom edges, in client coordinates. */
interface Band {
  top: number;
  bottom: number;
}

/**
 * Where the focused field's caret is (or the field, for one that is not editable text in the
 * page): a collapsed range's box, or its element's where a browser gives an empty one (an empty
 * line, WebKit).
 */
function focusRect(doc: Document, active: HTMLElement): Band | null {
  if (!active.isContentEditable) return active.getBoundingClientRect();
  const selection = doc.getSelection();
  const node = selection?.focusNode;
  if (!selection || !node || !active.contains(node)) return null;
  const range = doc.createRange();
  range.setStart(node, selection.focusOffset);
  const rect = range.getBoundingClientRect();
  if (rect.top || rect.bottom) return rect;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.getBoundingClientRect() ?? null;
}

const scrolls = (view: Window, box: HTMLElement) =>
  box.scrollHeight > box.clientHeight &&
  /^(auto|scroll|overlay)$/.test(view.getComputedStyle(box).overflowY);

/**
 * What has the focus, scrolled mid-way into its scrolling boxes if the fitted frame left it out of
 * sight, as Chrome does after it resizes the frame for the keyboard. Safari had shown the caret by
 * moving the visual viewport, and the frame fitted there moved with it, the caret too: a line
 * tapped in the lower half of the screen went under the keyboard.
 */
function reveal(view: Window, root: HTMLElement) {
  const doc = view.document;
  const active = doc.activeElement as HTMLElement | null;
  if (!active || active === doc.body || !root.contains(active)) return;
  let rect = focusRect(doc, active);
  if (!rect) return;
  const seen = root.getBoundingClientRect();
  for (let box = active.parentElement; box && box !== root; box = box.parentElement) {
    if (!scrolls(view, box)) continue;
    const edge = box.getBoundingClientRect();
    const top = Math.max(edge.top, seen.top);
    const bottom = Math.min(edge.bottom, seen.bottom);
    if (rect.top >= top && rect.bottom <= bottom) continue;
    const before = box.scrollTop;
    box.scrollTop += (rect.top + rect.bottom - top - bottom) / 2;
    const moved = box.scrollTop - before;
    rect = { top: rect.top - moved, bottom: rect.bottom - moved };
  }
}

/** Fits `root` above an on-screen keyboard the browser draws over the page; gives the undo. */
export function fitAboveKeyboard(root: HTMLElement, view: Window = window): () => void {
  const viewport = view.visualViewport;
  if (!viewport) return () => {};
  let fitted: number | null = null;

  const unfit = () => {
    if (fitted === null) return;
    fitted = null;
    for (const name of FITTED) root.style.removeProperty(name);
  };

  const update = () => {
    const layout = view.document.documentElement.clientHeight;
    const keyboard = Math.abs(viewport.scale - 1) < 0.01 && viewport.height < layout - SAME;
    if (!keyboard) return unfit();
    const resized = fitted !== viewport.height;
    fitted = viewport.height;
    const style = root.style;
    style.setProperty('position', 'fixed');
    style.setProperty('left', '0');
    style.setProperty('right', '0');
    style.setProperty('top', `${viewport.offsetTop}px`);
    style.setProperty('height', `${viewport.height}px`);
    if (resized) reveal(view, root);
  };

  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    unfit();
  };
}
