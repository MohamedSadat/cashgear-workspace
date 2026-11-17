// Contract `plugin-frame.1` in code (Phase 10, M10.4; DECISIONS.md, 2026-11-18): the messages
// between a Workspace page and a third-party plugin's sandboxed frame, and the validators both
// ends run on every message before using it. Modelled on `sheet-embed.1` (packages/editor's
// sheet/contract.ts). The vectors in `packages/plugins/vectors/plugin-frame-vectors.json` hold
// each verdict, so a plugin's author can run them through their own validators. No DOM, no
// network.
//
// Every message is a plain object with a known `type`, exactly the fields its table names (none
// missing, none extra: a contract version never changes once shipped), and every field as the
// field rules say. A parsed message is a fresh object holding only those fields, so nothing the
// sender added (a getter, an own `__proto__`) reaches the caller. Props are JSON data only.

/** The one contract version this code speaks. */
export const PLUGIN_FRAME_CONTRACT = 'plugin-frame.1';

/** The contract's limits (DECISIONS.md, 2026-11-18). */
export const PLUGIN_LIMITS = Object.freeze({
  /** A block's props as the plugin sees and writes them: their JSON's UTF-8 bytes. */
  propsBytes: 16 * 1024,
  /** Nesting of a props value (an object or an array is a level). */
  propsDepth: 32,
  /** The frame's height, CSS px: a `resize` is held to this range, past it the frame scrolls. */
  minHeight: 48,
  maxHeight: 1200,
  /** The frame's first height when the manifest names none. */
  defaultHeight: 240,
  /** A `resize`'s own bound (the host clamps what it takes to the range above). */
  reportedHeight: 100_000,
  /** Rows a plugin is shown of its view. */
  rows: 500,
  /** Properties a `Rows` names. */
  properties: 500,
  /** An `error`'s message, for the log only. */
  message: 500,
});

/** The codes a `refused` carries, the answer to a `setProps` that was not written. */
export const REFUSED_CODES = ['props.readOnly', 'props.invalid', 'props.tooLarge'] as const;
export type RefusedCode = (typeof REFUSED_CODES)[number];

export type PluginTheme = 'light' | 'dark';
export type PluginDirection = 'ltr' | 'rtl';
export type PluginLanguage = 'en' | 'ar';

/** JSON data, as a block's props hold it. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A block's props as the plugin sees them: a JSON object, without the host's `$` keys. */
export type PluginProps = { [key: string]: JsonValue };

/** Which plugin the frame is: its manifest's type and the version installed. */
export interface PluginRef {
  type: string;
  version: number;
}

/**
 * The block as the plugin may treat it: the version of the plugin that last wrote its props
 * (null for a block never written), whether the reader may change it here, and whether a later
 * version of the plugin wrote it (then it is drawn read-only and never written).
 */
export interface PluginBlockState {
  version: number | null;
  editable: boolean;
  newer: boolean;
}

/** Property types a plugin may be shown: never a person's (person, created by, edited by). */
export const ROWS_PROPERTY_TYPES = [
  'title',
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multiSelect',
  'status',
  'url',
  'email',
  'phone',
  'files',
  'relation',
  'formula',
  'rollup',
  'createdTime',
  'lastEditedTime',
] as const;
export type RowsPropertyType = (typeof ROWS_PROPERTY_TYPES)[number];

export const OPTION_COLOURS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
export type RowsOptionColour = (typeof OPTION_COLOURS)[number];

export const STATUS_GROUPS = ['todo', 'inProgress', 'complete'] as const;

export interface RowsOption {
  id: string;
  name: string;
  colour: RowsOptionColour;
  /** A status option's group. */
  group?: (typeof STATUS_GROUPS)[number];
}

export interface RowsProperty {
  id: string;
  name: string;
  type: RowsPropertyType;
  /** Select, multi-select and status: the options in their order. */
  options?: RowsOption[];
}

/**
 * A row as a plugin is shown it: its title, and the values of the view's shown properties by
 * property id (an empty value is absent). Stored values as rows hold them (text a string, a
 * number, a checkbox a boolean, a date `{start, end?}`, a select or status an option id, a
 * multi-select option ids, files asset ids, a relation row ids); a formula's or rollup's result
 * as the row's computed value (`{error}` when it failed); created and edited time `{start}`.
 */
export interface RowsRow {
  id: string;
  title: string;
  values: { [propertyId: string]: JsonValue };
}

/**
 * A database view's rows (only when the manifest asks, `reads.rows`, and the block names a view):
 * the view's own filter and sorts, its shown properties only, never a person, at most 500 rows,
 * read as the reader may read them.
 */
