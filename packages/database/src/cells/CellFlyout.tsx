// The flyout a picker cell edits in (dates, options, people, files, related rows): a CgFlyout
// next to the cell, mounted only while it is open (each mounted flyout watches the document for
// its anchor). It closes on Escape and on a click outside; the picker writes its value then.
import { CgFlyout, type CgFlyoutActions, type CgFlyoutCloseReason } from '@cashgear/ui';
import { useRef, type ReactNode } from 'react';

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
  return (
    <CgFlyout
      anchor={anchor}
      open
      actionsRef={actions}
      placement="bottom-start"
      offset={2}
      width={width ?? 300}
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
