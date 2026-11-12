// The read-only view of a page whose document is newer than this build (D7; SYNC_DESIGN.md,
// "Across the two models": the page opens read-only from the server's derived JSON, nothing is
// pushed). The server's ProseMirror JSON (`GET /pages/{id}/doc/json`) is made into content this
// build's schema can hold: every node type it does not know becomes a placeholder that says so,
// in the place it was, with whatever it held that this build can draw shown after it; nothing is
// dropped without a trace. Only the view is rewritten, never the stored document.
import { Mark, type MarkType, type NodeType, type Schema } from '@tiptap/pm/model';
import type { DocJSON } from './binding';
import { dateMentionText } from './dates';
import { documentSchema } from './schema';

export interface ReadOnlyStrings {
  /** What a block this build cannot draw says (the catalogue's `editor.readOnlyBlock`). */
  block: string;
  /** The same, short, for something inside a line of text (`editor.readOnlyInline`). */
  inline?: string;
}

export interface ReadOnlyOptions {
  schema?: Schema;
  /** Only these node and mark names count as known (default: the schema's). */
  known?: { nodes: ReadonlySet<string>; marks: ReadonlySet<string> };
}

export interface ReadOnlyView {
  /** ProseMirror JSON this build's schema holds. */
  json: DocJSON;
  /** Node types shown as placeholders, and mark types left out (their text stays), sorted. */
  unknownNodes: string[];
  unknownMarks: string[];
}

type MarkJSON = NonNullable<DocJSON['marks']>[number];
/** Stands between text blocks flattened into one line, until it becomes a line break. */
const SEPARATOR = ' separator';

