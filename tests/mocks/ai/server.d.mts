// Types for server.mjs, for the browser tests and the benches.

export declare const DEFAULT_PORT: number;

/** The first 16 hex digits of the key's SHA-256: how a request names its key. */
export declare function keyId(key: string): string;

export declare function actionOf(body: unknown): string | null;

export declare function defaultAnswer(body: unknown): { text?: string; json?: unknown };

export interface MockAiRequest {
  readonly id: string;
  readonly at: string;
  readonly keyId: string | null;
  readonly version: string | null;
  readonly beta: readonly string[];
  readonly action: string | null;
  /** The Messages API body as the server sent it. */
  readonly body: {
    readonly model: string;
    readonly max_tokens: number;
    readonly system?: unknown;
    readonly messages: readonly { readonly role: string; readonly content: unknown }[];
    readonly stream?: boolean;
    readonly [key: string]: unknown;
  };
  /** Milliseconds from the request to the first text sent: the provider's own time. */
  readonly firstTextMs: number | null;
}

export interface MockAiScript {
  /** The key this answer is for (or its `keyId`); absent: the next request with any key. */
  readonly key?: string;
  readonly keyId?: string;
  readonly text?: string;
  readonly json?: unknown;
  readonly stopReason?: 'end_turn' | 'max_tokens';
  readonly refusal?: boolean;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly chunkDelayMs?: number;
  readonly times?: number;
}

export interface MockAiFault {
  readonly key?: string;
  readonly keyId?: string;
  readonly status?: number;
  readonly latencyMs?: number;
  /** Drop the connection before answering, or halfway through the stream (Messages only). */
  readonly drop?: 'before' | 'after';
  readonly times?: number;
  /** Phase 10: `embeddings` queues the failure for `POST /v1/embeddings`; absent, for Messages. */
  readonly endpoint?: 'messages' | 'embeddings';
}

/** Phase 10: one `POST /v1/embeddings` call, as `GET /__mock/embeddings` lists it. */
export interface MockEmbeddingCall {
  readonly id: string;
  readonly at: string;
  readonly keyId: string | null;
  readonly model: string | null;
  readonly inputType: 'query' | 'document' | null;
  readonly outputDimension: number | null;
  readonly outputDtype: string | null;
  readonly truncation: boolean | null;
  readonly count: number;
  readonly inputs: readonly string[];
  /** The headers' names, never their values. */
  readonly headers: readonly string[];
}

export declare class MockAi {
  readonly requests: MockAiRequest[];
  readonly embeddings: MockEmbeddingCall[];
  reset(): void;
}

export declare function startMockAi(options?: {
  port?: number;
  host?: string;
}): Promise<{ url: string; mock: MockAi; close(): Promise<void> }>;
