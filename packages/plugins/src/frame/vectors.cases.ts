// The cases of `packages/plugins/vectors/plugin-frame-vectors.json`: every message type each way,
// every field's bounds, the wrong contract, wrong types, junk, prototype keys; the props a plugin
// may write; the manifest; the bundle's paths and file types. Each verdict follows the contract's
// rules (contract.ts, manifest.ts; the Phase 10 notes); where they leave a point open the case's
// name says which reading it takes. `vectors.test.ts` writes the file from these
// (`PLUGIN_VECTORS_WRITE=1`, then Prettier on it) and runs every vector; a plugin's author, and
// the server for the manifest and the bundle, can run the same file.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface MessageVector {
  name: string;
  message: Json;
  valid: boolean;
}

export interface PropsVector {
  name: string;
  props: Json;
  /** `ok` (then `kept` is what is written) or the `refused` code. */
  verdict: 'ok' | 'props.invalid' | 'props.tooLarge';
  kept?: Json;
}

export interface ManifestVector {
  name: string;
  manifest: Json;
  valid: boolean;
  /** For an invalid one: every problem, as the server's `errors` lists them. */
  errors?: { code: string; path?: string }[];
}

export interface PathVector {
  name: string;
  path: string;
  valid: boolean;
}

export interface TypeVector {
  path: string;
  /** The type it is served as, or null when a bundle may not hold it. */
  contentType: string | null;
}

export interface PluginFrameVectors {
  about: string;
  contract: string;
  host: MessageVector[];
  plugin: MessageVector[];
  props: PropsVector[];
  manifest: ManifestVector[];
  bundlePaths: PathVector[];
  bundleTypes: TypeVector[];
}

const ABOUT =
  'plugin-frame.1 validator vectors (Phase 10; docs/INTEGRATIONS.md, "Contract `plugin-frame.1`"). ' +
  '`host`: messages a Workspace page sends (init on the window, the rest on the port), run through ' +
  'parseHostMessage; `plugin`: messages a plugin sends, through parsePluginMessage; `valid` is the ' +
  'verdict. `props`: what a setProps carries, through checkProps: `ok` with `kept` (what is ' +
  'written: top-level keys starting with "$" dropped) or the refused code. `manifest`: ' +
  'manifest.json through parseManifest, with the errors the server lists. `bundlePaths` and ' +
  "`bundleTypes`: a bundle's file names and the types files are served as. An object whose " +
  '"$vector" key names a value JSON cannot hold stands for it: "undefined"; "number" (value ' +
  '"NaN", "Infinity" or "-Infinity"); "date" (a Date); "map" (a Map of a to 1); "bytes" (a ' +
  'Uint8Array of 1, 2, 3); "sparse" (an array of `length` with only its last index set, to 0); ' +
  '"text" (`repeat` repeated `count` times); "list" (`count` copies of `item`, each with "{{i}}" ' +
  'in its strings replaced by its index); "nest" (`leaf` inside `depth` arrays). Keys such as ' +
  '"__proto__" are own properties (as JSON.parse and a structured clone make them): decode with ' +
  'defineProperty, never assignment.';

type Obj = { [key: string]: Json };

function define(target: Obj, key: string, value: Json): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A copy of `base` with `key` set as an own property (so `__proto__` stays a key). */
function set(base: Obj, key: string, value: Json): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(base)) define(out, k, v);
  define(out, key, value);
  return out;
}

/** A copy of `base` without `key`. */
function drop(base: Obj, key: string): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(base)) if (k !== key) define(out, k, v);
  return out;
}

const special = (kind: string, extra: Obj = {}): Obj => ({ $vector: kind, ...extra });
const text = (repeat: string, count: number) => special('text', { repeat, count });
const list = (item: Json, count: number) => special('list', { item, count });
const nest = (depth: number, leaf: Json = 0) => special('nest', { depth, leaf });

const DATABASE = '0193a1c0-0000-7000-8000-00000000d001';
const VIEW = '0193a1c0-0000-7000-8000-00000000e001';
const ROW = (n: number | string) => `0193a1c0-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`;

const props: Obj = {
  title: 'Q3 notes',
  count: 3,
  tags: ['a', 'b'],
  nested: { on: true, none: null },
};

