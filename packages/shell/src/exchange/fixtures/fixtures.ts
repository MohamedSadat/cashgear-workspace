// Import fixtures, made here by code and never downloaded (M8.4): a Notion export (nested zips,
// pages and subpages, a database's CSV with typed columns and row pages, links, an image), a
// Markdown folder, a Word file written as its XML, hostile archives, and a large Notion export for
// the budget. Each says what it should import as. Used by the unit tests
// (`../import/import.test.ts`), the e2e spec (`tests/e2e/import.spec.ts`) and the bench
// (`bench/phase8-import.mjs`); `make.ts` writes them to a folder to try by hand. Erasable
// TypeScript only, so Node runs it as it is (`node packages/shell/src/exchange/fixtures/make.ts`).
import { zipSync, zlibSync, type Zippable } from 'fflate';

const utf8 = new TextEncoder();
const bytes = (text: string) => utf8.encode(text);

/** Notion's ids: 32 hex characters, made from a name so a fixture is the same every time. */
export function notionId(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 2246822519) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return (hex(h1) + hex(h2) + hex((h1 ^ 0x5bd1e995) >>> 0) + hex((h2 ^ 0x27d4eb2f) >>> 0)).slice(
    0,
    32,
  );
}

const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// ---- A PNG, made byte by byte -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(bytes(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * A PNG of one colour, `width` by `height`. With `claim`, its header names that size instead and
 * its pixels are those of a 1 by 1 image (a decompression bomb's header).
 */
export function png(
  width = 4,
  height = 3,
  rgb: [number, number, number] = [30, 120, 200],
  claim?: [number, number],
): Uint8Array {
  const [w, h] = claim ? [1, 1] : [width, height];
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, claim ? claim[0] : width);
  view.setUint32(4, claim ? claim[1] : height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) raw.set(rgb, y * (1 + w * 3) + 1 + x * 3);
  }
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** A PDF small enough to read, real enough to sniff. */
export const pdf = () =>
  bytes('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

export type Files = Record<string, Uint8Array>;

export function zip(files: Files): Uint8Array {
  const input: Zippable = {};
  for (const [path, data] of Object.entries(files)) input[path] = [data, { level: 6 }];
  return zipSync(input, { mtime: new Date(Date.UTC(2026, 10, 16)) });
}

// ---- A Notion export ---------------------------------------------------------------------------

/** What an import of a fixture should make, for the tests to hold it to. */
export interface Expected {
  top: string;
  /** Pages by title, each with its parent's title (null: the top). */
  pages: Record<string, string | null>;
  databases: Record<string, { rows: number; types: Record<string, string> }>;
  images: number;
  files: number;
  skipped: string[];
}

export function notionExport(): {
  name: string;
  bytes: Uint8Array;
  files: Files;
  expected: Expected;
} {
  const home = `Home ${notionId('home')}`;
  const projects = `Projects ${notionId('projects')}`;
  const launch = `Launch ${notionId('launch')}`;
  const notes = `Meeting notes ${notionId('notes')}`;
  const tasks = `Tasks ${notionId('tasks')}`;
  const spec = `Write the spec ${notionId('spec')}`;
  const review = `Review ${notionId('review')}`;
  const csvHeader = 'Name,Status,Due,Done,Estimate,Link,Project';
  const projectCell = (title: string, path: string) => `${title} (${enc(path)})`;
  const csvRows = [
    `Write the spec,Doing,"November 20, 2026",Yes,3,https://example.com/spec,"${projectCell('Launch', `${home}/${projects}/${launch}.md`)}"`,
    `Review,Done,"November 22, 2026 3:30 PM",No,1.5,https://example.com/review,`,
    `Ship it,Doing,"November 25, 2026 → November 27, 2026",No,8,,`,
    `Plan the party,Done,,Yes,2,,`,
  ];
  // UTF-8 with a byte order mark and CRLF, as Notion writes it.
  const csv = `${String.fromCharCode(0xfeff)}${[csvHeader, ...csvRows].join('\r\n')}\r\n`;
  const files: Files = {
    [`${home}.md`]: bytes(
      [
        '# Home',
        '',
        'Welcome to the **team** space. Read the [plans](' +
          enc(`${home}/${projects}.md`) +
          ') first.',
        '',
        `[Projects](${enc(`${home}/${projects}.md`)})`,
        '',
        `[Meeting notes](${enc(`${home}/${notes}.md`)})`,
        '',
        `[Tasks](${enc(`${home}/${tasks}.csv`)})`,
        '',
        `![diagram.png](${enc(`${home}/diagram.png`)})`,
        '',
        '<aside>',
        '💡 Remember to update the tasks.',
        '</aside>',
        '',
        `A link by address: [launch](https://www.notion.so/Launch-${notionId('launch')}).`,
        '',
        `A [missing page](${enc(`${home}/Gone ${notionId('gone')}.md`)}).`,
      ].join('\n'),
    ),
    [`${home}/diagram.png`]: png(8, 6),
    [`${home}/${projects}.md`]: bytes(
      [
        '# Projects',
        '',
        'Everything we are building.',
        '',
        `[Launch](${enc(`${projects}/${launch}.md`)})`,
        '',
      ].join('\n'),
    ),
    [`${home}/${projects}/${launch}.md`]: bytes(
      [
        '# Launch',
        '',
        '- [x] Pick a date',
        '- [ ] Tell everyone',
        '    - Write the note',
        '',
        '| Step | Owner |',
        '| --- | --- |',
        '| Draft | Sara |',
        '',
        '```ts',
        'const ready = true;',
        '```',
        '',
        `Back to [Home](${enc(`../../${home}.md`)}).`,
      ].join('\n'),
    ),
    [`${home}/${notes}.md`]: bytes(
      ['# Meeting notes', '', '> Decisions are final.', '', 'نلتقي يوم الأحد.'].join('\n'),
    ),
    [`${home}/${tasks}.csv`]: bytes(csv),
    [`${home}/${tasks}_all.csv`]: bytes(csv),
    [`${home}/${tasks}/${spec}.md`]: bytes(
      [
        '# Write the spec',
        '',
        'Status: Doing',
        'Due: November 20, 2026',
        `Project: ${projectCell('Launch', `../${projects}/${launch}.md`)}`,
        '',
        'The spec covers **import**.',
        '',
        `![chart](${enc(`${spec}/chart.png`)})`,
      ].join('\n'),
    ),
    [`${home}/${tasks}/${spec}/chart.png`]: png(5, 5, [200, 40, 40]),
    [`${home}/${tasks}/${review}.md`]: bytes(
      ['# Review', '', 'Status: Done', '', 'Look it over.'].join('\n'),
    ),
    [`${home}/notes.bin`]: new Uint8Array([0, 1, 2, 3, 0, 255, 254]),
  };
  // Notion writes a large export as an archive of archives.
  const names = Object.keys(files);
  const half = Math.ceil(names.length / 2);
  const part = (list: string[]) => zip(Object.fromEntries(list.map((n) => [n, files[n]])));
  const outer = zip({
    'Export-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0-Part-1.zip': part(names.slice(0, half)),
    'Export-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0-Part-2.zip': part(names.slice(half)),
  });
  return {
    name: 'Export-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.zip',
    bytes: outer,
    files,
    expected: {
      top: 'Home',
      pages: { Home: null, Projects: 'Home', Launch: 'Projects', 'Meeting notes': 'Home' },
      databases: {
        Tasks: {
          rows: 4,
          types: {
            Name: 'title',
            Status: 'select',
            Due: 'date',
            Done: 'checkbox',
            Estimate: 'number',
            Link: 'url',
            Project: 'text',
          },
        },
      },
      images: 2,
      files: 0,
      skipped: ['brokenLink', 'notLinked', 'linksAsText'],
    },
  };
}

// ---- Two related Notion databases ----------------------------------------------------------------

/**
 * A Notion export with two databases related both ways (Tasks' "Project" and Projects' "Tasks",
 * which name each other's rows), a relation by plain names within one database (Projects'
 * "Depends on"), a files column naming files of the export (Tasks' "Attachments"), one naming a
 * file that is not in it (Tasks' "References"), a relation to a page outside the export (Tasks'
 * "Blocked by"), and people columns (Projects' "Owner", Tasks' "Assignee").
 */
export function relatedNotionExport(): { name: string; bytes: Uint8Array; files: Files } {
  const work = `Work ${notionId('work-root')}`;
  const projects = `Projects ${notionId('rel-projects')}`;
  const tasks = `Tasks ${notionId('rel-tasks')}`;
  const launch = `Launch ${notionId('rel-launch')}`;
  const website = `Website ${notionId('rel-website')}`;
  const spec = `Write the spec ${notionId('rel-spec')}`;
  const review = `Review ${notionId('rel-review')}`;
  const ship = `Ship it ${notionId('rel-ship')}`;
  const unplanned = `Unplanned ${notionId('rel-unplanned')}`;
  // Paths in a CSV's cells are relative to the CSV, URL-encoded, after the page's name.
  const cell = (title: string, path: string) => `${title} (${enc(path)})`;
  const quoted = (text: string) => `"${text.replace(/"/g, '""')}"`;
  const projectRows = [
    'Name,Tasks,Owner,Depends on',
    [
      'Launch',
      quoted(
        `${cell('Write the spec', `${tasks}/${spec}.md`)}, ${cell('Review', `${tasks}/${review}.md`)}`,
      ),
      'Sara Ali',
      '',
    ].join(','),
    ['Website', quoted(cell('Ship it', `${tasks}/${ship}.md`)), 'Omar', 'Launch'].join(','),
  ];
  const taskRows = [
    'Name,Project,Attachments,References,Assignee,Blocked by',
    [
      'Write the spec',
      quoted(cell('Launch', `${projects}/${launch}.md`)),
      enc(`${tasks}/${spec}/brief.pdf`),
      quoted(`${enc(`${tasks}/${spec}/brief.pdf`)}, https://example.com/spec.pdf`),
      'Sara Ali',
      quoted(`Old plan (https://www.notion.so/Old-plan-${notionId('rel-outside')})`),
    ].join(','),
    ['Review', quoted(cell('Launch', `${projects}/${launch}.md`)), '', '', 'Omar', ''].join(','),
    [
      'Ship it',
      quoted(cell('Website', `${projects}/${website}.md`)),
      enc(`${tasks}/${ship}/logo.png`),
      '',
      'Sara Ali',
      '',
    ].join(','),
    'Unplanned,,,,,',
  ];
  const csv = (lines: string[]) => bytes(`${lines.join('\r\n')}\r\n`);
  const page = (title: string, extra: string[] = []) =>
    bytes([`# ${title}`, '', ...extra, '', `${title}'s page.`].join('\n'));
  const files: Files = {
    [`${work}.md`]: bytes(
      [
        '# Work',
        '',
        `[Projects](${enc(`${work}/${projects}.csv`)})`,
        '',
        `[Tasks](${enc(`${work}/${tasks}.csv`)})`,
      ].join('\n'),
    ),
    [`${work}/${projects}.csv`]: csv(projectRows),
    [`${work}/${projects}_all.csv`]: csv(projectRows),
    [`${work}/${tasks}.csv`]: csv(taskRows),
    [`${work}/${tasks}_all.csv`]: csv(taskRows),
    [`${work}/${projects}/${launch}.md`]: page('Launch', ['Owner: Sara Ali']),
    [`${work}/${projects}/${website}.md`]: page('Website', ['Owner: Omar', 'Depends on: Launch']),
    [`${work}/${tasks}/${spec}.md`]: page('Write the spec', ['Assignee: Sara Ali']),
    [`${work}/${tasks}/${review}.md`]: page('Review'),
    [`${work}/${tasks}/${ship}.md`]: page('Ship it'),
    [`${work}/${tasks}/${unplanned}.md`]: page('Unplanned'),
    [`${work}/${tasks}/${spec}/brief.pdf`]: pdf(),
    [`${work}/${tasks}/${ship}/logo.png`]: png(6, 6),
  };
  return { name: 'Export-related.zip', bytes: zip(files), files };
}

/**
 * Names written without the UTF-8 flag: an Arabic one in UTF-8 (as macOS and 7-Zip write it),
 * and one in an old code page (CP437's `é` is the byte 0x82), which is not UTF-8.
 */
export function unflaggedNames(): { bytes: Uint8Array; arabic: string } {
  const arabic = 'ملاحظات الاجتماع';
  const cp437 = new Uint8Array([...bytes('R'), 0x82, ...bytes('sum'), 0x82, ...bytes('.md')]);
  return {
    arabic,
    bytes: rawZip([
      { name: `${arabic}.md`, data: bytes('# ملاحظات\n\nنص.'), method: 0, utf8Flag: false },
      { name: 'Resume.md', nameBytes: cp437, data: bytes('# CV'), method: 0, utf8Flag: false },
      { name: 'Plain.md', data: bytes('# Plain'), method: 0, utf8Flag: false },
    ]),
  };
}

// ---- A Markdown folder -------------------------------------------------------------------------

export function markdownFolder(): {
  name: string;
  files: Files;
  bytes: Uint8Array;
  expected: Expected;
} {
  const files: Files = {
    'Handbook/Welcome.md': bytes(
      [
        '---',
        'title: Welcome',
        'tags: [intro]',
        '---',
        '# Welcome',
        '',
        'Start with the [guide](Guide.md) and the [[Install]] page.',
        '',
        '![Logo](images/logo.png)',
        '',
        '[The manual](files/manual.pdf)',
        '',
        '![Remote](https://example.com/remote.png)',
        '',
        'A [broken](Nowhere.md) link.',
        '',
        '1. First',
        '2. Second',
        '   - Nested bullet',
        '',
        '> A quote  ',
        '> on two lines',
        '',
        'Line one  ',
        'line two',
        '',
        '<https://example.com/bookmark>',
      ].join('\n'),
    ),
    'Handbook/Guide.md': bytes(
      ['# Guide', '', 'Read [the reference](Reference/API.md).', '', '---', '', 'Done.'].join('\n'),
    ),
    'Handbook/Guide/Install.md': bytes(['# Install', '', '```sh', 'npm install', '```'].join('\n')),
    'Handbook/Reference/API.md': bytes(
      ['# API', '', '| Name | Type |', '| --- | --- |', '| id | string |'].join('\n'),
    ),
    'Handbook/images/logo.png': png(16, 16, [10, 200, 90]),
    'Handbook/files/manual.pdf': pdf(),
    'Handbook/data.bin': new Uint8Array([0, 159, 146, 150, 0, 1]),
  };
  return {
    name: 'Handbook',
    files,
    bytes: zip(files),
    expected: {
      top: 'Handbook',
      pages: {
        Handbook: null,
        Welcome: 'Handbook',
        Guide: 'Handbook',
        Install: 'Guide',
        Reference: 'Handbook',
        API: 'Reference',
      },
      databases: {},
      images: 1,
      files: 1,
      skipped: ['frontMatter', 'externalImage', 'brokenLink', 'notLinked'],
    },
  };
}

// ---- A Word file, written as its XML -----------------------------------------------------------

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

const run = (text: string, props = '') =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (content: string, props = '') =>
  `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
const styled = (style: string, content: string, more = '') =>
  para(content, `<w:pStyle w:val="${style}"/>${more}`);
const listed = (numId: number, ilvl: number, content: string) =>
  para(
    content,
    `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`,
  );
const cell = (content: string, props = '') =>
  `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}${para(content)}</w:tc>`;

const drawing = (rel: string, alt: string) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture 1" descr="${alt}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${rel}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const textBox = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="2" name="Text Box 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>${para(run('In a box'))}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>`;

