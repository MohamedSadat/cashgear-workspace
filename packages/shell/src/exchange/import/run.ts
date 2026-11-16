// An import from start to end (M8.4): planned off the main thread (import.worker.ts: unzipping,
// reading every file, building every operation), then written through the session
// (write.ts). It runs on the device, in a local workspace and a synced one alike; the server never
// sees the archive, only the pages, rows and assets it makes (DECISIONS.md, 2026-11-16).
import type { Id } from '@cgw/workspace';
import type { WorkspaceSession } from '../../session';
import {
  planImport,
  type ImportKind,
  type ImportPlan,
  type ImportRequest,
  type ImportSource,
} from './plan';
import { ImportRefused, type ImportReport, type RefusalCode } from './report';
import { writePlan, type WriteProgress } from './write';

export interface ImportInput {
  kind: ImportKind;
  source: ImportSource;
  /** The section of the open workspace the new top page goes at the end of. */
  sectionId: Id;
  untitled: string;
  viewName: string;
  name?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Reading (the plan being made), then writing, with how far it got. */
  onPhase?(phase: 'reading' | 'writing', progress?: WriteProgress): void;
  /** Plans on this thread instead of a worker (tests). */
  inline?: boolean;
}

export interface ImportOutcome {
  topId: Id;
  report: ImportReport;
}

type WorkerAnswer =
  { ok: ImportPlan } | { refused: RefusalCode; count?: number } | { error: string };

function planInWorker(request: ImportRequest, signal?: AbortSignal): Promise<ImportPlan> {
  const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<ImportPlan>((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(new ImportRefused('stopped'));
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    const done = () => {
      signal?.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<WorkerAnswer>) => {
      done();
      const answer = event.data;
      if ('ok' in answer) resolve(answer.ok);
      else if ('refused' in answer) reject(new ImportRefused(answer.refused, answer.count));
      else reject(new ImportRefused('damaged', undefined, { cause: new Error(answer.error) }));
    };
    worker.onerror = (event) => {
      done();
      reject(new ImportRefused('failed', undefined, { cause: new Error(event.message) }));
    };
    // The files move to the worker: they are not needed here again.
    const buffers =
      request.source.kind === 'bytes'
        ? [request.source.bytes.buffer]
        : request.source.files.map((f) => f.bytes.buffer);
    worker.postMessage(request, [...new Set(buffers)] as ArrayBuffer[]);
  });
}

/** Plans and writes an import into the open workspace; throws `ImportRefused` with nothing made. */
export async function runImport(
  session: WorkspaceSession,
  input: ImportInput,
  options: RunOptions = {},
): Promise<ImportOutcome> {
  const workspaceId = session.workspaceId;
  if (!workspaceId || !session.mirror.sections.has(input.sectionId))
    throw new ImportRefused('failed');
  options.onPhase?.('reading');
  // Pending edits first, so the top page's place among its siblings is known.
  await session.flushAll();
  const request: ImportRequest = {
    kind: input.kind,
    source: input.source,
    untitled: input.untitled,
    viewName: input.viewName,
    ...(input.name ? { name: input.name } : {}),
    place: {
      workspaceId,
      sectionId: input.sectionId,
      orderKey: session.keyFor(input.sectionId, null),
    },
  };
  // Where there is no worker (an old WebView), the plan is made on this thread.
  const plan =
    options.inline || typeof Worker === 'undefined'
      ? await planImport(request)
      : await planInWorker(request, options.signal);
  if (options.signal?.aborted) throw new ImportRefused('stopped');
  options.onPhase?.('writing', { done: 0, total: plan.ops.length });
  await writePlan(session, plan, {
    signal: options.signal,
    onProgress: (progress) => options.onPhase?.('writing', progress),
  });
  return { topId: plan.topId, report: plan.report };
}
