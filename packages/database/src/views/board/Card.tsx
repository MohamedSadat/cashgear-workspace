// A row as a card (the board's and the gallery's): its picture when it has one, its title and a
// line for each shown property with a value, drawn by `renderCell`. No handlers of its own: the
// view listens on its box and finds the card by `data-card` (open, drag, keys, menu), so a card is
// drawn again only when its row, its place or whether it has the focus changes.
import type { RowRecord } from '@cgw/workspace';
import { memo, type CSSProperties, type ReactNode } from 'react';
import { renderCell } from '../../cells/CellDisplay';
import type { CellEnv } from '../../cells/env';
import type { PropertyDef } from '../../core';
import { cardLines } from './layout';

export interface CardProps {
  row: RowRecord;
  /** Unique in the view (a row may be in several columns): `group:rowId`. */
  cardKey: string;
  /** The element id prefix of the view (for the title's id). */
  idPrefix: string;
  shown: readonly PropertyDef[];
  env: CellEnv;
  /** The card the keyboard is on: the one card in the tab order. */
  active: boolean;
  style: CSSProperties;
  /** A picture above the title (the gallery's cover). */
  cover?: ReactNode;
  draggable: boolean;
}

export const cardDomId = (prefix: string, cardKey: string) =>
  `${prefix}-c-${cardKey.replace(/[^A-Za-z0-9_-]/g, '_')}`;

export const Card = memo(function Card({
  row,
  cardKey,
  idPrefix,
  shown,
  env,
  active,
  style,
  cover,
  draggable,
}: CardProps) {
  const id = cardDomId(idPrefix, cardKey);
  const title = row.title || env.t('untitled');
  return (
    <div
      id={id}
      className="cgw-card"
      role="article"
      tabIndex={active ? 0 : -1}
      data-card={cardKey}
      data-row-id={row.id}
      data-draggable={draggable || undefined}
      aria-labelledby={`${id}-t`}
      aria-description={draggable ? env.t('card.moveHint') : undefined}
      style={style}
    >
      {cover}
      <div className="cgw-card-body">
        <div className="cgw-card-title" id={`${id}-t`}>
          {row.icon ? (
            <span className="cgw-card-icon" aria-hidden="true">
              {row.icon}
            </span>
          ) : null}
          <span className={row.title ? undefined : 'cgw-card-untitled'} dir="auto">
            {title}
          </span>
        </div>
        {cardLines(row, shown).map((def) => (
          <div key={def.id} className="cgw-card-line" title={def.name}>
            {renderCell(def, row, env)}
          </div>
        ))}
      </div>
    </div>
  );
});
