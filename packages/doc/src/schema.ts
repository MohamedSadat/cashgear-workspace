// The block schema (DATA_MODEL.md, "Page content"), fixed by spike S1:
//   doc: block*      block: (body | block)*      one textBody node whose `kind` sets the text kind
// Rules that hold forever: `*` only; every attribute optional with a default; no node or attribute
// is ever removed or renamed. Schema version 1.
import { Extension, Mark, Node, getSchema, mergeAttributes, type AnyExtension } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';

/** Raised for every change an older client could not draw (DATA_MODEL.md). */
export const SCHEMA_VERSION = 1;

export const TEXT_KINDS = [
  'paragraph',
  'heading',
  'bulletItem',
  'numberedItem',
  'checkItem',
  'toggle',
  'quote',
  'callout',
] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

/** Named colours from the theme, never hex, so a page reads in light and dark (DATA_MODEL.md). */
export const COLOUR_TOKENS = [
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
export type ColourToken = (typeof COLOUR_TOKENS)[number];
const isToken = (value: unknown): value is ColourToken =>
  typeof value === 'string' && (COLOUR_TOKENS as readonly string[]).includes(value);

export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger', 'neutral'] as const;
export const IMAGE_ALIGNS = ['start', 'center', 'end'] as const;

/** Link schemes allowed when a link is parsed, drawn or clicked (ARCHITECTURE.md, Links). */
const SAFE_LINK = /^(https?:\/\/|mailto:|tel:|#\/p\/)/i;
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const value = href.trim();
  // Control characters inside a scheme are how `java\tscript:` gets past a check.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return SAFE_LINK.test(value) ? value : null;
}

const dirAttribute = {
  dir: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const dir = element.getAttribute('dir');
      return dir === 'ltr' || dir === 'rtl' ? dir : null;
    },
    // null means "from the first strong character" (D24).
    renderHTML: (attrs: Record<string, unknown>) => ({
      dir: attrs.dir === 'ltr' || attrs.dir === 'rtl' ? attrs.dir : 'auto',
    }),
  },
};

const plain = (name: string, fallback: unknown = null) => ({
  default: fallback,
  parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) ?? fallback,
  renderHTML: () => ({}),
});

/** Every text kind is one node: "turn into" changes `kind` and keeps a peer's typing (S1). */
const TextBody = Node.create({
  name: 'textBody',
  group: 'body',
  content: 'inline*',
  marks: '_',
  defining: true,
  addAttributes: () => ({
    ...dirAttribute,
    kind: {
      default: 'paragraph',
      parseHTML: (element: HTMLElement) => {
        const kind = element.getAttribute('data-kind');
        if (kind && (TEXT_KINDS as readonly string[]).includes(kind)) return kind;
        const tag = element.tagName.toLowerCase();
        if (tag === 'li') {
          if (element.querySelector(':scope > input[type=checkbox]')) return 'checkItem';
          return element.parentElement?.tagName === 'OL' ? 'numberedItem' : 'bulletItem';
        }
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'blockquote') return 'quote';
        return 'paragraph';
      },
      renderHTML: () => ({}),
    },
    level: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const match = /^h([1-6])$/.exec(element.tagName.toLowerCase());
        const level = match ? Number(match[1]) : Number(element.getAttribute('data-level'));
        return level ? Math.min(3, level) : null;
      },
      renderHTML: () => ({}),
    },
    checked: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        element.getAttribute('data-checked') === 'true' ||
        element.querySelector<HTMLInputElement>(':scope > input[type=checkbox]')?.checked ||
        null,
      renderHTML: () => ({}),
    },
    start: plain('start'),
    icon: plain('icon'),
    tone: plain('tone'),
    colour: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const value = element.getAttribute('data-colour');
        return isToken(value) ? value : null;
      },
      renderHTML: () => ({}),
    },
  }),
  parseHTML: () => [
    { tag: 'div[data-body="textBody"]' },
    { tag: 'p' },
    { tag: 'h1' },
    { tag: 'h2' },
    { tag: 'h3' },
    { tag: 'h4' },
    { tag: 'h5' },
    { tag: 'h6' },
    { tag: 'li' },
    { tag: 'blockquote', priority: 40 },
  ],
  renderHTML: ({ HTMLAttributes, node }) => {
    const { kind, level, checked, colour } = node.attrs;
    const tag = kind === 'heading' ? `h${Math.min(3, Math.max(1, Number(level) || 1))}` : 'div';
    return [
      tag,
      mergeAttributes(
        {
          'data-body': 'textBody',
          'data-kind': kind,
          'data-level': kind === 'heading' ? String(level ?? 1) : undefined,
          'data-checked': kind === 'checkItem' ? String(Boolean(checked)) : undefined,
          'data-colour': isToken(colour) ? colour : undefined,
          class: `cgw-body cgw-${kind}`,
        },
        HTMLAttributes,
      ),
      0,
    ];
  },
});

