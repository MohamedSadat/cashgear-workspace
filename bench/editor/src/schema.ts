// Spike S1's schema variants. The one S1 chose, (body | block)* with one textBody and a `kind`, is
// the product's own (@cgw/doc), which every harness now uses. The others are kept for S1's
// comparison runs and S2's newer builds.
//
// Two variants of the container's content expression, both `*` only:
//   ordered: block = body* block*      (bodies first, then child blocks)
//   mixed:   block = (body | block)*   (any order)
// and two ways of naming text bodies:
//   types: one node type per kind (paragraph, heading, bulletItem, ...), as DATA_MODEL.md lists
//   kind:  one `textBody` node with a `kind` attribute, so "turn into" is an attribute change
import { Mark, Node, mergeAttributes, type AnyExtension } from '@tiptap/core';
import { schemaExtensions as productSchema } from '@cgw/doc';

export type ContentVariant = 'ordered' | 'mixed';
export type BodyVariant = 'types' | 'kind';

export interface SchemaVariant {
  content: ContentVariant;
  bodies: BodyVariant;
}

export const containerContent = (variant: ContentVariant) =>
  variant === 'ordered' ? 'body* block*' : '(body | block)*';

/** Text bodies in the `types` variant, with the attributes each adds. */
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

const dirAttribute = {
  dir: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const dir = element.getAttribute('dir');
      return dir === 'ltr' || dir === 'rtl' ? dir : null;
    },
    // null means "from the first strong character" (D24).
    renderHTML: (attrs: Record<string, unknown>) => ({ dir: attrs.dir ?? 'auto' }),
  },
};

const kindAttributes: Record<TextKind, Record<string, { default: unknown }>> = {
  paragraph: {},
  heading: { level: { default: 1 } },
  bulletItem: {},
  numberedItem: { start: { default: null } },
  checkItem: { checked: { default: false } },
  toggle: {},
  quote: {},
  callout: { icon: { default: null }, tone: { default: null } },
};

function textBody(name: TextKind, extraAttributes: string[] = []) {
  const extra = Object.fromEntries(extraAttributes.map((key) => [key, { default: null }]));
  return Node.create({
    name,
    group: 'body',
    content: 'inline*',
    addAttributes: () => ({ ...dirAttribute, ...kindAttributes[name], ...extra }),
    parseHTML: () => [{ tag: `div[data-body="${name}"]` }],
    renderHTML: ({ HTMLAttributes, node }) => [
      name === 'heading' ? `h${node.attrs.level}` : 'div',
      mergeAttributes({ 'data-body': name, class: `cgw-body cgw-${name}` }, HTMLAttributes),
      0,
    ],
  });
}

/** The `kind` variant's single text body. */
const TextBody = Node.create({
  name: 'textBody',
  group: 'body',
  content: 'inline*',
  addAttributes: () => ({
    ...dirAttribute,
    kind: { default: 'paragraph' },
    level: { default: null },
    checked: { default: null },
    start: { default: null },
  }),
  parseHTML: () => [{ tag: 'div[data-body="textBody"]' }],
  renderHTML: ({ HTMLAttributes, node }) => [
    'div',
    mergeAttributes(
      {
        'data-body': 'textBody',
        'data-kind': node.attrs.kind,
        class: `cgw-body cgw-${node.attrs.kind}`,
      },
      HTMLAttributes,
    ),
    0,
  ],
});

const CodeBlock = Node.create({
  name: 'codeBlock',
  group: 'body',
  content: 'text*',
  marks: '',
  code: true,
  addAttributes: () => ({ language: { default: null }, wrap: { default: false } }),
  parseHTML: () => [{ tag: 'pre', preserveWhitespace: 'full' }],
  renderHTML: () => ['pre', { class: 'cgw-body cgw-codeBlock', dir: 'ltr' }, ['code', 0]],
});

