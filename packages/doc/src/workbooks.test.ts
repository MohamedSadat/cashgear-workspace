// Phase 9 (M9.3): an import that made a workspace's workbooks again points its sheet blocks at the
// new ones (`remapRefs`'s `workbooks`); a copy gives no such map and keeps the same workbook; an
// export of some pages finds the workbooks they show (`workbookRefs`).
import { describe, expect, it } from 'vitest';
import { build, remapRefs, workbookRefs, type DocJSON } from './index';

const { docOf, paragraph, sheetEmbed, toggle } = build;
const OLD = '01936f6e-0000-7000-8000-0000000000e1';
const NEW = '01936f6e-0000-7000-8000-0000000000f1';
const OTHER = '01936f6e-0000-7000-8000-0000000000e3';

const workbookOf = (json: DocJSON): unknown[] => {
  const out: unknown[] = [];
  const walk = (node: DocJSON) => {
    if (node.type === 'sheetEmbed') out.push(node.attrs?.workbookId);
    node.content?.forEach(walk);
  };
  walk(json);
  return out;
};

describe('workbooks in a copied document', () => {
  it('follow the workbooks map, every other attribute kept', () => {
    const json = docOf(
      paragraph('Before'),
      sheetEmbed(OLD, { sheet: 'Q1', range: 'A1:B2' }, 240),
      toggle(['More'], [sheetEmbed(OLD), sheetEmbed(OTHER)]),
    );
    const out = remapRefs(json, new Map(), new Map(), new Map([[OLD, NEW]]));
    expect(workbookOf(out)).toEqual([NEW, NEW, OTHER]);
    // Nothing else changed: the same document with the old id put back.
    expect(JSON.parse(JSON.stringify(out).replaceAll(NEW, OLD))).toEqual(json);
    // The original is not touched.
    expect(workbookOf(json)).toEqual([OLD, OLD, OTHER]);
  });

  it('stay as they were without a workbooks map, even when an id is in another map', () => {
    const json = docOf(sheetEmbed(OLD));
    const both = new Map([[OLD, NEW]]);
    expect(remapRefs(json, both, both)).toEqual(json);
    expect(remapRefs(json, new Map())).toEqual(json);
  });

  it('are what an export of the page brings', () => {
    const json = docOf(sheetEmbed(OLD), toggle(['More'], [sheetEmbed(OTHER), sheetEmbed(OLD)]));
    expect(workbookRefs(json)).toEqual(new Set([OLD, OTHER]));
    expect(workbookRefs(docOf(paragraph('None')))).toEqual(new Set());
  });
});