const status: Obj = {
  id: 'St12St34',
  name: 'Status',
  type: 'status',
  options: [
    { id: 'Op000001', name: 'Not started', colour: 'gray', group: 'todo' },
    { id: 'Op000003', name: 'Done', colour: 'green', group: 'complete' },
  ],
};
const tags: Obj = {
  id: 'Ta12Ta34',
  name: 'Tags',
  type: 'multiSelect',
  options: [{ id: 'Op000002', name: 'Red', colour: 'red' }],
};
const properties: Json[] = [
  { id: 'title', name: 'Name', type: 'title' },
  { id: 'Ab12Cd34', name: 'Amount', type: 'number' },
  status,
  tags,
  { id: 'Dt12Dt34', name: 'Due', type: 'date' },
  { id: 'Fo12Fo34', name: 'Double', type: 'formula' },
  { id: 'Ct12Ct34', name: 'Created', type: 'createdTime' },
];
const firstRow: Obj = {
  id: ROW(1),
  title: 'First',
  values: {
    Ab12Cd34: 12.5,
    St12St34: 'Op000001',
    Ta12Ta34: ['Op000002'],
    Dt12Dt34: { start: '2026-11-18', end: '2026-11-20' },
    Fo12Fo34: 25,
    Ct12Ct34: { start: '2026-11-17T09:30:00Z' },
  },
};
const rows: Obj = {
  databaseId: DATABASE,
  viewId: VIEW,
  properties,
  rows: [firstRow, { id: ROW(2), title: '', values: { Fo12Fo34: { error: 'formula.type' } } }],
  total: 2,
  complete: true,
};
const withRows = (key: string, value: Json): Obj => set(rows, key, value);
const withRow = (row: Json): Obj => set(rows, 'rows', [row]);
const withValues = (values: Json): Obj => withRow({ id: ROW(1), title: 'First', values });
const withProperty = (property: Json): Obj => set(rows, 'properties', [property]);

const init: Obj = {
  type: 'init',
  contract: 'plugin-frame.1',
  plugin: { type: 'vendor.notes', version: 1 },
  block: { version: 1, editable: true, newer: false },
  props,
  theme: 'light',
  direction: 'ltr',
  language: 'en',
  rows: null,
};
const initWith = (key: string, value: Json): Obj => set(init, key, value);
const rowsMessage = (value: Json): Obj => ({ type: 'rows', rows: value });
const propsMessage = (value: Json): Obj => ({ type: 'props', props: value });

const yes = (name: string, message: Json): MessageVector => ({ name, message, valid: true });
const no = (name: string, message: Json): MessageVector => ({ name, message, valid: false });

/** `{"t": "…"}` whose JSON is exactly `bytes` bytes of ASCII. */
const asciiProps = (bytes: number): Obj => ({ t: text('x', bytes - 8) });

