import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** A notice's link: where the work it speaks of is. */
export interface NoticeAction {
  label: string;
  href?: string;
  onSelect?: () => void;
}

/**
 * A short notice at the bottom of the window: what happened, where the work is (a link, if any),
 * and a way to dismiss it. It goes by itself after a while, but not while the pointer or the
 * keyboard is on it.
 */
export function Notice({
  text,
  action,
  onClose,
}: {
  text: string;
  action?: NoticeAction;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [held, setHeld] = useState(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const hold = () => setHeld(hovered.current || focused.current);
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(onClose, 8000);
    return () => window.clearTimeout(timer);
  }, [text, onClose, held]);
  return (
    <div
      className="cgw-notice"
      role="alert"
      onMouseEnter={() => ((hovered.current = true), hold())}
      onMouseLeave={() => ((hovered.current = false), hold())}
      onFocus={() => ((focused.current = true), hold())}
      onBlur={() => ((focused.current = false), hold())}
    >
      <span>{text}</span>
      {action &&
        (action.href ? (
          <a
            className="cgw-link-button cgw-notice-action"
            href={action.href}
            onClick={() => {
              action.onSelect?.();
              onClose();
            }}
          >
            {action.label}
          </a>
        ) : (
          <button
            type="button"
            className="cgw-link-button cgw-notice-action"
            onClick={() => {
              action.onSelect?.();
              onClose();
            }}
          >
            {action.label}
          </button>
        ))}
      <button type="button" className="cgw-link-button" onClick={onClose}>
        {t('frame.close')}
      </button>
    </div>
  );
}