const CodeBlock = Node.create({
  name: 'codeBlock',
  group: 'body',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes: () => ({
    language: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const language =
          element.getAttribute('data-language') ??
          element.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1] ??
          null;
        return language && /^[\w+-]{1,32}$/.test(language) ? language : null;
      },
      renderHTML: () => ({}),
    },
    wrap: {
      default: false,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-wrap') === 'true',
      renderHTML: () => ({}),
    },
  }),
  parseHTML: () => [{ tag: 'pre', preserveWhitespace: 'full' }],
  renderHTML: ({ node }) => [
    'pre',
    {
      'data-body': 'codeBlock',
      'data-language': node.attrs.language ?? undefined,
      'data-wrap': String(Boolean(node.attrs.wrap)),
      class: 'cgw-body cgw-codeBlock',
      dir: 'ltr',
    },
    ['code', 0],
  ],
});

function atomBody(
  name: string,
  attrs: Record<string, { default: unknown }>,
  tag = 'div',
): ReturnType<typeof Node.create> {
  return Node.create({
    name,
    group: 'body',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes: () =>
      Object.fromEntries(
        Object.entries(attrs).map(([key, spec]) => [
          key,
          {
            ...spec,
            parseHTML: (element: HTMLElement) => {
              const raw = element.getAttribute(`data-${key.toLowerCase()}`);
              if (raw === null) return spec.default;
              if (typeof spec.default === 'number') return Number(raw) || spec.default;
              return raw;
            },
            renderHTML: (values: Record<string, unknown>) =>
              values[key] === null || values[key] === undefined
                ? {}
                : { [`data-${key.toLowerCase()}`]: String(values[key]) },
          },
        ]),
      ),
    parseHTML: () => [{ tag: `${tag}[data-body="${name}"]` }],
    renderHTML: ({ HTMLAttributes }) => [
      tag,
      mergeAttributes({ 'data-body': name, class: `cgw-body cgw-${name}` }, HTMLAttributes),
    ],
  });
}

const Divider = Node.create({
  name: 'divider',
  group: 'body',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'hr' }],
  renderHTML: () => ['hr', { 'data-body': 'divider', class: 'cgw-body cgw-divider' }],
});

const Image = atomBody('image', {
  assetId: { default: null },
  width: { default: null },
  align: { default: null },
  alt: { default: null },
  caption: { default: null },
});
const FileBody = atomBody('file', { assetId: { default: null } });
const Bookmark = atomBody('bookmark', { url: { default: null } });
const ChildPage = atomBody('childPage', { pageId: { default: null } });

// Tables (DATA_MODEL.md): cells hold inline content. Header row and column are table attributes,
// not cell types. prosemirror-tables finds the three node types by their `tableRole`.
const TABLE_ROLES: Record<string, string> = { table: 'table', tableRow: 'row', tableCell: 'cell' };
const TableRoles = Extension.create({
  name: 'tableRoles',
  extendNodeSchema: (extension) =>
    TABLE_ROLES[extension.name] ? { tableRole: TABLE_ROLES[extension.name] } : {},
});

const Table = Node.create({
  name: 'table',
  group: 'body',
  content: 'tableRow*',
  isolating: true,
  addAttributes: () => ({
    headerRow: {
      default: false,
      parseHTML: (element: HTMLElement) =>
        element.getAttribute('data-header-row') === 'true' || !!element.querySelector('thead, th'),
      renderHTML: () => ({}),
    },
    headerColumn: {
      default: false,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-header-column') === 'true',
      renderHTML: () => ({}),
    },
  }),
  parseHTML: () => [{ tag: 'table' }],
  renderHTML: ({ node }) => [
    'table',
    {
      'data-body': 'table',
      'data-header-row': String(Boolean(node.attrs.headerRow)),
      'data-header-column': String(Boolean(node.attrs.headerColumn)),
      class: 'cgw-body cgw-table',
    },
    ['tbody', 0],
  ],
});
const TableRow = Node.create({
  name: 'tableRow',
  content: 'tableCell*',
  parseHTML: () => [{ tag: 'tr' }],
  renderHTML: () => ['tr', 0],
});
const TableCell = Node.create({
  name: 'tableCell',
  content: 'inline*',
  marks: '_',
  isolating: true,
  addAttributes: () => ({
    ...dirAttribute,
    colspan: {
      default: 1,
      parseHTML: (element: HTMLElement) => Number(element.getAttribute('colspan')) || 1,
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.colspan === 1 ? {} : { colspan: attrs.colspan },
    },
    rowspan: {
      default: 1,
      parseHTML: (element: HTMLElement) => Number(element.getAttribute('rowspan')) || 1,
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.rowspan === 1 ? {} : { rowspan: attrs.rowspan },
    },
    colwidth: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const value = element.getAttribute('data-colwidth');
        const widths = value ? value.split(',').map(Number) : null;
        return widths && widths.every((w) => w > 0) ? widths : null;
      },
      renderHTML: (attrs: Record<string, unknown>) =>
        Array.isArray(attrs.colwidth) ? { 'data-colwidth': attrs.colwidth.join(',') } : {},
    },
  }),
  parseHTML: () => [{ tag: 'td' }, { tag: 'th' }],
  renderHTML: ({ HTMLAttributes }) => ['td', HTMLAttributes, 0],
});