function atomBody(name: string, attrs: Record<string, { default: unknown }>, tag = 'div') {
  return Node.create({
    name,
    group: 'body',
    atom: true,
    selectable: true,
    addAttributes: () => attrs,
    parseHTML: () => [{ tag: `${tag}[data-body="${name}"]` }],
    renderHTML: ({ HTMLAttributes }) => [
      tag,
      mergeAttributes({ 'data-body': name, class: `cgw-body cgw-${name}` }, HTMLAttributes),
    ],
  });
}

const Divider = atomBody('divider', {}, 'hr');

// A table body with inline cells (DATA_MODEL.md); enough to check layout in RTL (S5).
const Table = Node.create({
  name: 'table',
  group: 'body',
  content: 'tableRow*',
  addAttributes: () => ({ headerRow: { default: false } }),
  parseHTML: () => [{ tag: 'table' }],
  renderHTML: () => ['table', { class: 'cgw-body cgw-table' }, ['tbody', 0]],
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
  addAttributes: () => ({ ...dirAttribute, colspan: { default: 1 }, rowspan: { default: 1 } }),
  parseHTML: () => [{ tag: 'td' }],
  renderHTML: ({ HTMLAttributes }) => ['td', HTMLAttributes, 0],
});
const Image = atomBody('image', {
  assetId: { default: null },
  width: { default: null },
  align: { default: null },
  alt: { default: null },
  caption: { default: null },
});
const ChildPage = atomBody('childPage', { pageId: { default: null } });

function blockNode(content: ContentVariant) {
  return Node.create({
    name: 'block',
    content: containerContent(content),
    // Not `defining`: a paste into a block must not drag the container along.
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
}

const Doc = Node.create({ name: 'doc', topNode: true, content: 'block*' });
const Text = Node.create({ name: 'text', group: 'inline' });

/** Link schemes allowed when a link is parsed, drawn or clicked (ARCHITECTURE.md, Links). */
export const SAFE_LINK = /^(https?:|mailto:|tel:|#|\/)/i;
const safeHref = (href: unknown) =>
  typeof href === 'string' && SAFE_LINK.test(href.trim()) ? href.trim() : null;

const Bold = Mark.create({
  name: 'bold',
  parseHTML: () => [{ tag: 'strong' }, { tag: 'b' }],
  renderHTML: () => ['strong', 0],
});
const Italic = Mark.create({
  name: 'italic',
  parseHTML: () => [{ tag: 'em' }, { tag: 'i' }],
  renderHTML: () => ['em', 0],
});
const Code = Mark.create({
  name: 'code',
  excludes: '_',
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
        return href ? { href, rel: 'noopener noreferrer', target: '_blank' } : {};
      },
    },
  }),
  parseHTML: () => [{ tag: 'a[href]' }],
  renderHTML: ({ HTMLAttributes }) => ['a', HTMLAttributes, 0],
});

/** What a newer build adds: node types, and attributes on text bodies (S2). */
export interface SchemaAdditions {
  kinds?: string[];
  attributes?: string[];
}

/** The variant the product ships (DATA_MODEL.md, Content expressions). */
export const isProductSchema = (variant: SchemaVariant) =>
  variant.content === 'mixed' && variant.bodies === 'kind';

export function schemaExtensions(
  variant: SchemaVariant,
  additions: SchemaAdditions = {},
): AnyExtension[] {
  if (isProductSchema(variant) && !additions.kinds?.length && !additions.attributes?.length)
    return productSchema();
  const extraKinds = additions.kinds ?? [];
  const bodies =
    variant.bodies === 'types'
      ? TEXT_KINDS.map((kind) => textBody(kind, additions.attributes))
      : [TextBody];
  // S2: a newer build adds a node type the older one does not know.
  const extra = extraKinds.map((name) => atomBody(name, { data: { default: null } }));
  return [
    Doc,
    Text,
    blockNode(variant.content),
    ...bodies,
    CodeBlock,
    Divider,
    Table,
    TableRow,
    TableCell,
    Image,
    ChildPage,
    ...extra,
    Bold,
    Italic,
    Code,
    Link,
  ];
}