const host: MessageVector[] = [
  // Not a message at all.
  no('null', null),
  no('a string', 'init'),
  no('a number', 1),
  no('true', true),
  no('an array holding a valid init', [init]),
  no('no type', drop(init, 'type')),
  no('type is not a string', set(init, 'type', 1)),
  no('an unknown type', { type: 'save', props }),
  no('type in another case', set(init, 'type', 'Init')),
  no('a plugin message (ready) sent by the host', { type: 'ready', contracts: ['plugin-frame.1'] }),

  // init
  yes('init', init),
  yes('init: no props yet (an empty object)', initWith('props', {})),
  yes('init: with rows', initWith('rows', rows)),
  yes('init: dark, right to left, Arabic', {
    ...init,
    theme: 'dark',
    direction: 'rtl',
    language: 'ar',
  }),
  yes(
    'init: a block a later version wrote (read-only)',
    initWith('block', { version: 3, editable: false, newer: true }),
  ),
  yes(
    'init: a reader who cannot edit',
    initWith('block', { version: 1, editable: false, newer: false }),
  ),
  yes(
    'init: a block never written (version null)',
    initWith('block', { version: null, editable: true, newer: false }),
  ),
  no(
    'init: editable and newer at once (a newer block is never editable)',
    initWith('block', { version: 3, editable: true, newer: true }),
  ),
  no('init: block version 0', initWith('block', { version: 0, editable: true, newer: false })),
  no(
    'init: block version a fraction',
    initWith('block', { version: 1.5, editable: true, newer: false }),
  ),
  no(
    'init: block editable as text',
    initWith('block', { version: 1, editable: 'true', newer: false }),
  ),
  no('init: block without newer', initWith('block', { version: 1, editable: true })),
  no(
    'init: block with an extra field',
    initWith('block', { version: 1, editable: true, newer: false, pageId: 'p1' }),
  ),
  no(
    'init: a reserved type (cashgear.*)',
    initWith('plugin', { type: 'cashgear.chart', version: 1 }),
  ),
  no('init: a type in capitals', initWith('plugin', { type: 'Vendor.Notes', version: 1 })),
  no('init: a type without a dot', initWith('plugin', { type: 'notes', version: 1 })),
  yes(
    'init: a type of 64 characters',
    initWith('plugin', { type: `a.${'b'.repeat(62)}`, version: 1 }),
  ),
  no(
    'init: a type of 65 characters',
    initWith('plugin', { type: `a.${'b'.repeat(63)}`, version: 1 }),
  ),
  no('init: plugin version 0', initWith('plugin', { type: 'vendor.notes', version: 0 })),
  yes(
    'init: plugin version 2,147,483,647',
    initWith('plugin', { type: 'vendor.notes', version: 2147483647 }),
  ),
  no(
    'init: plugin version 2,147,483,648',
    initWith('plugin', { type: 'vendor.notes', version: 2147483648 }),
  ),
  no('init: plugin version as text', initWith('plugin', { type: 'vendor.notes', version: '1' })),
  no('init: another contract', initWith('contract', 'plugin-frame.2')),
  no('init: the Sheet contract', initWith('contract', 'sheet-embed.1')),
  no('init: no contract', drop(init, 'contract')),
  no('init: no rows field (null when there are none)', drop(init, 'rows')),
  no('init: an extra field', initWith('session', 'abc')),
  no('init: an own "__proto__" key', initWith('__proto__', { editable: true })),
  no('init: props null', initWith('props', null)),
  no('init: props an array', initWith('props', [1, 2])),
  no('init: props as JSON text', initWith('props', '{"title":"Q3"}')),
  no(
    'init: props holding a host key ($view)',
    initWith('props', { $view: { databaseId: DATABASE } }),
  ),
  yes(
    'init: props with a "$" key inside (only top-level keys are the host\'s)',
    initWith('props', { a: { $b: 1 } }),
  ),
  yes(
    'init: props holding an own "__proto__" key (data, kept as a key)',
    initWith('props', set({}, '__proto__', { x: 1 })),
  ),
  yes('init: props of exactly 16,384 bytes as JSON', initWith('props', asciiProps(16384))),
  no('init: props of 16,385 bytes as JSON', initWith('props', asciiProps(16385))),
  no('init: props holding undefined', initWith('props', { a: special('undefined') })),
  no('init: an unknown theme', initWith('theme', 'sepia')),
  no('init: direction auto', initWith('direction', 'auto')),
  no('init: language fr', initWith('language', 'fr')),
  no('init: language en-US (two languages only)', initWith('language', 'en-US')),
  no('init: rows not an object', initWith('rows', [])),

  // props
  yes('props', propsMessage(props)),
  yes('props: empty', propsMessage({})),
  no('props: a host key', propsMessage({ $view: null })),
  no('props: missing', { type: 'props' }),
  no('props: null', propsMessage(null)),
  no('props: an extra field', { type: 'props', props, version: 2 }),

  // theme
  yes('theme', { type: 'theme', theme: 'dark', direction: 'rtl', language: 'ar' }),
  no('theme: no language', { type: 'theme', theme: 'dark', direction: 'rtl' }),
  no('theme: an extra field', {
    type: 'theme',
    theme: 'dark',
    direction: 'rtl',
    language: 'ar',
    accent: 'blue',
  }),

  // editable
  yes('editable: editable', { type: 'editable', editable: true, newer: false }),
  yes('editable: read-only', { type: 'editable', editable: false, newer: false }),
  yes('editable: newer', { type: 'editable', editable: false, newer: true }),
  no('editable: editable and newer', { type: 'editable', editable: true, newer: true }),
  no('editable: as text', { type: 'editable', editable: 'yes', newer: false }),
  no('editable: no newer', { type: 'editable', editable: true }),

  // rows
  yes('rows: null (no view, or the database went away)', rowsMessage(null)),
  yes('rows', rowsMessage(rows)),
  yes(
    'rows: none, incomplete (the view holds rows the reader has not been shown)',
    rowsMessage({
      ...rows,
      rows: [],
      total: 1200,
      complete: false,
    }),
  ),
  yes(
    'rows: 500 rows',
    rowsMessage({
      ...rows,
      rows: list(
        { id: '0193a1c0-0000-7000-8000-00000000{{i}}', title: 'Row {{i}}', values: {} },
        500,
      ),
      total: 500,
    }),
  ),
  no(
    'rows: 501 rows',
    rowsMessage({
      ...rows,
      rows: list(
        { id: '0193a1c0-0000-7000-8000-00000000{{i}}', title: 'Row {{i}}', values: {} },
        501,
      ),
      total: 501,
    }),
  ),
  no('rows: two rows of one id', rowsMessage(withRows('rows', [firstRow, firstRow]))),
  no(
    'rows: a person property',
    rowsMessage(withProperty({ id: 'Pe12Pe34', name: 'Owner', type: 'person' })),
  ),
  no(
    'rows: a created-by property',
    rowsMessage(withProperty({ id: 'Cb12Cb34', name: 'Created by', type: 'createdBy' })),
  ),
  no(
    'rows: an edited-by property',
    rowsMessage(withProperty({ id: 'Eb12Eb34', name: 'Edited by', type: 'lastEditedBy' })),
  ),
  no(
    'rows: an unknown property type',
    rowsMessage(withProperty({ id: 'Bu12Bu34', name: 'Go', type: 'button' })),
  ),
  no(
    'rows: a property id with a space',
    rowsMessage(withProperty({ id: 'Ab 12', name: 'A', type: 'text' })),
  ),
  no(
    'rows: two properties of one id',
    rowsMessage(withRows('properties', [properties[1]!, properties[1]!])),
  ),
  no(
    'rows: options on a number property',
    rowsMessage(withProperty({ id: 'Ab12Cd34', name: 'Amount', type: 'number', options: [] })),
  ),
  no(
    'rows: an option of an unknown colour',
    rowsMessage(
      withProperty({ ...tags, options: [{ id: 'Op000002', name: 'Teal', colour: 'teal' }] }),
    ),
  ),
  no(
    'rows: a status option of an unknown group',
    rowsMessage(
      withProperty({
        ...status,
        options: [{ id: 'Op000001', name: 'Done', colour: 'green', group: 'done' }],
      }),
    ),
  ),
  no(
    'rows: a select option with a group (only status options have one)',
    rowsMessage(
      withProperty({
        ...tags,
        options: [{ id: 'Op000002', name: 'Red', colour: 'red', group: 'todo' }],
      }),
    ),
  ),
  yes(
    'rows: a status option without a group',
    rowsMessage(
      withProperty({
        ...status,
        options: [{ id: 'Op000001', name: 'Not started', colour: 'gray' }],
      }),
    ),
  ),
  no(
    'rows: a value of null (an empty value is absent)',
    rowsMessage(withValues({ Ab12Cd34: null })),
  ),
  no(
    'rows: a value NaN',
    rowsMessage(withValues({ Ab12Cd34: special('number', { value: 'NaN' }) })),
  ),
  no('rows: a value undefined', rowsMessage(withValues({ Ab12Cd34: special('undefined') }))),
  no('rows: a value a Date', rowsMessage(withValues({ Dt12Dt34: special('date') }))),
  no('rows: a value key with a space', rowsMessage(withValues({ 'Ab 12': 1 }))),
  no('rows: values an array', rowsMessage(withValues([1]))),
  yes('rows: a value nested 4 deep', rowsMessage(withValues({ Ab12Cd34: nest(4) }))),
  no('rows: a value nested 5 deep', rowsMessage(withValues({ Ab12Cd34: nest(5) }))),
  yes('rows: a value list of 1,000', rowsMessage(withValues({ Re12Re34: list('r{{i}}', 1000) }))),
  no('rows: a value list of 1,001', rowsMessage(withValues({ Re12Re34: list('r{{i}}', 1001) }))),
  no('rows: a row without a title', rowsMessage(withRow({ id: ROW(1), values: {} }))),
  yes(
    'rows: a title of 10,000 characters',
    rowsMessage(withRow({ id: ROW(1), title: text('t', 10000), values: {} })),
  ),
  no(
    'rows: a title of 10,001 characters',
    rowsMessage(withRow({ id: ROW(1), title: text('t', 10001), values: {} })),
  ),
  no('rows: a row with an extra field', rowsMessage(withRow({ ...firstRow, createdBy: 'u1' }))),
  no('rows: fewer in total than shown', rowsMessage(withRows('total', 1))),
  no('rows: a negative total', rowsMessage(withRows('total', -1))),
  no('rows: a total that is a fraction', rowsMessage(withRows('total', 2.5))),
  no('rows: complete as text', rowsMessage(withRows('complete', 'yes'))),
  no('rows: no view id', rowsMessage(drop(rows, 'viewId'))),
  no('rows: an extra field (people)', rowsMessage(withRows('people', []))),
  no('rows: missing', { type: 'rows' }),

  // saved, refused
  yes('saved', { type: 'saved' }),
  no('saved: an extra field', { type: 'saved', version: 2 }),
  yes('refused: props.readOnly', { type: 'refused', code: 'props.readOnly' }),
  yes('refused: props.invalid', { type: 'refused', code: 'props.invalid' }),
  yes('refused: props.tooLarge', { type: 'refused', code: 'props.tooLarge' }),
  no('refused: an unknown code', { type: 'refused', code: 'props.rate' }),
  no('refused: no code', { type: 'refused' }),
  no('refused: an extra message', { type: 'refused', code: 'props.invalid', message: 'x' }),
];

