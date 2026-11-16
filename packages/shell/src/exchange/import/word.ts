// A Word `.docx` as one page (M8.4): the file unzipped with the archive's guards (it is a zip),
// its parts read by `@cgw/doc`'s own reader (`readDocx`, over the XML), its images made assets,
// and what Word has that a page does not counted in the report.
import { DocxError, MAX_ELEMENTS, XmlError, readDocx, type DocxSkip } from '@cgw/doc';
import { uuidv7 } from '@cgw/workspace';
import { readArchive, type ImportFile } from './archive';
import { AssetPlanner } from './assets';
import { ImportRefused, type ReportBuilder, type SkipCode } from './report';
import type { PlannedNode, PlannedTree } from './tree';

const SKIPS: Record<DocxSkip, SkipCode> = {
  trackedChanges: 'trackedChanges',
  comments: 'comments',
  footnotes: 'footnotes',
  textBoxes: 'textBoxes',
  equations: 'equation',
  charts: 'charts',
  shapes: 'shapes',
  embeddedObjects: 'embeddedObjects',
  pageBreaks: 'pageBreaks',
  nestedTables: 'nestedTables',
  linkedImages: 'linkedImages',
  missingImages: 'missingImage',
  headersAndFooters: 'headersAndFooters',
  blocksLeftOut: 'blocksLeftOut',
};

/** An XML part as text: UTF-8 (Word's own), or UTF-16 when it starts with a byte order mark. */
function partText(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder().decode(bytes);
}

export function planWord(
  bytes: Uint8Array,
  name: string,
  options: { untitled: string; report: ReportBuilder },
): PlannedTree {
  const { report } = options;
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new ImportRefused('notWord');
  let files: ImportFile[];
  try {
    files = readArchive(bytes, report);
  } catch (error) {
    if (error instanceof ImportRefused && error.code === 'damaged')
      throw new ImportRefused('notWord');
    throw error;
  }
  const parts = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const part = (path: string) => parts.get(path.toLowerCase())?.bytes;
  const document = partText(part('word/document.xml'));
  if (!document) throw new ImportRefused('notWord');
  const assets = new AssetPlanner(new Map(files.map((f) => [f.path, f.bytes])), report);
  const exact = new Map(files.map((f) => [f.path.toLowerCase(), f.path]));
  let read;
  try {
    read = readDocx(
      {
        document,
        styles: partText(part('word/styles.xml')),
        numbering: partText(part('word/numbering.xml')),
        relationships: partText(part('word/_rels/document.xml.rels')),
        headersAndFooters: files.filter((f) => /^word\/(header|footer)\d*\.xml$/i.test(f.path))
          .length,
      },
      {
        image: (path) => {
          const file = exact.get(path.toLowerCase());
          return file ? assets.image(file) : null;
        },
      },
    );
  } catch (error) {
    // A document that holds more than is read (the security review: parse amplification).
    if (error instanceof DocxError && error.code === 'tooMany')
      throw new ImportRefused('tooComplex', MAX_ELEMENTS);
    if (error instanceof DocxError || error instanceof XmlError) throw new ImportRefused('damaged');
    throw error;
  }
  for (const [skip, count] of Object.entries(read.skipped) as [DocxSkip, number][])
    report.skip(SKIPS[skip], undefined, count);
  const title = read.title || name.replace(/\.docx$/i, '').trim() || options.untitled;
  const top: PlannedNode = {
    id: uuidv7(),
    kind: 'page',
    title,
    icon: null,
    parent: null,
    children: [],
    rows: [],
    content: read.doc,
    sortName: title,
    path: null,
  };
  return { top, assets };
}
