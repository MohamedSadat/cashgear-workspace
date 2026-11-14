// sheet-embed.1's shared vectors (packages/editor/vectors/sheet-embed-vectors.json), which Sheet's
// validators run too (Track S5). The cases are in ./vectors.cases.ts; this test checks the file
// holds exactly those (rewrite it with `SHEET_VECTORS_WRITE=1`, then Prettier on it) and runs
// every vector read from the file through the validators, as sent and after a structured clone.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHEET_EMBED_CONTRACT, parseEmbedMessage, parseParentMessage } from './contract';
import { decodeVector as decode, sheetEmbedVectors, type SheetEmbedVectors } from './vectors.cases';

const WRITE = process.env.SHEET_VECTORS_WRITE === '1';
const FILE = new URL('../../vectors/sheet-embed-vectors.json', import.meta.url);

if (WRITE) writeFileSync(FILE, JSON.stringify(sheetEmbedVectors, null, 2) + '\n');
const onDisk = JSON.parse(readFileSync(FILE, 'utf8')) as SheetEmbedVectors;

describe('sheet-embed-vectors.json', () => {
  it('holds the cases as written', () => {
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(sheetEmbedVectors)));
  });

  it('names the contract and has enough cases', () => {
    expect(onDisk.contract).toBe(SHEET_EMBED_CONTRACT);
    expect(onDisk.parent.length + onDisk.embed.length).toBeGreaterThanOrEqual(120);
    expect(new Set(onDisk.parent.map((v) => v.name)).size).toBe(onDisk.parent.length);
    expect(new Set(onDisk.embed.map((v) => v.name)).size).toBe(onDisk.embed.length);
  });

  it('keeps "__proto__" keys as own properties when decoded', () => {
    const polluted = onDisk.parent.find((v) => v.name === 'init: an own "__proto__" key')!;
    const decoded = decode(polluted.message) as object;
    expect(Object.keys(decoded)).toContain('__proto__');
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  const suites = [
    ['parent', onDisk.parent, parseParentMessage],
    ['embed', onDisk.embed, parseEmbedMessage],
  ] as const;
  for (const [side, vectors, parse] of suites) {
    describe(side, () => {
      for (const vector of vectors) {
        it(`${vector.valid ? 'valid' : 'invalid'}: ${vector.name}`, () => {
          const message = decode(vector.message);
          expect(parse(message) !== null).toBe(vector.valid);
          expect(parse(structuredClone(message)) !== null).toBe(vector.valid);
        });
      }
    });
  }
});
