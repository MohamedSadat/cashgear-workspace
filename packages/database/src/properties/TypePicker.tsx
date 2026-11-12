// The list of property types to pick from: for a new property, and for a type change.
import type { PropertyType } from '../core';
import { useDbT } from '../i18n';
import { PICKABLE_TYPES, TYPE_GLYPH } from '../model/properties';
import { MenuItem, MenuList } from './MenuList';

export function TypePicker({
  current,
  label,
  onPick,
}: {
  current?: PropertyType;
  label: string;
  onPick(type: PropertyType): void;
}) {
  const { t } = useDbT();
  return (
    <MenuList label={label}>
      {PICKABLE_TYPES.map((type, i) => (
        <MenuItem
          key={type}
          glyph={TYPE_GLYPH[type]}
          checked={current === undefined ? undefined : current === type}
          initialFocus={current === undefined ? i === 0 : current === type}
          onSelect={() => onPick(type)}
        >
          {t(`type.${type}`)}
        </MenuItem>
      ))}
    </MenuList>
  );
}
