// Spike S1: random operations on several editors sharing one Yjs document, delivered in random
// order with clients going offline, then checked once everything is delivered.
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { BindingKind } from './binding';
import {
  between,
  blockText,
  createOps,
  listBlocks,
  pick,
  seeded,
  TEXT_KIND_NAMES,
  type BlockInfo,
  type Random,
} from './commands';
import { BLOCK_ID, blockIds } from './ids';
import { Network, type Client } from './network';
import type { SchemaVariant } from './schema';

export interface FuzzOptions {
  seed: number;
  clients: number;
  ops: number;
  binding: BindingKind;
  schema: SchemaVariant;
  /** Chance per step that an online client goes offline. */
  offlineRate?: number;
  maxBlocks?: number;
  /** Replaces the default mix of operations, to isolate one kind. */
  weights?: [string, number][];
  /** Keep every update each client made, for spike S3's corpus. */
  collect?: boolean;
  /** Runs on client 0's document before any edit (S3 stamps `meta`). */
  prepare?: (doc: Y.Doc) => void;
}

export interface Collected {
  /** Every update, in the order its client made it, all clients together. */
  updates: Uint8Array[];
  /** What Yjs 13 holds once everything is delivered. */
  xml: string;
  json: unknown;
}

export interface FuzzResult {
  options: FuzzOptions;
  ms: number;
  opsByKind: Record<string, number>;
  rounds: number;
  blocks: number;
  converged: boolean;
  editorsAgree: boolean;
  matchesYjs: boolean;
  schemaValid: boolean;
  contentErrors: number;
  duplicateIds: number;
  badIds: number;
  idsRepaired: number;
  localDuplicates: number;
  localDuplicateSources?: string[];
  remoteNulls: number;
  /** Batches after which Yjs held integrable updates as pending (Network.retryPending). */
  healedPending: number;
  contentErrorMessages: string[];
  /** A local move whose block lost its id or text in the mover's own view. */
  moveIdChanges: number;
  tokensTyped: number;
  tokensDeletedOnPurpose: number;
  tokensLost: number;
  /** Lost tokens by the structural operations that touched their block. */
  lostBy: Record<string, number>;
  tokensDuplicated: number;
  samples?: unknown[];
  divergence?: unknown;
  collected?: Collected;
  bytesSent: number;
  offlineSpells: number;
  failures: string[];
}

// A token is a unique core of six capitals in braces. Only the core is looked for: both bindings
// turn a text change into Yjs operations by diffing strings, so a deletion can take a
// neighbour's identical brace instead of its own. The text survives, shifted by a character.
const CORE = 6;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Where each known core starts in a text. */
function coresIn(text: string, known: Set<string>): { core: string; at: number }[] {
  const out: { core: string; at: number }[] = [];
  for (let i = 0; i + CORE <= text.length; i++) {
    const core = text.slice(i, i + CORE);
    if (known.has(core)) out.push({ core, at: i });
  }
  return out;
}

/** Offsets in a text body that do not fall inside a core, so typing never breaks one. */
function boundaries(body: PMNode, known: Set<string>): number[] {
  const text = body.textContent;
  const inside = new Set<number>();
  for (const { at } of coresIn(text, known)) for (let i = at + 1; i < at + CORE; i++) inside.add(i);
  const out: number[] = [];
  for (let i = 0; i <= text.length; i++) if (!inside.has(i)) out.push(i);
  return out;
}

export const WEIGHTS: [string, number][] = [
  ['type', 30],
  ['deleteText', 5],
  ['format', 5],
  ['split', 10],
  ['merge', 6],
  ['move', 8],
  ['indent', 6],
  ['outdent', 4],
  ['convert', 6],
  ['paste', 5],
  ['duplicate', 3],
  ['deleteBlock', 4],
  ['atom', 2],
];

function chooseKind(
  random: Random,
  blocks: number,
  maxBlocks: number,
  weights: [string, number][],
): string {
  const kinds = weights.map(([kind]) => kind);
  if (blocks > maxBlocks && random() < 0.5 && kinds.includes('deleteBlock')) return 'deleteBlock';
  if (blocks < 3 && kinds.includes('paste')) return 'paste';
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [kind, weight] of weights) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return 'type';
}