export interface Rows {
  databaseId: string;
  viewId: string;
  properties: RowsProperty[];
  rows: RowsRow[];
  /** Rows the view holds for the reader. */
  total: number;
  /** Every one of them is in `rows`. */
  complete: boolean;
}

// ---- Host to plugin ---------------------------------------------------------------------------

export interface InitMessage {
  type: 'init';
  contract: typeof PLUGIN_FRAME_CONTRACT;
  plugin: PluginRef;
  block: PluginBlockState;
  props: PluginProps;
  theme: PluginTheme;
  direction: PluginDirection;
  language: PluginLanguage;
  rows: Rows | null;
}

/** The block's props changed elsewhere (Undo, a collaborator). */
export interface PropsMessage {
  type: 'props';
  props: PluginProps;
}

export interface ThemeMessage {
  type: 'theme';
  theme: PluginTheme;
  direction: PluginDirection;
  language: PluginLanguage;
}

export interface EditableMessage {
  type: 'editable';
  editable: boolean;
  newer: boolean;
}

/** The view's rows changed, or the database went away (null). */
export interface RowsMessage {
  type: 'rows';
  rows: Rows | null;
}

/** A `setProps` was written. */
export interface SavedMessage {
  type: 'saved';
}

/** A `setProps` was not written. */
export interface RefusedMessage {
  type: 'refused';
  code: RefusedCode;
}

/** Host to plugin: `init` on the window (with the port), the rest on the port. */
export type HostMessage =
  | InitMessage
  | PropsMessage
  | ThemeMessage
  | EditableMessage
  | RowsMessage
  | SavedMessage
  | RefusedMessage;

// ---- Plugin to host ---------------------------------------------------------------------------

/** The contracts the plugin speaks (on the window, to `window.parent`, target `"*"`). */
export interface ReadyMessage {
  type: 'ready';
  contracts: string[];
}

/** The content's height, CSS px; the frame is made that tall within 48 to 1,200. */
export interface ResizeMessage {
  type: 'resize';
  height: number;
}

/**
 * The plugin's whole props, to be written as one undoable edit. `props` is checked by
 * `checkProps` (the answer is `saved` or `refused`), not by the message's validator.
 */
export interface SetPropsMessage {
  type: 'setProps';
  props: unknown;
}

/** The plugin cannot draw; `message` is for the log only. */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

/** Plugin to host: `ready` on the window, the rest on the port. */
export type PluginMessage = ReadyMessage | ResizeMessage | SetPropsMessage | ErrorMessage;

// ---- Field rules ------------------------------------------------------------------------------

const MAX_CONTRACTS = 16;
const MAX_CONTRACT_NAME = 64;
const MAX_NAME = 200;
const MAX_TITLE = 10_000;
const MAX_TEXT = 100_000;
const MAX_LIST = 1000;
const MAX_VALUE_DEPTH = 4;
const MAX_TOTAL = 1_000_000_000;
const MAX_VERSION = 2_147_483_647;

type Fields = Record<string, unknown>;

/** A plain object of any realm: its prototype is an `Object.prototype` or null. */
function isPlainObject(data: unknown): data is Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const proto: unknown = Object.getPrototypeOf(data);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return false;
  return Object.prototype.toString.call(data) === '[object Object]';
}

/**
 * A plain object whose own keys are exactly `required` plus any of `optional`, each a data
 * property: its values in a fresh map, or null.
 */
function fields(
  data: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Fields | null {
  if (!isPlainObject(data)) return null;
  const out: Fields = Object.create(null) as Fields;
  let seen = 0;
  for (const key of Reflect.ownKeys(data)) {
    if (typeof key !== 'string') return null;
    if (!required.includes(key) && !optional.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    if (!descriptor || !('value' in descriptor)) return null;
    out[key] = descriptor.value;
    if (required.includes(key)) seen++;
  }
  return seen === required.length ? out : null;
}

/** The message's own `type`, when it is a plain object with a string one. */
function typeOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(data, 'type');
  return descriptor && typeof descriptor.value === 'string' ? descriptor.value : null;
}

const isString = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max;

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value);

const THEMES = ['light', 'dark'] as const;
const DIRECTIONS = ['ltr', 'rtl'] as const;
const LANGUAGES = ['en', 'ar'] as const;

/** Ids of databases, views, rows, properties and options: 1 to 64 of `[A-Za-z0-9_-]`. */
export const isRowsId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** A plugin's type: dotted lower-case words, 3 to 64 characters, never `cashgear.*`. */
export function isPluginType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(value) &&
    !value.startsWith('cashgear.')
  );
}

