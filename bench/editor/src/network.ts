// A simulated network for several editors on one Yjs document: every client sends its own
// updates to every other; delivery is in random order, in random batches, and stops while a
// client is offline. Updates are idempotent and commutative, so any order must converge.
import * as Y from 'yjs';
import { createSpikeEditor, type SpikeEditor } from './editor';
import type { BindingKind } from './binding';
import type { SchemaAdditions, SchemaVariant } from './schema';
import type { Random } from './commands';

export const REMOTE = 'remote';

export interface Client {
  index: number;
  doc: Y.Doc;
  spike: SpikeEditor;
  online: boolean;
  bytesSent: number;
  updatesSent: number;
}

export class Network {
  readonly clients: Client[] = [];
  /** queues[from][to] */
  private readonly queues: Uint8Array[][][] = [];
  private readonly tasks: (() => void)[] = [];
  /** Content a client wrote inside a remote transaction (see the update handler). */
  readonly localInRemote: { client: number; structs: number }[] = [];
  readonly enqueued: number[][] = [];
  /** Times a client was left with pending structs it could integrate (see retryPending). */
  healedPending = 0;
  readonly applied: number[][] = [];

  constructor(
    count: number,
    binding: BindingKind,
    schema: SchemaVariant,
    additions?: SchemaAdditions,
  ) {
    for (let index = 0; index < count; index++) {
      const doc = new Y.Doc();
      const client: Client = {
        index,
        doc,
        online: true,
        bytesSent: 0,
        updatesSent: 0,
        spike: createSpikeEditor({
          doc,
          binding,
          schema,
          additions,
          schedule: (task) => this.tasks.push(task),
        }),
      };
      this.queues.push([]);
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE) {
          // A remote transaction should hold only the sender's content. If this client's own
          // content is in it, no provider would ever send it on.
          const own = Y.decodeUpdate(update).structs.filter((s) => s.id.client === doc.clientID);
          if (own.length) this.localInRemote.push({ client: index, structs: own.length });
          return;
        }
        client.bytesSent += update.byteLength;
        client.updatesSent++;
        for (let to = 0; to < count; to++)
          if (to !== index) {
            this.queues[index][to].push(update);
            this.enqueued[index][to]++;
          }
      });
      this.clients.push(client);
    }
    for (const row of this.queues) for (let to = 0; to < count; to++) row.push([]);
    for (let from = 0; from < count; from++) {
      this.enqueued.push(Array(count).fill(0));
      this.applied.push(Array(count).fill(0));
    }
  }

  /** Runs what the editors scheduled (the duplicate repair), until nothing is left. */
  flush(): void {
    while (this.tasks.length) this.tasks.shift()!();
  }

  pending(): number {
    let total = 0;
    for (const row of this.queues) for (const queue of row) total += queue.length;
    return total + this.tasks.length;
  }

  /** Delivers a random batch on one random live link, in random order. */
  deliverSome(random: Random): void {
    const links: [number, number][] = [];
    this.queues.forEach((row, from) =>
      row.forEach((queue, to) => {
        if (queue.length && this.clients[from].online && this.clients[to].online)
          links.push([from, to]);
      }),
    );
    if (!links.length) return;
    const [from, to] = links[Math.floor(random() * links.length)];
    const queue = this.queues[from][to];
    const count = 1 + Math.floor(random() * queue.length);
    const batch = queue.splice(0, count);
    // Shuffle: Yjs must cope with updates out of order.
    for (let i = batch.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
    for (const update of batch) {
      Y.applyUpdate(this.clients[to].doc, update, REMOTE);
      this.applied[from][to]++;
    }
    this.retryPending(this.clients[to].doc);
    this.flush();
  }

  /**
   * Yjs 13.6.33 can leave updates pending after every update they need has arrived, depending
   * on the order they came in (fixtures/yjs-pending-order.json). Applying the pending update
   * once more integrates it. What is still pending after that is genuinely missing.
   */
  private retryPending(doc: Y.Doc): void {
    const store = (doc as unknown as { store: { pendingStructs: { update: Uint8Array } | null } })
      .store;
    if (!store.pendingStructs) return;
    Y.applyUpdateV2(doc, store.pendingStructs.update, REMOTE);
    if (!store.pendingStructs) this.healedPending++;
  }

  /** Everyone online, everything delivered, every scheduled repair run. */
  quiesce(random: Random, maxRounds = 100): number {
    for (const client of this.clients) client.online = true;
    let rounds = 0;
    while (this.pending() && rounds < maxRounds) {
      rounds++;
      this.flush();
      for (let from = 0; from < this.clients.length; from++)
        for (let to = 0; to < this.clients.length; to++) {
          const queue = this.queues[from][to];
          if (!queue.length) continue;
          const batch = queue.splice(0);
          for (let i = batch.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [batch[i], batch[j]] = [batch[j], batch[i]];
          }
          for (const update of batch) {
            Y.applyUpdate(this.clients[to].doc, update, REMOTE);
            this.applied[from][to]++;
          }
          this.retryPending(this.clients[to].doc);
          this.flush();
        }
    }
    return rounds;
  }

  destroy(): void {
    for (const client of this.clients) {
      client.spike.editor.destroy();
      client.doc.destroy();
    }
  }
}
