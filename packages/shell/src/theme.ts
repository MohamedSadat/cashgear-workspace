// The theme controller, adapted from Cash Gear Sheet (packages/ui/src/theme.ts): it follows the
// system unless the user picks a theme, remembers the pick on this device, sets `data-cg-theme`
// on <html> (the CashGear controls and the editor read it) and gives the desktop window's own
// frame the same theme.
import type { Theme, WorkspacePlatform } from './platform';

export type ThemePreference = 'system' | Theme;

const storageKey = 'cgw-theme';

function readPreference(storage: () => Storage): ThemePreference {
  try {
    const saved = storage().getItem(storageKey);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

function writePreference(storage: () => Storage, preference: ThemePreference) {
  try {
    if (preference === 'system') storage().removeItem(storageKey);
    else storage().setItem(storageKey, preference);
  } catch {
    // The choice then lasts until the page closes.
  }
}

/** What the controller needs from its surroundings, so tests can supply their own. */
export interface ThemeEnvironment {
  systemDark: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  storage: () => Storage;
  root: { dataset: DOMStringMap };
}

function browserEnvironment(): ThemeEnvironment {
  return {
    systemDark: matchMedia('(prefers-color-scheme: dark)'),
    storage: () => localStorage,
    root: document.documentElement,
  };
}

export class ThemeController {
  private readonly listeners = new Set<() => void>();
  private currentPreference: ThemePreference;

  constructor(
    private readonly platform: Pick<WorkspacePlatform, 'setWindowTheme'>,
    private readonly environment: ThemeEnvironment = browserEnvironment(),
  ) {
    this.currentPreference = readPreference(environment.storage);
    environment.systemDark.addEventListener('change', this.apply);
    this.apply();
    this.syncWindow();
  }

  get preference(): ThemePreference {
    return this.currentPreference;
  }

  get theme(): Theme {
    if (this.currentPreference !== 'system') return this.currentPreference;
    return this.environment.systemDark.matches ? 'dark' : 'light';
  }

  setPreference(preference: ThemePreference) {
    if (preference === this.currentPreference) return;
    this.currentPreference = preference;
    writePreference(this.environment.storage, preference);
    this.apply();
    this.syncWindow();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispose() {
    this.environment.systemDark.removeEventListener('change', this.apply);
    this.listeners.clear();
  }

  private readonly apply = () => {
    this.environment.root.dataset.cgTheme = this.theme;
    for (const listener of this.listeners) listener();
  };

  private syncWindow() {
    const preference = this.currentPreference;
    this.platform
      .setWindowTheme(preference === 'system' ? null : preference)
      .catch((error: unknown) => console.warn('Could not set the window theme:', error));
  }
}
