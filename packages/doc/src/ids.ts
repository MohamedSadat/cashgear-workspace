// The block-id plugin (D4, refined by spike S1).
//
// - Ids are minted only in local transactions (create, paste, duplicate, split).
// - No id is rewritten in response to a remote transaction, except the duplicate repair: in
//   document order the first block with an id keeps it, and the k-th copy gets the first 12
//   base-62 characters of SHA-256 of `id:k`, or of the next k whose result is not already an id
//   in the page. Every client computes the same. The repair is its own transaction, dispatched
//   after the remote change; one appended to it would never reach Yjs.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { digest } from 'lib0/hash/sha256';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const BLOCK_ID = /^[0-9A-Za-z]{12}$/;

/** 12 random base-62 characters, about 71 bits. */
export function newBlockId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  // 62 * 4 = 248: rejection keeps the alphabet uniform.
  let id = '';
  while (id.length < 12) {
    for (const byte of bytes) {
      if (byte < 248 && id.length < 12) id += ALPHABET[byte % 62];
    }
    globalThis.crypto.getRandomValues(bytes);
  }
  return id;
}

function base62(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out.padStart(12, '0');
}

/** The id the k-th duplicate of `id` takes (k counts from 1). */
export function repairId(id: string, k: number): string {
  return base62(digest(new TextEncoder().encode(`${id}:${k}`))).slice(0, 12);
}

export interface BlockIdStats {
  minted: number;
  repaired: number;
  /** Duplicates a local transaction made: a command that should have minted an id did not. */
  localDuplicates: number;
  /** Blocks with no id that arrived from a peer; left alone, as the rules say. */
  remoteNulls: number;
  /** What the transactions looked like when a local duplicate was found (diagnostics). */
  localDuplicateSources?: string[];
}

export interface BlockIdOptions {
  /** True for a transaction the Yjs binding made from a remote change. */
  isRemote: (tr: Transaction) => boolean;
  /** The counters, behind a function: Tiptap copies option objects, never functions. */
  stats: () => BlockIdStats;
  /**
   * Runs the duplicate repair after a remote change has finished. Both bindings ignore a
   * transaction appended to a remote one (their mutex is held), so the repair is dispatched
   * on its own, as a local transaction the binding writes to Yjs.
   */
  schedule: (task: () => void) => void;
}

export const blockIdKey = new PluginKey<number>('cgwBlockIds');

export const newStats = (): BlockIdStats => ({
  minted: 0,
  repaired: 0,
  localDuplicates: 0,
  remoteNulls: 0,
});

/**
 * The duplicate repair: positions to change and the ids they get, in document order. The first
 * block with an id keeps it; the k-th copy takes repairId(id, k), or the next k whose id is not
 * already in the page, so a repair never makes a new duplicate. Same document, same answer.
 */
export function duplicateRepairs(doc: PMNode): { pos: number; id: string }[] {
  const taken = new Set<string>();
  doc.descendants((node: PMNode) => {
    if (node.type.name === 'block' && node.attrs.id) taken.add(node.attrs.id as string);
    return true;
  });
  const seen = new Map<string, number>();
  const fixes: { pos: number; id: string }[] = [];
  doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'block') return true;
    const id = node.attrs.id as string | null;
    if (id == null) return true;
    let k = seen.get(id) ?? 0;
    if (k === 0) {
      seen.set(id, 1);
      return true;
    }
    let candidate = repairId(id, k);
    while (taken.has(candidate)) candidate = repairId(id, ++k);
    seen.set(id, k + 1);
    taken.add(candidate);
    fixes.push({ pos, id: candidate });
    return true;
  });
  return fixes;
}

export function blockIdPlugin({ isRemote, stats: counters, schedule }: BlockIdOptions) {
  const stats = counters();
  return new Plugin<number>({
    key: blockIdKey,
    // Counts remote changes, so the view knows when to look for duplicates.
    state: {
      init: () => 0,
      apply: (tr, count) => (tr.docChanged && isRemote(tr) ? count + 1 : count),
    },
    appendTransaction(transactions, _oldState, state) {
      const changed = transactions.filter((tr) => tr.docChanged);
      // Remote changes and the repair's own transactions are never answered with a fresh id.
      if (
        !changed.length ||
        changed.some(isRemote) ||
        changed.every((tr) => tr.getMeta(blockIdKey))
      )
        return null;
      // Local: mint for blocks a command created without an id; a duplicate here is a command
      // that forgot to mint, so the later copy gets a fresh id.
      const seen = new Set<string>();
      const fixes: { pos: number; id: string }[] = [];
      state.doc.descendants((node: PMNode, pos: number) => {
        if (node.type.name !== 'block') return true;
        const id = node.attrs.id as string | null;
        if (id == null) {
          fixes.push({ pos, id: newBlockId() });
          stats.minted++;
        } else if (seen.has(id)) {
          fixes.push({ pos, id: newBlockId() });
          stats.localDuplicates++;
          (stats.localDuplicateSources ??= []).push(
            changed
              .map(
                (tr) =>
                  (tr.getMeta(blockIdKey) ? 'repair:' : '') +
                  tr.steps.map((st) => st.constructor.name).join(','),
              )
              .join(' | '),
          );
        } else seen.add(id);
        return true;
      });
      if (!fixes.length) return null;
      const tr = state.tr;
      for (const { pos, id } of fixes) tr.setNodeAttribute(pos, 'id', id);
      return tr.setMeta(blockIdKey, true).setMeta('addToHistory', false);
    },
    view: () => {
      let handled = 0;
      return {
        update(view) {
          const count = blockIdKey.getState(view.state) ?? 0;
          if (count === handled) return;
          handled = count;
          schedule(() => {
            if (view.isDestroyed) return;
            let nulls = 0;
            view.state.doc.descendants((node) => {
              if (node.type.name === 'block' && node.attrs.id == null) nulls++;
              return true;
            });
            stats.remoteNulls = nulls;
            const fixes = duplicateRepairs(view.state.doc);
            if (!fixes.length) return;
            const tr = view.state.tr;
            for (const { pos, id } of fixes) tr.setNodeAttribute(pos, 'id', id);
            stats.repaired += fixes.length;
            view.dispatch(tr.setMeta(blockIdKey, true).setMeta('addToHistory', false));
          });
        },
      };
    },
  });
}

export const BlockIds = Extension.create<BlockIdOptions>({
  name: 'blockIds',
  addOptions: () => ({
    isRemote: () => false,
    stats: () => newStats(),
    schedule: (task) => queueMicrotask(task),
  }),
  addProseMirrorPlugins() {
    return [blockIdPlugin(this.options)];
  },
});

/** Every block id in document order. */
export function blockIds(doc: PMNode): (string | null)[] {
  const ids: (string | null)[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'block') ids.push(node.attrs.id as string | null);
    return true;
  });
  return ids;
}
