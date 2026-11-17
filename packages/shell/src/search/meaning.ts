// Search by meaning in the palette (Phase 10, M10.3; decisions, 2026-11-18): once the person
// pauses typing, online, in a workspace kept on the account with search by meaning on, the server
// is asked which pages the question means (`GET …/search/meaning`), and the pages the words did
// not find are shown after the word results under "Related by meaning". The server embeds the
// question, keeps the vectors and checks every hit against what the person may read at that
// moment; no vector reaches this tab. A refusal or a failure shows nothing more: the word results
// stand on their own.
import type { ApiClient } from '@cgw/api';
import type { Id } from '@cgw/workspace';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Cloud } from '../cloud/cloud';
import { aiContextOf, type AiHandle } from '../ai/context';
import type { AiContext, AiSettingsState } from '../ai/store';
import type { RemoteSearchHit, WorkspaceSession } from '../session';

/** How long the person stops typing before the question is asked. */
export const MEANING_PAUSE_MS = 500;
/** Questions shorter than this are not asked: a letter or two means nothing yet. */
export const MEANING_MIN_CHARACTERS = 3;
/** The route's own limit on a question. */
export const MEANING_MAX_CHARACTERS = 1_000;
/** Pages asked for, of which those the words did not find are shown. */
export const MEANING_LIMIT = 10;

/** Whether search by meaning may be asked now: as AI's own rules, with its switch, not AI's. */
export function meaningOffered(state: AiSettingsState, context: AiContext): boolean {
  if (!context.signedIn || !context.synced || context.role === 'guest' || !context.online) {
    return false;
  }
  const settings = state.status === 'idle' ? null : state.settings;
  return settings?.embeddings?.enabled === true;
}

/** The question as the route takes it: trimmed, at most 1,000 characters; null if too short. */
export function meaningQuestion(text: string): string | null {
  const q = text.trim().slice(0, MEANING_MAX_CHARACTERS).trim();
  return q.length >= MEANING_MIN_CHARACTERS ? q : null;
}

/** Why the route refused, by its code (`ai.disabled`, `access.denied`, …), or `network`. */
export class MeaningError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(`Search by meaning: ${code}`);
    this.name = 'MeaningError';
  }
}

/** The route, through the cloud's client: the same hits as word search's. */
export async function meaningSearch(
  api: ApiClient,
  workspaceId: Id,
  q: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<RemoteSearchHit[]> {
  let result;
  try {
    result = await api.GET('/api/v1/workspaces/{workspaceId}/search/meaning', {
      params: { path: { workspaceId }, query: { q, limit: options.limit ?? MEANING_LIMIT } },
      signal: options.signal,
    });
  } catch {
    throw new MeaningError(options.signal?.aborted ? 'aborted' : 'network');
  }
  if (!result.response.ok || !result.data) {
    // The client has read the problem's body already: its code is in `error`.
    const body = result.error as { code?: unknown } | undefined;
    throw new MeaningError(
      typeof body?.code === 'string' ? body.code : 'server.error',
      result.response.status,
    );
  }
  return result.data.hits.map((hit): RemoteSearchHit => ({
    pageId: hit.pageId,
    title: hit.title,
    snippet: hit.snippet,
    score: Number(hit.score),
    kind: hit.kind === 'row' || hit.kind === 'database' ? hit.kind : 'page',
    databaseId: hit.databaseId ?? null,
  }));
}

/**
 * What meaning adds to the word results: its pages the words did not find and the tab does not
 * hold as trashed, in the server's order.
 */
export function relatedByMeaning(
  words: readonly Pick<RemoteSearchHit, 'pageId'>[],
  meaning: readonly RemoteSearchHit[],
  trashed: (pageId: Id) => boolean = () => false,
): RemoteSearchHit[] {
  const seen = new Set(words.map((hit) => hit.pageId));
  const out: RemoteSearchHit[] = [];
  for (const hit of meaning) {
    if (seen.has(hit.pageId) || trashed(hit.pageId)) continue;
    seen.add(hit.pageId);
    out.push(hit);
  }
  return out;
}

type Timers = {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};
const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Asks once the person pauses: each question waits `pauseMs`, a newer one (or none) cancels the
 * wait and the request out, and only the latest question's answer is handed on.
 */
export class MeaningAsker {
  #wait: unknown = null;
  #controller: AbortController | null = null;
  #asked: string | null = null;

  constructor(
    private readonly search: (q: string, signal: AbortSignal) => Promise<RemoteSearchHit[]>,
    private readonly onHits: (q: string, hits: RemoteSearchHit[]) => void,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly pauseMs = MEANING_PAUSE_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  /** The question now (null: none); the same one again changes nothing. */
  ask(q: string | null): void {
    if (q === this.#asked) return;
    this.cancel();
    this.#asked = q;
    if (q === null) return;
    this.#wait = this.timers.set(() => {
      this.#wait = null;
      const controller = new AbortController();
      this.#controller = controller;
      this.search(q, controller.signal).then(
        (hits) => {
          if (controller.signal.aborted || this.#asked !== q) return;
          this.#controller = null;
          this.onHits(q, hits);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          this.#controller = null;
          this.onError(error);
        },
      );
    }, this.pauseMs);
  }

  cancel(): void {
    if (this.#wait !== null) this.timers.clear(this.#wait);
    this.#wait = null;
    this.#controller?.abort();
    this.#controller = null;
    this.#asked = null;
  }
}

/**
 * The palette's pages by meaning for what was typed: the answer for the question as it stands,
 * empty while it is asked or when meaning is not offered. A refusal as `ai.disabled` means this
 * tab's settings are stale: they are read again.
 */
export function useMeaning(
  cloud: Cloud | null,
  session: WorkspaceSession,
  ai: AiHandle | null,
  query: string,
): { readonly question: string | null; readonly hits: readonly RemoteSearchHit[] } {
  const workspaceId = ai?.workspaceId ?? null;
  const store = ai?.store ?? null;
  // The settings as read: they may come in after the last key (AI's own availability may not
  // change with them, when completions are off).
  const subscribe = useMemo(
    () => (listener: () => void) => (store ? store.subscribe(listener) : () => {}),
    [store],
  );
  const state = useSyncExternalStore(subscribe, () =>
    store && workspaceId ? store.state(workspaceId) : null,
  );
  const offered =
    !!cloud && !!state && meaningOffered(state, aiContextOf(cloud, session, workspaceId));
  const question = offered ? meaningQuestion(query) : null;
  const [answer, setAnswer] = useState<{ q: string; hits: RemoteSearchHit[] } | null>(null);
  const api = cloud?.api ?? null;
  const asker = useMemo(
    () =>
      api && workspaceId
        ? new MeaningAsker(
            (q, signal) => meaningSearch(api, workspaceId, q, { signal }),
            (q, hits) => setAnswer({ q, hits }),
            (error) => {
              if (error instanceof MeaningError && error.code === 'ai.disabled') {
                store?.load(workspaceId, true);
              }
            },
          )
        : null,
    [api, workspaceId, store],
  );
  useEffect(() => () => asker?.cancel(), [asker]);
  useEffect(() => {
    asker?.ask(question);
  }, [asker, question]);
  return {
    question,
    hits: answer && question !== null && answer.q === question ? answer.hits : NONE,
  };
}

const NONE: readonly RemoteSearchHit[] = Object.freeze([]);
