// A workbook block where there is no Workspace session to read it with: a page shared by link
// (`SharedView`). A workbook is never shared outside its workspace (decisions, 2026-11-14), so
// the block says "You don't have access to this workbook" and shows no picture.
import type { EditorHost } from '@cgw/editor';
import './sheet.css';

export function noAccessWorkbooks(text: string): NonNullable<EditorHost['workbooks']> {
  return {
    mount: (element) => {
      const note = document.createElement('p');
      note.className = 'cgw-sheet-note';
      note.setAttribute('role', 'note');
      note.textContent = text;
      element.appendChild(note);
      return {
        update: () => {},
        destroy: () => note.remove(),
      };
    },
  };
}
