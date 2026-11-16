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

  it('lead to the page as the server has it, for an operation refused for access too', () => {
    const pageId = uuidv7();
    for (const type of ['page.update', 'page.move', 'page.trash', 'row.update'])
      expect(noticeTarget({ code: 'access.denied', pageId, refused: { type } }), type).toEqual({
        kind: 'page',
        pageId,
      });
    // Still in the trash, which is where it is.
    for (const type of ['page.restore', 'page.delete'])
      expect(noticeTarget({ code: 'access.denied', pageId, refused: { type } }), type).toEqual({
        kind: 'trash',
      });
    // Nothing was set aside, so there is no recovered page to lead to.
    for (const type of ['section.create', 'page.create', 'workspace.update'])
      expect(noticeTarget({ code: 'access.denied', refused: { type } }), type).toBeNull();
  });

  it('lead to the page as the server has it', () => {
    const pageId = uuidv7();
    for (const code of ['tree.section', 'page.notTrashed', 'invalid', 'request.invalid'])
      expect(noticeTarget({ code, pageId }), code).toEqual({ kind: 'page', pageId });
    for (const code of ['tree.section', 'section.notEmpty', 'invalid', 'request.invalid'])
      expect(noticeTarget({ code }), code).toBeNull();
  });
});

// An operation refused for access (the operations route's `access.denied`): the engine names the
// refused operation, and the notice says what was refused and that it was undone. The same code
// on a page's document (edit access lost there, its unsent edits set aside) keeps the recovered
// page's text (DECISIONS.md, 2026-11-15: After 0.7.0).
describe('operations refused for access', () => {
  const pageId = uuidv7();
  const denied = (type: string, options: { fields?: string[]; page?: boolean } = {}) => ({
    code: 'access.denied',
    ...(options.page === false ? {} : { pageId }),
    refused: { type, ...(options.fields ? { fields: options.fields } : {}) },
  });
  const say = (notice: Parameters<typeof noticeText>[0]) => {
    const key = noticeText(notice);
    return { key, en: english.get(key)!, ar: arabic.get(key)! };
  };

  it('a guest making a section: the new section was removed', () => {
    const text = say(denied('section.create', { page: false }));
    expect(text.key).toBe('notices.deniedSection');
    expect(text.en).toBe(
      'You may not make sections in this workspace, so the new section was removed.',
    );
  });

  it('a cover file the person may not read: the page and its cover change, undone', () => {
    const text = say(denied('page.update', { fields: ['coverAssetId'] }));
    expect(text.key).toBe('notices.deniedCover');
    expect(text.en).toContain('“{{title}}”');
    expect(text.en).toContain('cover change was undone');
  });

  it('another change to a page: named, and undone', () => {
    expect(say(denied('page.update', { fields: ['title'] })).key).toBe('notices.deniedChange');
    expect(say(denied('page.update', { fields: ['title'], page: false })).key).toBe(
      'notices.deniedChangeUnnamed',
    );
  });

  it('a page or row added where the person may not add one: not made', () => {
    expect(say(denied('page.create', { page: false })).key).toBe('notices.deniedNewPage');
  });

  it('a page moved where it may not go: back where it was', () => {
    expect(say(denied('page.move')).key).toBe('notices.deniedMove');
    expect(say(denied('page.move', { page: false })).key).toBe('notices.deniedMoveUnnamed');
  });

  it('the workspace renamed by someone who is not an owner or admin', () => {
    expect(say(denied('workspace.update', { fields: ['name'], page: false })).key).toBe(
      'notices.deniedWorkspace',
    );
  });

  it('a section renamed, moved or deleted by a guest', () => {
    expect(say(denied('section.update', { fields: ['name'], page: false })).key).toBe(
      'notices.deniedSectionChange',
    );
    expect(say(denied('section.delete', { page: false })).key).toBe('notices.deniedSectionChange');
  });

  it('the trash: moving there, restoring and deleting for good', () => {
    expect(say(denied('page.trash')).key).toBe('notices.deniedTrash');
    expect(say(denied('page.restore')).key).toBe('notices.deniedRestore');
    expect(say(denied('page.delete')).key).toBe('notices.deniedDelete');
  });

  it("a database's change (a property, a view, a row's value): named, and undone", () => {
    for (const type of ['db.update', 'view.upsert', 'view.delete', 'row.update'])
      expect(say(denied(type, { fields: ['p1'] })).key, type).toBe('notices.deniedChange');
  });

  it("keeps the recovered page's text where a document's edit access was lost", () => {
    expect(noticeText({ code: 'access.denied', pageId })).toBe('notices.accessDenied');
    expect(noticeText({ code: 'access.denied', pageId, setAside: true })).toBe(
      'notices.accessDenied',
    );
    expect(noticeTarget({ code: 'access.denied', pageId }, null)).toEqual({
      kind: 'recovered',
      pageId: null,
    });
    // An operation's refusal never speaks of a recovered page, whatever else waits in the list.
    for (const type of ['section.create', 'page.update', 'page.move', 'page.create'])
      expect(say({ ...denied(type), setAside: true }).en, type).not.toMatch(/recovered/);
  });

  it('every text in English and Arabic, naming a page only when there is one', () => {
    const types = [
      'section.create',
      'section.update',
      'section.delete',
      'workspace.update',
      'page.create',
      'page.update',
      'page.move',
      'page.trash',
      'page.restore',
      'page.delete',
      'db.update',
      'view.upsert',
      'view.delete',
      'row.update',
      'favourite.set',
    ];
    const seen = new Set<string>();
    for (const type of types)
      for (const page of [true, false])
        for (const fields of [undefined, ['coverAssetId']]) {
          const text = say(denied(type, { page, fields }));
          seen.add(text.key);
          expect(text.en, text.key).toBeTruthy();
          expect(text.ar, text.key).toMatch(/\p{Script=Arabic}/u);
          expect(text.ar.includes('{{title}}'), text.key).toBe(text.en.includes('{{title}}'));
          expect(text.en, text.key).not.toMatch(/recovered/);
          // A text with a title is chosen only when the answer names a page.
          if (!page) expect(text.en.includes('{{title}}'), `${type} without a page`).toBe(false);
        }
    expect(seen.size).toBe(12);
  });
});
