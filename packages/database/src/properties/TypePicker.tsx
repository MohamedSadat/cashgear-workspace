// The list of property types to pick from: for a new property, and for a type change. A
// `CgMenuPanel` of `CgMenuPanelItem`s (the arrows, Home and End walk it).
import { CgMenuPanel, CgMenuPanelItem } from '@cashgear/ui';
import type { ReactNode } from 'react';
import type { PropertyType } from '../core';
import { useDatabaseContext, useHost } from '../context';
import { useDbT } from '../i18n';
import { PICKABLE_TYPES, TYPE_GLYPH } from '../model/properties';

export function TypePicker({
  current,
  label,
  header,
  onPick,
}: {
  current?: PropertyType;
  label: string;
  /** Above the list, such as a `CgMenuPanelHeader` with a back button. */
  header?: ReactNode;
  onPick(type: PropertyType): void;
}) {
  const { t } = useDbT();
  const { host } = useDatabaseContext();
  // Phase 15: a button only where the server runs automations and knows the type (its
  // `/version`): a web app deployed before its server must not offer what the server refuses.
  const buttons = useHost(host, () => host.automations?.knowsButtons() === true);
  const types =
    buttons || current === 'button' ? [...PICKABLE_TYPES, 'button' as const] : PICKABLE_TYPES;
  return (
    <CgMenuPanel label={label} header={header} className="cgw-db-menu-panel">
      {types.map((type, i) => (
        <CgMenuPanelItem
          key={type}
          icon={TYPE_GLYPH[type]}
          checked={current === undefined ? undefined : current === type}
          initialFocus={current === undefined ? i === 0 : current === type}
          onSelect={() => onPick(type)}
        >
          {t(`type.${type}`)}
        </CgMenuPanelItem>
      ))}
    </CgMenuPanel>
  );
}
