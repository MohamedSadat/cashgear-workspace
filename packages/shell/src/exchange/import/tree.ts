// A Markdown folder or a Notion export as a tree of pages, planned in memory before anything is
// written (M8.4). The tree follows the folders: a folder is the page of the same name beside it
// (`Notes.md` and `Notes/`, as Notion and Obsidian write them) or inside it (`Notes/Notes.md`,
// as this app's export writes, or `Notes/index.md`), else a page made for it that lists its
// pages. A Notion database is its CSV (`Tasks <id>_all.csv`, else `Tasks <id>.csv`): its
// properties inferred as the CSV import infers them, its rows from the CSV's lines, each row's
// page (`Tasks <id>/<row> <id>.md`) its body. Notion's ids are taken off every name. Links
// between the files become page links (a mention when the text is the page's title, a child
// page or an inline database when the link is alone on a line), links to other files
// attachments, images assets; what cannot be read is reported.
import {
  MAX_PAGE_BLOCKS,
  newBlockId,
  parseMarkdown,
  type DocJSON,
  type LinkAnswer,
  type MarkdownInOptions,
  type MarkdownNote,
} from '@cgw/doc';
import {
  RELATION_LIMIT,
  TITLE_PROPERTY,
  convertProperty,
  inferProperties,
  isEmptyValue,
  parseCsv,
  textToValue,
  uuidv7,
  type Id,
  type PropertyDef,
  type PropertyId,
  type Value,
} from '@cgw/workspace';
import { cleanName, type ImportFile } from './archive';
import { AssetPlanner } from './assets';
import { IMPORT_MAX_CSV_BYTES, IMPORT_MAX_PAGE_DEPTH, IMPORT_MAX_PAGES } from './limits';
import {
  cellFiles,
  cellItems,
  cleanNotionCell,
  isPeopleColumn,
  notionIdsIn,
  notionName,
  withoutPropertyLines,
} from './notion';
import { ImportRefused, type ReportBuilder, type SkipCode } from './report';

export interface PlannedNode {
  id: Id;
  kind: 'page' | 'database' | 'row';
  title: string;
  icon: string | null;
  parent: PlannedNode | null;
  /** Pages and databases under it, in order. */
  children: PlannedNode[];
  /** A database's rows, in order. */
  rows: PlannedNode[];
  /** Its document; null for a database, and for a row with no page of its own. */
  content: DocJSON | null;
  /** A database's properties. */
  properties?: PropertyDef[];
  /** A row's values. */
  values?: Record<PropertyId, Value>;
  /** A row's relations: the related rows' ids by property, set once every row exists. */
  relations?: Record<PropertyId, Id[]>;
  /** What it sorts by among its siblings when its parent does not link them in order. */
  sortName: string;
  /** Its Markdown file (a database: its CSV), if it has one. */
  path: string | null;
}

export interface PlannedTree {
  top: PlannedNode;
  assets: AssetPlanner;
}

export interface TreeOptions {
  /** Read Notion's ids, databases, dates and row properties. */
  notion: boolean;
  /** The name of what was imported (a zip's, a folder's), for a top page made to hold several. */
  name: string;
  untitled: string;
  report: ReportBuilder;
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const fileOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const stemOf = (name: string) => name.replace(/\.[^./]*$/, '');
const isPage = (path: string) => /\.(md|markdown)$/i.test(path);
const isCsv = (path: string) => /\.csv$/i.test(path);
const csvKey = (path: string) => path.replace(/(_all)?\.csv$/i, '').toLowerCase();
const lower = (text: string) => text.toLowerCase();
const fold = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const hasScheme = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);
/** The folder a Notion export may wrap everything in. */
const NOTION_EXPORT = /^(Export|ExportBlock)-[0-9a-f-]{32,36}(-Part-\d+)?$/i;

