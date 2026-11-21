// Each workspace's AI settings as this tab last read them, and whether AI may be offered: signed
// in, the workspace kept on the account, not a guest, online, and on for the workspace (with a
// key). The server decides every completion again; this only decides what is shown.
import type { Id } from '@cgw/workspace';
import type { AiApi } from './api';
import { AiError, type AiSettings, type AiSettingsChange } from './types';

export type AiSettingsState =
  | { status: 'idle' }
  | { status: 'loading'; settings: AiSettings | null }
  | { status: 'ready'; settings: AiSettings }
  | { status: 'failed'; settings: AiSettings | null; code: string };

/** Why AI is not offered here, or `ready`. */
export type AiAvailability =
  'ready' | 'loading' | 'signedOut' | 'localWorkspace' | 'guest' | 'offline' | 'off' | 'failed';

/** What decides availability besides the settings. */
export interface AiContext {
  signedIn: boolean;
  /** The workspace is kept on the account (not "on this device only"). */
  synced: boolean;
  role: string | null;
  online: boolean;
}

export function availability(state: AiSettingsState, context: AiContext): AiAvailability {
  if (!context.signedIn) return 'signedOut';
  if (!context.synced) return 'localWorkspace';
  if (context.role === 'guest') return 'guest';
  if (!context.online) return 'offline';
  if (state.status === 'idle' || (state.status === 'loading' && !state.settings)) return 'loading';
  if (state.status === 'failed' && !state.settings) return 'failed';
  const settings = state.status === 'ready' ? state.settings : state.settings!;
  return settings.enabled ? 'ready' : 'off';
}

/** Settings are read again after this long when someone asks (another admin may change them). */
const FRESH_MS = 60_000;

/**
 * A failed read is not tried again for this long unless forced. The hook that asks
 * (`context.ts`) asks again whenever availability changes, and a failure is such a change: without
 * a pause, a workspace whose read fails (404 for an account that is not its member, a server
 * error) was asked for about fifteen times a second for as long as the tab stayed open.
 */
const RETRY_MS = 15_000;

const IDLE: AiSettingsState = Object.freeze({ status: 'idle' as const });

export class AiSettingsStore {
  private readonly states = new Map<Id, AiSettingsState>();
  private readonly readAt = new Map<Id, number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly api: AiApi,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The workspace's settings as read. The same object until they change: React's
   * `useSyncExternalStore` reads it as a snapshot, and a new one each time draws again for ever
   * (Settings did, for a workspace never read: a local one).
   */
  state(workspaceId: Id): AiSettingsState {
    return this.states.get(workspaceId) ?? IDLE;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private set(workspaceId: Id, state: AiSettingsState) {
    this.states.set(workspaceId, state);
    for (const listener of this.listeners) listener();
  }

  /** Reads the settings unless they were read a moment ago (or `force`). */
  load(workspaceId: Id, force = false): void {
    const state = this.state(workspaceId);
    if (state.status === 'loading') return;
    const at = this.readAt.get(workspaceId);
    const age = at === undefined ? Infinity : this.now() - at;
    if (
      !force &&
      ((state.status === 'ready' && age < FRESH_MS) ||
        (state.status === 'failed' && age < RETRY_MS))
    )
      return;
    const kept = state.status === 'idle' ? null : state.settings;
    this.set(workspaceId, { status: 'loading', settings: kept });
    this.api.settings(workspaceId).then(
      (settings) => {
        this.readAt.set(workspaceId, this.now());
        this.set(workspaceId, { status: 'ready', settings });
      },
      (error: unknown) => {
        this.readAt.set(workspaceId, this.now());
        this.set(workspaceId, {
          status: 'failed',
          settings: kept,
          code: error instanceof AiError ? error.code : 'server.error',
        });
      },
    );
  }

  /** Saves a change (owners and admins; the server decides) and keeps what it answers. */
  async save(workspaceId: Id, change: AiSettingsChange): Promise<AiSettings> {
    const settings = await this.api.saveSettings(workspaceId, change);
    this.readAt.set(workspaceId, this.now());
    this.set(workspaceId, { status: 'ready', settings });
    return settings;
  }

  /** The server refused a completion as `ai.disabled`: what this tab knew is stale. */
  refusedAsOff(workspaceId: Id): void {
    const state = this.state(workspaceId);
    if (state.status === 'ready')
      this.set(workspaceId, { status: 'ready', settings: { ...state.settings, enabled: false } });
    this.load(workspaceId, true);
  }
}