const ready = (contracts: Json): Obj => ({ type: 'ready', contracts });
const error = (extra: Obj = {}): Obj => ({
  type: 'error',
  code: 'data.missing',
  message: '',
  ...extra,
});

const plugin: MessageVector[] = [
  // Not a message at all.
  no('null', null),
  no('a string', 'ready'),
  no('an array holding a valid ready', [ready(['plugin-frame.1'])]),
  no('an unknown type', { type: 'navigate', url: 'https://example.com' }),
  no('type in another case', { type: 'Ready', contracts: ['plugin-frame.1'] }),
  no('a host message (init) sent by the plugin', init),
  no('a host message (saved) sent by the plugin', { type: 'saved' }),

  // ready
  yes('ready', ready(['plugin-frame.1'])),
  yes('ready: several contracts', ready(['plugin-frame.2', 'plugin-frame.1'])),
  yes(
    'ready: only a contract this build does not speak (the host then stops the frame)',
    ready(['plugin-frame.2']),
  ),
  no('ready: no contracts', ready([])),
  yes('ready: 16 contracts', ready(list('plugin-frame.{{i}}', 16))),
  no('ready: 17 contracts', ready(list('plugin-frame.{{i}}', 17))),
  no('ready: an empty name', ready([''])),
  yes('ready: a name of 64 characters', ready(['p'.repeat(64)])),
  no('ready: a name of 65 characters', ready(['p'.repeat(65)])),
  no('ready: a name that is a number', ready([1])),
  no('ready: contracts as text', ready('plugin-frame.1')),
  no('ready: missing contracts', { type: 'ready' }),
  no('ready: an extra field', { type: 'ready', contracts: ['plugin-frame.1'], origin: '*' }),
  no(
    'ready: an own "__proto__" key',
    set(ready(['plugin-frame.1']), '__proto__', { contracts: [] }),
  ),

  // resize
  yes('resize', { type: 'resize', height: 240 }),
  yes('resize: 0 (the host makes it 48)', { type: 'resize', height: 0 }),
  yes('resize: 100,000 (the host makes it 1,200)', { type: 'resize', height: 100000 }),
  no('resize: 100,001', { type: 'resize', height: 100001 }),
  no('resize: negative', { type: 'resize', height: -1 }),
  no('resize: a fraction', { type: 'resize', height: 240.5 }),
  no('resize: as text', { type: 'resize', height: '240' }),
  no('resize: missing', { type: 'resize' }),
  no('resize: an extra width', { type: 'resize', height: 240, width: 600 }),

  // setProps
  yes('setProps', { type: 'setProps', props }),
  yes('setProps: empty props', { type: 'setProps', props: {} }),
  yes('setProps: props null (the message is whole; checkProps refuses the props)', {
    type: 'setProps',
    props: null,
  }),
  yes('setProps: props too large (the message is whole; checkProps refuses the props)', {
    type: 'setProps',
    props: asciiProps(20000),
  }),
  no('setProps: missing props', { type: 'setProps' }),
  no('setProps: an extra version', { type: 'setProps', props, version: 2 }),
  no('setProps: an own "__proto__" key', set({ type: 'setProps', props }, '__proto__', {})),

  // error
  yes('error', error()),
  yes('error: with a message', error({ message: 'No database view to show' })),
  yes('error: a message of 500 characters', error({ message: 'm'.repeat(500) })),
  no('error: a message of 501 characters', error({ message: 'm'.repeat(501) })),
  no(
    'error: no message (reading: the field is always there, possibly empty)',
    drop(error(), 'message'),
  ),
  no('error: message a number', error({ message: 404 })),
  no('error: a code with a space', error({ code: 'data missing' })),
  yes('error: a code of 64 characters', error({ code: 'c'.repeat(64) })),
  no('error: a code of 65 characters', error({ code: 'c'.repeat(65) })),
  no('error: an empty code', error({ code: '' })),
  no('error: no code', drop(error(), 'code')),
  no('error: an extra field', error({ stack: 'at main.js:1' })),
];

