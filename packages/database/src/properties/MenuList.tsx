// A vertical menu inside a flyout: items are buttons with a menu role, walked with the arrow keys,
// Home and End (focus moves; Enter or Space activates the focused button).
import type { KeyboardEvent, ReactNode } from 'react';

const ITEMS =
  '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled]),[role="menuitemcheckbox"]:not([disabled])';

export function menuKeys(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next = 0;
  if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
  else if (event.key === 'ArrowUp')
    next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  items[next].focus();
}

export function MenuList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="menu" aria-label={label} className="cgw-db-menu" onKeyDown={menuKeys}>
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  glyph,
  hint,
  danger,
  disabled,
  checked,
  initialFocus,
}: {
  children: ReactNode;
  onSelect(): void;
  glyph?: string;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** A check or radio item when given. */
  checked?: boolean;
  initialFocus?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      tabIndex={-1}
      disabled={disabled}
      data-cg-initial-focus={initialFocus ? '' : undefined}
      className={`cgw-db-menu-item${danger ? ' cgw-danger' : ''}`}
      onClick={onSelect}
    >
      <span className="cgw-db-menu-glyph" aria-hidden="true">
        {checked ? '✓' : (glyph ?? '')}
      </span>
      <span className="cgw-db-menu-text">{children}</span>
      {hint ? <span className="cgw-db-menu-hint">{hint}</span> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="cgw-db-menu-separator" />;
}