export function wordDocument(): {
  name: string;
  bytes: Uint8Array;
  files: Files;
  expected: Expected & { blocks: string[] };
} {
  const body = [
    styled('Title', run('Quarterly report')),
    styled('Heading1', run('Summary')),
    para(
      run('Plain, ') +
        run('bold', '<w:b/>') +
        run(', ') +
        run('italic', '<w:i/>') +
        run(', ') +
        run('underlined', '<w:u w:val="single"/>') +
        run(', ') +
        run('struck', '<w:strike/>') +
        run(', ') +
        run('code', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>') +
        run(' and ') +
        run('marked', '<w:highlight w:val="yellow"/>') +
        run('. ') +
        `<w:hyperlink r:id="rIdLink">${run('A link', '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>` +
        run('.'),
    ),
    para(
      run('Kept ') +
        `<w:ins w:id="1" w:author="Sara">${run('inserted ')}</w:ins>` +
        `<w:del w:id="2" w:author="Sara"><w:r><w:delText>deleted </w:delText></w:r></w:del>` +
        run('text.') +
        '<w:commentRangeStart w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' +
        '<w:r><w:footnoteReference w:id="1"/></w:r>',
    ),
    styled('Heading2', run('Lists')),
    listed(1, 0, run('First bullet')),
    listed(1, 1, run('Nested bullet')),
    listed(1, 0, run('Second bullet')),
    listed(2, 0, run('Third step')),
    listed(2, 0, run('Fourth step')),
    para(
      '<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent>' +
        run('☒') +
        '</w:sdtContent></w:sdt>' +
        run(' Done item'),
    ),
    styled('Heading3', run('Figures')),
    para(drawing('rIdImage', 'A blue square')),
    `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(run('Region'))}${cell(run('Q3'))}${cell(run('Q4'))}</w:tr><w:tr>${cell(run('North'), '<w:vMerge w:val="restart"/>')}${cell(run('10'), '<w:gridSpan w:val="2"/>')}</w:tr><w:tr>${cell('', '<w:vMerge/>')}${cell(run('11'))}${cell(run('12'))}</w:tr></w:tbl>`,
    styled('Quote', run('Numbers are rounded.')),
    para(run('const total = 42;', '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')),
    para(run('مرحبا بالعالم', '<w:rtl/>'), '<w:bidi/>'),
    para(run('After a break') + '<w:r><w:br w:type="page"/></w:r>'),
    para(textBox + run('Beside a box')),
    para(
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.com/field" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        run('A field link') +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ),
    para(''),
    '<w:p><m:oMathPara><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath></m:oMathPara></w:p>',
    '<w:sectPr/>',
  ].join('');
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:u w:val="single"/></w:rPr></w:style></w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report" TargetMode="External"/></Relationships>`;
  const files: Files = {
    '[Content_Types].xml': bytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    ),
    '_rels/.rels': bytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': bytes(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ),
    'word/styles.xml': bytes(styles),
    'word/numbering.xml': bytes(numbering),
    'word/_rels/document.xml.rels': bytes(rels),
    'word/media/image1.png': png(10, 10),
    'word/header1.xml': bytes(
      `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${para(run('Header'))}</w:hdr>`,
    ),
  };
  return {
    name: 'Quarterly report.docx',
    bytes: zip(files),
    files,
    expected: {
      top: 'Quarterly report',
      pages: { 'Quarterly report': null },
      databases: {},
      images: 1,
      files: 0,
      skipped: [
        'trackedChanges',
        'comments',
        'footnotes',
        'textBoxes',
        'equation',
        'pageBreaks',
        'headersAndFooters',
      ],
      blocks: [
        'heading:Summary',
        'paragraph',
        'paragraph',
        'heading:Lists',
        'bulletItem',
        'bulletItem',
        'numberedItem',
        'numberedItem',
        'checkItem',
        'heading:Figures',
        'image',
        'table',
        'quote',
        'codeBlock',
        'paragraph',
        'paragraph',
        'paragraph',
        'paragraph',
      ],
    },
  };
}

// ---- Hostile archives --------------------------------------------------------------------------

interface RawEntry {
  name: string;
  data: Uint8Array;
  /** 0: stored, 8: deflated. */
  method: 0 | 8;
  /** The size the archive says the entry unpacks to (a lie, in a hostile one). */
  declared?: number;
  /** The name's bytes as written (else its UTF-8), and whether the UTF-8 flag is set (else it is). */
  nameBytes?: Uint8Array;
  utf8Flag?: boolean;
}

/** A zip written by hand, so its names and sizes can be anything (fflate's own checks them). */
export function rawZip(entries: RawEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.nameBytes ?? bytes(entry.name);
    const flags = entry.utf8Flag === false ? 0 : 0x800;
    const declared = entry.declared ?? entry.data.length;
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, flags, true);
    l.setUint16(8, entry.method, true);
    l.setUint32(18, entry.data.length, true);
    l.setUint32(22, declared, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const head = new Uint8Array(46 + name.length);
    const c = new DataView(head.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, entry.method, true);
    c.setUint32(20, entry.data.length, true);
    c.setUint32(24, declared, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    head.set(name, 46);
    parts.push(local, entry.data);
    central.push(head);
    offset += local.length + entry.data.length;
  }
  const directory = concat(central);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, directory.length, true);
  e.setUint32(16, offset, true);
  return concat([...parts, directory, end]);
}

