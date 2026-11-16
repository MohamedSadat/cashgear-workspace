// What a Notion export ("Markdown & CSV") writes that is Notion's own: an id after every page's,
// folder's and database's name (` 0123456789abcdef0123456789abcdef`, 32 hex, URL-encoded in
// links), a database's CSV twice (`Tasks <id>.csv`, the view, and `Tasks <id>_all.csv`, every
// row), dates as `November 16, 2026 3:04 PM`, related pages as `Name (Path%20<id>.md)`, and each
// row's properties again at the top of its page, under its title.

const NOTION_ID = /^(.*?)\s*([0-9a-f]{32})$/i;

/** A name without Notion's id (`Tasks 0123…` is `Tasks`), and the id. */
export function notionName(base: string): { name: string; id: string | null } {
  const match = NOTION_ID.exec(base);
  if (!match) return { name: base, id: null };
  return { name: match[1].trim(), id: match[2].toLowerCase() };
}

/** Every Notion id a link holds (a path or a notion.so address). */
export function notionIdsIn(href: string): string[] {
  return [...href.matchAll(/(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/gi)].map((m) =>
    m[1].toLowerCase(),
  );
}

/** Whether the files read as a Notion export: most pages and databases carry an id. */
export function looksLikeNotion(paths: readonly string[]): boolean {
  const named = paths.filter((p) => /\.(md|csv)$/i.test(p));
  if (!named.length) return false;
  const withId = named.filter(
    (p) =>
      notionName(
        p
          .split('/')
          .pop()!
          .replace(/(_all)?\.(md|csv)$/i, ''),
      ).id,
  );
  return withId.length * 2 >= named.length;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const DATE = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A Notion date (`November 16, 2026`, with ` 3:04 PM` or ` 15:04`) as the CSV import reads dates:
 * `2026-11-16`, or the instant of that local time on this device (Notion writes the exporter's
 * time zone, which is most often this person's own).
 */
export function notionDate(text: string): string | null {
  const match = DATE.exec(text.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 0 || day < 1 || day > 31) return null;
  if (match[4] === undefined) {
    const check = new Date(Date.UTC(year, month, day));
    if (check.getUTCMonth() !== month) return null;
    return `${year}-${pad(month + 1)}-${pad(day)}`;
  }
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const half = match[6]?.toLowerCase();
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const local = new Date(year, month, day, hour, minute);
  if (local.getMonth() !== month) return null;
  return local.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A link to an imported page in a cell: ` (Path%20<id>.md)` or ` (https://www.notion.so/…)`. */
const CELL_LINK =
  /\s*\((?:[^()]*?[0-9a-f]{32}[^()]*?|https?:\/\/(?:www\.)?notion\.(?:so|site)\/[^()\s]*)\)/gi;

/**
 * A cell of a Notion CSV as the CSV import should read it: links after related pages' names
 * taken off (`Launch (Launch%20<id>.md)` is `Launch`), and dates (and `a → b` spans) in ISO form.
 */
export function cleanNotionCell(text: string): { text: string; links: boolean } {
  let links = false;
  let out = text.replace(CELL_LINK, () => {
    links = true;
    return '';
  });
  const parts = out.split('→').map((part) => part.trim());
  if (parts.length <= 2 && parts[0]) {
    const dates = parts.map(notionDate);
    if (dates.every((d) => d !== null)) out = dates.join(' → ');
  }
  return { text: out, links };
}

/** One related page a cell names: `Name (path/Name <id>.md)` gives both, a plain name its name. */
export interface CellItem {
  name: string;
  /** The link Notion wrote after the name (a path, URL-encoded, or a notion.so address). */
  target: string | null;
}

/**
 * The pages a relation cell names, in order: each `Name (link)`, comma-separated, then any plain
 * names after them (split at commas; a name with a comma in it cannot be told from two).
 */
export function cellItems(raw: string): CellItem[] {
  const items: CellItem[] = [];
  let at = 0;
  for (const match of raw.matchAll(CELL_LINK)) {
    const name = raw
      .slice(at, match.index)
      .replace(/^\s*,\s*/, '')
      .trim();
    const target = match[0].trim().slice(1, -1).trim();
    items.push({ name, target });
    at = match.index + match[0].length;
  }
  for (const part of raw.slice(at).split(','))
    if (part.trim()) items.push({ name: part.trim(), target: null });
  return items;
}

/**
 * The files a files cell names: paths URL-encoded as Notion writes them, separated by `, ` (an
 * encoded path holds no space, so a comma in a name stays in it), else by commas.
 */
export function cellFiles(raw: string): string[] {
  return raw
    .split(/,\s/.test(raw) ? /,\s+/ : ',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/**
 * Columns that name people: Notion exports their names (or addresses), never the workspace's
 * members, so they stay text and are reported. Told by the column's name, as Notion and people
 * name them, in English and Arabic.
 */
const PEOPLE_COLUMNS =
  /^(assignees?|assigned to|owners?|person|people|persons|created by|last edited by|edited by|authors?|reviewers?|responsible|members?|lead|participants?|attendees?|المسؤول|المسؤولون|المالك|الشخص|الأشخاص|المكلف|المكلَّف|أنشأه|المؤلف|المراجع|الأعضاء|المشاركون)$/i;

export const isPeopleColumn = (name: string): boolean => PEOPLE_COLUMNS.test(name.trim());

/**
 * A row page's text without the lines Notion writes its properties as (`Status: Done`) under its
 * title, which the database's CSV holds already: the first lines of the body, up to the first
 * empty line, when each names one of the database's columns.
 */
export function withoutPropertyLines(body: string, columns: ReadonlySet<string>): string {
  const lines = body.split('\n');
  let at = 0;
  while (at < lines.length && !lines[at].trim()) at++;
  let end = at;
  while (end < lines.length && lines[end].trim()) {
    const key = /^([^:]{1,200}):\s?/.exec(lines[end].trim());
    if (!key || !columns.has(key[1].trim().toLowerCase())) return body;
    end++;
  }
  return end > at ? lines.slice(end).join('\n') : body;
}
