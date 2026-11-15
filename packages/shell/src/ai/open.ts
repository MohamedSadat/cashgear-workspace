// Asking for the AI panel from elsewhere (the page menu, the palette): the page on screen opens it.
import type { Id } from '@cgw/workspace';
import type { AiSelection, AiTaskAction } from './requests';

/** What the panel opens on: an action, and the selection or question it starts with. */
export interface AiPanelRequest {
  action: AiTaskAction;
  selection?: AiSelection | null;
  question?: string;
  /** Rises with each request, so asking again for the same action is seen. */
  n: number;
}

export const aiEvents = new EventTarget();

export interface AiOpenDetail {
  pageId: Id;
  action?: AiTaskAction;
  question?: string;
}

/** Opens the AI panel on a page on screen (nothing happens for a page not on screen). */
export function openAi(detail: AiOpenDetail) {
  aiEvents.dispatchEvent(new CustomEvent<AiOpenDetail>('open', { detail }));
}
