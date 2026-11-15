// What a refused operation says. The operations route (server OpsService and DatabaseOps) answers
// a rejected operation with one of these codes; the engine raises a notice with it, about the page
// the server's answer names, or about no page when it names none (a refused create, a section).
import { uuidv7 } from '@cgw/workspace';
import { describe, expect, it } from 'vitest';
import { ar, en, flatten } from './i18n';
import { noticeTarget, noticeText } from './notices';

/** Every code a rejected operation can carry, and whether its answer can name a page. */
const REFUSALS: { code: string; withPage: boolean; withoutPage: boolean }[] = [
  { code: 'not.found', withPage: false, withoutPage: true },
  { code: 'access.denied', withPage: true, withoutPage: true },
  { code: 'version.conflict', withPage: true, withoutPage: false },
  { code: 'tree.cycle', withPage: true, withoutPage: false },
  { code: 'tree.section', withPage: true, withoutPage: true },
  { code: 'page.trashed', withPage: true, withoutPage: false },
  { code: 'page.notTrashed', withPage: true, withoutPage: false },
  { code: 'section.notEmpty', withPage: false, withoutPage: true },
  { code: 'invalid', withPage: true, withoutPage: true },
  { code: 'request.invalid', withPage: false, withoutPage: true },
];

const cases = REFUSALS.flatMap(({ code, withPage, withoutPage }) => [
  ...(withPage ? [{ code, pageId: uuidv7() as string | undefined }] : []),
  ...(withoutPage ? [{ code, pageId: undefined }] : []),
]);

const english = flatten(en);
const arabic = flatten(ar);

describe('refused operations', () => {
  it('say something is gone only when it is', () => {
    for (const notice of cases) {
      if (notice.code === 'not.found') continue;
      expect(noticeText(notice), notice.code).not.toBe('notices.notFound');
    }
    expect(noticeText({ code: 'not.found' })).toBe('notices.notFound');
  });

  it('keep the texts of a lost page and lost access', () => {
    expect(noticeText({ code: 'not.found', pageId: uuidv7() })).toBe('notices.notFound');
    expect(noticeText({ code: 'access.denied', pageId: uuidv7() })).toBe('notices.accessDenied');
  });

  it('say what happened on another device', () => {
    const pageId = uuidv7();
    expect(noticeText({ code: 'tree.section', pageId })).toBe('notices.otherSection');
    expect(noticeText({ code: 'tree.section' })).toBe('notices.otherSectionNew');
    expect(noticeText({ code: 'section.notEmpty' })).toBe('notices.sectionNotEmpty');
    expect(noticeText({ code: 'page.notTrashed', pageId })).toBe('notices.notTrashed');
  });

  it('say a change was not accepted, for a code that names no cause', () => {
    const pageId = uuidv7();
    for (const code of ['invalid', 'request.invalid', 'some.futureCode']) {
      expect(noticeText({ code, pageId }), code).toBe('notices.notAccepted');
      expect(noticeText({ code }), code).toBe('notices.notAcceptedUnnamed');
    }
  });

  it('name a page only when the answer names one, in both languages', () => {
    for (const notice of cases) {
      // Lost access keeps its text, which names the page (the document's refusal always has one).
      if (notice.code === 'access.denied' && !notice.pageId) continue;
      const key = noticeText(notice);
      for (const [language, catalogue] of [
        ['en', english],
        ['ar', arabic],
      ] as const) {
        const text = catalogue.get(key);
        expect(text, `${language} ${key}`).toBeTruthy();
        // Without a page the title would read "Untitled": such a text names none.
        expect(text!.includes('{{title}}'), `${language} ${key}`).toBe(!!notice.pageId);
        if (language === 'ar') expect(text, key).toMatch(/\p{Script=Arabic}/u);
      }
    }
  });

  it('lead to the page as the server has it', () => {
    const pageId = uuidv7();
    for (const code of ['tree.section', 'page.notTrashed', 'invalid', 'request.invalid'])
      expect(noticeTarget({ code, pageId }), code).toEqual({ kind: 'page', pageId });
    for (const code of ['tree.section', 'section.notEmpty', 'invalid', 'request.invalid'])
      expect(noticeTarget({ code }), code).toBeNull();
  });
});