const ok = (name: string, value: Json, kept: Json = value): PropsVector => ({
  name,
  props: value,
  verdict: 'ok',
  kept,
});
const refused = (
  name: string,
  value: Json,
  verdict: 'props.invalid' | 'props.tooLarge',
): PropsVector => ({
  name,
  props: value,
  verdict,
});

const ARABIC_LETTER = 'ب';

const propsVectors: PropsVector[] = [
  ok('an empty object', {}),
  ok('text, numbers, lists, objects, true, false and null', {
    ...props,
    off: false,
    ratio: -0.25,
    big: 1e21,
  }),
  ok(
    'a host key ($view) is dropped',
    { $view: { databaseId: DATABASE, viewId: VIEW }, note: 'a' },
    { note: 'a' },
  ),
  ok('only host keys: nothing is kept', { $view: null, $other: 1 }, {}),
  ok('a "$" key inside is kept (only top-level keys are the host\'s)', { a: { $b: 1 } }),
  ok('an own "__proto__" key is kept as a key', set({}, '__proto__', { x: 1 })),
  refused('null', null, 'props.invalid'),
  refused('an array', [1, 2], 'props.invalid'),
  refused('a string', 'props', 'props.invalid'),
  refused('a number', 1, 'props.invalid'),
  refused('a value undefined', { a: special('undefined') }, 'props.invalid'),
  refused('a value NaN', { a: special('number', { value: 'NaN' }) }, 'props.invalid'),
  refused('a value Infinity', { a: special('number', { value: 'Infinity' }) }, 'props.invalid'),
  refused('a value -Infinity', { a: special('number', { value: '-Infinity' }) }, 'props.invalid'),
  refused('a Date', { a: special('date') }, 'props.invalid'),
  refused('a Map', { a: special('map') }, 'props.invalid'),
  refused('bytes', { a: special('bytes') }, 'props.invalid'),
  refused('an array with holes', { a: special('sparse', { length: 3 }) }, 'props.invalid'),
  refused('the props themselves a Map', special('map'), 'props.invalid'),
  ok('nested 32 deep (the object and 31 arrays)', { a: nest(31) }),
  refused('nested 33 deep', { a: nest(32) }, 'props.invalid'),
  ok('exactly 16,384 bytes as JSON', asciiProps(16384)),
  refused('16,385 bytes as JSON', asciiProps(16385), 'props.tooLarge'),
  ok('Arabic text counted in UTF-8 bytes: 8,188 letters are 16,384 bytes', {
    t: text(ARABIC_LETTER, 8188),
  }),
  refused(
    'Arabic text counted in UTF-8 bytes: 8,189 letters are 16,386 bytes',
    { t: text(ARABIC_LETTER, 8189) },
    'props.tooLarge',
  ),
  ok(
    'a host key does not count toward the size once dropped',
    { $view: { databaseId: DATABASE, viewId: VIEW }, ...asciiProps(16384) },
    asciiProps(16384),
  ),
  refused(
    'a host key holding a text past the bound (everything is walked within the bounds first)',
    { $big: text('x', 20000), a: 1 },
    'props.tooLarge',
  ),
  refused('one text of 16,385 characters', { t: text('x', 16385) }, 'props.tooLarge'),
  refused('a list of 20,000 numbers', { a: list(0, 20000) }, 'props.tooLarge'),
];

