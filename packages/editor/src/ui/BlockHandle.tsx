// The block handle's button and its drop line (Track U3): `@cashgear/ui`'s CgDragHandle drawn into
// the box the handle places beside a block (handle.ts), and CgDropIndicator into the frame, whose
// handle the drag moves directly. Drawn once, and again only when the label or the handle's boxes
// change: never per keystroke, never during a drag. The handle stays hidden from assistive
// technology as before (Ctrl+/ opens the block menu, Alt+Shift+arrows move a block).
import { CgDragHandle, CgDropIndicator, type CgDropIndicatorHandle } from '@cashgear/ui';
import { useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { BlockEditor } from '../editor';
import type { EditorHost } from '../host';

export function BlockHandleParts({ editor, host }: { editor: BlockEditor; host: EditorHost }) {
  const ui = editor.ui;
  const subscribe = useCallback(
    (listener: () => void) => {
      ui.onHandleParts = listener;
      return () => {
        if (ui.onHandleParts === listener) ui.onHandleParts = null;
      };
    },
    [ui],
  );
  const parts = useSyncExternalStore(subscribe, () => ui.handleParts ?? null);
  const setIndicator = useCallback(
    (indicator: CgDropIndicatorHandle | null) => {
      ui.dropIndicator = indicator;
    },
    [ui],
  );
  const label = host.strings?.dragHandle;
  if (!parts) return null;
  return (
    <>
      {label && createPortal(<CgDragHandle label={label} tabIndex={-1} />, parts.handle)}
      {createPortal(<CgDropIndicator ref={setIndicator} className="cgw-block-drop" />, parts.line)}
    </>
  );
}
