// Phase 19: the shell's part of Word, print and PDF that runs without a browser's print engine:
// which mode a browser prints in, a file's name, the notice of what was left out, a page's
// sub-pages, and the layout Page setup saves through the session. The rest is the specs'
// (tests/e2e/print.spec.ts), in Chrome, Edge and the Windows app.
import { MemoryStore } from '@cgw/workspace';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { localWorkspace } from '../../../workspace/src/testing/syncHarness';
import { addSection } from '../i18n/sections';
import { WorkspaceSession } from '../session';
import { MAX_SUB_PAGES, leftOutText, subPagesOf } from './collect';
import { fileName, printMode } from './run';
import { printWords } from './words';

describe('the print view’s mode', () => {
  it('is Chromium’s margin boxes in Chrome, Edge and WebView2, and pages cut by script elsewhere', () => {
    expect(
      printMode(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      ),
    ).toBe('css');
    expect(
      printMode(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
      ),
    ).toBe('css');
    expect(
      printMode(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
      ),
    ).toBe('paged');
    expect(
      printMode(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ),
    ).toBe('paged');
  });
});

describe('a file’s name', () => {
  it('is the page’s title, made safe on every system, with its extension', () => {
    expect(fileName('Q3: report / draft?', 'Untitled', 'docx')).toBe(
      'Q3 report draft .docx'.replace(' .', '.'),
    );
    expect(fileName('  ', 'Untitled', 'pdf')).toBe('Untitled.pdf');
    expect(fileName('تقرير الربع', 'بلا عنوان', 'pdf')).toBe('تقرير الربع.pdf');
  });
});

describe('the notice after', () => {
  it('names what the file left out, in the interface’s words, or says nothing', () => {
    const i18n = i18next.createInstance();
    void i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initAsync: false });
    addSection(i18n, printWords);
    const t = i18n.t.bind(i18n) as unknown as (key: string, o?: Record<string, unknown>) => string;
    expect(
      leftOutText(t, { images: 0, sheets: 0, databases: 0, deviceRows: 0, erp: 0 }, 'en'),
    ).toBeNull();
    expect(
      leftOutText(t, { images: 2, sheets: 0, databases: 1, deviceRows: 0, erp: 3 }, 'en'),
    ).toBe(
      'Not in it: images not on this device: 2; databases not on this device: 1; Cash Gear ERP blocks’ data: 3.',
    );
  });
});

describe('a page’s sub-pages', () => {
  it('are its pages and databases under it in the tree’s order, never rows or the trash', async () => {
    const store = new MemoryStore();
    const made = await localWorkspace(store);
    const session = await WorkspaceSession.start(store);
    session.switchTo(made.ws.id);
    const children = await Promise.all(
      ['One', 'Two'].map((title) =>
        session.createPage({ sectionId: made.section.id, parentPageId: made.a.id, title }),
      ),
    );
    const deep = await session.createPage({
      sectionId: made.section.id,
      parentPageId: children[0].id,
      title: 'Deep',
    });
    await session.trashPage(children[1].id);
    const under = subPagesOf(session, made.a.id);
    expect(under).toContain(children[0].id);
    expect(under).toContain(deep.id);
    expect(under).not.toContain(children[1].id);
    expect(under.indexOf(children[0].id)).toBeLessThan(under.indexOf(deep.id));
    expect(MAX_SUB_PAGES).toBe(200);
  });
});
