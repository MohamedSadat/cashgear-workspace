// Writes the import fixtures (packages/shell/src/exchange/fixtures/fixtures.ts) to a folder, to try
// an import by hand or to read what a test reads:
//   node tests/fixtures/import/make.mjs [folder]      (default target/import-fixtures)
// Node runs the fixtures' TypeScript as it is. Nothing here is downloaded.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  declaredHuge,
  hugeImage,
  largeNotionExport,
  manyPages,
  markdownFolder,
  nestedZips,
  notionExport,
  relatedNotionExport,
  traversalZip,
  unflaggedNames,
  wordDocument,
  wordWithDoctype,
  zipBomb,
} from '../../../packages/shell/src/exchange/fixtures/fixtures.ts';

const out = resolve(process.argv[2] ?? 'target/import-fixtures');
const write = (path, bytes) => {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`${path} (${bytes.length.toLocaleString()} bytes)`);
};

const notion = notionExport();
write(`notion/${notion.name}`, notion.bytes);
const related = relatedNotionExport();
write(`notion/${related.name}`, related.bytes);
write('names/unflagged-utf8-and-cp437.zip', unflaggedNames().bytes);
const folder = markdownFolder();
write('markdown/Handbook.zip', folder.bytes);
for (const [path, bytes] of Object.entries(folder.files)) write(`markdown/folder/${path}`, bytes);
const word = wordDocument();
write(`word/${word.name}`, word.bytes);
const large = largeNotionExport(1000);
write(`notion/large-${large.pages}-pages.zip`, large.bytes);
write('hostile/traversal.zip', traversalZip());
write('hostile/zip-bomb.zip', zipBomb());
write('hostile/declared-501-mb.zip', declaredHuge(501));
write('hostile/2001-pages.zip', manyPages(2001));
write('hostile/nested-3-deep.zip', nestedZips(3));
write('hostile/huge-image.zip', hugeImage());
write('hostile/doctype.docx', wordWithDoctype());
console.log(`Written to ${out}`);
