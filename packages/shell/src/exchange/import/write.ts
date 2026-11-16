// An import's plan written through the session (M8.4): the assets first (local store first; the
// engine uploads them when the workspace syncs, before the operations of each pass, so a row's
// files never reach the server before their bytes), then the operations in batches in the plan's
// order (parents first, relations, rows, rows' relations), then each page's first document. An import
// that fails or is stopped leaves nothing made: everything hangs under the plan's new top page,
// which is trashed and deleted for good in one batch, its documents, rows and search entries with
// it (DECISIONS.md, Phase 8). In a synced workspace the server may refuse the delete to someone
// without full access to the section: what was made then stays in the trash, never in the tree.
import { newOp, type Id } from '@cgw/workspace';
import type { WorkspaceSession } from '../../session';
import type { ImportPlan } from './plan';
import { ImportRefused } from './report';

/** Operations per `apply` (each one transaction of the store), as the export's import writes. */
export const OP_BATCH = 500;

export interface WriteProgress {
  done: number;
  total: number;
}

export interface WriteOptions {
  signal?: AbortSignal;
  onProgress?(progress: WriteProgress): void;
}

const stopped = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw new ImportRefused('stopped');
};

/** Writes the plan; on a failure or a stop, removes what it wrote and throws. */
export async function writePlan(
  session: WorkspaceSession,
  plan: ImportPlan,
  options: WriteOptions = {},
): Promise<void> {
  const { signal, onProgress } = options;
  const total = plan.ops.length + plan.assets.length + plan.documents.length;
  let done = 0;
  const step = (n: number) => {
    done += n;
    onProgress?.({ done, total });
  };
  let started = false;
  try {
    stopped(signal);
    for (const { record, bytes } of plan.assets) {
      stopped(signal);
      await session.store.putAsset(record, bytes);
      session.mirror.putAsset(record);
      step(1);
    }
    for (let i = 0; i < plan.ops.length; i += OP_BATCH) {
      stopped(signal);
      const batch = plan.ops.slice(i, i + OP_BATCH);
      // From the first batch on, the top page exists and holds whatever was written.
      started = true;
      await session.apply(batch);
      step(batch.length);
    }
    for (const { pageId, content } of plan.documents) {
      stopped(signal);
      await session.writeFirstDocument(pageId, plan.workspaceId, content);
      step(1);
    }
  } catch (error) {
    if (started) await removeImport(session, plan);
    if (error instanceof ImportRefused) throw error;
    throw new ImportRefused('failed', undefined, { cause: error });
  }
}

/** Everything an import made, removed: its top page trashed and deleted for good. */
export async function removeImport(session: WorkspaceSession, plan: ImportPlan): Promise<void> {
  const { workspaceId, topId } = plan;
  if (!session.mirror.pages.has(topId)) return;
  try {
    // The rows of its databases are in the mirror (made here), so the delete takes them too.
    for (const id of plan.databases)
      if (session.mirror.databases.has(id)) await session.loadRows(id);
    await session.apply([
      newOp('page.trash', workspaceId, topId, {}),
      newOp('page.delete', workspaceId, topId, {}),
    ]);
  } catch (error) {
    console.warn('An import could not be removed after it failed:', error);
  }
  // A page indexed while it was written is not found by search any more.
  await session.store.deleteSearchEntries(plan.pageIds as Id[]).catch(() => undefined);
}
