// The AI help an ERP view block is given (`ErpViewHost.ai`, `@cgw/erp/ai`): it sends the block's
// editable fields and the records it holds in memory, as the person's own ERP session gave them,
// and returns proposed changes for the block's pending list. Nothing else: it cannot commit, and
// it imports nothing of `@cgw/erp` but those types (lint, and `boundary.test.ts`).
import type { ErpAiAssist, ErpAiRequest, ErpChangeProposal } from '@cgw/erp/ai';
import type { Id } from '@cgw/workspace';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { parseRoute } from '../route';
import type { WorkspaceSession } from '../session';
import type { AiApi } from './api';
import { parseErpChanges } from './answers';
import { useAi } from './context';
import { AI_LIMITS, AiError } from './types';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The page on screen, which holds the block asking (when the block did not say). */
const pageOnScreen = (): Id | null => {
  const route = parseRoute(location.hash);
  return route.kind === 'page' ? route.pageId : null;
};

/**
 * Prepares ERP changes through `erpChanges`. Rejects with an `AiError` (`too.long`,
 * `request.empty`, `answer.invalid`, or what the server or the provider said).
 */
export function erpAssistOf(
  api: AiApi,
  workspaceId: Id,
  pageIdOf: () => Id | null,
  language: () => 'en' | 'ar',
): ErpAiAssist {
  return {
    async prepare(request: ErpAiRequest, options = {}): Promise<readonly ErpChangeProposal[]> {
      const pageId = pageIdOf();
      if (!pageId) throw new AiError('request.invalid');
      const instruction = request.instruction.trim();
      if (!instruction) throw new AiError('request.empty');
      const input = {
        instruction,
        connector: { id: request.connector.id, schemaVersion: request.connector.schemaVersion },
        fields: request.fields,
        records: request.records.map((r) => ({ id: r.id, key: r.key, values: r.values })),
      };
      if (
        instruction.length > AI_LIMITS.instruction ||
        input.records.length > AI_LIMITS.erpRecords ||
        bytes(input) > AI_LIMITS.erpBytes
      )
        throw new AiError('too.long');
      let text = '';
      for await (const event of api.complete(
        { workspaceId, action: 'erpChanges', pageId, language: language(), input },
        options.signal,
      )) {
        if (event.type === 'text') text += event.text;
        else if (event.type === 'error') throw new AiError(event.code);
        else if (event.type === 'done') {
          if (event.stopReason !== 'end') throw new AiError('answer.invalid');
          const fields = new Set(request.fields.map((f) => f.name));
          const ids = new Set(request.records.map((r) => r.id));
          // Only the block's own records and editable fields; the block checks each value again.
          return parseErpChanges(text, AI_LIMITS.erpRecords).filter(
            (change) => ids.has(change.id) && fields.has(change.field),
          );
        }
      }
      throw new AiError('response.invalid');
    },
  };
}

/** The workspace's ERP assist, or undefined when AI is not offered here now. */
export function useErpAiAssist(session: WorkspaceSession, pageId?: Id): ErpAiAssist | undefined {
  const ai = useAi(session, session.workspaceId);
  const { i18n } = useTranslation();
  const ready = ai?.availability === 'ready';
  const api = ai?.store.api;
  const workspaceId = ai?.workspaceId;
  return useMemo(
    () =>
      ready && api && workspaceId
        ? erpAssistOf(
            api,
            workspaceId,
            () => pageId ?? pageOnScreen(),
            () => (i18n.language === 'ar' ? 'ar' : 'en'),
          )
        : undefined,
    [ready, api, workspaceId, pageId, i18n],
  );
}
