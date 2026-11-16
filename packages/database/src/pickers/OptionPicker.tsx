// Choosing options of a select, multi-select or status cell, and managing the property's options
// on the way (create one from what was typed, rename, recolour, regroup a status, reorder, delete),
// in the library's `CgOptionPicker`. This file only maps a property onto it: its options, the
// option colours (as the cells draw them), a status's groups, every string, and the workspace's
// search normalisation (`normaliseText`: alef forms, ya and ta marbuta, Arabic-Indic digits), so
// an option is found as every search here finds things.
import {
  CgOptionPicker,
  type CgOptionPickerColour,
  type CgOptionPickerGroup,
  type CgOptionPickerLabels,
  type CgOptionPickerOption,
} from '@cashgear/ui';
import { normaliseText } from '@cgw/workspace';
import { useMemo } from 'react';
import {
  OPTION_COLOURS,
  newOptionId,
  type OptionColour,
  type OptionId,
  type PropertyDef,
  type SelectOption,
  type StatusGroup,
  type StatusOption,
} from '../core';
import { useDbT } from '../i18n';

export const STATUS_GROUPS: readonly StatusGroup[] = ['todo', 'inProgress', 'complete'];
export const COLOURS: readonly OptionColour[] = ['default', ...OPTION_COLOURS];

export interface OptionPickerProps {
  def: PropertyDef;
  /** The chosen option ids. */
  selected: readonly OptionId[];
  multiple: boolean;
  /** The person may add and change options (edit on the database). */
  canManage: boolean;
  /** Typed text the search starts with. */
  seed?: string | null;
  /** The choice changed (single: the one picked, after which the cell closes). */
  onSelect(ids: OptionId[]): void;
  /** The property's options changed: written at once, as one `db.update`. */
  onDefChange(def: PropertyDef): void;
  /** Only managing the options (the property's menu): a click opens the option's editor. */
  manage?: boolean;
}

/** The colour a new option gets: the one used least so far, in palette order. */
export function nextColour(options: readonly SelectOption[]): OptionColour {
  const counts = new Map<OptionColour, number>();
  for (const o of options) counts.set(o.colour, (counts.get(o.colour) ?? 0) + 1);
  let best = OPTION_COLOURS[0];
  for (const c of OPTION_COLOURS) if ((counts.get(c) ?? 0) < (counts.get(best) ?? 0)) best = c;
  return best;
}

const groupOf = (o: SelectOption | StatusOption): StatusGroup =>
  'group' in o && o.group ? o.group : 'todo';

export function OptionPicker({
  def,
  selected,
  multiple,
  canManage,
  seed,
  onSelect,
  onDefChange,
  manage = false,
}: OptionPickerProps) {
  const { t } = useDbT();
  const isStatus = def.type === 'status';
  const own = useMemo(() => def.options ?? [], [def.options]);
  const options = useMemo<CgOptionPickerOption[]>(
    () =>
      own.map((o) => ({
        key: o.id,
        name: o.name,
        colour: o.colour,
        ...(isStatus ? { group: groupOf(o) } : {}),
      })),
    [own, isStatus],
  );
  const colours = useMemo<CgOptionPickerColour[]>(
    () =>
      COLOURS.map((c) => ({
        key: c,
        label: t(`colour.${c}`),
        background: `var(--cgw-db-${c}-bg)`,
        text: 'var(--cgw-db-chip-text)',
      })),
    [t],
  );
  const groups = useMemo<CgOptionPickerGroup[] | undefined>(
    () => (isStatus ? STATUS_GROUPS.map((g) => ({ key: g, label: t(`status.${g}`) })) : undefined),
    [isStatus, t],
  );
  const labels = useMemo<CgOptionPickerLabels>(
    () => ({
      search: t('option.search'),
      searchOnly: t('option.searchOnly'),
      list: t('option.list'),
      create: (name) => t('option.create', { name }),
      noMatch: t('option.noMatch'),
      none: t('option.none'),
      optionMenu: (name) => t('option.menu', { name }),
      drag: (name) => t('option.drag', { name }),
      remove: (name) => t('option.remove', { name }),
      back: t('back'),
      name: t('option.name'),
      colour: t('option.colour'),
      group: t('option.group'),
      delete: t('option.delete'),
    }),
    [t],
  );

  /** The picker's options back as the property's, each keeping what the picker does not know. */
  const write = (next: CgOptionPickerOption[]) => {
    const byId = new Map(own.map((o) => [o.id, o]));
    onDefChange({
      ...def,
      options: next.map((o) => {
        const base = byId.get(o.key) ?? { id: o.key, name: o.name, colour: 'default' as const };
        const colour = (o.colour ?? base.colour) as OptionColour;
        return isStatus
          ? { ...base, name: o.name, colour, group: (o.group ?? 'todo') as StatusGroup }
          : { ...base, name: o.name, colour };
      }),
    });
  };

  return (
    <CgOptionPicker
      className="cgw-picker"
      options={options}
      selected={selected}
      multiple={multiple}
      canManage={canManage}
      manage={manage}
      defaultQuery={seed ?? ''}
      colours={colours}
      groups={groups}
      labels={labels}
      normalize={normaliseText}
      createOption={(name) => ({
        key: newOptionId(),
        name,
        colour: nextColour(own),
        ...(isStatus ? { group: 'todo' } : {}),
      })}
      onSelectionChange={(ids) => onSelect(ids)}
      onOptionsChange={(next) => write(next)}
    />
  );
}
