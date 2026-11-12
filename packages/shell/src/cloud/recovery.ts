// Recovered pages (M3.3; SYNC_DESIGN.md, Across the two models and Epoch change): what the sync
// engine set aside so nothing typed is lost (the store's quarantine) becomes a page
// "Recovered: {title}" at the top of the account's private section of the entry's workspace, or
// of the open workspace when that one is gone. Its content is the entry's log merged and read as
// ProseMirror JSON (`recoveredContent`), written as the new page's first document. Then the entry
// is settled as recovered, naming the page.
//
// The engine says `recover` after every pass while an entry is pending, every tab runs its own
// engine on the same store, and the app can stop at any point, so making a page is idempotent:
// - one run at a time in this tab, and across tabs under a Web Lock, each reading the entries
//   afresh;
// - the recovered page's id is derived from the entry's id, so a page made before a restart (or
//   by another tab without locks) is found, given its document if it has none yet, and settled,
//   never made twice.
import { keyBetween, type Id, type QuarantineEntry } from '@cgw/workspace';
import type { WorkspaceSession } from '../session';

/** An entry as the interface lists it: everything but the set-aside bytes. */
export type RecoveredItem = Omit<QuarantineEntry, 'parts'>;

const LOCK = 'cgw-recover';
/** While entries wait for a private section, the store is read again at most this often. */
const BLOCKED_RETRY_MS = 30_000;

/**
 * The recovered page's id for an entry: the entry's time (its UUIDv7 prefix) and bits of a hash of
 * its id, as a UUIDv7. The same entry always gives the same page.
 */
