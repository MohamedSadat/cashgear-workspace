// The flyout a picker cell edits in (dates, options, people, files, related rows), and the
// toolbar's and the menus' panels: a CgFlyout next to its anchor, mounted while it is open. It
// takes the focus on its first control (`data-cg-initial-focus`: a picker's search, a property's
// name; `autoFocus`), and closes on Escape and on a click outside; the picker writes its value
// then.
import { CgFlyout, type CgFlyoutCloseReason } from '@cashgear/ui';
import type { ReactNode } from 'react';

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
  return (
    <CgFlyout
      anchor={anchor}
      open
      autoFocus
      placement="bottom-start"
      offset={2}
      width={width ?? 300}
      maxHeight="min(30rem, calc(100vh - 16px))"
      role="dialog"
      aria-label={label}
      className={`cgw-db-flyout ${className ?? ''}`}
      onOpenChange={(open, details) => {
        if (!open) onClose(details.reason);
      }}
    >
      {children}
    </CgFlyout>
  );
}
