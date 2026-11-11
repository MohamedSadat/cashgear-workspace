// The touch toolbar: on a narrow or touch screen, while the editor has focus, a row of block tools
// sits above the on-screen keyboard: insert (the slash menu), bold, italic, move up and down,
// indent, outdent and the block menu. With no hover and no Alt+Shift+arrows on a phone, it is how
// blocks are moved there. Pointer-down is prevented, so the editor keeps its caret.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { currentBlock, indent, moveSibling, outdent } from '../blocks';
import type { BlockEditor } from '../editor';
import type { EditorHost } from '../host';
import { openSlash } from '../slash';

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

/** How far the on-screen keyboard reaches up from the bottom of the layout viewport. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () =>
      setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    update();
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
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
  const inset = useKeyboardInset();
  const bar = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(() => editor.isFocused);
  const [, render] = useState(0);

  // Nothing is listened to on a wide screen: the toolbar costs no keystroke there.
  useEffect(() => {
    if (!wanted) return;
    setFocused(editor.isFocused);
    const onFocus = () => setFocused(true);
    const onBlur = ({ event }: { event: FocusEvent }) => {
      const into = event.relatedTarget as Node | null;
      if (!into || !bar.current?.contains(into)) setFocused(false);
    };
    const onTransaction = () => render((n) => n + 1);
    editor.on('focus', onFocus);
    editor.on('blur', onBlur);
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('focus', onFocus);
      editor.off('blur', onBlur);
      editor.off('transaction', onTransaction);
    };
  }, [editor, wanted]);

  const s = host.strings;
  if (!wanted || !focused || !editor.isEditable || !s) return null;

  const block = currentBlock(editor.state);
  const run = (make: () => ReturnType<typeof indent>) => {
    const tr = make();
    if (tr) editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  };
  const tools: { key: string; label: string; glyph: string; act: () => void; pressed?: boolean }[] =
    [
      { key: 'insert', label: s.insertBlock, glyph: '+', act: () => openSlash(editor.view) },
      {
        key: 'bold',
        label: s.bold,
        glyph: 'B',
        pressed: editor.isActive('bold'),
        act: () => editor.chain().focus().toggleMark('bold').run(),
      },
      {
        key: 'italic',
        label: s.italic,
        glyph: 'I',
        pressed: editor.isActive('italic'),
        act: () => editor.chain().focus().toggleMark('italic').run(),
      },
      {
        key: 'up',
        label: s.moveUp,
        glyph: '↑',
        act: () => block && run(() => moveSibling(editor.state, block, -1)),
      },
      {
        key: 'down',
        label: s.moveDown,
        glyph: '↓',
        act: () => block && run(() => moveSibling(editor.state, block, 1)),
      },
      {
        key: 'indent',
        label: s.indent,
        glyph: '⇥',
        act: () => block && run(() => indent(editor.state, block)),
      },
      {
        key: 'outdent',
        label: s.outdent,
        glyph: '⇤',
        act: () => block && run(() => outdent(editor.state, block)),
      },
      {
        key: 'menu',
        label: s.blockMenu,
        glyph: '⋯',
        act: () => {
          const open = blockEditor.ui.openBlockMenu;
          if (!block || !open || !bar.current) return;
          open(block.pos, bar.current.getBoundingClientRect());
        },
      },
    ];

  return (
    <div
      ref={bar}
      className="cgw-touchbar"
      role="toolbar"
      aria-label={s.touchToolbar}
      style={{ bottom: inset }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {tools.map((tool) => (
        <button
          key={tool.key}
          type="button"
          className="cgw-touchbar-button"
          aria-label={tool.label}
          title={tool.label}
          aria-pressed={tool.pressed}
          data-tool={tool.key}
          onClick={tool.act}
        >
          <span aria-hidden="true">{tool.glyph}</span>
        </button>
      ))}
    </div>
  );
}