/** A plugin's version: a whole number from 1. */
export const isPluginVersion = (value: unknown): value is number =>
  isInteger(value, 1, MAX_VERSION);

/** An `error`'s code: 1 to 64 of `[A-Za-z0-9._-]`, the plugin's own. */
const isErrorCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);

function parseList<T>(data: unknown, max: number, item: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(data) || data.length > max) return null;
  const out: T[] = [];
  for (let i = 0; i < data.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(data, i)) return null;
    const parsed = item(data[i]);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

// ---- JSON data --------------------------------------------------------------------------------

/** Why a value is not JSON data, or would be too large: what `walkJson` found. */
type JsonVerdict = { ok: true; value: JsonValue } | { ok: false; why: 'invalid' | 'tooLarge' };

/**
 * A value as JSON data (plain objects, dense arrays, strings, finite numbers, booleans, null), as
 * a fresh copy holding only data properties; `invalid` for anything else or nested deeper than
 * `depth`; `tooLarge` as soon as it holds more than `budget` string characters and nodes (a cheap
 * bound, checked before the JSON is measured).
 */
function walkJson(
  value: unknown,
  depth: number,
  limits: { text: number; list: number },
  budget: { left: number },
): JsonVerdict {
  if (--budget.left < 0) return { ok: false, why: 'tooLarge' };
  if (value === null || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number')
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, why: 'invalid' };
  if (typeof value === 'string') {
    if (value.length > limits.text) return { ok: false, why: 'tooLarge' };
    budget.left -= value.length;
    return budget.left < 0 ? { ok: false, why: 'tooLarge' } : { ok: true, value };
  }
  if (typeof value !== 'object') return { ok: false, why: 'invalid' };
  if (depth <= 0) return { ok: false, why: 'invalid' };
  if (Array.isArray(value)) {
    if (!isPlainArray(value)) return { ok: false, why: 'invalid' };
    if (value.length > limits.list) return { ok: false, why: 'tooLarge' };
    const keys = Reflect.ownKeys(value);
    // Exactly the indexes and `length`: no holes, no extra keys.
    if (keys.length !== value.length + 1) return { ok: false, why: 'invalid' };
    const out: JsonValue[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (!descriptor || !('value' in descriptor)) return { ok: false, why: 'invalid' };
      const item = walkJson(descriptor.value, depth - 1, limits, budget);
      if (!item.ok) return item;
      out.push(item.value);
    }
    return { ok: true, value: out };
  }
  if (!isPlainObject(value)) return { ok: false, why: 'invalid' };
  const out: { [key: string]: JsonValue } = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return { ok: false, why: 'invalid' };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return { ok: false, why: 'invalid' };
    budget.left -= key.length;
    const item = walkJson(descriptor.value, depth - 1, limits, budget);
    if (!item.ok) return item;
    define(out, key, item.value);
  }
  return { ok: true, value: out };
}

/** An array of any realm, not a subclass: Array.prototype, then Object.prototype, then null. */
function isPlainArray(value: unknown[]): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null) return false;
  const base: unknown = Object.getPrototypeOf(proto);
  return base !== null && Object.getPrototypeOf(base) === null;
}

/** Sets an own data property, `__proto__` included (never the prototype). */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const utf8 = new TextEncoder();

/** The UTF-8 bytes of a JSON value's text. */
export const jsonBytes = (value: JsonValue): number => utf8.encode(JSON.stringify(value)).length;

/** The answer to a `setProps`'s props: the props to write, or why not. */
export type PropsCheck =
  { ok: true; props: PluginProps } | { ok: false; code: 'props.invalid' | 'props.tooLarge' };

/**
 * Props as a plugin sends them: a JSON object (nested at most 32 deep), its top-level keys that
 * start with `$` dropped (they are the host's), at most 16 KB as JSON. A fresh copy; never throws.
 */
export function checkProps(value: unknown): PropsCheck {
  if (!isPlainObject(value)) return { ok: false, code: 'props.invalid' };
  const walked = walkJson(
    value,
    PLUGIN_LIMITS.propsDepth,
    { text: PLUGIN_LIMITS.propsBytes, list: PLUGIN_LIMITS.propsBytes },
    { left: PLUGIN_LIMITS.propsBytes * 2 },
  );
  if (!walked.ok)
    return { ok: false, code: walked.why === 'invalid' ? 'props.invalid' : 'props.tooLarge' };
  const props: PluginProps = {};
  for (const [key, item] of Object.entries(walked.value as PluginProps))
    if (!key.startsWith('$')) define(props, key, item);
  return jsonBytes(props) > PLUGIN_LIMITS.propsBytes
    ? { ok: false, code: 'props.tooLarge' }
    : { ok: true, props };
}