export function runFuzz(options: FuzzOptions): FuzzResult {
  const started = performance.now();
  const random = seeded(options.seed);
  const net = new Network(options.clients, options.binding, options.schema);
  const updates: Uint8Array[] = [];
  if (options.collect)
    for (const client of net.clients)
      client.doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== 'remote') updates.push(update);
      });
  options.prepare?.(net.clients[0].doc);
  const ops = createOps(options.schema);
  const maxBlocks = options.maxBlocks ?? 150;
  const offlineRate = options.offlineRate ?? 0.01;
  const opsByKind: Record<string, number> = {};
  const failures: string[] = [];
  const deletedOnPurpose = new Set<string>();
  const copiedOnPurpose = new Set<string>();
  const typedTokens: string[] = [];
  const known = new Set<string>();
  const token = () => {
    let core = '';
    while (!core || known.has(core)) {
      core = '';
      for (let i = 0; i < CORE; i++) core += LETTERS[Math.floor(random() * LETTERS.length)];
    }
    known.add(core);
    typedTokens.push(core);
    return `{${core}}`;
  };
  const coresOf = (node: PMNode) => coresIn(node.textContent, known).map(({ core }) => core);

  // Which structural operations touched each block, to explain a lost token.
  const touched = new Map<string, Set<string>>();
  const tokenBlock = new Map<string, string>();
  /** The block a token was typed into and its ancestors, in the typing client's view. */
  const tokenChain = new Map<string, string[]>();
  const chainOf = (doc: PMNode, id: string): string[] => {
    const all = listBlocks(doc);
    const byPos = new Map(all.map((b) => [b.pos, b]));
    const chain: string[] = [];
    let block = all.find((b) => b.id === id);
    while (block) {
      if (block.id) chain.push(block.id);
      block = byPos.get(block.parentPos);
    }
    return chain;
  };
  const touch = (kind: string, node: PMNode, subtree: boolean) => {
    const mark = (n: PMNode) => {
      if (n.type.name !== 'block' || !n.attrs.id) return;
      const set = touched.get(n.attrs.id) ?? new Set<string>();
      set.add(kind);
      touched.set(n.attrs.id, set);
    };
    mark(node);
    if (subtree) node.descendants((child) => (mark(child), true));
  };
  let moveIdChanges = 0;
  let offlineSpells = 0;
  const offlineUntil: number[] = Array(options.clients).fill(-1);

  // A first document, made by client 0 and delivered to everyone.
  {
    const editor = net.clients[0].spike.editor;
    const blocks = Array.from({ length: 12 }, (_, i) =>
      ops.newBlock(editor.state, `start ${i} ${token()}`, pick(random, TEXT_KIND_NAMES)),
    );
    editor.view.dispatch(ops.insertBlocks(editor.state, 0, blocks));
    for (const block of listBlocks(editor.state.doc))
      for (const core of coresOf(block.node)) if (block.id) tokenBlock.set(core, block.id);
    net.quiesce(random);
  }

  const apply = (client: Client, kind: string): boolean => {
    const editor = client.spike.editor;
    const state = editor.state;
    const blocks = listBlocks(state.doc);
    const someBlock = (): BlockInfo | undefined =>
      blocks.length ? pick(random, blocks) : undefined;
    const typedBefore = typedTokens.length;
    let tr: Transaction | null = null;
    let copied: PMNode | null = null;
    let moved: { id: string; text: string } | null = null;
    let affected: { kind: string; node: PMNode; subtree: boolean } | null = null;
    let typedInto: string | null = null;
    let deletingFrom: PMNode | null = null;
    switch (kind) {
      case 'type': {
        const targets = ops.textBlocks(state);
        if (!targets.length) return false;
        const { block, body } = pick(random, targets);
        const offset = pick(random, boundaries(body.node, known));
        tr = ops.typeText(state, body.pos + 1 + offset, offset, token());
        typedInto = block.id;
        break;
      }
      case 'deleteText': {
        const targets = ops.textBlocks(state).filter((t) => t.body.node.content.size > 0);
        if (!targets.length) return false;
        const { body } = pick(random, targets);
        const size = body.node.content.size;
        const from = between(random, 0, size - 1);
        const to = between(random, from + 1, Math.min(size, from + 12));
        tr = state.tr.delete(body.pos + 1 + from, body.pos + 1 + to);
        // Cores the range cuts, whole or in part, are deleted on purpose.
        const text = body.node.textContent;
        for (const { core, at } of coresIn(text, known))
          if (at < to && at + CORE > from) deletedOnPurpose.add(core);
        deletingFrom = body.node;
        break;
      }
      case 'format': {
        const targets = ops
          .textBlocks(state)
          .filter((t) => t.body.node.content.size > 0 && !t.body.node.type.spec.code);
        if (!targets.length) return false;
        const { body } = pick(random, targets);
        const size = body.node.content.size;
        const from = between(random, 0, size - 1);
        const to = between(random, from + 1, size);
        const bold = state.schema.marks.bold;
        tr =
          random() < 0.7
            ? state.tr.addMark(body.pos + 1 + from, body.pos + 1 + to, bold.create())
            : state.tr.removeMark(body.pos + 1 + from, body.pos + 1 + to, bold);
        break;
      }
      case 'split': {
        const targets = ops.textBlocks(state);
        if (!targets.length) return false;
        const { block, body } = pick(random, targets);
        tr = ops.split(state, block, pick(random, boundaries(body.node, known)));
        affected = { kind: 'split', node: block.node, subtree: false };
        break;
      }
      case 'merge': {
        const block = someBlock();
        tr = block ? ops.merge(state, block) : null;
        if (block) affected = { kind: 'merge', node: block.node, subtree: true };
        break;
      }
      case 'move':
      case 'indent':
      case 'outdent': {
        const block = someBlock();
        if (!block) return false;
        if (kind === 'move') {
          const slots = ops.slots(state, block);
          tr = slots.length ? ops.move(state, block, pick(random, slots)) : null;
        } else tr = kind === 'indent' ? ops.indent(state, block) : ops.outdent(state, block);
        if (tr && block.id) moved = { id: block.id, text: blockText(block.node) };
        affected = { kind: 'move', node: block.node, subtree: true };
        break;
      }
      case 'convert': {
        const block = someBlock();
        tr = block ? ops.convert(state, block, pick(random, TEXT_KIND_NAMES)) : null;
        if (block) affected = { kind: 'convert', node: block.node, subtree: false };
        break;
      }
      case 'paste': {
        const count = between(random, 1, 3);
        const fresh = Array.from({ length: count }, () =>
          ops.newBlock(state, `paste ${token()}`, pick(random, TEXT_KIND_NAMES)),
        );
        tr = ops.insertBlocks(state, pick(random, ops.slots(state)), fresh);
        break;
      }
      case 'duplicate': {
        const block = someBlock();
        if (!block) return false;
        tr = ops.duplicate(state, block);
        copied = block.node;
        break;
      }
      case 'deleteBlock': {
        const block = someBlock();
        if (!block) return false;
        tr = ops.deleteBlock(state, block);
        affected = { kind: 'delete', node: block.node, subtree: true };
        for (const core of coresOf(block.node)) deletedOnPurpose.add(core);
        break;
      }
      case 'atom': {
        const type = pick(random, ['divider', 'image', 'childPage']);
        const block = state.schema.nodes.block.create(
          { id: null },
          state.schema.nodes[type].create(),
        );
        tr = ops.insertBlocks(state, pick(random, ops.slots(state)), [block]);
        break;
      }
    }
    if (!tr || !tr.docChanged) {
      // Nothing happened: forget the tokens made for it.
      for (const core of typedTokens.splice(typedBefore)) known.delete(core);
      return false;
    }
    void deletingFrom;
    editor.view.dispatch(tr);
    const after = editor.state.doc;
    if (affected) touch(affected.kind, affected.node, affected.subtree);
    const fresh = typedTokens.slice(typedBefore);
    if (typedInto) for (const core of fresh) tokenBlock.set(core, typedInto);
    else if (fresh.length)
      for (const block of listBlocks(after)) {
        const text = blockText(block.node);
        for (const core of fresh)
          if (block.id && text.includes(core)) tokenBlock.set(core, block.id);
      }
    for (const core of fresh) {
      const block = tokenBlock.get(core);
      if (block) tokenChain.set(core, chainOf(after, block));
    }
    if (copied) for (const core of coresOf(copied)) copiedOnPurpose.add(core);
    if (moved) {
      const found = listBlocks(after).filter((b) => b.id === moved.id);
      if (found.length !== 1 || blockText(found[0].node) !== moved.text) moveIdChanges++;
    }
    return true;
  };

  let done = 0;
  let step = 0;
  while (done < options.ops) {
    step++;
    // Offline spells: a client stops sending and receiving for a while, and keeps editing.
    net.clients.forEach((client, index) => {
      if (!client.online && step >= offlineUntil[index]) client.online = true;
      else if (client.online && random() < offlineRate) {
        client.online = false;
        offlineUntil[index] = step + between(random, 20, 400);
        offlineSpells++;
      }
    });
    if (random() < 0.55) {
      const client = pick(random, net.clients);
      const kind = chooseKind(
        random,
        listBlocks(client.spike.editor.state.doc).length,
        maxBlocks,
        options.weights ?? WEIGHTS,
      );
      if (apply(client, kind)) {
        done++;
        opsByKind[kind] = (opsByKind[kind] ?? 0) + 1;
      }
    } else net.deliverSome(random);
  }

  const rounds = net.quiesce(random);
  let divergence: unknown = undefined;
  const docs = net.clients.map((c) => c.spike.editor.state.doc);
  const xml = net.clients.map((c) => c.spike.fragment.toJSON());
  const converged =
    xml.every((x) => x === xml[0]) &&
    net.clients.every((c) =>
      equalBytes(Y.encodeStateVector(c.doc), Y.encodeStateVector(net.clients[0].doc)),
    );
  if (!converged) {
    failures.push('The Yjs documents differ after every update was delivered.');
    const store = (doc: Y.Doc) =>
      (doc as unknown as { store: { pendingStructs: unknown; pendingDs: unknown } }).store;
    divergence = net.clients.map((c) => ({
      stateVector: [...Y.decodeStateVector(Y.encodeStateVector(c.doc))]
        .map(([k, v]) => `${k}:${v}`)
        .sort(),
      pendingStructs: store(c.doc).pendingStructs !== null,
      pendingDs: store(c.doc).pendingDs !== null,
      xmlLength: c.spike.fragment.toJSON().length,
      updatesSent: c.updatesSent,
    }));
    divergence = {
      clients: divergence,
      localInRemote: net.localInRemote,
      enqueued: net.enqueued,
      applied: net.applied,
      pendingNow: net.pending(),
    };
    if (options.collect) {
      // A fresh document from every update, in the order they were made.
      const fresh = new Y.Doc();
      for (const update of updates) Y.applyUpdate(fresh, update);
      const freshPending = store(fresh).pendingStructs !== null;
      // Everything again, to every client.
      for (const client of net.clients)
        for (const update of updates) Y.applyUpdate(client.doc, update, 'remote');
      const after = net.clients.map((c) => c.spike.fragment.toJSON());
      divergence = {
        ...(divergence as object),
        freshPending,
        freshMatchesClient1:
          fresh.getXmlFragment('content').toJSON() === net.clients[1].spike.fragment.toJSON(),
        healedByRedelivery: after.every((x) => x === after[0]),
      };
    }
  }
  // Each editor has its own Schema instance, so compare JSON rather than nodes.
  const json = docs.map((doc) => JSON.stringify(doc.toJSON()));
  const editorsAgree = json.every((j) => j === json[0]);
  if (!editorsAgree) failures.push('The editors show different documents.');

  let matchesYjs = true;
  for (const client of net.clients) {
    const schema = client.spike.editor.schema;
    try {
      const fromYjs = schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(client.spike.fragment));
      if (!fromYjs.eq(client.spike.editor.state.doc)) matchesYjs = false;
    } catch {
      matchesYjs = false;
    }
  }
  if (!matchesYjs) failures.push('An editor does not show what its Yjs document holds.');

  let schemaValid = true;
  for (const doc of docs) {
    try {
      doc.check();
    } catch (error) {
      schemaValid = false;
      failures.push('Schema check failed: ' + (error as Error).message);
      break;
    }
  }
  const contentErrors = net.clients.reduce((sum, c) => sum + c.spike.contentErrors.length, 0);
  if (contentErrors) failures.push(`${contentErrors} content errors from the binding.`);

  const ids = blockIds(docs[0]);
  const duplicateIds = ids.length - new Set(ids).size;
  const badIds = ids.filter((id) => id === null || !BLOCK_ID.test(id)).length;
  if (duplicateIds) failures.push(`${duplicateIds} duplicate block ids after quiescence.`);
  if (badIds) failures.push(`${badIds} blocks without a well-formed id.`);
  if (moveIdChanges) failures.push(`${moveIdChanges} local moves changed a block's id or text.`);

  const counts = new Map<string, number>();
  for (const core of coresOf(docs[0])) counts.set(core, (counts.get(core) ?? 0) + 1);
  const lostTokens = typedTokens.filter((t) => !counts.has(t) && !deletedOnPurpose.has(t));
  const lostBy: Record<string, number> = {};
  for (const t of lostTokens) {
    const chain = tokenChain.get(t) ?? [];
    const set = new Set<string>();
    for (const id of chain) for (const kind of touched.get(id) ?? []) set.add(kind);
    const kinds = chain.length ? [...set].sort().join('+') : 'no block';
    const key = kinds || 'unexplained';
    lostBy[key] = (lostBy[key] ?? 0) + 1;
  }
  const finalBlocks = new Map(listBlocks(docs[0]).map((b) => [b.id, blockText(b.node)]));
  const samples = lostTokens
    .filter((t) => !(tokenChain.get(t) ?? []).some((id) => touched.get(id)?.size))
    .slice(0, 8)
    .map((t) => {
      const block = tokenBlock.get(t) ?? null;
      return {
        token: t,
        block,
        blockExists: finalBlocks.has(block),
        blockText: finalBlocks.get(block)?.slice(0, 120) ?? null,
      };
    });
  let duplicated = 0;
  for (const [core, count] of counts) if (count > 1 && !copiedOnPurpose.has(core)) duplicated++;

  const result: FuzzResult = {
    options,
    ms: Math.round(performance.now() - started),
    opsByKind,
    rounds,
    blocks: ids.length,
    converged,
    editorsAgree,
    matchesYjs,
    schemaValid,
    contentErrors,
    duplicateIds,
    badIds,
    idsRepaired: net.clients.reduce((sum, c) => sum + c.spike.stats.repaired, 0),
    localDuplicates: net.clients.reduce((sum, c) => sum + c.spike.stats.localDuplicates, 0),
    localDuplicateSources: net.clients
      .flatMap((c) => c.spike.stats.localDuplicateSources ?? [])
      .slice(0, 12),
    remoteNulls: net.clients.reduce((sum, c) => sum + c.spike.stats.remoteNulls, 0),
    healedPending: net.healedPending,
    contentErrorMessages: net.clients
      .flatMap((c) => c.spike.contentErrors.map((e) => e.message.slice(0, 600)))
      .slice(0, 4),
    moveIdChanges,
    tokensTyped: typedTokens.length,
    tokensDeletedOnPurpose: deletedOnPurpose.size,
    tokensLost: lostTokens.length,
    lostBy,
    tokensDuplicated: duplicated,
    samples,
    divergence,
    bytesSent: net.clients.reduce((sum, c) => sum + c.bytesSent, 0),
    offlineSpells,
    failures,
  };
  if (options.collect)
    result.collected = {
      updates,
      xml: net.clients[0].spike.fragment.toJSON(),
      json: yXmlFragmentToProsemirrorJSON(net.clients[0].spike.fragment),
    };
  net.destroy();
  return result;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