export async function recoveredPageId(entryId: Id): Promise<Id> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`cgw-recovered:${entryId}`),
    ),
  );
  const bytes = new Uint8Array(16);
  const hex = entryId.replace(/-/g, '');
  for (let i = 0; i < 6; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  bytes.set(digest.subarray(0, 10), 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const out = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

type Locks = { request<T>(name: string, run: () => Promise<T>): Promise<T> };

function withLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
  return locks ? locks.request(LOCK, run) : run();
}

const strip = ({ parts, ...item }: QuarantineEntry): RecoveredItem => (void parts, item);

export class Recovery {
  /** Every entry, newest first, as last read (dismissed ones included). */
  private items_: RecoveredItem[] = [];
  private revision = 0;
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  /** Entries waited for a private section at this mirror revision and time. */
  private blocked: { revision: number; at: number } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly session: WorkspaceSession,
    /** "Recovered: {title}", in the interface language. */
    private readonly titleFor: (title: string) => string,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getRevision = () => this.revision;

  get items(): readonly RecoveredItem[] {
    return this.items_;
  }

  /**
   * Entries to list with the open workspace: its own, those whose page was recovered into it,
   * and those of workspaces no longer on this device. Dismissed ones are left out.
   */
  visible(): RecoveredItem[] {
    const open = this.session.workspaceId;
    const { mirror } = this.session;
    return this.items_.filter((item) => {
      if (item.status === 'dismissed') return false;
      if (item.workspaceId === open || !mirror.workspaces.has(item.workspaceId)) return true;
      const page = item.recoveredPageId ? mirror.pages.get(item.recoveredPageId) : undefined;
      return page?.workspaceId === open;
    });
  }

  /** The newest entry set aside from a page. */
  latestFor(pageId: Id): RecoveredItem | undefined {
    return this.items_.find((item) => item.pageId === pageId);
  }

  private bump() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Makes pages of the pending entries. Calls while one runs share one more run after it, which
   * reads the store again; `force` reads it even while entries wait for a private section.
   */
  run(force = false): Promise<void> {
    if (force) this.blocked = null;
    if (this.queued) return this.queued;
    const next = this.chain.then(() => {
      this.queued = null;
      return this.pass().catch((error: unknown) =>
        console.warn('Recovered pages could not be made:', error),
      );
    });
    this.queued = next;
    this.chain = next;
    return next;
  }

  /** Waits for a run that sees what the store holds now, at most `ms`. */
  settled(ms = 3000): Promise<void> {
    return Promise.race([this.run(true), new Promise<void>((done) => setTimeout(done, ms))]);
  }

  async dismiss(id: Id): Promise<void> {
    const item = this.items_.find((i) => i.id === id);
    if (!item || item.status !== 'recovered') return;
    await this.session.store.settleQuarantine(id, 'dismissed', item.recoveredPageId);
    this.items_ = this.items_.map((i) => (i.id === id ? { ...i, status: 'dismissed' } : i));
    this.bump();
  }

  private async pass() {
    const blocked = this.blocked;
    if (
      blocked &&
      blocked.revision === this.session.mirror.getRevision() &&
      Date.now() - blocked.at < BLOCKED_RETRY_MS
    )
      return;
    await withLock(async () => {
      const entries = await this.session.store.quarantine(null);
      let waiting = false;
      // Oldest first, each at the top of its section: the newest ends on top.
      for (const entry of [...entries].reverse()) {
        if (entry.status !== 'pending') continue;
        const pageId = await this.recover(entry);
        if (pageId) {
          entry.status = 'recovered';
          entry.recoveredPageId = pageId;
        } else waiting = true;
      }
      this.blocked = waiting
        ? { revision: this.session.mirror.getRevision(), at: Date.now() }
        : null;
      // A page another tab recovered is in the store before this tab's mirror knows it.
      for (const entry of entries)
        if (
          entry.status === 'recovered' &&
          entry.recoveredPageId &&
          !this.session.mirror.pages.has(entry.recoveredPageId) &&
          (await this.session.store.getPage(entry.recoveredPageId))
        ) {
          await this.session.reloadMirror();
          break;
        }
      const items = entries.map(strip);
      if (JSON.stringify(items) !== JSON.stringify(this.items_)) {
        this.items_ = items;
        this.bump();
      }
    });
  }

  /** Where an entry's page goes: a private section of its workspace, else of the open one. */
  private target(entry: QuarantineEntry): { workspaceId: Id; sectionId: Id } | null {
    const { mirror } = this.session;
    for (const workspaceId of [entry.workspaceId, this.session.workspaceId]) {
      const workspace = workspaceId ? mirror.workspaces.get(workspaceId) : undefined;
      if (!workspace || workspace.deletedAt) continue;
      const section = mirror.sectionsOf(workspace.id).find((s) => s.visibility === 'private');
      if (section) return { workspaceId: workspace.id, sectionId: section.id };
    }
    return null;
  }

  /** Makes (or finishes) one entry's page and settles the entry; null if it must wait. */
  private async recover(entry: QuarantineEntry): Promise<Id | null> {
    const { session } = this;
    const pageId = await recoveredPageId(entry.id);
    const existing = await session.store.getPage(pageId);
    if (!existing) {
      const target = this.target(entry);
      if (!target) return null;
      const content = await contentOf(entry);
      await session.createRecoveredPage(
        {
          id: pageId,
          ...target,
          title: this.titleFor(entry.title),
          orderKey: keyBetween(
            null,
            session.mirror.topPages(target.sectionId)[0]?.orderKey ?? null,
          ),
        },
        content,
      );
    } else {
      // Made before the app stopped, or by another tab: its document, if it has none yet.
      const doc = await session.store.loadDoc(pageId);
      if (!doc.snapshot && !doc.updates.length)
        await session.writeFirstDocument(pageId, existing.workspaceId, await contentOf(entry));
      if (!session.mirror.pages.has(pageId)) await session.reloadMirror();
    }
    await session.store.settleQuarantine(entry.id, 'recovered', pageId);
    return pageId;
  }
}

async function contentOf(entry: QuarantineEntry) {
  const { recoveredContent } = await import('@cgw/doc');
  const json = recoveredContent(entry.parts);
  // Nothing readable: the page still gets its one empty paragraph.
  return json.content?.length ? json : undefined;
}
