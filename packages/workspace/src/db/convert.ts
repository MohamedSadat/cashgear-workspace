// Property type changes (Phase 4 contracts, section 2; DATA_MODEL.md, Databases). The same table
// runs on the server over every row it has and here over every row a device holds; coercion
// (values.ts, `coerceValue`) reads any JSON through it too. Shared vectors:
// db-convert-vectors.json.
//
// A value is first read as what it holds (its source), by its old type:
//
//   title, text, url, email, phone   text (whitespace only is empty)
//   number                           number
//   date, created and edited time    date (a point, or a span)
//   checkbox                         checked (unchecked is stored as no value)
//   select, status, multi-select     options: the known ones, in the value's order (unknown ids
//                                    are dropped: they read as empty)
//   person, created and edited by    people (ids)
//   files                            files (ids)
//   relation                         rows (ids) of the relation's database
//   formula, rollup                  the result: number, text, boolean as checked or not, date;
//                                    a list as text joined with ", "; an error or empty is nothing
//
// then written as the new type:
//
//   to \ from        text           number          date        checked  options        ids
//   text, title      as is          String(n)       start[ → end] "true"  names ", "     -
//   url, email,      trimmed        String(n)       start[ → end] "true"  names ", "     -
//     phone
//   number           parsed (1)     as is           -           1        one name parsed -
//   date             parsed (2)     -               as is       -        one name parsed -
//   checkbox         word (3)       n ≠ 0           -           as is    one name, word  -
//   select, status   option named   option named    option      option   same id, else   -
//                    (trimmed)      String(n)       named text  "true"   same name
//   multi-select     each of the    option named    as select   as select each: same id, -
//                    comma parts    String(n)                            else same name
//   person           -              -               -           -        -              people
//   files            -              -               -           -        -              files
//   relation         -              -               -           -        -              rows of
//                                                                                       the same
//                                                                                       database,
//                                                                                       first 1,000
//   formula, rollup, created and edited time and by: nothing (they store no value)
//
//   - is no value (cleared). (1) text.ts `parseNumberText`. (2) dates.ts `parseDateText`: ISO
//   points, `start → end`. (3) text.ts `parseBoolean`: true, yes, 1, on, checked, x, ✓, نعم and
//   false, no, 0, off, unchecked, لا; another word is no value. Checked false is no value. Option
//   names match exactly (after trimming the text), never by case or normalisation.
//
// `convertProperty` makes the options the new def needs: those the caller gave stay; going from an
// option type, the old def's options are added (by id) so values keep their ids; then each name the
// values need that no option has, in first-seen order, is added with `derivedOption`'s id and
// colour (status options: group `todo`).
import type { Id } from '../ids';
import { coerceDate, dateText, parseDateText } from './dates';
import { derivedOption } from './ids';
import { numberText, parseBoolean, parseNumberText, splitNames } from './text';
import type {
  CellValue,
  DateValue,
  OptionId,
  PropertyDef,
  PropertyType,
  SelectOption,
  StatusOption,
  Value,
} from './types';

/** A relation holds at most this many row ids. */
export const RELATION_LIMIT = 1000;

/** What a value holds, whatever its type (the rows of the table above). */
export type Source =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'date'; value: DateValue }
  | { kind: 'checkbox'; value: boolean }
  | { kind: 'options'; ids: OptionId[]; names: string[] }
  | { kind: 'ids'; of: 'person' | 'files' | 'relation'; ids: string[]; databaseId: Id | null };

export const isOptionType = (type: PropertyType): boolean =>
  type === 'select' || type === 'multiSelect' || type === 'status';

export const isErrorCell = (value: unknown): value is { error: string } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { error?: unknown }).error === 'string';

const textSource = (text: string): Source | undefined =>
  text.trim() === '' ? undefined : { kind: 'text', text };

function idList(value: unknown): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const ids: string[] = [];
  for (const id of list)
    if (typeof id === 'string' && id.trim() !== '' && !ids.includes(id)) ids.push(id);
  return ids;
}

/** A formula's or rollup's result, read as a source. */
function resultSource(value: unknown): Source | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) ? { kind: 'number', value } : undefined;
  if (typeof value === 'string') return textSource(value);
  if (typeof value === 'boolean') return { kind: 'checkbox', value };
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item !== '');
    return items.length ? textSource(items.join(', ')) : undefined;
  }
  if (isErrorCell(value)) return undefined;
  const date = coerceDate(value);
  return date && { kind: 'date', value: date };
}

