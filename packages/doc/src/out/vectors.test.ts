// Phase 19: the Word writer's vectors (packages/doc/vectors/docx-vectors.json), each file's parts
// as written from the page with every block, in English and in Arabic and in two layouts. The
// server's tests put each in a package and run DocumentFormat.OpenXml's validator over it
// (`DocxVectorTests`). Rewrite them with `DOCX_VECTORS_WRITE=1`.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { writeDocx } from './docx';
import { LAYOUT, everyBlockInput } from './fixtures';

const file = new URL('../../vectors/docx-vectors.json', import.meta.url);

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

function vectors() {
  const cases = [
    { name: 'every block, English, A4', input: everyBlockInput('en') },
    { name: 'every block, Arabic, A4', input: everyBlockInput('ar') },
    {
      name: 'every block, English, Letter landscape, wide margins, no header',
      input: everyBlockInput('en', {
        ...LAYOUT,
        size: 'letter',
        orientation: 'landscape',
        margins: 'wide',
        header: { start: '', center: '', end: '' },
      }),
    },
  ];
  return {
    files: cases.map(({ name, input }) => ({
      name,
      parts: writeDocx(input).map((part) =>
        typeof part.data === 'string'
          ? { path: part.path, text: part.data }
          : { path: part.path, base64: toBase64(part.data) },
      ),
    })),
  };
}

/** JSON with invisible format characters escaped, so the file reads the same in any editor. */
const toJson = (value: unknown) =>
  JSON.stringify(value, null, 1).replace(
    /\p{Cf}/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  ) + '\n';

describe("the Word writer's vectors", () => {
  it('docx-vectors.json holds what the writer writes now', () => {
    const made = vectors();
    if (process.env.DOCX_VECTORS_WRITE === '1') writeFileSync(file, toJson(made));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(made)));
  });
});
