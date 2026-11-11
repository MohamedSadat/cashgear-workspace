import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BlockEditor } from '../editor';
import type { EditorHost, SlashItem } from '../host';
import { closeMention, insertMention, mentionState } from '../mention';
import { CommandMenu } from './SlashMenu';

/** The page picker after `@`: pages whose titles match, chosen by keyboard or pointer. */
export function MentionMenu({ editor, host }: { editor: BlockEditor; host: EditorHost }) {
  const view = editor.editor.view;
  const cache = useRef('');
  const key = useSyncExternalStore(
    (listener) => {
      editor.editor.on('transaction', listener);
      return () => {
        editor.editor.off('transaction', listener);
      };
    },
    () => {
      const state = mentionState(editor.editor.state);
      const next = state.active ? `${state.from}:${state.query}` : '';
      if (next !== cache.current) cache.current = next;
      return cache.current;
    },
  );
  const state = mentionState(editor.editor.state);
  const items: SlashItem[] = useMemo(
    () =>
      key
        ? (host.pages?.search(state.query) ?? []).slice(0, 12).map((page) => ({
            id: page.id,
            label: page.title || (host.strings?.untitled ?? ''),
            glyph: page.icon ?? '📄',
          }))
        : [],
    // The key holds the query and position.
    [key, host],
  );
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [key]);
  const latest = useRef({ items, active });
  latest.current = { items, active };
  useEffect(() => {
    if (!key) return;
    editor.ui.mentionKeys = {
      onKey(event) {
        const { items: list, active: index } = latest.current;
        if (event.key === 'ArrowDown') setActive((index + 1) % Math.max(1, list.length));
        else if (event.key === 'ArrowUp')
          setActive((index - 1 + list.length) % Math.max(1, list.length));
        else if (event.key === 'Enter' || event.key === 'Tab') {
          if (!list[index]) return false;
          insertMention(view, list[index].id);
        } else return false;
        event.preventDefault();
        return true;
      },
    };
    return () => {
      editor.ui.mentionKeys = null;
    };
  }, [key, editor, view]);
  useEffect(() => {
    if (key && items.length === 0 && state.query.length > 20) closeMention(view);
  }, [key, items.length, state.query, view]);
  if (!key) return null;
  let anchor;
  try {
    anchor = view.coordsAtPos(state.from);
  } catch {
    return null;
  }
  return (
    <CommandMenu
      items={items}
      anchor={anchor}
      activeIndex={active}
      onActiveIndex={setActive}
      onChoose={(item) => insertMention(view, item.id)}
      emptyText={host.strings?.noPages ?? ''}
      label={host.strings?.pagePicker ?? ''}
    />
  );
}