/** Props as the host sends them: as `checkProps` takes them, and holding no `$` key. */
function parseShownProps(value: unknown): PluginProps | null {
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) if (key.startsWith('$')) return null;
  const checked = checkProps(value);
  return checked.ok ? checked.props : null;
}

/** The bounds of a row's texts: a title, a property's or option's name. */
export const ROWS_TEXT = Object.freeze({ title: MAX_TITLE, name: MAX_NAME });

/** Whether a row's value is as `Rows` carries one (not null: an empty value is absent). */
export const isRowsValue = (value: unknown): boolean =>
  value !== null && parseValue(value) !== null;

/** A value of a row: JSON data, nested at most 4 deep, texts of at most 100,000 characters. */
function parseValue(value: unknown): JsonValue | null {
  if (value === null) return null;
  const walked = walkJson(
    value,
    MAX_VALUE_DEPTH,
    { text: MAX_TEXT, list: MAX_LIST },
    { left: MAX_TEXT * 2 },
  );
  return walked.ok ? walked.value : null;
}

function parseOption(data: unknown, status: boolean): RowsOption | null {
  const f = fields(data, ['id', 'name', 'colour'], status ? ['group'] : []);
  if (!f || !isRowsId(f.id) || !isString(f.name, 0, MAX_NAME)) return null;
  if (!oneOf(f.colour, OPTION_COLOURS)) return null;
  if (status && 'group' in f) {
    if (!oneOf(f.group, STATUS_GROUPS)) return null;
    return { id: f.id, name: f.name, colour: f.colour, group: f.group };
  }
  return { id: f.id, name: f.name, colour: f.colour };
}

const WITH_OPTIONS: readonly string[] = ['select', 'multiSelect', 'status'];

function parseProperty(data: unknown): RowsProperty | null {
  const type = isPlainObject(data) ? Object.getOwnPropertyDescriptor(data, 'type')?.value : null;
  const optioned = WITH_OPTIONS.includes(type as string);
  const f = fields(data, ['id', 'name', 'type'], optioned ? ['options'] : []);
  if (!f || !isRowsId(f.id) || !isString(f.name, 0, MAX_NAME)) return null;
  if (!oneOf(f.type, ROWS_PROPERTY_TYPES)) return null;
  if (!('options' in f)) return { id: f.id, name: f.name, type: f.type };
  const options = parseList(f.options, MAX_LIST, (o) => parseOption(o, f.type === 'status'));
  return options ? { id: f.id, name: f.name, type: f.type, options } : null;
}

