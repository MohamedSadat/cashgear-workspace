// The touch toolbar: on a narrow or touch screen, while the editor has focus, a row of block tools
// sits above the on-screen keyboard: insert (the slash menu), bold, italic, move up and down,
// indent, outdent and the block menu, and at its end "Done editing", which leaves the editor (and
// closes the keyboard). With no hover and no Alt+Shift+arrows on a phone, it is how blocks are moved
// there. `@cashgear/ui`'s CgSelectionToolbar docked (Track U2): presses in it keep the focus in the
// editor, so the editor keeps its caret.
import { CgSelectionToolbar, type CgToolbarItem } from '@cashgear/ui';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { currentBlock, indent, moveSibling, outdent, type BlockInfo } from '../blocks';
import type { BlockEditor } from '../editor';
import { editorString, type EditorHost } from '../host';
import { openSlash } from '../slash';
import { visualFoot, type TouchbarMarginStorage } from '../touchbarMargin';

const QUERY = '(pointer: coarse), (max-width: 767px)';

function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const list = matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}

const none = () => () => {};

/**
 * The visual viewport's foot while the toolbar shows (touchbarMargin.ts's `visualFoot`). The
 * library docks the toolbar by `innerHeight`, which on iOS under the keyboard is no measure of the
 * layout viewport: there it sat behind the keyboard. Placed from the layout viewport's top at this
 * foot, it is above the keyboard wherever Safari has moved the visual viewport; where the visual
 * viewport is the layout viewport (Android, desktop) the place is the same as the library's.
 */
function useVisualFoot(active: boolean): number | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      const viewport = window.visualViewport;
      if (!active || !viewport) return () => {};
      viewport.addEventListener('resize', listener);
      viewport.addEventListener('scroll', listener);
      return () => {
        viewport.removeEventListener('resize', listener);
        viewport.removeEventListener('scroll', listener);
      };
    },
    [active],
  );
  return useSyncExternalStore(subscribe, () =>
    active && window.visualViewport ? Math.round(visualFoot()) : null,
  );
}

export function TouchToolbar({
  editor: blockEditor,
  host,
}: {
  editor: BlockEditor;
  host: EditorHost;
}) {
  const editor = blockEditor.editor;
  const wanted = useMedia(QUERY);
  const bar = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(() => editor.isFocused);

  // Nothing is listened to on a wide screen: the toolbar costs no keystroke there.
  useEffect(() => {
    if (!wanted) return;
    setFocused(editor.isFocused);
    const onFocus = () => setFocused(true);
    const onBlur = ({ event }: { event: FocusEvent }) => {
      const into = event.relatedTarget as Node | null;
      if (!into || !bar.current?.contains(into)) setFocused(false);
    };
    editor.on('focus', onFocus);
    editor.on('blur', onBlur);
    return () => {
      editor.off('focus', onFocus);
      editor.off('blur', onBlur);
    };
  }, [editor, wanted]);
  // Drawn again only when what it shows changes: Bold and Italic pressed, the page editable.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!wanted) return none();
      editor.on('transaction', listener);
      return () => {
        editor.off('transaction', listener);
      };
    },
    [editor, wanted],
  );
  const state = useSyncExternalStore(subscribe, () =>
    wanted ? `${editor.isEditable}:${editor.isActive('bold')}:${editor.isActive('italic')}` : 'off',
  );

  const s = host.strings;
  const items = useMemo((): CgToolbarItem[] => {
    if (!s) return [];
    const [, bold, italic] = state.split(':');
    // The block the caret is in when a tool is pressed.
    const run = (make: (block: BlockInfo) => ReturnType<typeof indent>) => {
      const block = currentBlock(editor.state);
      const tr = block && make(block);
      if (tr) editor.view.dispatch(tr.scrollIntoView());
      editor.view.focus();
    };
    const tool = (name: string, text: string, icon: CgToolbarItem['icon'], act: () => void) => ({
      name,
      text,
      icon,
      iconOnly: true,
      className: 'cgw-touchbar-button',
      onClick: () => act(),
    });
    return [
      tool('insert', s.insertBlock, 'add', () => void openSlash(editor.view)),
      {
        ...tool('bold', s.bold, 'text-bold', () => {
          editor.chain().focus().toggleMark('bold').run();
        }),
        checked: bold === 'true',
      },
      {
        ...tool('italic', s.italic, 'text-italic', () => {
          editor.chain().focus().toggleMark('italic').run();
        }),
        checked: italic === 'true',
      },
      tool('up', s.moveUp, 'chevron-up', () =>
        run((block) => moveSibling(editor.state, block, -1)),
      ),
      tool('down', s.moveDown, 'chevron-down', () =>
        run((block) => moveSibling(editor.state, block, 1)),
      ),
      tool('indent', s.indent, 'indent-increase', () =>
        run((block) => indent(editor.state, block)),
      ),
      tool('outdent', s.outdent, 'indent-decrease', () =>
        run((block) => outdent(editor.state, block)),
      ),
      tool('menu', s.blockMenu, 'more', () => {
        const block = currentBlock(editor.state);
        const open = blockEditor.ui.openBlockMenu;
        if (!block || !open || !bar.current) return;
        open(block.pos, bar.current.getBoundingClientRect());
      }),
      // At the bar's end, kept in view when its tools scroll along a narrow phone (editor.css).
      // The editor's focus and the selection go inside the press (Tiptap's `blur` waits a frame),
      // so the keyboard closes, and the toolbar with the focus.
      {
        ...tool('done', editorString(host, 'doneEditing'), 'check', () => {
          editor.view.dom.blur();
          editor.view.dom.ownerDocument.getSelection()?.removeAllRanges();
        }),
        alignment: 'end' as const,
        className: 'cgw-touchbar-button cgw-touchbar-done',
      },
    ];
  }, [s, state, editor, blockEditor, host]);

  const shown = wanted && focused && editor.isEditable && !!s?.touchToolbar;
  const foot = useVisualFoot(shown);
  // The caret scrolls into view above the toolbar while it shows (touchbarMargin.ts).
  useEffect(() => {
    const storage = (editor.storage as unknown as Record<string, TouchbarMarginStorage | undefined>)
      .cgwTouchbarMargin;
    if (!shown || !storage) return;
    const mine = () => bar.current;
    storage.bar = mine;
    return () => {
      if (storage.bar === mine) storage.bar = null;
    };
  }, [editor, shown]);

  if (!shown) return null;

  return (
    <CgSelectionToolbar
      ref={bar}
      mode="docked"
      className="cgw-touchbar"
      label={s.touchToolbar}
      items={items}
      size="large"
      autoCollapseText={false}
      zIndex={40}
      style={
        foot === null
          ? undefined
          : { insetBlockStart: foot, insetBlockEnd: 'auto', transform: 'translateY(-100%)' }
      }
    />
  );
}
