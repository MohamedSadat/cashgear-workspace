// A comment's body (contract section 3): the document's inline nodes, a strict subset, as
// ProseMirror JSON. Text without marks or line breaks inside, hard breaks, and mentions of people
// and pages. The composer writes it from its editable area; a comment is drawn from it.
import type { Id } from '@cgw/workspace';

export type CommentInline =
  | { type: 'text'; text: string }
  | { type: 'hardBreak' }
  | { type: 'userMention'; attrs: { userId: string } }
  | { type: 'pageMention'; attrs: { pageId: string } };

export type CommentBody = CommentInline[];

/** At most this many characters of text in a body (contract section 3). */
export const BODY_TEXT_LIMIT = 4000;
/** At most this many mentions in a body. */
export const BODY_MENTION_LIMIT = 50;

const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');
const ZWSP = new RegExp(String.fromCharCode(0x200b), 'g');

/** Merges neighbouring text, drops empty text, and trims blank text and breaks at both ends. */
export function normaliseBody(body: CommentBody): CommentBody {
  const out: CommentBody = [];
  for (const node of body) {
    if (node.type === 'text') {
      const text = node.text.replace(/\r/g, '').replace(NBSP, ' ').replace(ZWSP, '');
      // A line break inside text is a hard break.
      text.split('\n').forEach((part, i) => {
        if (i > 0) out.push({ type: 'hardBreak' });
        if (!part) return;
        const last = out[out.length - 1];
        if (last?.type === 'text') last.text += part;
        else out.push({ type: 'text', text: part });
      });
    } else out.push(node);
  }
  const blank = (node: CommentInline | undefined) =>
    !!node && (node.type === 'hardBreak' || (node.type === 'text' && !node.text.trim()));
  while (blank(out[0])) out.shift();
  while (blank(out[out.length - 1])) out.pop();
  const first = out[0];
  if (first?.type === 'text') first.text = first.text.trimStart();
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text = last.text.trimEnd();
  return out;
}

export const bodyTextLength = (body: CommentBody) =>
  body.reduce((n, node) => n + (node.type === 'text' ? node.text.length : 0), 0);

export const bodyMentions = (body: CommentBody) =>
  body.filter((node) => node.type === 'userMention' || node.type === 'pageMention').length;

/** Why a body cannot be sent, or null when it can. */
export function bodyProblem(body: CommentBody): 'empty' | 'tooLong' | 'tooManyMentions' | null {
  const hasText = body.some((node) => node.type === 'text' && node.text.trim());
  if (!hasText && !bodyMentions(body)) return 'empty';
  if (bodyTextLength(body) > BODY_TEXT_LIMIT) return 'tooLong';
  if (bodyMentions(body) > BODY_MENTION_LIMIT) return 'tooManyMentions';
  return null;
}

/** The people a body mentions. */
export const mentionedPeople = (body: CommentBody): Id[] => [
  ...new Set(body.flatMap((node) => (node.type === 'userMention' ? [node.attrs.userId] : []))),
];

/** A mention as the composer draws it: an atom the caret moves over, with its id. */
export function mentionElement(
  doc: Document,
  mention: { kind: 'user'; id: Id } | { kind: 'page'; id: Id },
  label: string,
): HTMLElement {
  const span = doc.createElement('span');
  span.className = `cgw-comment-mention is-${mention.kind}`;
  span.contentEditable = 'false';
  span.dataset[mention.kind === 'user' ? 'userId' : 'pageId'] = mention.id;
  span.textContent = mention.kind === 'user' ? `@${label}` : label;
  return span;
}

const BLOCKS = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'PRE']);

/**
 * The body the composer's editable area holds: its text, its line breaks (a `<br>`, or a line a
 * browser made a `<div>` of) and its mention atoms. Formatting a browser adds is left out.
 */
export function bodyFromElement(root: Node): CommentBody {
  const out: CommentBody = [];
  // A line a browser made a block of ends there: what follows it starts a line of its own.
  let afterBlock = false;
  const breakBefore = () => {
    afterBlock = false;
    const last = out[out.length - 1];
    if (last && last.type !== 'hardBreak') out.push({ type: 'hardBreak' });
  };
  const push = (node: CommentInline) => {
    if (afterBlock) breakBefore();
    out.push(node);
  };
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        push({ type: 'text', text: (child as Text).data });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as HTMLElement;
      if (el.tagName === 'BR') {
        // Breaks at the end are trimmed: a browser's placeholder <br> adds nothing.
        push({ type: 'hardBreak' });
      } else if (el.dataset.userId) {
        push({ type: 'userMention', attrs: { userId: el.dataset.userId } });
      } else if (el.dataset.pageId) {
        push({ type: 'pageMention', attrs: { pageId: el.dataset.pageId } });
      } else if (BLOCKS.has(el.tagName)) {
        breakBefore();
        walk(el);
        afterBlock = true;
      } else walk(el);
    }
  };
  walk(root);
  return normaliseBody(out);
}

/** Fills the composer's editable area with a body (editing a comment). */
export function fillElement(
  root: HTMLElement,
  body: CommentBody,
  labels: { person: (userId: Id) => string; page: (pageId: Id) => string },
) {
  root.replaceChildren();
  const doc = root.ownerDocument;
  for (const node of body) {
    if (node.type === 'text') root.append(doc.createTextNode(node.text));
    else if (node.type === 'hardBreak') root.append(doc.createElement('br'));
    else if (node.type === 'userMention')
      root.append(
        mentionElement(
          doc,
          { kind: 'user', id: node.attrs.userId },
          labels.person(node.attrs.userId),
        ),
      );
    else
      root.append(
        mentionElement(
          doc,
          { kind: 'page', id: node.attrs.pageId },
          labels.page(node.attrs.pageId),
        ),
      );
  }
}

/** The body as one line of plain text (an editor's label, a test): mentions by their labels. */
export function bodyText(
  body: CommentBody,
  labels: { person: (userId: Id) => string; page: (pageId: Id) => string },
): string {
  return body
    .map((node) =>
      node.type === 'text'
        ? node.text
        : node.type === 'hardBreak'
          ? '\n'
          : node.type === 'userMention'
            ? `@${labels.person(node.attrs.userId)}`
            : labels.page(node.attrs.pageId),
    )
    .join('');
}

/** A body from the server, kept to the shape this build draws (anything else is left out). */
export function readBody(value: unknown): CommentBody {
  if (!Array.isArray(value)) return [];
  const out: CommentBody = [];
  for (const node of value as {
    type?: unknown;
    text?: unknown;
    attrs?: Record<string, unknown>;
  }[]) {
    if (node?.type === 'text' && typeof node.text === 'string')
      out.push({ type: 'text', text: node.text });
    else if (node?.type === 'hardBreak') out.push({ type: 'hardBreak' });
    else if (node?.type === 'userMention' && typeof node.attrs?.userId === 'string')
      out.push({ type: 'userMention', attrs: { userId: node.attrs.userId } });
    else if (node?.type === 'pageMention' && typeof node.attrs?.pageId === 'string')
      out.push({ type: 'pageMention', attrs: { pageId: node.attrs.pageId } });
  }
  return out;
}

/**
 * The "@" being typed before the caret in a text node, if any: what follows it (the query) and
 * where it starts. An "@" counts at the start of the text or after a space or an opening bracket.
 */
export function mentionQueryAt(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s(])@([^\s@]{0,40})$/u.exec(before);
  if (!match) return null;
  return { query: match[1], start: caret - match[1].length - 1 };
}
