// The flyout a picker cell edits in (dates, options, people, files, related rows): a CgFlyout
// next to the cell, mounted only while it is open (each mounted flyout watches the document for
// its anchor). It closes on Escape and on a click outside; the picker writes its value then.
import { CgFlyout, type CgFlyoutActions, type CgFlyoutCloseReason } from '@cashgear/ui';
import { useEffect, useRef, type ReactNode } from 'react';

export interface CellFlyoutProps {
  anchor: HTMLElement;
  label: string;
  onClose(reason: CgFlyoutCloseReason | 'programmatic'): void;
  children: ReactNode;
  width?: number | string;
  className?: string;
}

export function CellFlyout({
  anchor,
  label,
  onClose,
  children,
  width,
  className,
}: CellFlyoutProps) {
  const actions = useRef<CgFlyoutActions>(null);
  // The library calls `onAfterOpen` when a flyout opens after it was mounted; these mount open,
  // so it never ran and the focus stayed behind the flyout (keys typed went to the grid). Its
  // first control (`data-cg-initial-focus`: a picker's search, a property's name) takes the focus
  // once the flyout is drawn.
  useEffect(() => {
    const frame = requestAnimationFrame(() => actions.current?.focusFirst());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <CgFlyout
      anchor={anchor}
      open
      actionsRef={actions}
      placement="bottom-start"
      offset={2}
      width={width ?? 300}
      // Stand-in for Track U: the library's positioned overlay spreads its computed position,
      // `width: undefined` included, over an explicit width, so the flyout measured only its
      // padding and was never shifted or flipped into the window (menus at the window's edge
      // were cut off). `style` is spread last, so the width holds.
      style={{ width: width ?? 300 }}
      maxHeight="min(30rem, calc(100vh - 16px))"
      role="dialog"
      aria-label={label}
      className={`cgw-db-flyout ${className ?? ''}`}
      onAfterOpen={() => actions.current?.focusFirst()}
      onOpenChange={(open, details) => {
        if (!open) onClose(details.reason);
      }}
    >
      {children}
    </CgFlyout>
  );
}