const stored = (name: string, text: string): RawEntry => ({ name, data: bytes(text), method: 0 });

/** Paths out of the folder, absolute paths and control characters, beside one good page. */
export function traversalZip(): Uint8Array {
  return rawZip([
    stored('Good.md', '# Good\n\nKept.'),
    stored('../escape.md', '# Escape'),
    stored('notes/../../escape2.md', '# Escape too'),
    stored('/etc/passwd.md', '# Absolute'),
    stored('C:/Windows/win.md', '# Drive'),
    stored(`bad${String.fromCharCode(1)}name.md`, '# Control'),
    stored(`${'deep/'.repeat(40)}page.md`, '# Deep'),
    stored(`Over${String.fromCharCode(0x202e)}gnp.md`, '# Reversed'),
  ]);
}

/** 20 MB of zeros, deflated about 1,000 to 1. */
export function zipBomb(): Uint8Array {
  return zipSync({ 'bomb.md': [new Uint8Array(20 * 1024 * 1024), { level: 9 }] });
}

/** An archive that says it unpacks to `megabytes` MB (1 MB entries at 512 to 1; never unpacked). */
export function declaredHuge(megabytes = 501): Uint8Array {
  const filler = new Uint8Array(2048).map((_, i) => (i * 7919) % 251);
  return rawZip(
    Array.from({ length: megabytes }, (_, i) => ({
      name: `big/${i}.md`,
      data: filler,
      method: 8 as const,
      declared: 1024 * 1024,
    })),
  );
}