/** A path relative to a folder, `..` and `.` resolved; null when it leaves the import. */
export function joinPath(dir: string, relative: string): string | null {
  const parts = relative.startsWith('/') ? [] : dir ? dir.split('/') : [];
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

const unescapeMarkdown = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** A page's `# Title` (its first line), with an emoji before it as its icon, and the rest. */
export function splitTitle(
  text: string,
  fileTitle: string,
): { title: string | null; icon: string | null; body: string } {
  const lines = text.split('\n');
  let at = 0;
  while (at < lines.length && !lines[at].trim()) at++;
  // Front matter first (`---` … `---`): the title is the heading after it; it stays in the body,
  // where the Markdown reader takes it out (and says so).
  if (at === 0 && lines[0]?.trim() === '---') {
    const end = lines.findIndex(
      (l, j) => j > 0 && j < 200 && (l.trim() === '---' || l.trim() === '...'),
    );
    if (end > 0) {
      at = end + 1;
      while (at < lines.length && !lines[at].trim()) at++;
    }
  }
  const heading = /^#\s+(.*?)\s*#*$/.exec(lines[at]?.trim() ?? '');
  if (!heading) return { title: null, icon: null, body: text };
  let title = heading[1].trim();
  let icon: string | null = null;
  // This app's export writes `# 📄 Title`: the emoji is the icon when the rest is the file's name.
  const emoji = /^(\p{Extended_Pictographic}\S*)\s+(.+)$/u.exec(title);
  if (emoji && fold(emoji[2]) === fold(fileTitle)) {
    icon = emoji[1];
    title = emoji[2];
  }
  const body = [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n');
  return { title: unescapeMarkdown(title), icon, body };
}

function newNode(
  kind: PlannedNode['kind'],
  title: string,
  parent: PlannedNode | null,
  path: string | null,
): PlannedNode {
  return {
    id: uuidv7(),
    kind,
    title,
    icon: null,
    parent,
    children: [],
    rows: [],
    content: null,
    sortName: title,
    path,
  };
}

const NOTE_CODES: Record<MarkdownNote, SkipCode> = {
  html: 'html',
  frontMatter: 'frontMatter',
  equation: 'equation',
  externalImage: 'externalImage',
  missingImage: 'missingImage',
  tooDeep: 'tooDeep',
  tooManyBlocks: 'blocksLeftOut',
};

const decoder = new TextDecoder();

/** Pages, databases and rows of a tree. */
export function countPages(n: PlannedNode): number {
  let count = 1 + n.rows.length;
  for (const child of n.children) count += countPages(child);
  return count;
}

/** The files of a Markdown folder or a Notion export as a tree of pages, every page parsed. */
export function planTree(files: readonly ImportFile[], options: TreeOptions): PlannedTree {
  const { notion, report } = options;
  const bytes = new Map(files.map((f) => [f.path, f.bytes]));
  const exact = new Map(files.map((f) => [lower(f.path), f.path]));
  const find = (path: string) => exact.get(lower(path));
  // This app's own export is read by "Import an export", which keeps every id and record.
  if (files.some((f) => /^([^/]+\/)?cgw-export\.json$/i.test(f.path)))
    throw new ImportRefused('workspaceExport');
  const assets = new AssetPlanner(bytes, report);

  // Names: Notion's ids taken off, control characters out (said once per name).
  const names = new Map<string, { title: string; notionId: string | null }>();
  const named = (base: string) => {
    const known = names.get(base);
    if (known) return known;
    const { name, id } = notion ? notionName(base) : { name: base, id: null };
    const clean = cleanName(name);
    if (clean.cleaned) report.skip('namesCleaned', clean.name);
    const made = {
      title: NOTION_EXPORT.test(clean.name) ? options.name : clean.name,
      notionId: id,
    };
    names.set(base, made);
    return made;
  };

  // Databases (Notion): one per CSV, the `_all` one when both are there.
  const csvs = new Map<string, string>();
  const tooLarge = new Set<string>();
  if (notion)
    for (const f of files) {
      if (!isCsv(f.path)) continue;
      if (f.bytes.length > IMPORT_MAX_CSV_BYTES) {
        report.skip('csvTooLarge', f.path);
        tooLarge.add(f.path);
        continue;
      }
      const key = csvKey(f.path);
      if (/_all\.csv$/i.test(f.path) || !csvs.has(key)) csvs.set(key, f.path);
    }

  const pages = files.map((f) => f.path).filter(isPage);
  if (!pages.length && !csvs.size) throw new ImportRefused('empty');
  const pageSet = new Set(pages.map(lower));
  // Each page's text, read once: its title first, then its body.
  const texts = new Map<string, { title: string | null; icon: string | null; body: string }>();
  for (const path of pages) {
    const raw = decoder.decode(bytes.get(path)!).replace(/\r\n?/g, '\n');
    texts.set(path, splitTitle(raw, named(stemOf(fileOf(path))).title));
  }

  const byNotionId = new Map<string, PlannedNode>();
  const byPath = new Map<string, PlannedNode>();
  const nodes: PlannedNode[] = [];
  const top = newNode('page', '', null, null);
  const node = (
    kind: PlannedNode['kind'],
    title: string,
    parent: PlannedNode,
    path: string | null,
    notionId: string | null,
  ) => {
    const made = newNode(kind, title || options.untitled, parent, path);
    if (notionId && !byNotionId.has(notionId)) byNotionId.set(notionId, made);
    if (path) byPath.set(lower(path), made);
    const text = path ? texts.get(path) : undefined;
    if (text?.title) made.title = made.sortName = text.title;
    if (text?.icon) made.icon = text.icon;
    nodes.push(made);
    return made;
  };

  /** The Markdown file that is a folder's page, if one is: beside it, else inside it. */
  const folderPage = (dir: string): string | null => {
    const base = fileOf(dir);
    for (const candidate of [
      `${dir}.md`,
      `${dir}.markdown`,
      `${dir}/${base}.md`,
      `${dir}/index.md`,
    ])
      if (pageSet.has(lower(candidate))) return find(candidate)!;
    return null;
  };
  const owners = new Map<string, PlannedNode>();
  const mdNodes = new Map<string, PlannedNode>();
  /** The page (or database) a folder's files go under. */
  const ownerOf = (dir: string): PlannedNode => {
    if (dir === '') return top;
    const known = owners.get(lower(dir));
    if (known) return known;
    let made: PlannedNode;
    const csv = csvs.get(lower(dir));
    const page = folderPage(dir);
    if (csv) {
      const { title, notionId } = named(stemOf(fileOf(csv)).replace(/_all$/i, ''));
      made = node('database', title, ownerOf(dirOf(dir)), csv, notionId);
      byPath.set(lower(`${dir}.csv`), made);
      byPath.set(lower(`${dir}_all.csv`), made);
    } else if (page && dirOf(page) === dirOf(dir)) made = mdNode(page);
    else if (page) {
      const { title, notionId } = named(fileOf(dir));
      made = node('page', title, ownerOf(dirOf(dir)), page, notionId);
      mdNodes.set(lower(page), made);
    } else {
      const { title, notionId } = named(fileOf(dir));
      made = node('page', title, ownerOf(dirOf(dir)), null, notionId);
    }
    owners.set(lower(dir), made);
    return made;
  };
  /** A Markdown file's page (a row, in a database's folder). */
  const mdNode = (path: string): PlannedNode => {
    const known = mdNodes.get(lower(path));
    if (known) return known;
    const dir = dirOf(path);
    // The page inside its folder (`Notes/Notes.md`) is the folder's.
    if (dir && folderPage(dir) === path) return ownerOf(dir);
    const parent = ownerOf(dir);
    const { title, notionId } = named(stemOf(fileOf(path)));
    const made = node(parent.kind === 'database' ? 'row' : 'page', title, parent, path, notionId);
    mdNodes.set(lower(path), made);
    return made;
  };
  for (const path of pages) mdNode(path);
  for (const path of csvs.values()) ownerOf(path.replace(/(_all)?\.csv$/i, ''));

  // The tree: pages and databases under their parent, which must be a page (under a row they go
  // beside its database); rows into their database, matched with its CSV's lines below.
  for (const n of nodes) {
    if (n.kind === 'row') continue;
    let parent = n.parent!;
    if (parent.kind !== 'page') {
      while (parent.kind !== 'page') parent = parent.parent!;
      report.skip('underRow', n.title);
    }
    n.parent = parent;
    parent.children.push(n);
  }
  // Each database's CSV: its cells as written, line by line with its rows, for the relations.
  const sheets = new Map<PlannedNode, string[][]>();
  for (const database of nodes.filter((n) => n.kind === 'database')) {
    const rowPages = nodes.filter((n) => n.kind === 'row' && n.parent === database);
    const csv = decoder.decode(bytes.get(database.path!)!);
    sheets.set(database, readDatabase(database, csv, rowPages, report));
  }

  // Pages nest at most so deep: deeper ones go at the deepest level.
  const place = (n: PlannedNode, depth: number) => {
    for (const child of [...n.children]) {
      if (depth >= IMPORT_MAX_PAGE_DEPTH && n.parent) {
        n.children.splice(n.children.indexOf(child), 1);
        n.parent.children.push(child);
        child.parent = n.parent;
        report.skip('tooDeep', child.title);
        place(child, depth);
      } else place(child, depth + 1);
    }
  };
  place(top, 1);

  // One page at the top holds the import: the only page there, else one made for it.
  let root = top;
  if (top.children.length === 1 && top.children[0].kind === 'page') {
    root = top.children[0];
    root.parent = null;
  } else top.title = top.sortName = named(options.name).title || options.untitled;

  const count = countPages(root);
  if (count > IMPORT_MAX_PAGES) throw new ImportRefused('tooManyPages', count);

  // Every page's and row's body, parsed, its links resolved.
  const linkOrder = new Map<PlannedNode, PlannedNode[]>();
  const childLinked = new Set<PlannedNode>();
  const titled = new Map<string, PlannedNode>();
  for (const n of nodes) {
    if (n.kind === 'database') continue;
    if (!titled.has(fold(n.title))) titled.set(fold(n.title), n);
    if (n.path) {
      const stem = fold(named(stemOf(fileOf(n.path))).title);
      if (!titled.has(stem)) titled.set(stem, n);
    }
  }
  const byFile = (path: string): PlannedNode | undefined => {
    const file = find(path);
    if (file) return byPath.get(lower(file)) ?? mdNodes.get(lower(file));
    return owners.get(lower(path)) ?? byPath.get(lower(path));
  };
  linkColumns(sheets, { byFile, byNotionId, find, assets, report });
  const parseBody = (n: PlannedNode, text: string) => {
    const fromDir = dirOf(n.path!);
    const order: PlannedNode[] = [];
    linkOrder.set(n, order);
    const imageSeen = new Set<string>();
    const answer = (target: PlannedNode, text: string, alone: boolean): LinkAnswer => {
      order.push(target);
      const parentOf = target.kind === 'row' ? null : target.parent;
      if (alone && parentOf === n && target.kind === 'database') return { databaseView: target.id };
      if (alone && parentOf === n && target.kind === 'page' && !childLinked.has(target)) {
        childLinked.add(target);
        return { childPage: target.id };
      }
      const label = fold(unescapeMarkdown(text));
      const stem = target.path ? fold(named(stemOf(fileOf(target.path))).title) : '';
      if (!label || label === fold(target.title) || label === stem) return { mention: target.id };
      return { page: target.id };
    };
    const linkOptions: MarkdownInOptions = {
      wikiLinks: !notion,
      maxBlocks: MAX_PAGE_BLOCKS,
      link: (href, text, alone) => {
        if (href.startsWith('[[')) {
          const target = titled.get(fold(href.slice(2, -2).split('#')[0]));
          if (target) return answer(target, text, alone);
          report.skip('brokenLink', href.slice(2, -2));
          return null;
        }
        if (hasScheme(href)) {
          // A link to a page of the export by its Notion address.
          if (notion && /notion\.(so|site)\//i.test(href)) {
            // The page's id is the last in the address's path (one after `#` names a block).
            const id = notionIdsIn(href.replace(/[?#].*$/, '')).at(-1);
            const target = id ? byNotionId.get(id) : undefined;
            if (target) return answer(target, text, alone);
          }
          return { href };
        }
        // An anchor in this page: its text (block ids are not known before they are made).
        if (href.startsWith('#')) return null;
        const relative = href.replace(/[?#].*$/, '');
        const path = relative ? joinPath(fromDir, relative) : null;
        if (path === null) {
          report.skip('brokenLink', href);
          return null;
        }
        const target = byFile(path) ?? byFile(path.replace(/\/$/, ''));
        if (target) return answer(target, text, alone);
        // A page moved between the export's parts keeps its id: the file's own (the last one in
        // the path; the folders' ids are its parents').
        const id = notion ? notionIdsIn(fileOf(path)).at(-1) : undefined;
        const found = id ? byNotionId.get(id) : undefined;
        if (found) return answer(found, text, alone);
        const file = find(path);
        if (file) {
          const assetId = assets.file(file);
          return assetId ? { file: assetId } : null;
        }
        report.skip('brokenLink', path);
        return null;
      },
      image: (src) => {
        if (hasScheme(src)) return null;
        const path = joinPath(fromDir, src.replace(/[?#].*$/, ''));
        const file = path === null ? undefined : find(path);
        if (!file) return null;
        // A file that is there but cannot be an image was reported as such, not as missing.
        imageSeen.add(src);
        return assets.image(file);
      },
      note: (what, detail) => {
        if (what === 'missingImage' && detail && imageSeen.has(detail)) return;
        report.skip(NOTE_CODES[what], what === 'tooManyBlocks' ? n.title : detail);
      },
    };
    n.content = parseMarkdown(text, linkOptions);
  };

  for (const n of nodes) {
    if (n.kind === 'database' || !n.path) continue;
    assets.used.add(n.path);
    const { body } = texts.get(n.path)!;
    const columns =
      n.kind === 'row' ? new Set(n.parent!.properties!.map((p) => lower(p.name))) : null;
    parseBody(n, columns ? withoutPropertyLines(body, columns) : body);
  }
  // A database's CSVs are its own; what no page links is said.
  for (const f of files)
    if (tooLarge.has(f.path) || (notion && isCsv(f.path) && csvs.has(csvKey(f.path))))
      assets.used.add(f.path);
  for (const f of files) if (!assets.used.has(f.path)) report.skip('notLinked', f.path);

  // Siblings in the order their parent links them, then by name.
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sort = (n: PlannedNode) => {
    const order = linkOrder.get(n) ?? [];
    const rank = (c: PlannedNode) => {
      const at = order.indexOf(c);
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    n.children.sort((a, b) => rank(a) - rank(b) || collator.compare(a.sortName, b.sortName));
    n.children.forEach(sort);
  };
  sort(root);

  // A page made for a folder, or to hold the import, lists what is under it.
  const listing = (n: PlannedNode) => {
    if (n.kind === 'page' && !n.path && !n.content)
      n.content = {
        type: 'doc',
        content: n.children.map((child) => ({
          type: 'block',
          attrs: { id: newBlockId() },
          content: [
            child.kind === 'database'
              ? { type: 'databaseView', attrs: { databaseId: child.id, viewId: null } }
              : { type: 'childPage', attrs: { pageId: child.id } },
          ],
        })),
      };
    n.children.forEach(listing);
  };
  listing(root);
  return { top: root, assets };
}

const TEXT: PropertyDef = { id: '', name: '', type: 'text' };
const OPTION_TYPES = new Set<PropertyDef['type']>(['select', 'multiSelect', 'status']);

/**
 * A database from its CSV, as the CSV import makes a new one (`inferProperties`, then each cell
 * read as its property reads text), with Notion's cells cleaned first; its rows are the CSV's
 * lines, each with the page of the same title in its folder as its body. A page with no line is
 * a row too, with its title only. Returns the lines' cells as written (`linkColumns` reads them),
 * in the order of the database's first rows.
 */
function readDatabase(
  database: PlannedNode,
  csv: string,
  rowPages: PlannedNode[],
  report: ReportBuilder,
): string[][] {
  const parsed = parseCsv(csv);
  const header = parsed[0] ?? [];
  const lines = parsed.slice(1).filter((r) => r.some((c) => c.trim()));
  const records = lines.map((r) => r.map((cell) => cleanNotionCell(cell).text));
  let properties = inferProperties(header, records, { databaseId: database.id });
  const rows = records.map(() => ({ title: '', values: {} as Record<PropertyId, Value> }));
  for (const [col, def] of properties.entries()) {
    const texts = records.map((r) => (r[col] ?? '').trim());
    if (def.id === TITLE_PROPERTY) {
      texts.forEach((text, i) => (rows[i].title = text.replace(/[\r\n]+/g, ' ')));
      continue;
    }
    let values: (Value | undefined)[];
    if (OPTION_TYPES.has(def.type)) {
      const converted = convertProperty(
        TEXT,
        def,
        texts.map((t) => t || undefined),
        database.id,
      );
      properties = properties.map((p) => (p.id === def.id ? converted.def : p));
      values = converted.values;
    } else values = texts.map((text) => (text ? textToValue(def, text) : undefined));
    values.forEach((value, i) => {
      if (def.type === 'checkbox') {
        if (value === true) rows[i].values[def.id] = true;
      } else if (value !== undefined && !isEmptyValue(value)) rows[i].values[def.id] = value;
    });
  }
  database.properties = properties;
  // Row pages by title; each line takes the first page of its title not yet taken.
  const pagesByTitle = new Map<string, PlannedNode[]>();
  for (const page of rowPages) {
    const key = fold(page.title);
    pagesByTitle.set(key, [...(pagesByTitle.get(key) ?? []), page]);
  }
  const taken = new Set<PlannedNode>();
  database.rows = rows.map((row) => {
    const page = pagesByTitle.get(fold(row.title))?.find((p) => !taken.has(p));
    const made = page ?? newNode('row', row.title, database, null);
    if (page) taken.add(page);
    made.title = made.sortName = row.title;
    made.values = row.values;
    made.parent = database;
    return made;
  });
  for (const page of rowPages)
    if (!taken.has(page)) {
      report.skip('unmatchedRowPage', page.title);
      page.values = {};
      database.rows.push(page);
    }
  return lines;
}

interface LinkContext {
  byFile(path: string): PlannedNode | undefined;
  byNotionId: ReadonlyMap<string, PlannedNode>;
  find(path: string): string | undefined;
  assets: AssetPlanner;
  report: ReportBuilder;
}

/** A Notion relation column made a relation property: its rows' related rows. */
interface RelationColumn {
  database: PlannedNode;
  def: PropertyDef;
  target: PlannedNode;
  related: Map<PlannedNode, PlannedNode[]>;
  /** The back column of the other database this one pairs with (Notion's two-way relation). */
  pair: RelationColumn | null;
}

const decodeSafe = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * Notion's relation and files columns, once every database's rows are known (Phase 8 follow-up).
 * A column whose cells name rows of one database of the export, by link (`Name (path.md)`, or a
 * notion.so address) or by plain names, becomes a relation to it; two that name each other's rows
 * consistently are paired as two-way relations are (`relation.reversePropertyId` both ways; one
 * side's values written, the other side follows them as the planner keeps reverse relations). A
 * column naming pages that are not rows of the export stays text (`linksAsText`). A column whose
 * cells name files of the export becomes a files property of their assets; naming files that are
 * not there, it stays text (`filesAsText`). People columns stay text (`peopleAsText`): an export
 * holds names, not members.
 */
function linkColumns(sheets: Map<PlannedNode, string[][]>, ctx: LinkContext) {
  const { report, assets } = ctx;
  const titles = new Map<PlannedNode, Map<string, PlannedNode>>();
  for (const database of sheets.keys()) {
    const byTitle = new Map<string, PlannedNode>();
    for (const row of database.rows)
      if (!byTitle.has(fold(row.title))) byTitle.set(fold(row.title), row);
    titles.set(database, byTitle);
  }
  const resolveLink = (target: string, dir: string): PlannedNode | null => {
    if (hasScheme(target)) {
      const id = notionIdsIn(target.replace(/[?#].*$/, '')).at(-1);
      return (id && ctx.byNotionId.get(id)) || null;
    }
    const decoded = decodeSafe(target).replace(/[?#].*$/, '');
    const path = joinPath(dir, decoded);
    const found = path === null ? undefined : ctx.byFile(path);
    if (found) return found;
    const id = notionIdsIn(fileOf(decoded)).at(-1);
    return (id && ctx.byNotionId.get(id)) || null;
  };

  /** The rows a column's cells name, if all are rows of one database; 'text' if a link is not. */
  const relationOf = (
    def: PropertyDef,
    cells: string[],
    dir: string,
  ): { target: PlannedNode; related: PlannedNode[][] } | 'text' | null => {
    const items = cells.map((cell) => (cell ? cellItems(cell) : []));
    if (items.some((list) => list.some((item) => item.target))) {
      let target: PlannedNode | null = null;
      const linked = items.map((list) =>
        list.map((item) => (item.target ? resolveLink(item.target, dir) : null)),
      );
      for (const [l, list] of items.entries())
        for (const [i, item] of list.entries()) {
          if (!item.target) continue;
          const row = linked[l][i];
          if (!row || row.kind !== 'row' || (target && row.parent !== target)) return 'text';
          target = row.parent;
        }
      const byTitle = titles.get(target!)!;
      const related = items.map((list, l) =>
        list.map((item, i) => linked[l][i] ?? byTitle.get(fold(item.name)) ?? null),
      );
      return related.every((list) => list.every(Boolean))
        ? { target: target!, related: related as PlannedNode[][] }
        : 'text';
    }
    // Plain names: a relation only when every name is a row's title in exactly one database.
    if (def.type !== 'text' && def.type !== 'select') return null;
    const names = items.flat();
    if (!names.length) return null;
    const candidates = [...titles].filter(([, byTitle]) =>
      names.every((item) => byTitle.has(fold(item.name))),
    );
    if (candidates.length !== 1) return null;
    const [target, byTitle] = candidates[0];
    return {
      target,
      related: items.map((list) => list.map((item) => byTitle.get(fold(item.name))!)),
    };
  };

  /** The files a column's cells name, if all are files of the export; 'text' if not. */
  const filesOf = (cells: string[], bases: string[]): string[][] | 'text' | null => {
    const lists = cells.map((cell) => (cell ? cellFiles(cell) : []));
    const parts = lists.flat();
    if (!parts.length || !parts.every((part) => /\.[a-z][a-z0-9]{0,7}$/i.test(part))) return null;
    const resolve = (part: string) => {
      for (const base of bases) {
        const path = joinPath(base, part);
        const file = path === null ? undefined : ctx.find(path);
        if (file && !isPage(file) && !isCsv(file) && assets.canKeep(file)) return file;
      }
      return null;
    };
    const files = lists.map((list) => list.map(resolve));
    if (files.every((list) => list.every(Boolean))) return files as string[][];
    // Names of files that are not all here: said when they read as paths, or some are here.
    return parts.some((part) => part.includes('/')) || files.flat().some(Boolean) ? 'text' : null;
  };

  const columns: RelationColumn[] = [];
  for (const [database, lines] of sheets) {
    const dir = dirOf(database.path!);
    const folder = database.path!.replace(/(_all)?\.csv$/i, '');
    const rows = database.rows.slice(0, lines.length);
    const properties = database.properties!;
    for (const [col, def] of properties.entries()) {
      if (def.id === TITLE_PROPERTY) continue;
      const cells = lines.map((line) => (line[col] ?? '').trim());
      if (!cells.some(Boolean)) continue;
      const where = `${database.title}: ${def.name}`;
      if (isPeopleColumn(def.name)) {
        report.skip('peopleAsText', where);
        continue;
      }
      const relation = relationOf(def, cells, dir);
      if (relation === 'text') {
        report.skip('linksAsText', where);
        continue;
      }
      if (relation) {
        const made: PropertyDef = {
          id: def.id,
          name: def.name,
          type: 'relation',
          relation: { databaseId: relation.target.id, reversePropertyId: null },
        };
        properties[col] = made;
        const related = new Map<PlannedNode, PlannedNode[]>();
        rows.forEach((row, i) => {
          delete row.values?.[def.id];
          if (relation.related[i].length) related.set(row, [...new Set(relation.related[i])]);
        });
        columns.push({ database, def: made, target: relation.target, related, pair: null });
        continue;
      }
      if (def.type !== 'text') continue;
      const files = filesOf(cells, [dir, folder, '']);
      if (files === 'text') report.skip('filesAsText', where);
      else if (files) {
        properties[col] = { id: def.id, name: def.name, type: 'files' };
        rows.forEach((row, i) => {
          const ids = [...new Set(files[i].map((path) => assets.file(path)))].filter(
            (id): id is Id => !!id,
          );
          if (ids.length) row.values![def.id] = ids;
          else delete row.values?.[def.id];
        });
      }
    }
  }

  // Two columns that name each other's rows, every pair both ways, are one two-way relation.
  const named = (column: RelationColumn, row: PlannedNode) => column.related.get(row) ?? [];
  const consistent = (a: RelationColumn, b: RelationColumn) =>
    [...a.related].every(([row, list]) => list.every((other) => named(b, other).includes(row))) &&
    [...b.related].every(([row, list]) => list.every((other) => named(a, other).includes(row)));
  for (const column of columns) {
    if (column.pair) continue;
    const back = columns.find(
      (other) =>
        other !== column &&
        !other.pair &&
        other.database === column.target &&
        other.target === column.database &&
        consistent(column, other),
    );
    if (back) {
      column.pair = back;
      back.pair = column;
    }
  }
  for (const [index, column] of columns.entries()) {
    column.def.relation = {
      databaseId: column.target.id,
      reversePropertyId: column.pair?.def.id ?? null,
    };
    // Of a pair, the first column's values are written; the planner keeps the back one in step.
    if (column.pair && columns.indexOf(column.pair) < index) continue;
    for (const [row, related] of column.related)
      (row.relations ??= {})[column.def.id] = related.slice(0, RELATION_LIMIT).map((r) => r.id);
  }
}