const reference: Obj = {
  contract: 'plugin-frame.1',
  type: 'vendor.notes',
  version: 1,
  name: { en: 'Notes', ar: 'ملاحظات' },
  description: { en: 'A note and a counter.', ar: 'ملاحظة وعدّاد.' },
  entry: 'index.html',
  reads: { rows: true },
  height: 240,
  keywords: ['notes', 'ملاحظات'],
};
const manifestWith = (key: string, value: Json): Obj => set(reference, key, value);
const valid = (name: string, manifest: Json): ManifestVector => ({ name, manifest, valid: true });
const invalid = (
  name: string,
  manifest: Json,
  errors: { code: string; path?: string }[],
): ManifestVector => ({ name, manifest, valid: false, errors });
const field = (path: string) => [{ code: 'manifest.invalid', path }];

const manifest: ManifestVector[] = [
  valid('a whole manifest', reference),
  valid('the fewest fields (entry index.html, height 240, no rows, no keywords)', {
    contract: 'plugin-frame.1',
    type: 'vendor.notes',
    version: 1,
    name: { en: 'Notes', ar: 'ملاحظات' },
  }),
  valid('unknown fields are left out', manifestWith('homepage', 'https://example.com')),
  valid('description null', manifestWith('description', null)),
  valid('reads with nothing asked', manifestWith('reads', {})),
  valid('height 48', manifestWith('height', 48)),
  valid('height 1,200', manifestWith('height', 1200)),
  invalid('height 47', manifestWith('height', 47), field('height')),
  invalid('height 1,201', manifestWith('height', 1201), field('height')),
  invalid('height a fraction', manifestWith('height', 240.5), field('height')),
  invalid('a reserved type (cashgear.*)', manifestWith('type', 'cashgear.chart'), [
    { code: 'type.reserved', path: 'type' },
  ]),
  invalid('a type in capitals', manifestWith('type', 'Vendor.Notes'), field('type')),
  invalid('a type without a dot', manifestWith('type', 'notes'), field('type')),
  valid('a type of 64 characters', manifestWith('type', `a.${'b'.repeat(62)}`)),
  invalid('a type of 65 characters', manifestWith('type', `a.${'b'.repeat(63)}`), field('type')),
  invalid('version 0', manifestWith('version', 0), field('version')),
  invalid('version as text', manifestWith('version', '1'), field('version')),
  invalid('version a fraction', manifestWith('version', 1.5), field('version')),
  invalid('another contract', manifestWith('contract', 'plugin-frame.2'), field('contract')),
  invalid('no contract', drop(reference, 'contract'), field('contract')),
  invalid(
    'an empty English name',
    manifestWith('name', { en: '', ar: 'ملاحظات' }),
    field('name.en'),
  ),
  valid(
    'an Arabic name of 80 characters',
    manifestWith('name', { en: 'Notes', ar: 'ب'.repeat(80) }),
  ),
  invalid(
    'an Arabic name of 81 characters',
    manifestWith('name', { en: 'Notes', ar: 'ب'.repeat(81) }),
    field('name.ar'),
  ),
  invalid('no Arabic name', manifestWith('name', { en: 'Notes' }), field('name.ar')),
  invalid('the name as text', manifestWith('name', 'Notes'), field('name')),
  valid(
    'a description of 300 characters',
    manifestWith('description', { en: 'd'.repeat(300), ar: 'ب'.repeat(300) }),
  ),
  invalid(
    'a description of 301 characters',
    manifestWith('description', { en: 'd'.repeat(301), ar: 'وصف' }),
    field('description.en'),
  ),
  valid('another entry', manifestWith('entry', 'app.html')),
  valid('an entry in a folder, .htm', manifestWith('entry', 'pages/index.htm')),
  invalid('an entry out of the bundle', manifestWith('entry', '../index.html'), field('entry')),
  invalid('an absolute entry', manifestWith('entry', '/index.html'), field('entry')),
  invalid('an entry that is a script', manifestWith('entry', 'index.js'), field('entry')),
  invalid('an entry with a backslash', manifestWith('entry', 'pages\\index.html'), field('entry')),
  invalid('reads.rows as text', manifestWith('reads', { rows: 'yes' }), field('reads.rows')),
  invalid('reads as a list', manifestWith('reads', ['rows']), field('reads')),
  valid(
    '10 keywords',
    manifestWith(
      'keywords',
      Array.from({ length: 10 }, (_, i) => `word${i}`),
    ),
  ),
  invalid(
    '11 keywords',
    manifestWith(
      'keywords',
      Array.from({ length: 11 }, (_, i) => `word${i}`),
    ),
    field('keywords'),
  ),
  invalid('an empty keyword', manifestWith('keywords', ['']), field('keywords')),
  invalid('a keyword of spaces only', manifestWith('keywords', ['   ']), field('keywords')),
  invalid(
    'an English name of spaces only',
    manifestWith('name', { en: '  ', ar: 'ملاحظات' }),
    field('name.en'),
  ),
  valid(
    'an empty description (descriptions may be empty)',
    manifestWith('description', { en: '', ar: '' }),
  ),
  invalid('an entry with a colon', manifestWith('entry', 'c:index.html'), field('entry')),
  invalid(
    'a keyword of 31 characters',
    manifestWith('keywords', ['k'.repeat(31)]),
    field('keywords'),
  ),
  invalid('not an object', [reference], [{ code: 'manifest.invalid' }]),
  invalid('null', null, [{ code: 'manifest.invalid' }]),
  invalid(
    'every problem listed',
    {
      contract: 'plugin-frame.1',
      type: 'cashgear.notes',
      version: 0,
      name: { en: 'Notes', ar: '' },
    },
    [
      { code: 'type.reserved', path: 'type' },
      { code: 'manifest.invalid', path: 'version' },
      { code: 'manifest.invalid', path: 'name.ar' },
    ],
  ),
];