/** `n` pages, one Markdown file each. */
export function manyPages(n: number): Uint8Array {
  const files: Files = {};
  for (let i = 0; i < n; i++) files[`Many/Page ${i}.md`] = bytes(`# Page ${i}\n\nText ${i}.`);
  return zip(files);
}

/** An archive in an archive, `depth` deep, a page at the bottom. */
export function nestedZips(depth: number): Uint8Array {
  let inner = zip({ 'Deep.md': bytes('# Deep') });
  for (let i = 0; i < depth; i++) inner = zip({ [`level${i}.zip`]: inner });
  return inner;
}

/** A page with an image whose header claims 30,000 by 30,000 pixels. */
export function hugeImage(): Uint8Array {
  return zip({
    'Gallery.md': bytes('# Gallery\n\n![Huge](huge.png)\n\n![Fine](fine.png)'),
    'huge.png': png(1, 1, [0, 0, 0], [30_000, 30_000]),
    'fine.png': png(2, 2),
  });
}

/** Lists nested 100 deep and `<aside>`s nested 20 deep. */
export function deepMarkdown(): string {
  const list = Array.from({ length: 100 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n');
  const asides = `${'<aside>\n'.repeat(20)}inside\n${'</aside>\n'.repeat(20)}`;
  return `# Deep\n\n${list}\n\n${asides}`;
}

/** A Word file whose document has a document type (an entity bomb). */
export function wordWithDoctype(): Uint8Array {
  const bomb =
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>' +
    `<w:document ${W}><w:body>${para(run('&lol2;'))}</w:body></w:document>`;
  return zip({ 'word/document.xml': bytes(bomb) });
}

// ---- A large Notion export (the budget) ---------------------------------------------------------

/**
 * A Notion export of `pages` pages in all: section pages with subpages linking each other, and a
 * database whose rows have pages of their own (a fifth of the pages), with an image shared by
 * every tenth page.
 */
export function largeNotionExport(pages = 1000): {
  name: string;
  bytes: Uint8Array;
  pages: number;
} {
  const files: Files = {};
  const root = `Company ${notionId('company')}`;
  // The root page and the database, ten sections of pages (four fifths), and rows for the rest.
  const sections = 10;
  const perSection = Math.max(1, Math.floor((pages * 0.8 - 2 - sections) / sections));
  const rowsCount = Math.max(0, pages - 2 - sections * (1 + perSection));
  const db = `Work ${notionId('work')}`;
  const lines = (title: string, extra: string[]) =>
    bytes(
      [
        `# ${title}`,
        '',
        `${title} is described here, with **bold** and *italic* words and a [link](https://example.com/${encodeURIComponent(title)}).`,
        '',
        '- One point',
        '- Another point',
        '    - A detail',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        ...extra,
      ].join('\n'),
    );
  const sectionLinks: string[] = [];
  let made = 1;
  files[`${root}/logo.png`] = png(32, 32);
  for (let s = 0; s < sections; s++) {
    const section = `Section ${s} ${notionId(`s${s}`)}`;
    sectionLinks.push(`[Section ${s}](${enc(`${root}/${section}.md`)})`, '');
    const children: string[] = [];
    for (let p = 0; p < perSection; p++) {
      const page = `Page ${s}-${p} ${notionId(`p${s}-${p}`)}`;
      children.push(`[Page ${s}-${p}](${enc(`${section}/${page}.md`)})`, '');
      const next = `Page ${s}-${(p + 1) % perSection} ${notionId(`p${s}-${(p + 1) % perSection}`)}`;
      files[`${root}/${section}/${page}.md`] = lines(`Page ${s}-${p}`, [
        `See [Page ${s}-${(p + 1) % perSection}](${enc(`${next}.md`)}).`,
        ...(p % 10 === 0 ? ['', `![logo](${enc('../logo.png')})`] : []),
      ]);
      made++;
    }
    files[`${root}/${section}.md`] = lines(`Section ${s}`, children);
    made++;
  }
  const header = 'Name,Status,Due,Points,Done';
  const rows: string[] = [];
  for (let r = 0; r < rowsCount; r++) {
    const title = `Task ${r}`;
    rows.push(
      `${title},${['Open', 'Doing', 'Done'][r % 3]},"November ${1 + (r % 28)}, 2026",${r % 13},${r % 2 ? 'Yes' : 'No'}`,
    );
    files[`${root}/${db}/${title} ${notionId(`t${r}`)}.md`] = lines(title, []);
    made++;
  }
  const csv = bytes(`${[header, ...rows].join('\r\n')}\r\n`);
  files[`${root}/${db}.csv`] = csv;
  files[`${root}/${db}_all.csv`] = csv;
  made++;
  files[`${root}.md`] = lines('Company', [...sectionLinks, `[Work](${enc(`${root}/${db}.csv`)})`]);
  return { name: 'Export-large.zip', bytes: zip(files), pages: made };
}