/** The page as this build can draw it read-only. */
export function readOnlyView(
  json: DocJSON,
  strings: ReadOnlyStrings,
  options: ReadOnlyOptions = {},
): ReadOnlyView {
  const schema = options.schema ?? documentSchema();
  const unknownNodes = new Set<string>();
  const unknownMarks = new Set<string>();
  const knownNode = (name: string): NodeType | null =>
    (!options.known || options.known.nodes.has(name)) && schema.nodes[name]
      ? schema.nodes[name]
      : null;
  const knownMark = (name: string): MarkType | null =>
    (!options.known || options.known.marks.has(name)) && schema.marks[name]
      ? schema.marks[name]
      : null;
  const { textBody, table, tableRow, tableCell, text } = schema.nodes;

  const textNode = (value: string, marks?: MarkJSON[]): DocJSON =>
    marks?.length ? { type: 'text', text: value, marks } : { type: 'text', text: value };
  const callout = (): DocJSON => ({
    type: 'textBody',
    attrs: { kind: 'callout', icon: '⚠️', tone: 'warning' },
    content: [textNode(strings.block)],
  });

  /** Marks this build knows and the parent allows; unknown ones are noted. */
  const marksFor = (marks: MarkJSON[] | undefined, parent: NodeType): MarkJSON[] | undefined => {
    if (!marks?.length) return undefined;
    // A set ProseMirror accepts: known, allowed here, and none excluding another (code
    // excludes every other mark), in the schema's order.
    let set = Mark.none;
    for (const json of marks) {
      const type = knownMark(json.type);
      if (!type) unknownMarks.add(json.type);
      if (!type || !parent.allowsMarkType(type)) continue;
      try {
        set = schema.markFromJSON(json).addToSet(set);
      } catch {
        // Attributes it cannot hold: the text is shown without the mark.
      }
    }
    return set.length ? set.map((mark) => mark.toJSON() as MarkJSON) : undefined;
  };

  /** Every piece of inline content inside a node, for a place that holds only a line of text. */
  const inlineOf = (node: DocJSON, parent: NodeType): DocJSON[] => {
    const out: DocJSON[] = [];
    const canBreak = parent.contentMatch.matchType(schema.nodes.hardBreak) !== null;
    const lineBreak = (): DocJSON => (canBreak ? { type: 'hardBreak' } : textNode('\n'));
    const walk = (n: DocJSON) => {
      const type = knownNode(n.type);
      if (!type) {
        unknownNodes.add(n.type);
        out.push(textNode(strings.inline ?? strings.block));
      } else if (type === text) {
        if (n.text) out.push(textNode(n.text, marksFor(n.marks, parent)));
        return;
      } else if (type.isInline) {
        if (parent.contentMatch.matchType(type)) out.push(build(n, type, parent));
        else if (type.name === 'hardBreak') out.push(lineBreak());
        else if (type.name === 'dateMention') {
          // Where only text goes (a code block), a date is its text.
          const date = dateMentionText(n.attrs);
          if (date) out.push(textNode(date));
        }
        return;
      }
      const before = out.length;
      n.content?.forEach(walk);
      // Lines of separate text blocks stay on separate lines (none after the last).
      if (type?.isTextblock && out.length > before) out.push({ type: SEPARATOR });
    };
    walk(node);
    while (out.length && out[out.length - 1].type === SEPARATOR) out.pop();
    return out.map((n) => (n.type === SEPARATOR ? lineBreak() : n));
  };

  /** A node of a known type, its content fitted to it. */
  const build = (node: DocJSON, type: NodeType, parent: NodeType): DocJSON => {
    const out: DocJSON = { type: node.type };
    if (node.attrs) out.attrs = node.attrs;
    const marks = marksFor(node.marks, parent);
    if (marks) out.marks = marks;
    if (type === text) out.text = node.text;
    else if (node.content) {
      const content = fit(node.content, type);
      if (content.length) out.content = content;
    }
    return out;
  };

  /** A node made to fit under a parent that does not take its type, by wrapping it. */
  const wrap = (node: DocJSON, parent: NodeType): DocJSON[] => {
    let current = node;
    for (let i = 0; i < 4; i++) {
      const type = schema.nodes[current.type];
      if (parent.contentMatch.matchType(type)) return [current];
      if (parent === table || parent === tableRow) {
        // A table holds rows and cells only: anything else becomes a cell's text.
        const cell: DocJSON =
          type === tableCell
            ? current
            : { type: 'tableCell', content: inlineOf(current, tableCell) };
        return [parent === tableRow ? cell : { type: 'tableRow', content: [cell] }];
      }
      if (type.isInline)
        current = { type: 'textBody', attrs: { kind: 'paragraph' }, content: [current] };
      else if (type === tableCell) current = { type: 'tableRow', content: [current] };
      else if (type === tableRow) current = { type: 'table', content: [current] };
      else current = { type: 'block', attrs: { id: null }, content: [current] };
    }
    return [{ type: 'block', attrs: { id: null }, content: [callout()] }];
  };

  /** A placeholder for an unknown node, in the form its parent takes. */
  const placeholder = (parent: NodeType): DocJSON => {
    if (parent.inlineContent) return textNode(strings.inline ?? strings.block);
    if (parent === tableRow) return { type: 'tableCell', content: [textNode(strings.block)] };
    if (parent === table)
      return {
        type: 'tableRow',
        content: [{ type: 'tableCell', content: [textNode(strings.block)] }],
      };
    if (parent.contentMatch.matchType(textBody)) return callout();
    return { type: 'block', attrs: { id: null }, content: [callout()] };
  };

  /** A node's children as its type can hold them. */
  function fit(children: DocJSON[], parent: NodeType): DocJSON[] {
    const out: DocJSON[] = [];
    // Inline content where blocks belong is gathered into one paragraph.
    let run: DocJSON[] | null = null;
    const endRun = () => {
      if (run?.length)
        out.push(...wrap({ type: 'textBody', attrs: { kind: 'paragraph' }, content: run }, parent));
      run = null;
    };
    for (const child of children) {
      if (!child || typeof child.type !== 'string') continue;
      const type = knownNode(child.type);
      if (!type) {
        endRun();
        unknownNodes.add(child.type);
        out.push(placeholder(parent));
        // What it held that this build knows is shown after it.
        if (child.content?.length) out.push(...fit(child.content, parent));
        continue;
      }
      if (type === text && !child.text) continue;
      if (type === schema.topNodeType) {
        // A document inside a document: its content, where it was.
        endRun();
        out.push(...fit(child.content ?? [], parent));
        continue;
      }
      if (parent.inlineContent) {
        out.push(
          ...(type.isInline && parent.contentMatch.matchType(type)
            ? [build(child, type, parent)]
            : inlineOf(child, parent)),
        );
        continue;
      }
      if (type.isInline && !parent.contentMatch.matchType(type)) {
        (run ??= []).push(build(child, type, textBody));
        continue;
      }
      endRun();
      const built = build(child, type, parent);
      out.push(...(parent.contentMatch.matchType(type) ? [built] : wrap(built, parent)));
    }
    endRun();
    return out;
  }

  const doc = schema.topNodeType;
  const result: DocJSON = { type: doc.name };
  const content = fit(json.type === doc.name ? (json.content ?? []) : [json], doc);
  if (content.length) result.content = content;
  return {
    json: result,
    unknownNodes: [...unknownNodes].sort(),
    unknownMarks: [...unknownMarks].sort(),
  };
}
