import type { BlockEditor } from '@cgw/editor';
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { CommandRegistry } from './commands';
import type { WorkspacePlatform } from './platform';
import type { ThemeController, ThemePreference } from './theme';

/** What the app's frame hands to everything inside it. */
export interface ShellServices {
  platform: WorkspacePlatform;
  theme: ThemeController;
  commands: CommandRegistry<CommandContext>;
  /** The editor of the page on screen, if any: block commands act on it. */
  editor: { current: BlockEditor | null };
}

/** What a command can act on. Grows as the shell does. */
export interface CommandContext {
  services: ShellServices;
  toggleSidebar: () => void;
}

export const ShellContext = createContext<ShellServices | null>(null);

export function useShell(): ShellServices {
  const services = useContext(ShellContext);
  if (!services) throw new Error('useShell outside <WorkspaceApp>');
  return services;
}

export function useThemePreference(): ThemePreference {
  const { theme } = useShell();
  return useSyncExternalStore(theme.subscribe, () => theme.preference);
}
