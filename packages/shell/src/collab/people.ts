// The workspace's people as the shell knows them: the members route's answer (a guest sees whom
// that route shows them), read again when the feed says the members changed, when the account
// changes and when something names a person the directory does not know. Names and colours of
// mentions, cursors, avatars and comments come from here, never from a message (contract
// section 4). It is the editor host's `people` (contract section 6).
import { normaliseText, type Id } from '@cgw/workspace';

export interface Person {
  id: Id;
  name: string;
  email: string;
}

export interface Member {
  userId: Id;
  displayName: string;
  email: string;
}

/** The "@" menu's limit (contract section 6). */
export const PEOPLE_SEARCH_LIMIT = 8;
/** A person nobody knows yet is asked about again at most this often. */
const MISSING_RETRY_MS = 60_000;

interface Folded {
  person: Person;
  name: string;
  words: string[];
  email: string;
}

export class PeopleDirectory {
  private people = new Map<Id, Person>();
  private folded: Folded[] = [];
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private again = false;
  private revision = 0;
  private lastMissing = 0;
  private disposed = false;

  constructor(
    readonly workspaceId: Id,
    private readonly read: (workspaceId: Id) => Promise<Member[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads the members again; a call while one is out reads once more after it. */
  refresh(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.again = false;
        try {
          this.set(await this.read(this.workspaceId));
        } catch {
          // Offline or refused: the people known stay as they were.
        }
      } while (this.again && !this.disposed);
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  private set(members: Member[]) {
    if (this.disposed) return;
    const next = new Map<Id, Person>();
    for (const m of members)
      next.set(m.userId, { id: m.userId, name: m.displayName, email: m.email });
    const same =
      next.size === this.people.size &&
      [...next].every(([id, p]) => {
        const was = this.people.get(id);
        return was && was.name === p.name && was.email === p.email;
      });
    if (same) return;
    this.people = next;
    this.folded = [...next.values()].map((person) => {
      const name = normaliseText(person.name);
      return { person, name, words: name.split(' '), email: normaliseText(person.email) };
    });
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  /** The person's display name, or undefined when unknown. */
  name = (userId: Id): string | undefined => {
    const person = this.people.get(userId);
    if (!person) this.missing();
    return person?.name;
  };

  person = (userId: Id): Person | undefined => this.people.get(userId);

  all = (): Person[] => [...this.people.values()];

  /** A name or an id nobody has: the members are read again, at most once a minute. */
  private missing() {
    const now = this.now();
    if (now - this.lastMissing < MISSING_RETRY_MS) return;
    this.lastMissing = now;
    void this.refresh();
  }

  /**
   * People whose name, a word of it, or address starts with the query (folded alike: case,
   * Arabic marks and letter forms), at most eight, best matches first.
   */
  search = (query: string): { id: Id; name: string }[] => {
    const q = normaliseText(query);
    const scored: { person: Person; score: number }[] = [];
    for (const entry of this.folded) {
      const score = !q
        ? 0
        : entry.name.startsWith(q)
          ? 0
          : entry.words.some((word) => word.startsWith(q))
            ? 1
            : entry.email.startsWith(q)
              ? 2
              : -1;
      if (score >= 0) scored.push({ person: entry.person, score });
    }
    return scored
      .sort((a, b) => a.score - b.score || a.person.name.localeCompare(b.person.name))
      .slice(0, PEOPLE_SEARCH_LIMIT)
      .map(({ person }) => ({ id: person.id, name: person.name }));
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Changes when a name or the set of people does (for `useSyncExternalStore`). */
  getRevision = () => this.revision;

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
