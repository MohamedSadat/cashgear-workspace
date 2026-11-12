// Building and rewriting ProseMirror JSON outside an editor: first-run pages, templates, imports,
// pasted blocks. Every block made here gets a fresh id, because each of these is a local creation
// (D4); nothing here runs in response to a remote change.
import type { DocJSON } from './binding';
import { newBlockId } from './ids';
import { readOnlyView } from './readonly';
import type { TextKind } from './schema';

type Mark = 'bold' | 'italic' | 'underline' | 'strike' | 'code';
type Inline = string | DocJSON;

export const text = (
  value: string,
  ...marks: (Mark | { type: 'link'; href: string })[]
): DocJSON => ({
  type: 'text',
  text: value,
  ...(marks.length
    ? {
        marks: marks.map((mark) =>
          typeof mark === 'string' ? { type: mark } : { type: 'link', attrs: { href: mark.href } },
        ),
      }
    : {}),
});

const inline = (content: Inline[]): DocJSON[] =>
  content.filter((c) => c !== '').map((c) => (typeof c === 'string' ? text(c) : c));

export function block(body: DocJSON, children: DocJSON[] = []): DocJSON {
  return { type: 'block', attrs: { id: newBlockId() }, content: [body, ...children] };
}

export function textBlock(
  kind: TextKind,
  content: Inline[] = [],
  attrs: Record<string, unknown> = {},
  children: DocJSON[] = [],
): DocJSON {
  const body: DocJSON = { type: 'textBody', attrs: { kind, ...attrs } };
  const parts = inline(content);
  if (parts.length) body.content = parts;
  return block(body, children);
}

export const paragraph = (...content: Inline[]) => textBlock('paragraph', content);
export const heading = (level: 1 | 2 | 3, ...content: Inline[]) =>
  textBlock('heading', content, { level });
export const bullet = (content: Inline[], children: DocJSON[] = []) =>
  textBlock('bulletItem', content, {}, children);
export const numbered = (content: Inline[], children: DocJSON[] = []) =>
  textBlock('numberedItem', content, {}, children);
export const todo = (checked: boolean, ...content: Inline[]) =>
  textBlock('checkItem', content, { checked });
export const quote = (...content: Inline[]) => textBlock('quote', content);
export const toggle = (summary: Inline[], children: DocJSON[]) =>
  textBlock('toggle', summary, {}, children);
export const callout = (icon: string, tone: string, ...content: Inline[]) =>
  textBlock('callout', content, { icon, tone });
export const divider = () => block({ type: 'divider' });
export const code = (language: string | null, source: string) =>
  block({ type: 'codeBlock', attrs: { language }, content: source ? [text(source)] : [] });
export const bookmark = (url: string) => block({ type: 'bookmark', attrs: { url } });
export const childPage = (pageId: string) => block({ type: 'childPage', attrs: { pageId } });

export function table(rows: Inline[][], headerRow = true): DocJSON {
  return block({
    type: 'table',
    attrs: { headerRow },
    content: rows.map((cells) => ({
      type: 'tableRow',
      content: cells.map((cell) => ({
        type: 'tableCell',
        ...(cell === '' ? {} : { content: inline([cell]) }),
      })),
    })),
  });
}

export const docOf = (...blocks: DocJSON[]): DocJSON => ({ type: 'doc', content: blocks });

/** A deep copy in which every block has a new id, for a duplicate, a template copy or an import. */
export function withNewIds(node: DocJSON): DocJSON {
  const copy: DocJSON = { ...node };
  if (node.type === 'block') copy.attrs = { ...node.attrs, id: newBlockId() };
  if (node.content) copy.content = node.content.map(withNewIds);
  return copy;
}

/** A deep copy with every block id cleared, so the editor's id plugin mints them (paste). */
export function withoutIds(node: DocJSON): DocJSON {
  const copy: DocJSON = { ...node };
  if (node.type === 'block') copy.attrs = { ...node.attrs, id: null };
  if (node.content) copy.content = node.content.map(withoutIds);
  return copy;
}

/** Rewrites page references (child pages, mentions) and asset ids, for a copied subtree. */
export function remapRefs(
  node: DocJSON,
  pages: ReadonlyMap<string, string>,
  assets: ReadonlyMap<string, string> = new Map(),
): DocJSON {
  const copy: DocJSON = { ...node };
  const attrs = node.attrs;
  if (attrs) {
    const next = { ...attrs };
    if (typeof attrs.pageId === 'string' && pages.has(attrs.pageId))
      next.pageId = pages.get(attrs.pageId);
    if (typeof attrs.assetId === 'string' && assets.has(attrs.assetId))
      next.assetId = assets.get(attrs.assetId);
    copy.attrs = next;
  }
  if (node.marks)
    copy.marks = node.marks.map((mark) => {
      const href = mark.attrs?.href;
      if (mark.type !== 'link' || typeof href !== 'string') return mark;
      const match = /^#\/p\/([0-9a-f-]{36})(.*)$/.exec(href);
      return match && pages.has(match[1])
        ? { ...mark, attrs: { ...mark.attrs, href: `#/p/${pages.get(match[1])}${match[2]}` } }
        : mark;
    });
  if (node.content) copy.content = node.content.map((child) => remapRefs(child, pages, assets));
  return copy;
}

/** Every page and asset a document points at: what an export or a copy must bring along. */
export function references(doc: DocJSON): { pages: Set<string>; assets: Set<string> } {
  const pages = new Set<string>();
  const assets = new Set<string>();
  const walk = (node: DocJSON) => {
    if (typeof node.attrs?.pageId === 'string') pages.add(node.attrs.pageId);
    if (typeof node.attrs?.assetId === 'string') assets.add(node.attrs.assetId);
    node.content?.forEach(walk);
  };
  walk(doc);
  return { pages, assets };
}

/**
 * The document as this schema can draw it: a node type it does not know becomes a placeholder
 * saying so (used only for a read-only view; the stored document is never rewritten). The same
 * as `readOnlyView` (readonly.ts), which also says what it replaced.
 */
export function readableJSON(
  doc: DocJSON,
  known: { nodes: ReadonlySet<string>; marks: ReadonlySet<string> },
  placeholder: string,
): DocJSON {
  return readOnlyView(doc, { block: placeholder }, { known }).json;
}
