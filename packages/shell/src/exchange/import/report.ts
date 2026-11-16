// What an import made and what it skipped, and why (M8.4: every import ends with a report; what
// is not understood is reported, never dropped silently), and why an import was refused.

/** Something not imported, or imported only in part. Each has its text in the catalogues. */
export const SKIP_CODES = [
  // The archive
  'unsafePath',
  'duplicate',
  'unsupportedEntry',
  'nestedArchive',
  'tooDeep',
  'namesCleaned',
  'namesGarbled',
  // Files
  'unknownType',
  'fileTooLarge',
  'imageTooLarge',
  'notImage',
  'notLinked',
  // Links and images
  'brokenLink',
  'missingImage',
  'externalImage',
  // Markdown
  'html',
  'frontMatter',
  'equation',
  // Notion
  'csvTooLarge',
  'underRow',
  'unmatchedRowPage',
  'linksAsText',
  'filesAsText',
  'peopleAsText',
  // Word
  'trackedChanges',
  'comments',
  'footnotes',
  'textBoxes',
  'charts',
  'shapes',
  'embeddedObjects',
  'pageBreaks',
  'nestedTables',
  'linkedImages',
  'headersAndFooters',
] as const;
export type SkipCode = (typeof SKIP_CODES)[number];

export interface SkipEntry {
  code: SkipCode;
  count: number;
  /** A few of the files or names it concerns (at most `EXAMPLES`). */
  examples: string[];
}

export interface ImportMade {
  /** Pages made, the top page included; databases and rows are counted on their own. */
  pages: number;
  databases: number;
  rows: number;
  images: number;
  files: number;
}

export interface ImportReport {
  made: ImportMade;
  skipped: SkipEntry[];
}

/** Why an import made nothing. Each has its text in the catalogues. */
export type RefusalCode =
  | 'tooManyPages'
  | 'tooLarge'
  | 'tooManyFiles'
  | 'zipBomb'
  | 'damaged'
  | 'empty'
  | 'workspaceExport'
  | 'notWord'
  | 'stopped'
  | 'failed';

export class ImportRefused extends Error {
  constructor(
    readonly code: RefusalCode,
    /** A number the text names (pages counted, megabytes). */
    readonly count?: number,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ImportRefused';
  }
}

const EXAMPLES = 5;

export class ReportBuilder {
  readonly made: ImportMade = { pages: 0, databases: 0, rows: 0, images: 0, files: 0 };
  private readonly entries = new Map<SkipCode, SkipEntry>();

  skip(code: SkipCode, example?: string, count = 1) {
    let entry = this.entries.get(code);
    if (!entry) this.entries.set(code, (entry = { code, count: 0, examples: [] }));
    entry.count += count;
    if (example && entry.examples.length < EXAMPLES && !entry.examples.includes(example))
      entry.examples.push(example);
  }

  build(): ImportReport {
    return {
      made: { ...this.made },
      skipped: SKIP_CODES.flatMap((code) => {
        const entry = this.entries.get(code);
        return entry ? [{ ...entry, examples: [...entry.examples] }] : [];
      }),
    };
  }
}
