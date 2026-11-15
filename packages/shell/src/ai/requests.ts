// What a person asks AI for, as the request the API takes (INTEGRATIONS.md, AI, the actions'
// table): exactly the `input` fields the action names, held to the server's limits here too, so a
// page too long is said before anything is sent.
import type { Id } from '@cgw/workspace';
import { AI_LIMITS, AiError, type AiCompleteRequest, type RewriteInstruction } from './types';

/** A selection the person asked about: its range when asked, and its plain text. */
export interface AiSelection {
  from: number;
  to: number;
  text: string;
}

/** One thing to ask AI for, on a page. */
export type AiTask =
  | {
      action: 'rewrite';
      selection: AiSelection;
      instruction: RewriteInstruction;
      /** `translate`: into this language. */
      target?: 'en' | 'ar';
      /** `custom`: what the person typed. */
      prompt?: string;
    }
  | { action: 'summarise' }
  | { action: 'actionItems' }
  | { action: 'generatePage'; prompt: string }
  | { action: 'generateDatabase'; prompt: string }
  | { action: 'ask'; question: string };

export type AiTaskAction = AiTask['action'];

/** Where the task runs: the workspace, the page, the interface language and the page's text. */
export interface AiTaskPlace {
  workspaceId: Id;
  pageId: Id;
  language: 'en' | 'ar';
  /** The page's text as this tab holds it (summarise, action items), read when asked. */
  pageText: () => string;
}

function within(text: string, limit: number): string {
  if (text.length > limit) throw new AiError('too.long');
  return text;
}

function required(text: string, limit: number): string {
  const trimmed = text.trim();
  if (!trimmed) throw new AiError('request.empty');
  return within(trimmed, limit);
}

/** The request for a task; throws `too.long` or `request.empty` before anything is sent. */
export function buildRequest(task: AiTask, place: AiTaskPlace): AiCompleteRequest {
  const base = { workspaceId: place.workspaceId, language: place.language };
  const onPage = { ...base, pageId: place.pageId };
  switch (task.action) {
    case 'rewrite': {
      const input: Record<string, unknown> = {
        text: required(task.selection.text, AI_LIMITS.rewriteText),
        instruction: task.instruction,
      };
      if (task.instruction === 'translate') input.target = task.target ?? place.language;
      if (task.instruction === 'custom')
        input.prompt = required(task.prompt ?? '', AI_LIMITS.instruction);
      return { ...onPage, action: 'rewrite', input };
    }
    case 'summarise':
    case 'actionItems':
      return {
        ...onPage,
        action: task.action,
        input: { text: required(place.pageText(), AI_LIMITS.pageText) },
      };
    case 'generatePage':
      return {
        ...onPage,
        action: 'generatePage',
        input: { prompt: required(task.prompt, AI_LIMITS.prompt) },
      };
    case 'generateDatabase':
      return {
        ...base,
        action: 'generateDatabase',
        input: { prompt: required(task.prompt, AI_LIMITS.prompt) },
      };
    case 'ask':
      return {
        ...base,
        action: 'ask',
        input: { question: required(task.question, AI_LIMITS.question) },
      };
  }
}
