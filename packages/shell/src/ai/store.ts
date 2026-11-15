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

export class AiSettingsStore {
  private readonly states = new Map<Id, AiSettingsState>();
  private readonly readAt = new Map<Id, number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly api: AiApi,
    private readonly now: () => number = Date.now,
  ) {}

  state(workspaceId: Id): AiSettingsState {
    return this.states.get(workspaceId) ?? { status: 'idle' };
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
    if (!force && state.status === 'ready' && at !== undefined && this.now() - at < FRESH_MS)
      return;
    const kept = state.status === 'idle' ? null : state.settings;
    this.set(workspaceId, { status: 'loading', settings: kept });
    this.api.settings(workspaceId).then(
      (settings) => {
        this.readAt.set(workspaceId, this.now());
        this.set(workspaceId, { status: 'ready', settings });
      },
      (error: unknown) =>
        this.set(workspaceId, {
          status: 'failed',
          settings: kept,
          code: error instanceof AiError ? error.code : 'server.error',
        }),
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
