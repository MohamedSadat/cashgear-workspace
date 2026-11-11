// Tables (M1.5) on prosemirror-tables: cell selection, Tab and arrows between cells, column
// widths by dragging a border. Header row and column are table attributes (DATA_MODEL.md), drawn
// by CSS. The table controls (add and remove rows and columns, headers) are in TableMenu.
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import {
  CellSelection,
  TableMap,
  TableView,
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  columnResizing,
  deleteColumn,
  deleteRow,
  goToNextCell,
  isInTable,
  selectedRect,
  tableEditing,
} from '@tiptap/pm/tables';

/** The table view draws our header attributes on the table element. */
class CgwTableView extends TableView {
  constructor(node: PMNode, cellMinWidth: number) {
    super(node, cellMinWidth);
    this.dom.classList.add('cgw-body', 'cgw-table-wrap');
    this.dom.dataset.body = 'table';
    this.sync(node);
  }
  private sync(node: PMNode) {
    this.table.dataset.headerRow = String(Boolean(node.attrs.headerRow));
    this.table.dataset.headerColumn = String(Boolean(node.attrs.headerColumn));
    this.table.classList.add('cgw-table');
  }
  update(node: PMNode) {
    if (!super.update(node)) return false;
    this.sync(node);
    return true;
  }
}

export const Tables = Extension.create({
  name: 'cgwTables',
  addProseMirrorPlugins() {
    return [
      columnResizing({
        handleWidth: 5,
        cellMinWidth: 60,
        View: CgwTableView,
        lastColumnResizable: true,
      }),
      tableEditing({ allowTableNodeSelection: false }),
    ];
  },
  addKeyboardShortcuts() {
    const run =
      (command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) => () =>
        command(this.editor.state, this.editor.view.dispatch);
    return {
      Tab: () => {
        if (!isInTable(this.editor.state)) return false;
        // Tab in the last cell adds a row, as editors do.
        if (goToNextCell(1)(this.editor.state, this.editor.view.dispatch)) return true;
        return run(addRowAfter)() && goToNextCell(1)(this.editor.state, this.editor.view.dispatch);
      },
      'Shift-Tab': () =>
        isInTable(this.editor.state)
          ? (goToNextCell(-1)(this.editor.state, this.editor.view.dispatch), true)
          : false,
    };
  },
});

export type TableCommand =
  | 'addRowBefore'
  | 'addRowAfter'
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'deleteRow'
  | 'deleteColumn'
  | 'toggleHeaderRow'
  | 'toggleHeaderColumn';

const commands = {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
};

/** The table the selection is in: its position and node. */
export function tableAt(state: EditorState): { pos: number; node: PMNode } | null {
  if (!isInTable(state)) return null;
  const $from =
    state.selection instanceof CellSelection ? state.selection.$anchorCell : state.selection.$from;
  for (let d = $from.depth; d > 0; d--)
    if ($from.node(d).type.name === 'table') return { pos: $from.before(d), node: $from.node(d) };
  return null;
}

export function runTableCommand(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  name: TableCommand,
): boolean {
  const table = tableAt(state);
  if (!table) return false;
  if (name === 'toggleHeaderRow' || name === 'toggleHeaderColumn') {
    const attr = name === 'toggleHeaderRow' ? 'headerRow' : 'headerColumn';
    dispatch(
      state.tr.setNodeMarkup(table.pos, undefined, {
        ...table.node.attrs,
        [attr]: !table.node.attrs[attr],
      }),
    );
    return true;
  }
  // The last row or column goes with the whole table, from the block menu.
  if (name === 'deleteRow' || name === 'deleteColumn') {
    const rect = selectedRect(state);
    const map = TableMap.get(table.node);
    if ((name === 'deleteRow' && map.height <= 1) || (name === 'deleteColumn' && map.width <= 1))
      return false;
    void rect;
  }
  return commands[name](state, dispatch);
}