/** What a value of `from` holds; undefined when it holds nothing. */
export function sourceOf(
  from: PropertyDef,
  value: CellValue | Value | undefined,
): Source | undefined {
  if (value === undefined || value === null) return undefined;
  switch (from.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return typeof value === 'string' ? textSource(value) : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { kind: 'number', value }
        : undefined;
    case 'checkbox':
      return value === true ? { kind: 'checkbox', value: true } : undefined;
    case 'date':
    case 'createdTime':
    case 'lastEditedTime': {
      const date = coerceDate(value);
      return date && { kind: 'date', value: date };
    }
    case 'select':
    case 'status':
    case 'multiSelect': {
      const known: (SelectOption | StatusOption)[] = [];
      for (const id of idList(value)) {
        const option = from.options?.find((o) => o.id === id);
        if (option && !known.includes(option)) known.push(option);
      }
      if (!known.length) return undefined;
      return { kind: 'options', ids: known.map((o) => o.id), names: known.map((o) => o.name) };
    }
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
    case 'files':
    case 'relation': {
      const ids = idList(value);
      if (!ids.length) return undefined;
      const of = from.type === 'files' ? 'files' : from.type === 'relation' ? 'relation' : 'person';
      return { kind: 'ids', of, ids, databaseId: from.relation?.databaseId ?? null };
    }
    case 'formula':
    case 'rollup':
      return resultSource(value);
    default:
      return undefined;
  }
}

/** What any JSON holds, by its shape alone (coercion of a value written to a property). */
export function jsonSource(raw: unknown): Source | undefined {
  if (typeof raw === 'string') return textSource(raw);
  if (typeof raw === 'number')
    return Number.isFinite(raw) ? { kind: 'number', value: raw } : undefined;
  if (typeof raw === 'boolean') return { kind: 'checkbox', value: raw };
  if (Array.isArray(raw)) {
    const items = raw.filter(
      (item): item is string => typeof item === 'string' && item.trim() !== '',
    );
    return items.length ? textSource(items.join(', ')) : undefined;
  }
  const date = coerceDate(raw);
  return date && { kind: 'date', value: date };
}

function textOf(s: Source): string | undefined {
  switch (s.kind) {
    case 'text':
      return s.text;
    case 'number':
      return numberText(s.value);
    case 'date':
      return dateText(s.value);
    case 'checkbox':
      return s.value ? 'true' : 'false';
    case 'options':
      return s.names.join(', ');
    default:
      return undefined;
  }
}

/** The one option name a scalar source gives (select, status; multi-select from a scalar). */
function nameOf(s: Source): string | undefined {
  if (s.kind === 'text') return s.text.trim() || undefined;
  if (s.kind === 'options' || s.kind === 'ids') return undefined;
  return textOf(s);
}

/** The names a value needs as options of a `to`-typed property. */
function namesNeeded(to: PropertyType, s: Source | undefined): string[] {
  if (!s || s.kind === 'options' || s.kind === 'ids') return [];
  if (to === 'multiSelect' && s.kind === 'text') return splitNames(s.text);
  const name = nameOf(s);
  return name ? [name] : [];
}

const byName = (options: readonly SelectOption[], name: string | undefined) =>
  name === undefined ? undefined : options.find((o) => o.name === name);

/** The only name of an options source, read as text (number, date, checkbox from an option). */
const oneName = (s: Source): string | undefined =>
  s.kind === 'options' ? (s.names.length === 1 ? s.names[0] : undefined) : undefined;

const zeroless = (n: number) => (n === 0 ? 0 : n);

