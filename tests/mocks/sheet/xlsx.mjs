// A tiny xlsx writer and reader for the mock Sheet (tests/mocks/sheet) and its tests. Plain
// ECMAScript with no dependencies, so the same file runs in Node and in the mock's pages: the
// writer makes a zip of stored entries with their CRC-32; the reader takes stored or deflated
// entries (`DecompressionStream('deflate-raw')`), the workbook's sheets, shared strings and cell
// values. Enough for the workbooks Workspace's server, Sheet and this writer make; no styles,
// formulas are read as their saved values, charts and drawings are ignored.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309, as zip uses it) of the bytes. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of `[name, text or bytes]` entries, each stored (method 0) with its CRC-32. */
export function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 10, true); // version needed: stored
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true); // time
    local.setUint16(12, 0x0021, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 10, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, 0, true);
    header.setUint16(14, 0x0021, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.length, true);
    header.setUint32(24, data.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(header.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function inflate(bytes) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** The entries of a zip, by name: stored or deflated, no zip64. Throws on anything else. */
export async function unzip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (packed === 0xffffffff || size === 0xffffffff) throw new Error('zip64');
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error('bad local header');
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = bytes.subarray(start, start + packed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflate(data));
    else throw new Error('unsupported compression');
  }
  return files;
}

const escapeXml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const unescapeXml = (text) =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
  });

/** A column's letters from its number (1 is A). */
export function columnLetters(n) {
  let text = '';
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    text = String.fromCharCode(65 + ((rest - 1) % 26)) + text;
  }
  return text;
}

/** A column's number from its letters. */
export function columnNumber(letters) {
  let n = 0;
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n;
}

/** `{row, col}` of `A1`-style text, or null. */
export function cellAt(ref) {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref);
  return match ? { row: Number(match[2]), col: columnNumber(match[1]) } : null;
}

/** Cells by reference (`A1` → value) from rows of values starting at A1; null leaves a gap. */
export function cellsFromRows(rows) {
  const cells = new Map();
  rows.forEach((row, r) =>
    row.forEach((value, c) => {
      if (value !== null && value !== undefined)
        cells.set(`${columnLetters(c + 1)}${r + 1}`, value);
    }),
  );
  return cells;
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const STYLES =
  `<styleSheet xmlns="${MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font>` +
  '</fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill ' +
  'patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/>' +
  '<bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" ' +
  'fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" ' +
  'fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" ' +
  'xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * An xlsx of `{sheets: [{name, rows?, cells?, rtl?, state?}]}`: `rows` are values from A1 (null
 * for none), or `cells` a Map of `A1` → value; values are numbers, strings (shared) or booleans.
 * `state` is `hidden` or `veryHidden` for a sheet not shown.
 */