/** The block container. Not `defining`: a paste into a block must not drag the container. */
const Block = Node.create({
  name: 'block',
  content: '(body | block)*',
  addAttributes: () => ({
    id: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-block-id'),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.id ? { 'data-block-id': attrs.id } : {},
    },
  }),
  parseHTML: () => [{ tag: 'div[data-block]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes({ 'data-block': '', class: 'cgw-block' }, HTMLAttributes),
    0,
  ],
});

const Doc = Node.create({ name: 'doc', topNode: true, content: 'block*' });
const Text = Node.create({ name: 'text', group: 'inline' });
const HardBreak = Node.create({
  name: 'hardBreak',
  group: 'inline',
  inline: true,
  selectable: false,
  parseHTML: () => [{ tag: 'br' }],
  renderHTML: () => ['br'],
});

/** A link to a page, or a block in it, by id. The title is resolved when drawn (D6). */
const PageMention = Node.create({
  name: 'pageMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    pageId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-page-id'),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.pageId ? { 'data-page-id': attrs.pageId } : {},
    },
    blockId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-block-id'),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.blockId ? { 'data-block-id': attrs.blockId } : {},
    },
  }),
  parseHTML: () => [{ tag: 'span[data-page-mention]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    mergeAttributes({ 'data-page-mention': '', class: 'cgw-page-mention' }, HTMLAttributes),
  ],
  renderText: () => '@page',
});

const simpleMark = (name: string, tags: string[], render: string, extra = {}) =>
  Mark.create({
    name,
    ...extra,
    parseHTML: () => tags.map((tag) => ({ tag })),
    renderHTML: () => [render, 0],
  });

const Bold = Mark.create({
  name: 'bold',
  parseHTML: () => [
    { tag: 'strong' },
    { tag: 'b', getAttrs: (node: HTMLElement) => node.style.fontWeight !== 'normal' && null },
    {
      style: 'font-weight',
      getAttrs: (value: string) => /^(bold(er)?|[6-9]\d{2,})$/.test(value) && null,
    },
  ],
  renderHTML: () => ['strong', 0],
});
const Italic = simpleMark('italic', ['em', 'i'], 'em');
const Underline = simpleMark('underline', ['u'], 'u');
const Strike = simpleMark('strike', ['s', 'del', 'strike'], 's');
const Code = Mark.create({
  name: 'code',
  excludes: '_',
  code: true,
  parseHTML: () => [{ tag: 'code' }],
  renderHTML: () => ['code', 0],
});

const Link = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes: () => ({
    href: {
      default: null,
      parseHTML: (element: HTMLElement) => safeHref(element.getAttribute('href')),
      renderHTML: (attrs: Record<string, unknown>) => {
        const href = safeHref(attrs.href);
        return href
          ? {
              href,
              rel: 'noopener noreferrer nofollow',
              target: href.startsWith('#') ? null : '_blank',
            }
          : {};
      },
    },
  }),
  // A link whose scheme is not allowed is not a link at all.
  parseHTML: () => [
    {
      tag: 'a[href]',
      getAttrs: (node: HTMLElement) => (safeHref(node.getAttribute('href')) ? null : false),
    },
  ],
  renderHTML: ({ HTMLAttributes }) => ['a', HTMLAttributes, 0],
});

const tokenMark = (name: 'textColour' | 'highlight', css: string) =>
  Mark.create({
    name,
    addAttributes: () => ({
      token: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute(`data-${css}`);
          return isToken(value) ? value : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          isToken(attrs.token) ? { [`data-${css}`]: attrs.token } : {},
      },
    }),
    parseHTML: () => [
      {
        tag: `span[data-${css}]`,
        getAttrs: (node: HTMLElement) => (isToken(node.getAttribute(`data-${css}`)) ? null : false),
      },
    ],
    renderHTML: ({ HTMLAttributes }) => ['span', { ...HTMLAttributes, class: `cgw-${css}` }, 0],
  });

/** The document's node and mark types, in the order ProseMirror gives priority to. */
export function schemaExtensions(): AnyExtension[] {
  return [
    TableRoles,
    Doc,
    Text,
    Block,
    TextBody,
    CodeBlock,
    Divider,
    Table,
    TableRow,
    TableCell,
    Image,
    FileBody,
    Bookmark,
    ChildPage,
    HardBreak,
    PageMention,
    Link,
    Bold,
    Italic,
    Underline,
    Strike,
    Code,
    tokenMark('textColour', 'colour'),
    tokenMark('highlight', 'highlight'),
  ];
}

/** Body node types that are atoms: an id and settings, no text. */
export const ATOM_BODIES = ['divider', 'image', 'file', 'bookmark', 'childPage'] as const;

let cached: Schema | null = null;

/** The ProseMirror schema itself, for work done without an editor (export, import, history). */
export function documentSchema(): Schema {
  return (cached ??= getSchema(schemaExtensions()));
}

/** The node and mark names this build can draw: anything else is shown as a placeholder. */
export function knownTypes(): { nodes: ReadonlySet<string>; marks: ReadonlySet<string> } {
  const schema = documentSchema();
  return { nodes: new Set(Object.keys(schema.nodes)), marks: new Set(Object.keys(schema.marks)) };
}
