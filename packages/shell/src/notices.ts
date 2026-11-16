// What the app says when the sync engine or a page's document reports something (contracts §3's
// notice codes, SYNC_DESIGN.md, What the user sees): what happened, and where the work is: the
// recovered page, the trash, the page's history, or the page itself.
import type { Id } from '@cgw/workspace';
import type { en } from './i18n/en';

type NoticeKey = `notices.${keyof (typeof en)['notices']}`;

/** Codes whose unsent changes the engine set aside: they become recovered pages. */
export const RECOVERY_CODES: ReadonlySet<string> = new Set([
  'doc.epochMismatch',
  'page.gone',
  'access.denied',
  'page.removed',
  'workspace.lost',
]);

/** Where a notice's link goes. */
export type NoticeTarget =
  | { kind: 'recovered'; pageId: Id | null }
  | { kind: 'trash' }
  | { kind: 'history'; pageId: Id }
  | { kind: 'page'; pageId: Id }
  | { kind: 'block'; pageId: Id; blockId: string };

export interface NoticeInfo {
  code: string;
  pageId?: Id;
  blockId?: string;
  /** `doc.moveConflict`: `editLost` or `movedTwice`. */
  reason?: string;
  /**
   * For a code of RECOVERY_CODES: whether anything was set aside. A restore pulled with nothing
   * unsent here sets nothing aside, and the notice says only what happened.
   */
  setAside?: boolean;
  /** An operation the server refused (the engine names it): its type, the fields an update set. */
  refused?: { type: string; fields?: string[] };
}

/**
 * An operation refused for access (`access.denied` on the operations route): what was refused,
 * and that it was undone. The same code on a page's document (edit access lost, its unsent edits
 * set aside) keeps the recovered page's text.
 */
function deniedText(
  { type, fields }: NonNullable<NoticeInfo['refused']>,
  pageId: Id | undefined,
): NoticeKey {
  switch (type) {
    case 'section.create':
      return 'notices.deniedSection';
    case 'section.update':
    case 'section.delete':
      return 'notices.deniedSectionChange';
    case 'workspace.update':
      return 'notices.deniedWorkspace';
    case 'page.create':
      // A refused create has no page on the server, so its answer names none.
      return 'notices.deniedNewPage';
    case 'page.move':
      return pageId ? 'notices.deniedMove' : 'notices.deniedMoveUnnamed';
  }
  if (!pageId) return 'notices.deniedChangeUnnamed';
  switch (type) {
    case 'page.update':
      return fields?.includes('coverAssetId') ? 'notices.deniedCover' : 'notices.deniedChange';
    case 'page.trash':
      return 'notices.deniedTrash';
    case 'page.restore':
      return 'notices.deniedRestore';
    case 'page.delete':
      return 'notices.deniedDelete';
    default:
      return 'notices.deniedChange';
  }
}

/** The catalogue key of a notice's text. Texts with a page name take `title`. */
export function noticeText(notice: NoticeInfo): NoticeKey {
  switch (notice.code) {
    case 'doc.epochMismatch':
      return notice.setAside === false ? 'notices.restored' : 'notices.epochMismatch';
    case 'page.gone':
      return 'notices.pageGone';
    case 'access.denied':
      return notice.refused ? deniedText(notice.refused, notice.pageId) : 'notices.accessDenied';
    case 'page.removed':
      return 'notices.pageRemoved';
    case 'page.trashed':
      return 'notices.pageTrashed';
    case 'tree.parentMissing':
      return 'notices.parentMissing';
    case 'tree.cycle':
      return 'notices.cycle';
    case 'version.conflict':
      return 'notices.versionConflict';
    case 'client.tooOld':
      return 'notices.clientTooOld';
    case 'doc.refused':
      return 'notices.refused';
    case 'doc.clientTaken':
      return 'notices.clientTaken';
    case 'doc.repaired':
      return 'notices.repaired';
    case 'doc.repairFailed':
      return 'notices.repairFailed';
    case 'limit.size':
      return 'notices.tooLarge';
    case 'asset.typeNotAllowed':
      return 'notices.typeNotAllowed';
    case 'workspace.lost':
      return 'notices.workspaceLost';
    case 'doc.moveConflict':
      return notice.reason === 'movedTwice' ? 'notices.moveTwice' : 'notices.moveEditLost';
    case 'not.found':
      return 'notices.notFound';
    // Refused operations (OpsService): what happened meanwhile on another device. A refused move
    // answers the page; a refused create has no page on the server.
    case 'tree.section':
      return notice.pageId ? 'notices.otherSection' : 'notices.otherSectionNew';
    case 'section.notEmpty':
      return 'notices.sectionNotEmpty';
    case 'page.notTrashed':
      return 'notices.notTrashed';
    default:
      // `invalid`, `request.invalid`, and any code this app does not know: the server refused a
      // change this device let through. Nothing says it is gone; that is `not.found`'s alone.
      return notice.pageId ? 'notices.notAccepted' : 'notices.notAcceptedUnnamed';
  }
}

/**
 * Where the work is. `recoveredPageId` is the page made of what was set aside, once made; the
 * list of recovered pages until then.
 */
export function noticeTarget(notice: NoticeInfo, recoveredPageId?: Id | null): NoticeTarget | null {
  const { code, pageId, blockId } = notice;
  if (code === 'doc.epochMismatch' && notice.setAside === false)
    return pageId ? { kind: 'history', pageId } : null;
  // An operation refused for access: the page as the server has it (in the trash, for a restore
  // or a delete that was refused); nothing was set aside.
  if (code === 'access.denied' && notice.refused) {
    if (!pageId) return null;
    const type = notice.refused.type;
    return type === 'page.restore' || type === 'page.delete'
      ? { kind: 'trash' }
      : { kind: 'page', pageId };
  }
  if (RECOVERY_CODES.has(code)) return { kind: 'recovered', pageId: recoveredPageId ?? null };
  if (code === 'page.trashed') return { kind: 'trash' };
  if (!pageId) return null;
  switch (code) {
    case 'doc.moveConflict':
      return notice.reason === 'movedTwice' && blockId
        ? { kind: 'block', pageId, blockId }
        : { kind: 'history', pageId };
    case 'doc.refused':
    case 'doc.clientTaken':
    case 'doc.repairFailed':
    case 'limit.size':
      return { kind: 'history', pageId };
    case 'tree.parentMissing':
    case 'version.conflict':
    case 'doc.repaired':
    case 'tree.section':
    case 'page.notTrashed':
    case 'invalid':
    case 'request.invalid':
      return { kind: 'page', pageId };
    default:
      return null;
  }
}

/** The catalogue key of a target's link text. */
export function targetLabel(target: NoticeTarget): NoticeKey {
  switch (target.kind) {
    case 'recovered':
      return target.pageId ? 'notices.openRecovered' : 'notices.openRecoveredList';
    case 'trash':
      return 'notices.openTrash';
    case 'history':
      return 'notices.openHistory';
    case 'block':
      return 'notices.showBlock';
    default:
      return 'notices.openPage';
  }
}
