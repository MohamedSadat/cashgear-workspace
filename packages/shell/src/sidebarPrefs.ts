// Whether the sidebar shows its Recent pages, kept on this device as the theme and the language
// are (DECISIONS.md, 2026-11-27: "Settings in tabs, Recent optional…"). Shown unless hidden here;
// visits are recorded either way, so the palette's Recent and opening the last page are unchanged.
import { useSyncExternalStore } from 'react';

const storageKey = 'cgw-recent';

/** What the preference needs from its surroundings, so tests can supply their own. */
export interface RecentEnvironment {
  storage: () => Storage;
  /** Where another tab's change arrives (`storage` events), if anywhere. */
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

function browserEnvironment(): RecentEnvironment {
  return {
    storage: () => localStorage,
    events: typeof window === 'undefined' ? undefined : window,
  };
}

function readShown(storage: () => Storage): boolean {
  try {
    return storage().getItem(storageKey) !== 'hidden';
  } catch {
    return true;
  }
}

export class RecentPreference {
  private readonly listeners = new Set<() => void>();
  private shown: boolean;

  constructor(private readonly environment: RecentEnvironment = browserEnvironment()) {
    this.shown = readShown(environment.storage);
  }

  /** Whether the sidebar shows Recent (a primitive, so React's snapshot stays stable). */
  getShown = (): boolean => this.shown;

  setShown(shown: boolean) {
    if (shown === this.shown) return;
    this.shown = shown;
    try {
      if (shown) this.environment.storage().removeItem(storageKey);
      else this.environment.storage().setItem(storageKey, 'hidden');
    } catch {
      // The choice then lasts until the page closes.
    }
    this.notify();
  }

  subscribe = (listener: () => void) => {
    if (this.listeners.size === 0)
      this.environment.events?.addEventListener('storage', this.onStorage);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0)
        this.environment.events?.removeEventListener('storage', this.onStorage);
    };
  };

  /** Another tab of this origin changed it. */
  private readonly onStorage = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key !== null && key !== storageKey) return;
    const shown = readShown(this.environment.storage);
    if (shown === this.shown) return;
    this.shown = shown;
    this.notify();
  };

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

let shared: RecentPreference | null = null;

/** The app's one preference (made on first use). */
export function recentPreference(): RecentPreference {
  shared ??= new RecentPreference();
  return shared;
}

/** Whether the sidebar shows Recent, drawn again when it changes here or in another tab. */
export function useRecentShown(preference: RecentPreference = recentPreference()): boolean {
  return useSyncExternalStore(preference.subscribe, preference.getShown);
}
