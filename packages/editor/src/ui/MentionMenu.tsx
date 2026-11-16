import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { BlockEditor } from '../editor';
import type { EditorHost, SlashItem } from '../host';
import { chooseMention, closeMention, mentionItems, mentionState } from '../mention';
import type { SlashKeys } from '../slash';
import { CaretMenu } from './SlashMenu';

/**
 * The picker after `@`: people, pages whose titles match, and dates (Today, Tomorrow, Pick a
 * date), chosen by keyboard or pointer, in the same command menu at the caret as `/`.
 */
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
    () => (key ? mentionItems(host, state.query) : []),
    // The key holds the query and position.
    [key, host],
  );
  const setKeys = useCallback(
    (keys: SlashKeys | null) => {
      editor.ui.mentionKeys = keys;
    },
    [editor],
  );
  useEffect(() => {
    if (key && items.length === 0 && state.query.length > 20) closeMention(view);
  }, [key, items.length, state.query, view]);
  if (!key) return null;
  return (
    <CaretMenu
      editor={editor}
      setKeys={setKeys}
      items={items}
      at={state.from}
      label={host.strings?.pagePicker ?? ''}
      emptyText={host.strings?.noPages ?? ''}
      onChoose={(item) => chooseMention(view, editor.ui, item.id)}
    />
  );
}
