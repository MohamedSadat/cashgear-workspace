// `@cgw/erp/ai`: all that AI code may take from `@cgw/erp` (INTEGRATIONS.md, AI, "No path to
// Commit"). Types only: what an ERP view block hands an AI helper when the person asks it to
// prepare changes, and what comes back. The proposals go into the block's pending list, where the
// person reviews and commits them on the usual screen; nothing here can reach `Commit`.
import type { FieldType, WireValue } from './contract';

/** One editable field, as the block's schema gives it for this person, for the model to fill. */
export interface ErpAiField {
  readonly name: string;
  /** In the interface language. */
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly min?: string | number;
  readonly max?: string | number;
  readonly scale?: number;
  /**
   * Phase 10: the value belongs to every record of the same key (an item's name across its rows),
   * so one change applies to all of them. Absent for a record's own field.
   */
  readonly scope?: 'key';
  /** A lookup's active codes, with their labels: the only values a change may choose. */
  readonly lookup?: readonly { readonly code: string; readonly label: string }[];
}

/** What a block sends to be prepared: the records it holds in memory, from the person's session. */
export interface ErpAiRequest {
  /** What the person asked for, as typed (at most 2,000 characters). */
  readonly instruction: string;
  readonly connector: { readonly id: string; readonly schemaVersion: string };
  /** The editable fields only. */
  readonly fields: readonly ErpAiField[];
  /** At most 500, as loaded; `values` only the fields the block shows. */
  readonly records: readonly {
    readonly id: string;
    readonly key: string;
    readonly values: Readonly<Record<string, WireValue>>;
  }[];
}

/** One proposed change: a record's field and its new value. Checked by the block before it shows. */
export interface ErpChangeProposal {
  readonly id: string;
  readonly field: string;
  readonly to: WireValue;
}

/** What the shell's AI gives an ERP view block (`ErpViewHost.ai`); absent when AI is off. */
export interface ErpAiAssist {
  prepare(
    request: ErpAiRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly ErpChangeProposal[]>;
}
