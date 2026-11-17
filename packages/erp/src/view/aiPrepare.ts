// "Prepare changes with AI" (INTEGRATIONS.md, Level 2 and AI): what the block hands the shell's AI
// (`ErpViewHost.ai`, `@cgw/erp/ai`), and how its proposals become pending changes. The records go
// as the block holds them in memory, from the person's own session; each proposal is checked with
// the same local rules as a typed change and lands in the pending list marked as AI's. Nothing
// here can commit: the person reviews and commits on the usual screen.
//
// Phase 10: a field shared by a key (`scope: 'key'`, an item's name across its rows) is marked so
// in the request, and a proposal for it changes every row of its key on screen, as a typed change
// does; proposals giving one key two values keep the last, as for one record's field.
import type { ErpAiField, ErpAiRequest, ErpChangeProposal } from '../ai';
import {
  sharedByKey,
  type ConnectorSchema,
  type ErpRecord,
  type Language,
  type WireValue,
} from '../contract';
import { localProblem, sameValue, type ErpDraft } from '../drafts';
import { labelOf } from './settings';

/** Most records a request carries, and most characters of it (INTEGRATIONS.md, AI's limits). */
export const AI_MAX_RECORDS = 500;
export const AI_MAX_CHARACTERS = 400_000;
export const AI_MAX_INSTRUCTION = 2_000;

const isWire = (v: unknown): v is WireValue =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v));

/** The editable fields and the records on screen, as the AI is asked about them. */
export function buildAiRequest(
  instruction: string,
  schema: ConnectorSchema,
  records: readonly ErpRecord[],
  language: Language,
): ErpAiRequest {
  const fields: ErpAiField[] = schema.fields
    .filter((f) => f.editable)
    .map((f) => {
      const items = f.type === 'lookup' && f.lookup ? schema.lookups[f.lookup] : undefined;
      return {
        name: f.name,
        label: labelOf(f, language),
        type: f.type,
        ...(f.required !== undefined ? { required: f.required } : {}),
        ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
        ...(f.min !== undefined ? { min: f.min } : {}),
        ...(f.max !== undefined ? { max: f.max } : {}),
        ...(f.scale !== undefined ? { scale: f.scale } : {}),
        ...(sharedByKey(f) ? { scope: 'key' as const } : {}),
        ...(items
          ? {
              lookup: items
                .filter((i) => i.active !== false)
                .map((i) => ({ code: i.code, label: i.label })),
            }
          : {}),
      };
    });
  const request: {
    instruction: string;
    connector: { id: string; schemaVersion: string };
    fields: ErpAiField[];
    records: { id: string; key: string; values: Readonly<Record<string, WireValue>> }[];
  } = {
    instruction: instruction.trim().slice(0, AI_MAX_INSTRUCTION),
    connector: { id: schema.id, schemaVersion: schema.schemaVersion },
    fields,
    records: records
      .slice(0, AI_MAX_RECORDS)
      .map((r) => ({ id: r.id, key: r.key, values: r.values })),
  };
  // The largest request the server takes, records dropped from the end until it fits.
  while (request.records.length > 0 && JSON.stringify(request).length > AI_MAX_CHARACTERS) {
    request.records.pop();
  }
  return request;
}

/**
 * Proposals into the block's pending list: each must name a record on screen and an editable
 * field, and pass the local checks; one that changes nothing is dropped quietly. Counts what was
 * used and what could not be.
 */
export function applyProposals(
  draft: ErpDraft,
  proposals: readonly ErpChangeProposal[],
  records: readonly ErpRecord[],
  schema: ConnectorSchema,
): { applied: number; skipped: number } {
  const byId = new Map(records.map((r) => [r.id, r]));
  const fields = new Map(schema.fields.map((f) => [f.name, f]));
  let applied = 0;
  let skipped = 0;
  const seen = new Set<string>();
  // The last proposal for a record's field wins, as if made in that order.
  for (const proposal of [...proposals].reverse()) {
    const record = typeof proposal?.id === 'string' ? byId.get(proposal.id) : undefined;
    const field = typeof proposal?.field === 'string' ? fields.get(proposal.field) : undefined;
    if (!record || !field || !field.editable || !isWire(proposal.to)) {
      skipped++;
      continue;
    }
    // A field's name is an identifier, so it holds no `|`. A shared field's slot is its key's.
    const shared = sharedByKey(field);
    const slot = shared ? `${field.name}|key:${record.key}` : `${field.name}|${record.id}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    if (localProblem(field, schema, proposal.to) !== null) {
      skipped++;
      continue;
    }
    const pending = draft.record(record.id)?.changes[field.name];
    const now = pending ? pending.to : (record.values[field.name] ?? null);
    if (sameValue(now, proposal.to)) continue;
    if (draft.apply(schema, record, field.name, proposal.to, { byAi: true, held: records }))
      applied++;
    else skipped++;
  }
  return { applied, skipped };
}