function parseRow(data: unknown): RowsRow | null {
  const f = fields(data, ['id', 'title', 'values']);
  if (!f || !isRowsId(f.id) || !isString(f.title, 0, MAX_TITLE)) return null;
  if (!isPlainObject(f.values)) return null;
  const values: { [key: string]: JsonValue } = {};
  for (const key of Reflect.ownKeys(f.values)) {
    if (!isRowsId(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(f.values, key);
    // An empty value is absent, never null.
    if (!descriptor || !('value' in descriptor) || descriptor.value === null) return null;
    const value = parseValue(descriptor.value);
    if (value === null) return null;
    define(values, key, value);
  }
  return { id: f.id, title: f.title, values };
}

/** A view's rows, or null (for `null` too: say which with `parseRowsOrNull`). */
export function parseRows(data: unknown): Rows | null {
  const f = fields(data, ['databaseId', 'viewId', 'properties', 'rows', 'total', 'complete']);
  if (!f || !isRowsId(f.databaseId) || !isRowsId(f.viewId)) return null;
  if (!isInteger(f.total, 0, MAX_TOTAL) || typeof f.complete !== 'boolean') return null;
  const properties = parseList(f.properties, PLUGIN_LIMITS.properties, parseProperty);
  const rows = parseList(f.rows, PLUGIN_LIMITS.rows, parseRow);
  if (!properties || !rows) return null;
  if (new Set(properties.map((p) => p.id)).size !== properties.length) return null;
  if (new Set(rows.map((r) => r.id)).size !== rows.length) return null;
  if (rows.length > f.total) return null;
  return {
    databaseId: f.databaseId,
    viewId: f.viewId,
    properties,
    rows,
    total: f.total,
    complete: f.complete,
  };
}

/** `rows` as a message carries it: Rows, or null (no view, or the database went away). */
function parseRowsField(data: unknown): { rows: Rows | null } | null {
  if (data === null) return { rows: null };
  const rows = parseRows(data);
  return rows ? { rows } : null;
}

function parsePluginRef(data: unknown): PluginRef | null {
  const f = fields(data, ['type', 'version']);
  return f && isPluginType(f.type) && isPluginVersion(f.version)
    ? { type: f.type, version: f.version }
    : null;
}

function parseBlockState(data: unknown): PluginBlockState | null {
  const f = fields(data, ['version', 'editable', 'newer']);
  if (!f || (f.version !== null && !isPluginVersion(f.version))) return null;
  if (typeof f.editable !== 'boolean' || typeof f.newer !== 'boolean') return null;
  // A block a later version wrote is never editable.
  if (f.newer && f.editable) return null;
  return { version: f.version as number | null, editable: f.editable, newer: f.newer };
}

/** A message from the host (`init` on the window, the rest on the port), or null. */
export function parseHostMessage(data: unknown): HostMessage | null {
  switch (typeOf(data)) {
    case 'init': {
      const f = fields(data, [
        'type',
        'contract',
        'plugin',
        'block',
        'props',
        'theme',
        'direction',
        'language',
        'rows',
      ]);
      if (!f || f.contract !== PLUGIN_FRAME_CONTRACT) return null;
      const plugin = parsePluginRef(f.plugin);
      const block = parseBlockState(f.block);
      const props = parseShownProps(f.props);
      const rows = parseRowsField(f.rows);
      if (!plugin || !block || !props || !rows) return null;
      if (!oneOf(f.theme, THEMES) || !oneOf(f.direction, DIRECTIONS)) return null;
      if (!oneOf(f.language, LANGUAGES)) return null;
      return {
        type: 'init',
        contract: PLUGIN_FRAME_CONTRACT,
        plugin,
        block,
        props,
        theme: f.theme,
        direction: f.direction,
        language: f.language,
        rows: rows.rows,
      };
    }
    case 'props': {
      const f = fields(data, ['type', 'props']);
      const props = f && parseShownProps(f.props);
      return props ? { type: 'props', props } : null;
    }
    case 'theme': {
      const f = fields(data, ['type', 'theme', 'direction', 'language']);
      if (!f || !oneOf(f.theme, THEMES) || !oneOf(f.direction, DIRECTIONS)) return null;
      if (!oneOf(f.language, LANGUAGES)) return null;
      return { type: 'theme', theme: f.theme, direction: f.direction, language: f.language };
    }
    case 'editable': {
      const f = fields(data, ['type', 'editable', 'newer']);
      if (!f || typeof f.editable !== 'boolean' || typeof f.newer !== 'boolean') return null;
      if (f.newer && f.editable) return null;
      return { type: 'editable', editable: f.editable, newer: f.newer };
    }
    case 'rows': {
      const f = fields(data, ['type', 'rows']);
      const rows = f && parseRowsField(f.rows);
      return rows ? { type: 'rows', rows: rows.rows } : null;
    }
    case 'saved':
      return fields(data, ['type']) ? { type: 'saved' } : null;
    case 'refused': {
      const f = fields(data, ['type', 'code']);
      return f && oneOf(f.code, REFUSED_CODES) ? { type: 'refused', code: f.code } : null;
    }
    default:
      return null;
  }
}

/** A message from the plugin (`ready` on the window, the rest on the port), or null. */
export function parsePluginMessage(data: unknown): PluginMessage | null {
  switch (typeOf(data)) {
    case 'ready': {
      const f = fields(data, ['type', 'contracts']);
      const contracts =
        f &&
        parseList(f.contracts, MAX_CONTRACTS, (c) =>
          isString(c, 1, MAX_CONTRACT_NAME) ? c : null,
        );
      return contracts && contracts.length > 0 ? { type: 'ready', contracts } : null;
    }
    case 'resize': {
      const f = fields(data, ['type', 'height']);
      return f && isInteger(f.height, 0, PLUGIN_LIMITS.reportedHeight)
        ? { type: 'resize', height: f.height }
        : null;
    }
    case 'setProps': {
      const f = fields(data, ['type', 'props']);
      return f ? { type: 'setProps', props: f.props } : null;
    }
    case 'error': {
      const f = fields(data, ['type', 'code', 'message']);
      if (!f || !isErrorCode(f.code) || !isString(f.message, 0, PLUGIN_LIMITS.message)) return null;
      return { type: 'error', code: f.code, message: f.message };
    }
    default:
      return null;
  }
}

/** A height a `resize` asks for, as the frame is made: within 48 to 1,200 CSS px. */
export const frameHeight = (height: number): number =>
  Math.min(PLUGIN_LIMITS.maxHeight, Math.max(PLUGIN_LIMITS.minHeight, Math.round(height)));
