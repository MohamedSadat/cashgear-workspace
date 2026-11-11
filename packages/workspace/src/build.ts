import { uuidv7, type Id } from './ids';
import type { Operation } from './types';

/** An operation with a fresh id and the current time. */
export function newOp<T extends Operation['type']>(
  type: T,
  workspaceId: Id,
  entityId: Id,
  payload: Extract<Operation, { type: T }>['payload'],
  baseVersion: number | null = null,
): Operation {
  return {
    opId: uuidv7(),
    type,
    workspaceId,
    entityId,
    baseVersion,
    payload,
    createdAt: new Date().toISOString(),
  } as Operation;
}
