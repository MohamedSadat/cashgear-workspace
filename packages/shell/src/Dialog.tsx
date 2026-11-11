// A small modal dialog: focus moves in and is kept in, Escape closes it, focus goes back after.
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Dialog({
  title,
  onClose,
  children,
  role = 'dialog',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
}) {
  const box = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    const previous = returnTo.current;
    const el = box.current;
    if (el && !el.contains(document.activeElement))
      el.querySelector<HTMLElement>('input, button, [tabindex]')?.focus();
    return () => (previous as HTMLElement | null)?.focus?.();
  }, []);
  return createPortal(
    <div
      className="cgw-dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={box}
        className="cgw-dialog"
        role={role}
        aria-modal="true"
        aria-labelledby="cgw-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const items = [
            ...(box.current?.querySelectorAll<HTMLElement>(
              'input, button, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
            ) ?? []),
          ].filter((item) => !item.hasAttribute('disabled'));
          if (!items.length) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id="cgw-dialog-title" className="cgw-dialog-title">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
