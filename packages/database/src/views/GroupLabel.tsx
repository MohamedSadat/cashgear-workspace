// A group's name as a view's section header (table, list) or column (board) shows it: the
// option's chip, the person, Checked or Not checked, the date's day, week, month or year, and
// "No <property>" for the group of rows without a value.
import type { GroupRule, PropertyDef } from '../core';
import { OptionChip, PersonChip } from '../cells/CellDisplay';
import type { CellEnv } from '../cells/env';
import { formatDatePart, optionById } from '../model/format';

const monthFormats = new Map<string, Intl.DateTimeFormat>();
function monthFormat(locale: string, year: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${year}`;
  let format = monthFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(
      locale,
      year
        ? { year: 'numeric', timeZone: 'UTC' }
        : { year: 'numeric', month: 'long', timeZone: 'UTC' },
    );
    monthFormats.set(key, format);
  }
  return format;
}

/** A group's name as text (for accessible names and the board's column labels). */
export function groupText(
  def: PropertyDef | undefined,
  rule: GroupRule,
  key: string,
  env: CellEnv,
): string {
  if (!def) return key;
  if (key === '') return env.t('group.noValue', { name: def.name });
  switch (def.type) {
    case 'select':
    case 'status':
    case 'multiSelect':
      return optionById(def, key)?.name ?? key;
    case 'checkbox':
      return key === 'true' ? env.t('group.checked') : env.t('group.unchecked');
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
      return env.people.get(key)?.name ?? env.t('person.unknown');
    case 'date':
    case 'createdTime':
    case 'lastEditedTime': {
      const [y, m, d] = key.split('-').map(Number);
      if (!y || !m || !d) return key;
      const date = new Date(Date.UTC(y, m - 1, d));
      switch (rule.dateBy ?? 'month') {
        case 'year':
          return monthFormat(env.locale, true).format(date);
        case 'month':
          return monthFormat(env.locale, false).format(date);
        case 'week':
          return env.t('group.weekOf', { date: formatDatePart(key, env.locale) });
        default:
          return formatDatePart(key, env.locale);
      }
    }
    default:
      return key;
  }
}

export function GroupLabel({
  def,
  rule,
  groupKey,
  env,
}: {
  def: PropertyDef | undefined;
  rule: GroupRule;
  groupKey: string;
  env: CellEnv;
}) {
  if (def && groupKey !== '') {
    if (def.type === 'select' || def.type === 'status' || def.type === 'multiSelect') {
      const option = optionById(def, groupKey);
      if (option) return <OptionChip name={option.name} colour={option.colour} />;
    }
    if (def.type === 'person' || def.type === 'createdBy' || def.type === 'lastEditedBy')
      return <PersonChip id={groupKey} env={env} />;
  }
  return (
    <span className="cgw-group-name" dir="auto">
      {groupText(def, rule, groupKey, env)}
    </span>
  );
}
