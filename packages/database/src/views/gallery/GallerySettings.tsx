// The gallery's layout settings: the card's picture (none, the page cover, or the first image of
// a files property) and the card size. One view write per change.
import { useId } from 'react';
import type { ViewConfig } from '../../core';
import { useDatabaseContext } from '../../context';
import { useDbT } from '../../i18n';
import { liveProperties } from '../../model/properties';
import type { ViewSettingsProps } from '../types';
import { coverOf, sizeOf, type CardSize } from './layout';

const SIZES: CardSize[] = ['small', 'medium', 'large'];

export function GallerySettings({ database, view }: ViewSettingsProps) {
  const { t } = useDbT();
  const { actions, editable } = useDatabaseContext();
  const id = useId();
  const files = liveProperties(database).filter((p) => p.type === 'files');
  const cover = coverOf(view.config);
  const coverValue = cover.kind === 'property' ? `p:${cover.propertyId}` : cover.kind;
  const write = (config: ViewConfig) => void actions.updateView(view, config);
  return (
    <div className="cgw-setup cgw-layout-settings">
      <label className="cgw-label" htmlFor={`${id}-cover`}>
        {t('layout.cover')}
      </label>
      <select
        id={`${id}-cover`}
        className="cgw-select"
        data-cg-initial-focus=""
        value={coverValue}
        disabled={!editable}
        onChange={(event) => {
          const value = event.target.value;
          write({
            ...view.config,
            cover:
              value === 'none'
                ? { kind: 'none' }
                : value === 'pageCover'
                  ? { kind: 'pageCover' }
                  : { kind: 'property', propertyId: value.slice(2) },
          });
        }}
      >
        <option value="none">{t('layout.coverNone')}</option>
        <option value="pageCover">{t('layout.coverPage')}</option>
        {files.map((p) => (
          <option key={p.id} value={`p:${p.id}`}>
            {t('layout.coverFiles', { name: p.name })}
          </option>
        ))}
      </select>
      <label className="cgw-label" htmlFor={`${id}-size`}>
        {t('layout.cardSize')}
      </label>
      <select
        id={`${id}-size`}
        className="cgw-select"
        value={sizeOf(view.config)}
        disabled={!editable}
        onChange={(event) => write({ ...view.config, cardSize: event.target.value as CardSize })}
      >
        {SIZES.map((size) => (
          <option key={size} value={size}>
            {t(`layout.${size}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