const path = (name: string, value: string, ok: boolean): PathVector => ({
  name,
  path: value,
  valid: ok,
});

const bundlePaths: PathVector[] = [
  path('a file at the root', 'index.html', true),
  path('a file in a folder', 'scripts/main.js', true),
  path('a name of 200 characters', `${'n'.repeat(195)}.html`, true),
  path('a name of 201 characters', `${'n'.repeat(196)}.html`, false),
  path('out of the bundle', '../index.html', false),
  path('a folder out of the bundle', 'a/../../b.js', false),
  path('absolute', '/index.html', false),
  path('a drive', 'C:/index.html', false),
  path('a backslash', 'scripts\\main.js', false),
  path('a "." part', 'a/./b.js', false),
  path('an empty part', 'a//b.js', false),
  path('a control character', 'a\u0001b.js', false),
  path('DEL', `a${String.fromCharCode(0x7f)}b.js`, false),
  path('a C1 control character (NEL)', `a${String.fromCharCode(0x85)}b.js`, false),
  path('a line separator', `a${String.fromCharCode(0x2028)}b.js`, false),
  path('a lone surrogate', `a${String.fromCharCode(0xd800)}b.js`, false),
  path('a pair of surrogates (one character)', `a${String.fromCodePoint(0x1f600)}b.js`, true),
  path('Arabic letters', 'صفحة/main.js', true),
  path('a colon', 'a:b.js', false),
  path('a space', 'my page/main.js', true),
  path('empty', '', false),
];

