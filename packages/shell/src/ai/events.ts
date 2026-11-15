// The completion's answer as it streams: newline-delimited JSON, one `AiEvent` a line. Each line
// is checked against the contract before it is used; a line that breaks it ends the answer with
// `response.invalid`, and nothing of it is shown.
import { AI_STREAM_ERRORS, AiError, type AiEvent } from './types';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A token count: a whole number, which .NET may write as a string for an int64. */
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : typeof value === 'string' && /^\d{1,15}$/.test(value)
      ? Number(value)
      : null;

/** One line of the answer as an event, or null when it breaks the contract. */
export function parseAiEvent(value: unknown): AiEvent | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'start':
      return typeof value.requestId === 'string' && typeof value.model === 'string'
        ? { type: 'start', requestId: value.requestId, model: value.model }
        : null;
    case 'text':
      return typeof value.text === 'string' ? { type: 'text', text: value.text } : null;
    case 'sources': {
      if (!Array.isArray(value.pages)) return null;
      const pages: { pageId: string; title: string }[] = [];
      for (const page of value.pages) {
        if (!isObject(page) || typeof page.pageId !== 'string' || typeof page.title !== 'string')
          return null;
        pages.push({ pageId: page.pageId, title: page.title });
      }
      return { type: 'sources', pages };
    }
    case 'done': {
      const usage = value.usage;
      if (value.stopReason !== 'end' && value.stopReason !== 'length') return null;
      if (!isObject(usage)) return null;
      const inputTokens = count(usage.inputTokens);
      const outputTokens = count(usage.outputTokens);
      if (inputTokens === null || outputTokens === null) return null;
      return { type: 'done', stopReason: value.stopReason, usage: { inputTokens, outputTokens } };
    }
    case 'error':
      return (AI_STREAM_ERRORS as readonly unknown[]).includes(value.code)
        ? { type: 'error', code: value.code as (typeof AI_STREAM_ERRORS)[number] }
        : null;
    default:
      return null;
  }
}

/**
 * The events of a streamed answer, in order. Throws an `AiError`: `response.invalid` for a line
 * that breaks the contract or an answer that ends without `done` or `error`, `aborted` when
 * `signal` fires, `network` when the stream breaks.
 */
export async function* readAiEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AiEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let ended = false;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort);
  const line = (text: string): AiEvent | null => {
    if (!text.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AiError('response.invalid');
    }
    const event = parseAiEvent(parsed);
    if (!event) throw new AiError('response.invalid');
    return event;
  };
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (signal?.aborted) throw new AiError('aborted');
        throw new AiError('network');
      }
      if (signal?.aborted) throw new AiError('aborted');
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const event = line(pending.slice(0, at));
        pending = pending.slice(at + 1);
        if (!event) continue;
        if (event.type === 'done' || event.type === 'error') ended = true;
        yield event;
        if (ended) return;
      }
    }
    pending += decoder.decode();
    const last = line(pending);
    if (last) {
      if (last.type === 'done' || last.type === 'error') ended = true;
      yield last;
    }
    if (!ended) throw new AiError(signal?.aborted ? 'aborted' : 'response.invalid');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Stops the server's stream when the answer ended early (a `done` before the body closed).
    void reader.cancel().catch(() => undefined);
  }
}
