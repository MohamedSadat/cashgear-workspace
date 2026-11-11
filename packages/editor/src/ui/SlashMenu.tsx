// The slash menu: a filtered list of block commands at the caret, used by keyboard or pointer.
// A stand-in for Track U1's command menu in CashGear.React.UI, behind the props it will take.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BlockEditor } from '../editor';
import type { EditorHost, SlashItem } from '../host';
import { closeSlash, removeSlashText, slashState } from '../slash';

export interface CommandMenuProps {
  items: SlashItem[];
  /** Where to draw it: the caret's rectangle, in viewport coordinates. */
  anchor: { left: number; right: number; top: number; bottom: number };
  activeIndex: number;
  onActiveIndex(index: number): void;
  onChoose(item: SlashItem): void;
  emptyText: string;
  label: string;
}

/** The menu itself: a listbox, active item by aria-activedescendant, focus stays in the editor. */
export function CommandMenu({
  items,
  anchor,
  activeIndex,
  onActiveIndex,
  onChoose,
  emptyText,
  label,
}: CommandMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number }>({
    top: anchor.bottom + 4,
    left: anchor.left,
  });
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    const height = el.offsetHeight;
    const width = el.offsetWidth;
    const below = anchor.bottom + 4 + height <= window.innerHeight;
    const top = below ? anchor.bottom + 4 : Math.max(8, anchor.top - 4 - height);
    let left = rtl ? anchor.right - width : anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setPlace({ top, left });
  }, [anchor.left, anchor.right, anchor.top, anchor.bottom, items.length]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  let group = '';
  return (
    <div
      ref={list}
      className="cgw-command-menu"
      role="listbox"
      aria-label={label}
      id="cgw-command-menu"
      style={{ top: place.top, left: place.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length === 0 && <div className="cgw-command-empty">{emptyText}</div>}
      {items.map((item, index) => {
        const header = item.group && item.group !== group ? item.group : null;
        group = item.group ?? group;
        return (
          <div key={item.id}>
            {header && (
              <div className="cgw-command-group" role="presentation">
                {header}
              </div>
            )}
            <div
              id={`cgw-command-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className="cgw-command-item"
              onMouseEnter={() => onActiveIndex(index)}
              onClick={() => onChoose(item)}
            >
              <span className="cgw-command-glyph" aria-hidden="true">
                {item.glyph}
              </span>
              <span className="cgw-command-label">{item.label}</span>
              {item.shortcut && <span className="cgw-command-shortcut">{item.shortcut}</span>}
            </div>
          </div>
        );
      })}
    </div>
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
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [slash.query, slash.active]);

  const choose = (item: SlashItem | undefined) => {
    if (!item) return;
    removeSlashText(editor.editor.view);
    void host.slash?.run(item.id);
  };

  // Close when nothing matches a longer query, as editors do.
  useEffect(() => {
    if (slash.active && items.length === 0 && slash.query.length > 3)
      closeSlash(editor.editor.view);
  }, [slash.active, items.length, slash.query, editor]);

  const state = useRef({ items, active });
  state.current = { items, active };
  useEffect(() => {
    editor.ui.slashKeys = {
      onKey(event) {
        const { items: list, active: index } = state.current;
        if (event.key === 'ArrowDown') setActive((index + 1) % Math.max(1, list.length));
        else if (event.key === 'ArrowUp')
          setActive((index - 1 + list.length) % Math.max(1, list.length));
        else if (event.key === 'Enter' || event.key === 'Tab') {
          if (!list.length) return false;
          choose(list[index]);
        } else return false;
        event.preventDefault();
        return true;
      },
    };
    return () => {
      editor.ui.slashKeys = null;
    };
  });

  if (!slash.active) return null;
  const view = editor.editor.view;
  let anchor;
  try {
    anchor = view.coordsAtPos(slash.from);
  } catch {
    return null;
  }
  const strings = host.strings;
  return (
    <CommandMenu
      items={items}
      anchor={anchor}
      activeIndex={active}
      onActiveIndex={setActive}
      onChoose={choose}
      emptyText={strings?.noCommands ?? ''}
      label={strings?.commandMenu ?? ''}
    />
  );
}
