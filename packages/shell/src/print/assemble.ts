// After 0.19.0: the part of a page out that runs in its worker (`out.worker.ts`), pure, no DOM. Each
// page's content is read there from its stored log (`readContent`) and walked for what the main
// thread must resolve (the files its pictures show, the pages it names, people, the blocks that are
// not text); the main thread sends back what it found, and the content is put back into the input
// the writers read. So a large page is never replayed, turned to JSON or walked on the main thread,
// nor copied to the worker (ARCHITECTURE.md, "Word, PDF and print").
import type { DocJSON } from '@cgw/doc';
import {
  printView,
  readContent,
  writeDocx,
  type OutInput,
  type OutPage,
  type PrintMode,
  type PrintView,
} from '@cgw/doc/out';
import type { Id, StoredDoc } from '@cgw/workspace';
import { strToU8, zipSync, type Zippable } from 'fflate';

/** A page to read: its stored log, or a database page (its view, as one database block). */
export type ReadPage = { id: Id; log: StoredDoc } | { id: Id; database: true };

/** The kinds of block the main thread makes the out of (a database's rows, a picture, a line). */
export type ShellBlockType = 'databaseView' | 'sheetEmbed' | 'erpView' | 'pluginBlock';

/** What a page shows that only the main thread can read, in the document's order. */
export interface PageNeeds {
  /** Files the page's pictures (`image`) and file blocks show, by asset id. */
  assets: { id: Id; image: boolean }[];
  /** Pages a mention, a child page or a link into the app names. */
  pages: Id[];
  people: Id[];
  /** Blocks that are not text, by the id of the block they are in. */
  blocks: { blockId: string; type: ShellBlockType; attrs: Record<string, unknown> }[];
}

export interface PageRead {
  id: Id;
  needs: PageNeeds;
  /** Updates of its log that did not apply (their local sequences), for the store's quarantine. */
  bad: number[];
}

/** The input with every page's content left out: the worker puts it back (`withContents`). */
export type OutShell = Omit<OutInput, 'pages'> & { pages: Omit<OutPage, 'content'>[] };

/**
 * What the main thread asks of the worker: read the pages, then make the file or the view; or
 * forget the pages it read (a page out stopped between the two), which has no answer.
 */
export type OutRequest =
  | { type: 'read'; pages: ReadPage[] }
  | { type: 'make'; purpose: 'word'; input: OutShell }
  | { type: 'make'; purpose: 'print'; mode: PrintMode; input: OutShell }
  | { type: 'forget' };

export type OutAnswer =
  | { type: 'read'; reads: PageRead[] }
  | { type: 'word'; bytes: Uint8Array }
  | { type: 'print'; view: PrintView }
  | { type: 'error'; error: string };

const SHELL_BLOCKS = new Set<string>(['databaseView', 'sheetEmbed', 'erpView', 'pluginBlock']);

/** A database page's content: its view as one database block, as the page shows it. */
export function databaseContent(id: Id): DocJSON {
  return {
    type: 'doc',
    content: [
      {
        type: 'block',
        attrs: { id: `db-${id}` },
        content: [{ type: 'databaseView', attrs: { databaseId: id, viewId: null } }],
      },
    ],
  };
}

/** Every node of a document, depth first, with the block it is in. */
function nodes(doc: DocJSON, visit: (node: DocJSON, block: DocJSON | null) => void) {
  const walk = (node: DocJSON, block: DocJSON | null) => {
    visit(node, block);
    for (const child of node.content ?? []) walk(child, node.type === 'block' ? node : block);
  };
  walk(doc, null);
}

