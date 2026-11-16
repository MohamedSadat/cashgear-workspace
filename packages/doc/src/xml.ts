// A small XML reader for the parts of an Office file (Word's document, styles, numbering and
// relationships): elements, attributes, text and CDATA; the five named entities and character
// references. No DTD is read: a document type is refused, so no entity can expand (a "billion
// laughs" file), and nesting deeper than `maxDepth`, or more than `maxElements` elements, is
// refused. Names keep their prefixes
// (`w:p`); `local` reads a name without one. Pure: it runs in a worker and in Node, where there
// is no DOMParser (DECISIONS.md, Phase 8: our own tokenizer, not the main thread's parser).

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

export class XmlError extends Error {
  constructor(
    readonly code: 'doctype' | 'depth' | 'tooMany' | 'malformed',
    message: string = code,
  ) {
    super(message);
    this.name = 'XmlError';
  }
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Text with its entities and character references read; an unknown entity stays as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] !== '#') return NAMED[body] ?? whole;
    const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    const valid =
      code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe;
    return valid ? String.fromCodePoint(code) : String.fromCharCode(0xfffd);
  });
}

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/** Elements a document is read up to; past it the document is refused (`tooMany`). */
export const MAX_ELEMENTS = 2_000_000;

/** The root element of an XML text. Throws `XmlError` for what it will not read. */
export function parseXml(
  input: string,
  options: { maxDepth?: number; maxElements?: number } = {},
): XmlElement {
  const maxDepth = options.maxDepth ?? 256;
  // What parsing makes of a few bytes is bounded too (the security review: 50 MB of `<w:p/>`,
  // 50 KB zipped, made 12.5 million elements).
  const maxElements = options.maxElements ?? MAX_ELEMENTS;
  let made = 0;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const n = text.length;
  const addText = (value: string) => {
    const top = stack[stack.length - 1];
    if (!top || !value) return;
    const last = top.children[top.children.length - 1];
    if (typeof last === 'string') top.children[top.children.length - 1] = last + value;
    else top.children.push(value);
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(text.slice(i, lt)));
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('malformed', 'An unclosed processing instruction');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('malformed', 'An unclosed comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('malformed', 'An unclosed CDATA section');
      addText(text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw new XmlError('doctype', 'A document type is not read');
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2);
      if (end < 0) throw new XmlError('malformed', 'An unclosed end tag');
      const name = text.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name)
        throw new XmlError('malformed', `</${name}> does not close <${top?.name ?? ''}>`);
      i = end + 1;
      continue;
    }
    // A start tag: its name, then attributes, then `>` or `/>`.
    let j = lt + 1;
    while (j < n && !isSpace(text[j]) && text[j] !== '>' && text[j] !== '/') j++;
    const name = text.slice(lt + 1, j);
    if (!name) throw new XmlError('malformed', 'A tag with no name');
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(text[j])) j++;
      if (j >= n) throw new XmlError('malformed', `An unclosed <${name}>`);
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const start = j;
      while (j < n && !isSpace(text[j]) && text[j] !== '=' && text[j] !== '>' && text[j] !== '/')
        j++;
      const key = text.slice(start, j);
      while (j < n && isSpace(text[j])) j++;
      if (!key || text[j] !== '=') throw new XmlError('malformed', `An attribute of <${name}>`);
      j++;
      while (j < n && isSpace(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'")
        throw new XmlError('malformed', `An unquoted attribute of <${name}>`);
      const close = text.indexOf(quote, j + 1);
      if (close < 0) throw new XmlError('malformed', `An unclosed attribute of <${name}>`);
      attrs[key] = decodeEntities(text.slice(j + 1, close));
      j = close + 1;
    }
    if (++made > maxElements) throw new XmlError('tooMany', 'More elements than are read');
    const element: XmlElement = { name, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (!root) root = element;
    else throw new XmlError('malformed', 'More than one root element');
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > maxDepth) throw new XmlError('depth', 'Elements nested too deeply');
    }
    i = j;
  }
  if (stack.length)
    throw new XmlError('malformed', `An unclosed <${stack[stack.length - 1].name}>`);
  if (!root) throw new XmlError('malformed', 'No root element');
  return root;
}

/** A name without its prefix: `w:p` is `p`. */
export const local = (name: string): string => {
  const at = name.indexOf(':');
  return at < 0 ? name : name.slice(at + 1);
};

/** The element's child elements, all or those with a local name. */
export function elements(element: XmlElement | undefined, name?: string): XmlElement[] {
  if (!element) return [];
  const out: XmlElement[] = [];
  for (const child of element.children)
    if (typeof child !== 'string' && (name === undefined || local(child.name) === name))
      out.push(child);
  return out;
}

/** The first child element with a local name. */
export function element(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!parent) return undefined;
  for (const child of parent.children)
    if (typeof child !== 'string' && local(child.name) === name) return child;
  return undefined;
}

/** An attribute by its local name (`w:val`, `r:embed`), whatever its prefix. */
export function attr(el: XmlElement | undefined, name: string): string | undefined {
  if (!el) return undefined;
  if (name in el.attrs) return el.attrs[name];
  for (const [key, value] of Object.entries(el.attrs)) if (local(key) === name) return value;
  return undefined;
}

/** The first descendant (depth first) with a local name. */
export function descendant(root: XmlElement, name: string): XmlElement | undefined {
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const next = stack.pop()!;
    if (next !== root && local(next.name) === name) return next;
    for (let i = next.children.length - 1; i >= 0; i--) {
      const child = next.children[i];
      if (typeof child !== 'string') stack.push(child);
    }
  }
  return undefined;
}

/** All the text inside an element, in order. */
export function textOf(el: XmlElement): string {
  let out = '';
  for (const child of el.children) out += typeof child === 'string' ? child : textOf(child);
  return out;
}
