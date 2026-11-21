// AI's contract with Workspace's API (INTEGRATIONS.md, AI, "As agreed for 0.7.0"): the settings,
// the completion request and the events its answer streams. The client never talks to a provider:
// only to these routes.
import type { Id } from '@cgw/workspace';

export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];

export interface AiUsageMonth {
  month: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** Phase 13: where a part's calls get their key: the workspace's own, or Cash Gear's subscription. */
export type KeySource = 'own' | 'subscription';

/** Phase 13: a workspace's month on Cash Gear's subscription, in tokens. */
export interface Allowance {
  month: string;
  allowance: number;
  used: number;
  reserved: number;
}

export interface AiSettings {
  /** On, and a key is set. */
  enabled: boolean;
  provider: 'anthropic';
  model: string;
  models: string[];
  /** Owners and admins only. */
  hasKey?: boolean;
  keySetAt?: string | null;
  keySetBy?: { id: string; name: string } | null;
  usage?: AiUsageMonth;
  /** Phase 10: search by meaning; absent from a server before it (read as off). */
  embeddings?: EmbeddingsSettings;
  /** Phase 13: `own` from a server before it. */
  keySource: KeySource;
  /** Phase 13, owners and admins: Cash Gear's subscription when this server offers it to the workspace. */
  subscription?: Allowance;
}

/**
 * Phase 10: search by meaning's own switch, key and model (decisions, 2026-11-18): on while AI
 * completions are off too, since it needs no Anthropic key. The vectors never reach a client.
 */
export interface EmbeddingsSettings {
  /** On, with a key, and AI on for this server. */
  enabled: boolean;
  /** Phase 13: `local` for the model on this server (voyage-4-nano). */
  provider: 'voyage' | 'local';
  /** `voyage-4` unless changed. */
  model: string;
  models: string[];
  /** Owners and admins only. */
  hasKey?: boolean;
  keySetAt?: string | null;
  keySetBy?: { id: string; name: string } | null;
  usage?: { month: string; requests: number; tokens: number };
  /** While on: the pages to embed with this model, and those embedded. */
  progress?: { pages: number; embedded: number };
  /** Phase 13: a Voyage model's key's source (the local model needs none). */
  keySource: KeySource;
  /** Phase 13, owners and admins: Cash Gear's subscription for search by meaning when offered. */
  subscription?: Allowance;
}

/** Phase 13: the model this server runs itself, offered when it has one. */
export const LOCAL_EMBEDDINGS_MODEL = 'voyage-4-nano';

/** What `PUT …/ai-settings` takes: `apiKey` a string sets the key, null removes it, absent keeps it. */
export interface AiSettingsChange {
  enabled?: boolean;
  model?: string;
  apiKey?: string | null;
  /** Phase 13. */
  keySource?: KeySource;
  /** Phase 10: search by meaning's, with the same rules for its key. */
  embeddings?: {
    enabled?: boolean;
    model?: string;
    apiKey?: string | null;
    keySource?: KeySource;
  };
}

export const AI_ACTIONS = [
  'rewrite',
  'summarise',
  'actionItems',
  'generatePage',
  'generateDatabase',
  'ask',
  'erpChanges',
] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

export const REWRITE_INSTRUCTIONS = [
  'improve',
  'shorter',
  'longer',
  'fixGrammar',
  'translate',
  'custom',
] as const;
export type RewriteInstruction = (typeof REWRITE_INSTRUCTIONS)[number];

export interface AiCompleteRequest {
  workspaceId: Id;
  action: AiAction;
  /** The page the action is about: all but generateDatabase and ask. */
  pageId?: Id;
  language: 'en' | 'ar';
  input: Record<string, unknown>;
}

export type AiStopReason = 'end' | 'length';

export type AiEvent =
  | { type: 'start'; requestId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'sources'; pages: { pageId: Id; title: string }[] }
  | {
      type: 'done';
      stopReason: AiStopReason;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; code: AiStreamErrorCode };

export const AI_STREAM_ERRORS = ['ai.refused', 'ai.keyInvalid', 'ai.provider', 'ai.limit'] as const;
export type AiStreamErrorCode = (typeof AI_STREAM_ERRORS)[number];

/**
 * Why a completion did not give an answer: the server's code before the stream started
 * (`ai.disabled`, `access.denied`, `request.invalid`, `limit.rate`, `limit.size`, ...), one the
 * stream ended with, or the client's own (`network`, `aborted`, `response.invalid`, `too.long`).
 */
export class AiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`AI: ${code}${status === null ? '' : ` (${status})`}`);
    this.name = 'AiError';
  }
}

/** The input limits the server holds a request to (INTEGRATIONS.md, AI, Rules). */
export const AI_LIMITS = {
  rewriteText: 20_000,
  pageText: 100_000,
  prompt: 4_000,
  question: 1_000,
  instruction: 2_000,
  erpRecords: 500,
  erpBytes: 400 * 1024,
} as const;
