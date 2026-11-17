// Plugin blocks in a page (`EditorHost.plugins`, schema version 6; INTEGRATIONS.md, Plugin blocks):
// the first-party definitions (`@cgw/plugins`), drawn into a block's frame over the open
// workspace's database host. The views load with the first plugin block on screen: `mount`
// answers at once with a frame that draws when they have loaded.
import type { DatabaseHost } from '@cgw/database';
import type { EditorHost, MountedFrame, PluginMountOptions } from '@cgw/editor';
import { FIRST_PARTY, type PluginData, type PluginRegistry } from '@cgw/plugins';
import type { i18n as I18n } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useDatabaseHost } from '../database/context';
import { canAsk, requestDatabasePick } from '../database/dialogs';

export interface PluginsHostDeps {
  /**
   * The open workspace's databases, or a page shared by link's (read only, Phase 9:
   * cloud/sharedDatabase.ts); null where there are none.
   */
  databases: DatabaseHost | null;
  /** The linked-view picker, when the frame can ask. */
  pickDatabase?: PluginData['pickDatabase'];
  i18n: I18n;
  registry?: PluginRegistry;
}

/** `EditorHost.plugins` over the given databases. */
export function pluginsHost(deps: PluginsHostDeps): NonNullable<EditorHost['plugins']> {
  const registry = deps.registry ?? FIRST_PARTY;
  const data: PluginData = {
    databases: deps.databases,
    ...(deps.pickDatabase ? { pickDatabase: deps.pickDatabase } : {}),
  };
  return {
    has: (type) => registry.has(type),
    mount: (element, options) => lazyFrame(element, options, { registry, data, i18n: deps.i18n }),
  };
}

/** `EditorHost.plugins` for a page of the open workspace: its databases and the frame's picker. */
export function usePluginsHost(): NonNullable<EditorHost['plugins']> {
  const { i18n } = useTranslation();
  const databases = useDatabaseHost();
  return useMemo(
    () =>
      pluginsHost({
        databases,
        pickDatabase: async () => (canAsk() ? requestDatabasePick() : null),
        i18n,
      }),
    [databases, i18n],
  );
}

/** A frame drawn once `@cgw/plugins/view` has loaded; `update` and `destroy` work before then. */
function lazyFrame(
  element: HTMLElement,
  options: PluginMountOptions,
  deps: { registry: PluginRegistry; data: PluginData; i18n: I18n },
): MountedFrame<PluginMountOptions> {
  let latest = options;
  let gone = false;
  let frame: MountedFrame<PluginMountOptions> | null = null;
  void import('@cgw/plugins/view').then(
    ({ mountPlugin }) => {
      if (gone) return;
      frame = mountPlugin(element, latest, deps);
    },
    (error: unknown) => {
      console.error('The plugin blocks could not be loaded:', error);
      if (!gone) element.textContent = deps.i18n.t('editor.pluginUnavailable');
    },
  );
  return {
    update: (next) => {
      latest = next;
      frame?.update(next);
    },
    destroy: () => {
      gone = true;
      frame?.destroy();
      frame = null;
    },
  };
}