/** What the main thread must resolve for a page's content. */
export function needsOf(content: DocJSON): PageNeeds {
  const needs: PageNeeds = { assets: [], pages: [], people: [], blocks: [] };
  const assets = new Set<Id>();
  nodes(content, (node, block) => {
    const attrs = node.attrs ?? {};
    const blockId = typeof block?.attrs?.id === 'string' ? block.attrs.id : null;
    switch (node.type) {
      case 'image':
      case 'file': {
        const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : null;
        if (assetId && !assets.has(assetId)) {
          assets.add(assetId);
          needs.assets.push({ id: assetId, image: node.type === 'image' });
        }
        break;
      }
      case 'pageMention':
      case 'childPage':
        if (typeof attrs.pageId === 'string') needs.pages.push(attrs.pageId);
        break;
      case 'userMention':
        if (typeof attrs.userId === 'string') needs.people.push(attrs.userId);
        break;
      case 'text':
        for (const mark of node.marks ?? []) {
          const href = mark.type === 'link' ? String(mark.attrs?.href ?? '') : '';
          const linked = /^#\/p\/([0-9a-f-]{36})/i.exec(href);
          if (linked) needs.pages.push(linked[1].toLowerCase());
        }
        break;
      default:
        if (blockId && SHELL_BLOCKS.has(node.type))
          needs.blocks.push({ blockId, type: node.type as ShellBlockType, attrs });
    }
  });
  return needs;
}

/** Reads each page (its log replayed, or a database page's block) and says what it needs. */
export function readPages(pages: ReadPage[]): { contents: Map<Id, DocJSON>; reads: PageRead[] } {
  const contents = new Map<Id, DocJSON>();
  const reads: PageRead[] = [];
  for (const page of pages) {
    const { content, bad } =
      'log' in page ? readContent(page.log) : { content: databaseContent(page.id), bad: [] };
    contents.set(page.id, content);
    reads.push({ id: page.id, needs: needsOf(content), bad });
  }
  return { contents, reads };
}

/** The writers' input: the shell's, each page's content put back. */
export function withContents(shell: OutShell, contents: Map<Id, DocJSON>): OutInput {
  return {
    ...shell,
    pages: shell.pages.map((page) => ({
      ...page,
      content: contents.get(page.id) ?? { type: 'doc', content: [] },
    })),
  };
}

/** The Word file: `writeDocx`'s parts zipped, `[Content_Types].xml` first, as Word writes it. */
export function wordFile(input: OutInput): Uint8Array {
  const files: Zippable = {};
  for (const part of writeDocx(input)) {
    const data = typeof part.data === 'string' ? strToU8(part.data) : part.data;
    // XML compresses; pictures are compressed already.
    files[part.path] = [data, { level: part.path.startsWith('word/media/') ? 0 : 6 }];
  }
  const ordered: Zippable = { '[Content_Types].xml': files['[Content_Types].xml'] };
  for (const [path, entry] of Object.entries(files)) if (!(path in ordered)) ordered[path] = entry;
  const made = new Date(input.madeAt);
  return zipSync(ordered, { mtime: Number.isNaN(made.getTime()) ? new Date() : made });
}

/**
 * The worker's work, with the pages it read kept between `read` and `make` and let go after:
 * `out.worker.ts` runs one, kept for the next page out; a test runs one on its own thread. Each
 * answer comes with what it may transfer; `forget` has none.
 */
export function outWork(): (
  request: OutRequest,
) => { answer: OutAnswer; transfer: Transferable[] } | null {
  let contents = new Map<Id, DocJSON>();
  return (request) => {
    if (request.type === 'forget') {
      contents = new Map();
      return null;
    }
    try {
      if (request.type === 'read') {
        const read = readPages(request.pages);
        contents = read.contents;
        return { answer: { type: 'read', reads: read.reads }, transfer: [] };
      }
      const input = withContents(request.input, contents);
      contents = new Map();
      if (request.purpose === 'word') {
        const bytes = wordFile(input);
        return { answer: { type: 'word', bytes }, transfer: [bytes.buffer] };
      }
      return { answer: { type: 'print', view: printView(input, request.mode) }, transfer: [] };
    } catch (error) {
      return { answer: { type: 'error', error: String(error) }, transfer: [] };
    }
  };
}
