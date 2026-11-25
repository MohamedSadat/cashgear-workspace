// AI's routes on Workspace's API, through the cloud's own client: the API's cookie with its
// antiforgery header on the web, the bearer token on the desktop (`@cgw/api`). The completion's
// answer is read as it streams.
import { ApiError, NetworkError, problemOf, type ApiClient, type Schemas } from '@cgw/api';
import type { Id } from '@cgw/workspace';
import { readAiEvents } from './events';
import {
  AiError,
  LOCAL_EMBEDDINGS_MODEL,
  type AiCompleteRequest,
  type AiEvent,
  type AiSettings,
  type AiSettingsChange,
  type Allowance,
  type EmbeddingsSettings,
  type KeySource,
} from './types';

/** What the AI client needs of the server; tests give their own. */
export interface AiApi {
  settings(workspaceId: Id): Promise<AiSettings>;
  saveSettings(workspaceId: Id, change: AiSettingsChange): Promise<AiSettings>;
  /** The answer's events in order; throws an `AiError`. */
  complete(request: AiCompleteRequest, signal?: AbortSignal): AsyncGenerator<AiEvent>;
}

/**
 * An `AiError` for what went wrong with a request. `body` is the problem openapi-fetch already
 * read from an answer that was not ok (it consumes the body, so `problemOf` alone finds no code).
 */
async function failure(error: unknown, response?: Response, body?: unknown): Promise<AiError> {
  if (error instanceof AiError) return error;
  if (response) {
    const read = body as { code?: unknown; reason?: unknown } | null | undefined;
    const problem =
      typeof read?.code === 'string'
        ? {
            // Phase 13: a workspace past its allowance on Cash Gear's subscription is its own case.
            code:
              read.code === 'ai.limit' && read.reason === 'allowance' ? 'ai.allowance' : read.code,
            status: response.status,
          }
        : await problemOf(response);
    const retry = Number(response.headers.get('Retry-After'));
    return new AiError(
      problem.code,
      problem.status,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  if (error instanceof ApiError) return new AiError(error.code, error.status);
  if (error instanceof DOMException && error.name === 'AbortError') return new AiError('aborted');
  if (error instanceof NetworkError || error instanceof TypeError) return new AiError('network');
  return new AiError('server.error');
}

const count = (value: number | string | undefined | null) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const sourceOf = (value: unknown): KeySource => (value === 'subscription' ? 'subscription' : 'own');

/** Phase 13: a month on the subscription, counts as numbers; absent when not offered. */
function allowanceOf(dto: Schemas['AllowanceDto'] | null | undefined): Allowance | null {
  if (!dto) return null;
  return {
    month: dto.month,
    allowance: count(dto.allowance),
    used: count(dto.used),
    reserved: count(dto.reserved),
  };
}

/** Phase 10: search by meaning's settings as the contract's; null from a server before it. */
export function embeddingsOf(
  dto: Schemas['EmbeddingsSettingsDto'] | null | undefined,
): EmbeddingsSettings | null {
  if (!dto) return null;
  const subscription = allowanceOf(dto.subscription);
  return {
    enabled: dto.enabled,
    provider: dto.model === LOCAL_EMBEDDINGS_MODEL ? 'local' : 'voyage',
    model: dto.model,
    models: dto.models,
    keySource: sourceOf(dto.keySource),
    ...(subscription ? { subscription } : {}),
    ...(dto.hasKey === undefined || dto.hasKey === null ? {} : { hasKey: dto.hasKey }),
    ...(dto.keySetAt === undefined ? {} : { keySetAt: dto.keySetAt }),
    ...(dto.keySetBy === undefined ? {} : { keySetBy: dto.keySetBy }),
    ...(dto.usage
      ? {
          usage: {
            month: dto.usage.month,
            requests: count(dto.usage.requests),
            tokens: count(dto.usage.tokens),
          },
        }
      : {}),
    ...(dto.progress
      ? { progress: { pages: count(dto.progress.pages), embedded: count(dto.progress.embedded) } }
      : {}),
  };
}

/** The server's settings as the contract's (counts as numbers, absent fields as absent). */
export function settingsOf(dto: Schemas['AiSettingsDto']): AiSettings {
  const embeddings = embeddingsOf(dto.embeddings);
  const subscription = allowanceOf(dto.subscription);
  const limits = dto.limits;
  return {
    enabled: dto.enabled,
    provider: dto.provider === 'local' ? 'local' : 'anthropic',
    model: dto.model,
    models: dto.models,
    ...(dto.localModel ? { localModel: dto.localModel } : {}),
    ...(limits
      ? {
          limits: {
            rewriteText: count(limits.rewriteText),
            pageText: count(limits.pageText),
            prompt: count(limits.prompt),
            question: count(limits.question),
            instruction: count(limits.instruction),
            requestPrompt: count(limits.requestPrompt),
          },
        }
      : {}),
    keySource: sourceOf(dto.keySource),
    ...(subscription ? { subscription } : {}),
    ...(dto.hasKey === undefined || dto.hasKey === null ? {} : { hasKey: dto.hasKey }),
    ...(dto.keySetAt === undefined ? {} : { keySetAt: dto.keySetAt }),
    ...(dto.keySetBy === undefined ? {} : { keySetBy: dto.keySetBy }),
    ...(dto.usage
      ? {
          usage: {
            month: dto.usage.month,
            requests: count(dto.usage.requests),
            inputTokens: count(dto.usage.inputTokens),
            outputTokens: count(dto.usage.outputTokens),
          },
        }
      : {}),
    ...(embeddings ? { embeddings } : {}),
  };
}

export function cloudAiApi(api: ApiClient): AiApi {
  return {
    async settings(workspaceId) {
      const result = await api
        .GET('/api/v1/workspaces/{workspaceId}/ai-settings', {
          params: { path: { workspaceId } },
        })
        .catch(async (error: unknown) => {
          throw await failure(error);
        });
      if (!result.response.ok || !result.data)
        throw await failure(null, result.response, result.error);
      return settingsOf(result.data);
    },
    async saveSettings(workspaceId, change) {
      const result = await api
        .PUT('/api/v1/workspaces/{workspaceId}/ai-settings', {
          params: { path: { workspaceId } },
          body: change,
        })
        .catch(async (error: unknown) => {
          throw await failure(error);
        });
      if (!result.response.ok || !result.data)
        throw await failure(null, result.response, result.error);
      return settingsOf(result.data);
    },
    async *complete(request, signal) {
      let result: { data?: unknown; error?: unknown; response: Response };
      try {
        result = await api.POST('/api/v1/ai/complete', {
          body: request,
          parseAs: 'stream',
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw new AiError('aborted');
        throw await failure(error);
      }
      if (!result.response.ok) throw await failure(null, result.response, result.error);
      const body = result.data as ReadableStream<Uint8Array> | null | undefined;
      if (!body) throw new AiError('response.invalid');
      yield* readAiEvents(body, signal);
    },
  };
}