/** A source written as `to`'s type: the table above. */
export function toTarget(to: PropertyDef, s: Source): Value | undefined {
  switch (to.type) {
    case 'title':
    case 'text': {
      const text = textOf(s);
      return text && text.trim() !== '' ? text : undefined;
    }
    case 'url':
    case 'email':
    case 'phone':
      return textOf(s)?.trim() || undefined;
    case 'number': {
      if (s.kind === 'number') return zeroless(s.value);
      if (s.kind === 'text') return parseNumberText(s.text);
      if (s.kind === 'checkbox') return s.value ? 1 : undefined;
      const name = oneName(s);
      return name === undefined ? undefined : parseNumberText(name);
    }
    case 'date': {
      if (s.kind === 'date') return s.value;
      if (s.kind === 'text') return parseDateText(s.text);
      const name = oneName(s);
      return name === undefined ? undefined : parseDateText(name);
    }
    case 'checkbox': {
      let checked: boolean | undefined;
      if (s.kind === 'checkbox') checked = s.value;
      else if (s.kind === 'number') checked = s.value !== 0;
      else if (s.kind === 'text') checked = parseBoolean(s.text);
      else if (s.kind === 'options') {
        const name = oneName(s);
        checked = name === undefined ? undefined : parseBoolean(name);
      }
      return checked ? true : undefined;
    }
    case 'select':
    case 'status': {
      const options = to.options ?? [];
      if (s.kind === 'options') {
        for (const id of s.ids) if (options.some((o) => o.id === id)) return id;
        for (const name of s.names) {
          const option = byName(options, name);
          if (option) return option.id;
        }
        return undefined;
      }
      return byName(options, nameOf(s))?.id;
    }
    case 'multiSelect': {
      const options = to.options ?? [];
      let ids: (OptionId | undefined)[];
      if (s.kind === 'options')
        ids = s.ids.map((id, i) =>
          options.some((o) => o.id === id) ? id : byName(options, s.names[i])?.id,
        );
      else if (s.kind === 'text') ids = splitNames(s.text).map((name) => byName(options, name)?.id);
      else ids = [byName(options, nameOf(s))?.id];
      const unique: OptionId[] = [];
      for (const id of ids) if (id !== undefined && !unique.includes(id)) unique.push(id);
      return unique.length ? unique : undefined;
    }
    case 'person':
    case 'files':
      return s.kind === 'ids' && s.of === to.type ? s.ids : undefined;
    case 'relation':
      return s.kind === 'ids' &&
        s.of === 'relation' &&
        s.databaseId !== null &&
        s.databaseId === (to.relation?.databaseId ?? null)
        ? s.ids.slice(0, RELATION_LIMIT)
        : undefined;
    default:
      return undefined;
  }
}

/**
 * A value of `from` as `to`'s type, by the table above; undefined is no value. `value` is the
 * stored value, or for a formula, rollup, created or edited time or by, what the cell reads as
 * (values.ts, `cellValue`). `to` must hold the options the value needs (`convertProperty`).
 */
export function convertValue(
  from: PropertyDef,
  to: PropertyDef,
  value: CellValue | Value | undefined,
): Value | undefined {
  const s = sourceOf(from, value);
  return s ? toTarget(to, s) : undefined;
}

/** Whether a property may change from one type to the other: the title property never does. */
export const canChangeType = (from: PropertyType, to: PropertyType): boolean =>
  from === to || (from !== 'title' && to !== 'title');

function shapeOption(
  option: SelectOption | StatusOption,
  type: PropertyType,
): SelectOption | StatusOption {
  if (type !== 'status' || 'group' in option) return { ...option };
  return { ...option, group: 'todo' };
}

/**
 * A property's type change: the new def (with the options its values need) and each value
 * converted, in the order given. `values` are as `convertValue` takes them; `databaseId` seeds the
 * derived option ids. Throws when the title property's type would change.
 */
export function convertProperty(
  from: PropertyDef,
  to: PropertyDef,
  values: readonly (CellValue | Value | undefined)[],
  databaseId: Id,
): { def: PropertyDef; values: (Value | undefined)[] } {
  if (!canChangeType(from.type, to.type)) throw new Error('The title property keeps its type');
  let def: PropertyDef = { ...to };
  if (isOptionType(to.type)) {
    const options = (to.options ?? []).map((o) => shapeOption(o, to.type));
    if (isOptionType(from.type))
      for (const option of from.options ?? [])
        if (!options.some((o) => o.id === option.id)) options.push(shapeOption(option, to.type));
    const names: string[] = [];
    for (const value of values)
      for (const name of namesNeeded(to.type, sourceOf(from, value)))
        if (!names.includes(name)) names.push(name);
    for (const name of names) {
      if (byName(options, name)) continue;
      const { id, colour } = derivedOption(
        databaseId,
        to.id,
        name,
        new Set(options.map((o) => o.id)),
      );
      options.push(
        to.type === 'status' ? { id, name, colour, group: 'todo' } : { id, name, colour },
      );
    }
    def = { ...to, options };
  }
  return { def, values: values.map((value) => convertValue(from, def, value)) };
}
