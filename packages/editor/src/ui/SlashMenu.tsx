// The slash menu: the block commands at the caret, filtered by what is typed after `/`, chosen by
// keyboard or pointer. `@cashgear/ui`'s CgCommandMenu (Track U1), floating at the caret while the
// editor keeps the focus: the editor forwards the menu's keys to it (`editor.ui.slashKeys`) and
// points its `aria-activedescendant` at the active option.
import { CgCommandMenu, type CgCommandMenuHandle, type CgCommandMenuItem } from '@cashgear/ui';
import type { EditorView } from '@tiptap/pm/view';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import type { BlockEditor } from '../editor';
import type { EditorHost, SlashItem } from '../host';
import { closeSlash, removeSlashText, slashState, type SlashKeys } from '../slash';

/** The keys a menu at the caret takes from the editor; Home, End and the rest stay the text's. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab']);

export interface CaretMenuProps {
  editor: BlockEditor;
  /** The open menu's keys are set here (`editor.ui.slashKeys`, `.mentionKeys`). */
  setKeys(keys: SlashKeys | null): void;
  items: SlashItem[];
  /** Where the typed `/` or `@` is: the menu sits below it, above when there is no room. */
  at: number;
  label: string;
  emptyText: string;
  onChoose(item: SlashItem): void;
}

const toItem = (item: SlashItem): CgCommandMenuItem<SlashItem> => ({
  key: item.id,
  label: item.label,
  group: item.group,
  icon: item.glyph || undefined,
  shortcut: item.shortcut,
  data: item,
});

/** The caret's rectangle in the viewport, the same object while it does not move. */
function useCaretRect(view: EditorView, at: number) {
  let coords: { left: number; right: number; top: number; bottom: number } | null = null;
  try {
    coords = view.coordsAtPos(at);
  } catch {
    coords = null;
  }
  const key = coords ? `${coords.left}:${coords.right}:${coords.top}:${coords.bottom}` : '';
  return useMemo(
    () =>
      coords && {
        x: coords.left,
        y: coords.top,
        width: Math.max(0, coords.right - coords.left),
        height: Math.max(0, coords.bottom - coords.top),
      },
    // The key holds the coordinates.
    [key],
  );
}

/**
 * A command menu at the caret (the slash and "@" menus). Focus stays in the editor: the arrows,
 * Enter and Tab reach the menu through `setKeys`, and the editor's `aria-activedescendant` names
 * the active option while it is open. Nothing here changes per keystroke outside the menu itself.
 */
export function CaretMenu({
  editor,
  setKeys,
  items,
  at,
  label,
  emptyText,
  onChoose,
}: CaretMenuProps): ReactElement | null {
  const view = editor.editor.view;
  const menu = useRef<CgCommandMenuHandle>(null);
  const anchor = useCaretRect(view, at);
  const menuItems = useMemo(() => items.map(toItem), [items]);
  const choose = useRef(onChoose);
  choose.current = onChoose;

  useEffect(() => {
    setKeys({
      onKey: (event) =>
        MENU_KEYS.has(event.key) ? (menu.current?.handleKeyDown(event) ?? false) : false,
    });
    return () => setKeys(null);
  }, [setKeys]);

  const onActive = useCallback(
    (id: string | undefined) => {
      if (id) view.dom.setAttribute('aria-activedescendant', id);
      else view.dom.removeAttribute('aria-activedescendant');
    },
    [view],
  );
  // Closed, the editor names no option.
  useEffect(() => () => view.dom.removeAttribute('aria-activedescendant'), [view]);

  if (!anchor || !label) return null;
  return (
    <CgCommandMenu<SlashItem>
      ref={menu}
      anchor={anchor}
      items={menuItems}
      filter={false}
      label={label}
      emptyText={emptyText}
      selectOnTab
      width={300}
      maxHeight="min(360px, 60vh)"
      onActiveDescendantChange={onActive}
      onSelect={(item) => item.data && choose.current(item.data)}
      // A press anywhere in the menu leaves the focus (and the menu) with the editor.
      onMouseDown={(event) => event.preventDefault()}
    />
  );
}

function useEditorState<T>(editor: BlockEditor, read: () => T): T {
  const cache = useRef<{ key: string; value: T } | null>(null);
  return useSyncExternalStore(
    (listener) => {
      editor.editor.on('transaction', listener);
      editor.editor.on('focus', listener);
      editor.editor.on('blur', listener);
      return () => {
        editor.editor.off('transaction', listener);
        editor.editor.off('focus', listener);
        editor.editor.off('blur', listener);
      };
    },
    () => {
      const value = read();
      const key = JSON.stringify(value);
      if (cache.current?.key !== key) cache.current = { key, value };
      return cache.current.value;
    },
  );
}

/** Watches the slash state and draws the menu while it is open. */
export function SlashMenu({ editor, host }: { editor: BlockEditor; host: EditorHost }) {
  const slash = useEditorState(editor, () => slashState(editor.editor.state));
  const items = useMemo(
    () => (slash.active ? (host.slash?.list(slash.query) ?? []) : []),
    [slash.active, slash.query, host],
  );
  const setKeys = useCallback(
    (keys: SlashKeys | null) => {
      editor.ui.slashKeys = keys;
    },
    [editor],
  );

  // Close when nothing matches a longer query, as editors do.
  useEffect(() => {
    if (slash.active && items.length === 0 && slash.query.length > 3)
      closeSlash(editor.editor.view);
  }, [slash.active, items.length, slash.query, editor]);

  if (!slash.active) return null;
  const strings = host.strings;
  return (
    <CaretMenu
      editor={editor}
      setKeys={setKeys}
      items={items}
      at={slash.from}
      label={strings?.commandMenu ?? ''}
      emptyText={strings?.noCommands ?? ''}
      onChoose={(item) => {
        removeSlashText(editor.editor.view);
        void host.slash?.run(item.id);
      }}
    />
  );
}