const typeOf = (file: string, contentType: string | null): TypeVector => ({
  path: file,
  contentType,
});

const bundleTypes: TypeVector[] = [
  typeOf('index.html', 'text/html'),
  typeOf('page.HTM', 'text/html'),
  typeOf('main.js', 'text/javascript'),
  typeOf('main.mjs', 'text/javascript'),
  typeOf('style.css', 'text/css'),
  typeOf('data.json', 'application/json'),
  typeOf('logo.svg', 'image/svg+xml'),
  typeOf('logo.png', 'image/png'),
  typeOf('photo.jpg', 'image/jpeg'),
  typeOf('photo.jpeg', 'image/jpeg'),
  typeOf('moving.gif', 'image/gif'),
  typeOf('photo.webp', 'image/webp'),
  typeOf('favicon.ico', 'image/x-icon'),
  typeOf('font.woff', 'font/woff'),
  typeOf('font.woff2', 'font/woff2'),
  typeOf('LICENSE.txt', 'text/plain'),
  typeOf('main.js.map', 'application/json'),
  typeOf('worker.wasm', null),
  typeOf('run.exe', null),
  typeOf('page.xhtml', null),
  typeOf('README', null),
  typeOf('.htaccess', null),
  typeOf('x.constructor', null),
  typeOf('x.__proto__', null),
];

export const pluginFrameVectors: PluginFrameVectors = {
  about: ABOUT,
  contract: 'plugin-frame.1',
  host,
  plugin,
  props: propsVectors,
  manifest,
  bundlePaths,
  bundleTypes,
};

/** Replaces `{{i}}` in every string of a JSON value. */
function indexed(value: Json, i: number): Json {
  if (typeof value === 'string') return value.split('{{i}}').join(String(i).padStart(4, '0'));
  if (Array.isArray(value)) return value.map((v) => indexed(v, i));
  if (value && typeof value === 'object') {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) define(out, k, indexed(v, i));
    return out;
  }
  return value;
}

/**
 * A vector's value as a sender holds it: `{"$vector"}` objects become what they stand for, and
 * every key stays an own property (`__proto__` included), as a structured clone keeps it.
 */
export function decodeVector(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decodeVector);
  if (value === null || typeof value !== 'object') return value;
  const kind = Object.prototype.hasOwnProperty.call(value, '$vector') ? value.$vector : undefined;
  if (typeof kind === 'string') {
    switch (kind) {
      case 'undefined':
        return undefined;
      case 'number':
        return Number(value.value);
      case 'date':
        return new Date(0);
      case 'map':
        return new Map([['a', 1]]);
      case 'bytes':
        return new Uint8Array([1, 2, 3]);
      case 'sparse': {
        const out: unknown[] = [];
        out.length = Number(value.length);
        out[out.length - 1] = 0;
        return out;
      }
      case 'text':
        return String(value.repeat).repeat(Number(value.count));
      case 'list':
        return Array.from({ length: Number(value.count) }, (_, i) =>
          decodeVector(indexed(value.item ?? null, i)),
        );
      case 'nest': {
        let out: unknown = decodeVector(value.leaf ?? null);
        for (let i = 0; i < Number(value.depth); i++) out = [out];
        return out;
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, {
      value: decodeVector(value[key]!),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
