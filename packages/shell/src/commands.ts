// The command registry (ARCHITECTURE.md, "Commands"): one list that the slash menu, the bubble
// toolbar, the block menu, the Ctrl+K palette and the keyboard shortcuts all read.
import { matchesShortcut } from './shortcuts';

export type CommandGroup = 'navigation' | 'page' | 'app' | 'block' | 'format';

export interface Command<Context = unknown> {
  id: string;
  group: CommandGroup;
  /** The label in the current language, read when drawn. */
  label: () => string;
  /** Words that find the command, in both languages, so either works in either interface. */
  keywords?: () => string[];
  /** An `event.code` chord (shortcuts.ts). */
  shortcut?: string;
  /** Whether the command applies now; absent means always. */
  when?: (context: Context) => boolean;
  run: (context: Context) => void | Promise<void>;
}

/** Folds text for matching: case, Arabic diacritics and letter variants. Search uses the same. */
export type Fold = (text: string) => string;

const defaultFold: Fold = (text) => text.toLocaleLowerCase();

export class CommandRegistry<Context = unknown> {
  private readonly commands = new Map<string, Command<Context>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly fold: Fold = defaultFold) {}

  register(...commands: Command<Context>[]): () => void {
    for (const command of commands) {
      if (this.commands.has(command.id))
        throw new Error(`Command ${command.id} is registered twice`);
      this.commands.set(command.id, command);
    }
    this.emit();
    return () => {
      for (const command of commands) this.commands.delete(command.id);
      this.emit();
    };
  }

  get(id: string): Command<Context> | undefined {
    return this.commands.get(id);
  }

  /** The commands that apply in this context, filtered by a query, best matches first. */
  list(context: Context, query = '', groups?: readonly CommandGroup[]): Command<Context>[] {
    const q = this.fold(query.trim());
    const scored: { command: Command<Context>; score: number }[] = [];
    let order = 0;
    for (const command of this.commands.values()) {
      order++;
      if (groups && !groups.includes(command.group)) continue;
      if (command.when && !command.when(context)) continue;
      const score = q ? this.score(command, q) : 0;
      if (score === null) continue;
      scored.push({ command, score: score * 100000 + order });
    }
    return scored.sort((a, b) => a.score - b.score).map((entry) => entry.command);
  }

  async run(id: string, context: Context): Promise<boolean> {
    const command = this.commands.get(id);
    if (!command || (command.when && !command.when(context))) return false;
    await command.run(context);
    return true;
  }

  /** Runs the command whose shortcut the event is, if one applies. */
  handleKey(event: KeyboardEvent, context: Context): boolean {
    for (const command of this.commands.values()) {
      if (!command.shortcut || !matchesShortcut(event, command.shortcut)) continue;
      if (command.when && !command.when(context)) continue;
      event.preventDefault();
      void command.run(context);
      return true;
    }
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 0: the label starts with the query; 1: a word of it does or it contains it; 2: a keyword. */
  private score(command: Command<Context>, q: string): number | null {
    const label = this.fold(command.label());
    if (label.startsWith(q)) return 0;
    if (label.split(/\s+/).some((word) => word.startsWith(q)) || label.includes(q)) return 1;
    const words = (command.keywords?.() ?? []).flatMap((k) => this.fold(k).split(/\s+/));
    if (words.some((word) => word.startsWith(q))) return 2;
    return null;
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
