// The table's controls while the caret is in a table: rows and columns added and removed, header
// row and column. Mousedown is prevented, so the cell keeps the caret.
import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { BlockEditor } from '../editor';
import type { EditorHost } from '../host';
import { runTableCommand, tableAt, type TableCommand } from '../tables';

const BUTTONS: { command: TableCommand; glyph: string }[] = [
  { command: 'addRowBefore', glyph: '⤒' },
  { command: 'addRowAfter', glyph: '⤓' },
  { command: 'addColumnBefore', glyph: '⇤' },
  { command: 'addColumnAfter', glyph: '⇥' },
  { command: 'deleteRow', glyph: '⊖' },
  { command: 'deleteColumn', glyph: '⊘' },
  { command: 'toggleHeaderRow', glyph: '▤' },
  { command: 'toggleHeaderColumn', glyph: '▥' },
];

export function TableMenu({
  editor: blockEditor,
  host,
}: {
  editor: BlockEditor;
  host: EditorHost;
}) {
  const editor = blockEditor.editor;
  const tablePos = useSyncExternalStore(
    (listener) => {
      editor.on('transaction', listener);
      editor.on('blur', listener);
      editor.on('focus', listener);
      return () => {
        editor.off('transaction', listener);
        editor.off('blur', listener);
        editor.off('focus', listener);
      };
    },
    () => (editor.isEditable && editor.isFocused ? (tableAt(editor.state)?.pos ?? -1) : -1),
  );
  const [place, setPlace] = useState({ top: -9999, left: -9999 });
  useLayoutEffect(() => {
    if (tablePos < 0) return;
    const dom = editor.view.nodeDOM(tablePos) as HTMLElement | null;
    const rect = dom?.getBoundingClientRect();
    if (!rect) return;
    setPlace({ top: Math.max(8, rect.top - 36), left: Math.max(8, rect.left) });
  }, [tablePos, editor]);
  const s = host.strings;
  if (tablePos < 0 || !s) return null;
  const table = tableAt(editor.state);
  return (
    <div
      className="cgw-table-menu"
      role="toolbar"
      aria-label={s.tableTools}
      style={{ top: place.top, left: place.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {BUTTONS.map(({ command, glyph }) => (
        <button
          key={command}
          type="button"
          className="cgw-bubble-button"
          aria-label={s[`table_${command}`]}
          title={s[`table_${command}`]}
          aria-pressed={
            command === 'toggleHeaderRow'
              ? Boolean(table?.node.attrs.headerRow)
              : command === 'toggleHeaderColumn'
                ? Boolean(table?.node.attrs.headerColumn)
                : undefined
          }
          onClick={() => runTableCommand(editor.state, editor.view.dispatch, command)}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}
