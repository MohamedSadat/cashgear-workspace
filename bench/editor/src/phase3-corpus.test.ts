// Phase 3's benchmarks (bench/phase3.mjs), step 1: the documents of the seeded workspace, written
// by the product's own document code (@cgw/doc's newDocumentUpdate: the page's meta, then its
// content, as a page's first update). Runs only when PHASE3_CORPUS names a folder holding
// pages.json (`{ clientId, pages: [{ id, blocks }] }`, written by phase3.mjs), so `pnpm test`
// skips it; writes docs.json there (page id -> base64 update).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newDocumentUpdate, type DocJSON } from '@cgw/doc';

const DIR = process.env.PHASE3_CORPUS ? resolve(process.env.PHASE3_CORPUS) : '';
const WORDS = [
  'invoice',
  'budget',
  'ledger',
  'warehouse',
  'forecast',
  'quarter',
  'report',
  'customer',
  'الفاتورة',
  'الميزانية',
  'المستودع',
  'العميل',
  'تقرير',
  'الربع',
  'الحساب',
  'العقد',
];
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** mulberry32: the same corpus for the same pages. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function page(blocks: number, random: () => number): DocJSON {
  const id = () => Array.from({ length: 12 }, () => DIGITS[Math.floor(random() * 62)]).join('');
  const sentence = (n: number) =>
    Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
  return {
    type: 'doc',
    content: Array.from({ length: blocks }, (_, i) => ({
      type: 'block',
      attrs: { id: id() },
      content: [
        i % 7 === 0
          ? {
              type: 'textBody',
              attrs: { kind: 'heading', level: 2 },
              content: [{ type: 'text', text: sentence(4) }],
            }
          : {
              type: 'textBody',
              attrs: { kind: 'paragraph' },
              content: [{ type: 'text', text: sentence(12 + (i % 9)) }],
            },
      ],
    })),
  };
}

describe.skipIf(!DIR)('Phase 3 corpus', () => {
  it('writes every page its first document', () => {
    const input = JSON.parse(readFileSync(join(DIR, 'pages.json'), 'utf8')) as {
      clientId: number;
      pages: { id: string; blocks: number }[];
    };
    const random = seeded(3);
    const docs: Record<string, string> = {};
    for (const p of input.pages)
      docs[p.id] = Buffer.from(
        newDocumentUpdate(p.id, page(p.blocks, random), input.clientId),
      ).toString('base64');
    writeFileSync(join(DIR, 'docs.json'), JSON.stringify(docs));
    expect(existsSync(join(DIR, 'docs.json'))).toBe(true);
  });
});