export function writeXlsx({ sheets }) {
  const strings = [];
  const stringIndex = new Map();
  const shared = (text) => {
    if (!stringIndex.has(text)) {
      stringIndex.set(text, strings.length);
      strings.push(text);
    }
    return stringIndex.get(text);
  };
  const sheetXml = sheets.map((sheet) => {
    const cells = sheet.cells ?? cellsFromRows(sheet.rows ?? []);
    const byRow = new Map();
    let bottom = 0;
    let right = 0;
    for (const [ref, value] of cells) {
      const at = cellAt(ref);
      if (!at) throw new Error(`bad cell reference ${ref}`);
      if (!byRow.has(at.row)) byRow.set(at.row, []);
      byRow.get(at.row).push([at.col, ref, value]);
      bottom = Math.max(bottom, at.row);
      right = Math.max(right, at.col);
    }
    const rows = [...byRow.keys()]
      .sort((a, b) => a - b)
      .map((row) => {
        const body = byRow
          .get(row)
          .sort((a, b) => a[0] - b[0])
          .map(([, ref, value]) => {
            if (typeof value === 'number') {
              if (!Number.isFinite(value)) throw new Error('a number must be finite');
              return `<c r="${ref}"><v>${value}</v></c>`;
            }
            if (typeof value === 'boolean')
              return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
            return `<c r="${ref}" t="s"><v>${shared(String(value))}</v></c>`;
          })
          .join('');
        return `<row r="${row}">${body}</row>`;
      })
      .join('');
    const dimension = bottom ? `A1:${columnLetters(right)}${bottom}` : 'A1';
    const view = `<sheetViews><sheetView workbookViewId="0"${sheet.rtl ? ' rightToLeft="1"' : ''}/></sheetViews>`;
    return `${HEADER}<worksheet xmlns="${MAIN}" xmlns:r="${RELS}"><dimension ref="${dimension}"/>${view}<sheetData>${rows}</sheetData></worksheet>`;
  });
  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');
  const entries = [
    [
      '[Content_Types].xml',
      `${HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${overrides}</Types>`,
    ],
    [
      '_rels/.rels',
      `${HEADER}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `${HEADER}<workbook xmlns="${MAIN}" xmlns:r="${RELS}"><bookViews><workbookView/></bookViews><sheets>${sheets
        .map((sheet, i) => {
          const state = sheet.state ? ` state="${sheet.state}"` : '';
          return `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}"${state} r:id="rId${i + 1}"/>`;
        })
        .join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `${HEADER}<Relationships xmlns="${PACKAGE_RELS}">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${RELS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rStyles" Type="${RELS}/styles" Target="styles.xml"/><Relationship Id="rStrings" Type="${RELS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    ['xl/styles.xml', HEADER + STYLES],
    [
      'xl/sharedStrings.xml',
      `${HEADER}<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings
        .map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
        .join('')}</sst>`,
    ],
    ...sheetXml.map((xml, i) => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
  ];
  return zip(entries);
}

const attributes = (text) => {
  const out = {};
  for (const [, name, value] of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    out[name.replace(/^.*:/, '')] = unescapeXml(value);
  }
  return out;
};

const textOf = (xml) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map(([, text]) => unescapeXml(text))
    .join('');

/** A part's path from a relationship target, relative to the part that names it. */
function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}

/**
 * A part's XML with element names' namespace prefixes taken off (`<x:sheet>` reads as `<sheet>`):
 * writers such as DocumentFormat.OpenXml (the server's view export) prefix SpreadsheetML.
 */
const unprefixed = (xml) => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, '<$1');

function relationships(files, part) {
  const at = part.split('/');
  const name = at.pop();
  const path = [...at, '_rels', `${name}.rels`].join('/');
  const xml = files.get(path);
  const out = new Map();
  if (!xml) return out;
  for (const [, body] of unprefixed(decoder.decode(xml)).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attributes(body);
    out.set(a.Id, { type: a.Type ?? '', target: resolvePart(part, a.Target ?? '') });
  }
  return out;
}

/**
 * The sheets of an xlsx, in tab order: `{name, kind ('worksheet' | 'chartsheet'), state
 * ('visible' | 'hidden' | 'veryHidden'), rtl, cells: Map of A1 → number | string | boolean}`.
 */
export async function readXlsx(bytes) {
  const files = await unzip(bytes);
  const text = (path) => {
    const data = files.get(path);
    if (!data) throw new Error(`missing ${path}`);
    return unprefixed(decoder.decode(data));
  };
  const office = [...relationships(files, '').values()].find((r) =>
    r.type.endsWith('/officeDocument'),
  );
  const workbookPath = office?.target ?? 'xl/workbook.xml';
  const workbook = text(workbookPath);
  const rels = relationships(files, workbookPath);
  const sharedRel = [...rels.values()].find((r) => r.type.endsWith('/sharedStrings'));
  const strings = sharedRel
    ? [...text(sharedRel.target).matchAll(/<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(
        ([, body]) => textOf(body ?? ''),
      )
    : [];
  const sheets = [];
  for (const [, body] of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = attributes(body);
    const rel = rels.get(a.id);
    if (!rel) continue;
    const kind = rel.type.endsWith('/chartsheet') ? 'chartsheet' : 'worksheet';
    const sheet = {
      name: a.name ?? '',
      kind,
      state: a.state === 'hidden' || a.state === 'veryHidden' ? a.state : 'visible',
      rtl: false,
      cells: new Map(),
    };
    sheets.push(sheet);
    if (kind !== 'worksheet' || !files.has(rel.target)) continue;
    const xml = text(rel.target);
    const view = /<sheetView\b([^>]*?)\/?>/.exec(xml);
    sheet.rtl = view ? ['1', 'true'].includes(attributes(view[1]).rightToLeft) : false;
    let rowNumber = 0;
    for (const [, rowAttrs, rowBody] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attributes(rowAttrs).r);
      rowNumber = Number.isInteger(r) && r > 0 ? r : rowNumber + 1;
      let col = 0;
      for (const [, cellAttrs, cellBody] of (rowBody ?? '').matchAll(
        /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
      )) {
        const c = attributes(cellAttrs);
        const at = c.r ? cellAt(c.r) : null;
        col = at ? at.col : col + 1;
        const ref = `${columnLetters(col)}${at ? at.row : rowNumber}`;
        const inner = cellBody ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let value = null;
        if (c.t === 'inlineStr') value = textOf(inner);
        else if (v) {
          const raw = unescapeXml(v[1]);
          if (c.t === 's') value = strings[Number(raw)] ?? '';
          else if (c.t === 'b') value = raw === '1' || raw === 'true';
          else if (c.t === 'str' || c.t === 'e' || c.t === 'd') value = raw;
          else value = Number(raw);
        }
        if (value !== null && value !== '') sheet.cells.set(ref, value);
      }
    }
  }
  if (sheets.length === 0) throw new Error('no sheets');
  return { sheets };
}
