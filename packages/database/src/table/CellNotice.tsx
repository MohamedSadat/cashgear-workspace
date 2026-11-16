// The notice under the table after a paste or a clear of several cells: what changed and what was
// left as it was, and Undo, which writes the old values back (and takes away the rows a paste
// added). It goes by itself after a while, but not while the pointer or the keyboard is on it, as
// the frame's notices do; Escape closes it. A refusal says so and offers nothing.
import { CgButton } from '@cashgear/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DbT } from '../i18n';

export interface CellNoticeState {
  /** A new notice each time, so its timer starts again for the same text. */
  id: number;
  text: string;
  error?: boolean;
  /** Takes the change back; absent once it has been, or when there is nothing to take back. */
  undo?: () => void;
}

const SHOWN_MS = 15_000;

export function CellNotice({
  notice,
  t,
  onClose,
}: {
  notice: CellNoticeState;
  t: DbT;
  onClose(): void;
}) {
  const [held, setHeld] = useState(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const hold = () => setHeld(hovered.current || focused.current);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(onClose, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [notice.id, held, onClose]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div
      className={`cgw-db-notice cgw-db-cell-notice${notice.error ? ' cgw-db-error' : ''}`}
      role={notice.error ? 'alert' : 'status'}
      onMouseEnter={() => ((hovered.current = true), hold())}
      onMouseLeave={() => ((hovered.current = false), hold())}
      onFocus={() => ((focused.current = true), hold())}
      onBlur={() => ((focused.current = false), hold())}
      onKeyDown={onKeyDown}
    >
      <span className="cgw-db-cell-notice-text">{notice.text}</span>
      {notice.undo ? (
        <CgButton appearance="outline" size="small" onClick={notice.undo}>
          {t('cells.undo')}
        </CgButton>
      ) : null}
      <CgButton appearance="ghost" size="small" onClick={onClose}>
        {t('cells.close')}
      </CgButton>
    </div>
  );
}
