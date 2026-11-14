// A workbook block's frame (`EditorHost.workbooks.mount`, contracts section 2): `SheetBlock` in a
// React root of its own, inside the editor's frame element, with the app's strings and direction.
// The editor calls `update` when the block's view or height changes (the same root draws them)
// and `destroy` when the block goes far away, is removed, or points at another workbook.
import type { MountedFrame, SheetMountOptions } from '@cgw/editor';
import type { i18n as I18n } from 'i18next';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { SheetBlock, type SheetBlockDeps } from './SheetBlock';
import './sheet.css';

export interface WorkbookMountDeps extends SheetBlockDeps {
  i18n: I18n;
}

export function mountWorkbook(
  element: HTMLElement,
  options: SheetMountOptions,
  deps: WorkbookMountDeps,
): MountedFrame<SheetMountOptions> {
  const container = document.createElement('div');
  container.className = 'cgw-sheet-block';
  element.appendChild(container);
  // The block's own direction and language: the CashGear controls read the nearest `dir`.
  const { i18n } = deps;
  const apply = () => {
    container.dir = i18n.dir(i18n.language);
    container.lang = i18n.language;
  };
  apply();
  i18n.on('languageChanged', apply);
  const root = createRoot(container);
  const render = (current: SheetMountOptions) =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <SheetBlock options={current} deps={deps} />
      </I18nextProvider>,
    );
  render(options);
  let gone = false;
  return {
    update(next) {
      if (!gone) render(next);
    },
    destroy() {
      if (gone) return;
      gone = true;
      i18n.off('languageChanged', apply);
      // Out of the page at once (a new frame may be mounted in its place now); the root goes
      // after the editor's own update, as React refuses to unmount a root while rendering.
      container.remove();
      setTimeout(() => root.unmount(), 0);
    },
  };
}
