// One completion as it runs: the text so far, the sources an answer cites, then done or failed.
// Nothing is written anywhere while it runs; the panel shows it, and Accept turns it into an edit.
import type { AiApi } from './api';
import { AiError, type AiCompleteRequest, type AiStopReason } from './types';

export type AiRun =
  | {
      status: 'running';
      text: string;
      sources: { pageId: string; title: string }[];
      /** Phase 18: answers before this one for the server's own model, while it waits. */
      ahead?: number;
    }
  | {
      status: 'done';
      text: string;
      sources: { pageId: string; title: string }[];
      stopReason: AiStopReason;
    }
  | { status: 'failed'; text: string; code: string; retryAfterSeconds: number | null };

/**
 * Runs a completion, telling `onChange` each state (at most once a frame while text streams, so a
 * long answer does not draw per token). Resolves with the last state; a stop by `signal` resolves
 * `failed` with `aborted`.
 */
export async function runCompletion(
  api: AiApi,
  request: AiCompleteRequest,
  onChange: (run: AiRun) => void,
  signal: AbortSignal,
  frame: (callback: () => void) => void = (callback) =>
    typeof requestAnimationFrame === 'function'
      ? void requestAnimationFrame(callback)
      : void setTimeout(callback, 16),
): Promise<AiRun> {
  let text = '';
  let sources: { pageId: string; title: string }[] = [];
  let ahead: number | undefined;
  let scheduled = false;
  let finished = false;
  const show = () => {
    if (scheduled || finished) return;
    scheduled = true;
    frame(() => {
      scheduled = false;
      if (!finished) onChange({ status: 'running', text, sources, ...(ahead ? { ahead } : {}) });
    });
  };
  const end = (run: AiRun) => {
    finished = true;
    onChange(run);
    return run;
  };
  onChange({ status: 'running', text, sources });
  try {
    for await (const event of api.complete(request, signal)) {
      if (event.type === 'text') {
        text += event.text;
        ahead = undefined;
        show();
      } else if (event.type === 'queued') {
        ahead = event.ahead;
        show();
      } else if (event.type === 'sources') {
        sources = event.pages;
        show();
      } else if (event.type === 'done')
        return end({ status: 'done', text, sources, stopReason: event.stopReason });
      else if (event.type === 'error')
        return end({ status: 'failed', text, code: event.code, retryAfterSeconds: null });
    }
    return end({ status: 'failed', text, code: 'response.invalid', retryAfterSeconds: null });
  } catch (error) {
    const failure = error instanceof AiError ? error : new AiError('server.error');
    return end({
      status: 'failed',
      text,
      code: signal.aborted ? 'aborted' : failure.code,
      retryAfterSeconds: failure.retryAfterSeconds,
    });
  }
}
