// Plugin blocks in a page (`EditorHost.plugins`, schema version 6; INTEGRATIONS.md, Plugin blocks):
// the first-party definitions (`@cgw/plugins`), drawn into a block's frame over the open
// workspace's database host; and from Phase 10 third-party plugins, each in its sandboxed frame
// (`@cgw/plugins/frame-view`, plugin-frame.1), from the workspace's list and a frame ticket the
// server makes for a member. Both views load with the first block of their kind on screen:
// `mount` answers at once with a frame that draws when they have loaded.
import type { DatabaseHost } from '@cgw/database';
import type { EditorHost, MountedFrame, PluginMountOptions } from '@cgw/editor';
import { FIRST_PARTY, type PluginData, type PluginRegistry } from '@cgw/plugins';
import { isPluginType, type ThirdPartyDeps } from '@cgw/plugins/frame';
import type { Id } from '@cgw/workspace';
import type { i18n as I18n } from 'i18next';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import { useDatabaseHost } from '../database/context';
import { canAsk, requestDatabasePick } from '../database/dialogs';
import type { WorkspacePlatform } from '../platform';
import type { WorkspaceSession } from '../session';
import { registerThirdPartyCommands } from './commands';
import { SHARED_SOURCE, pluginServices } from './services';

/** What third-party blocks are drawn with, but the data and the strings. */
export type ThirdPartyHost = Omit<ThirdPartyDeps, 'data' | 'i18n'>;

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
  /**
   * Third-party plugins (Phase 10). Without it a type that is not first-party draws the editor's
   * own placeholder ("needs a newer version"), as before.
   */
  thirdParty?: ThirdPartyHost;
}

/** `EditorHost.plugins` over the given databases. */
export function pluginsHost(deps: PluginsHostDeps): NonNullable<EditorHost['plugins']> {
  const registry = deps.registry ?? FIRST_PARTY;
  const data: PluginData = {
    databases: deps.databases,
    ...(deps.pickDatabase ? { pickDatabase: deps.pickDatabase } : {}),
  };
  const thirdParty = deps.thirdParty;
  return {
    // A first-party type this build has; any other plugin type is drawn by its frame (or the
    // frame's placeholder). A `cashgear.*` type this build does not know needs a newer build.
    has: (type) => registry.has(type) || (!!thirdParty && isPluginType(type)),
    mount: (element, options) =>
      options.type && !registry.has(options.type) && thirdParty
        ? lazyThirdParty(element, options, { ...thirdParty, data, i18n: deps.i18n })
        : lazyFrame(element, options, { registry, data, i18n: deps.i18n }),
  };
}

/** The build's plugins origin, when it is one (`VITE_CGW_PLUGINS`); else no frame is made. */
export function pluginsOriginOf(platform: Pick<WorkspacePlatform, 'pluginsOrigin'>): string | null {
  if (!platform.pluginsOrigin) return null;
  try {
    const url = new URL(platform.pluginsOrigin);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * `EditorHost.plugins` for a page of the open workspace: its databases, the frame's picker, and
 * the workspace's third-party plugins (whose slash-menu entries it registers while the page is
 * open).
 */
export function usePluginsHost(
  session: WorkspaceSession,
  page: { workspaceId: Id },
): NonNullable<EditorHost['plugins']> {
  const { i18n } = useTranslation();
  const databases = useDatabaseHost();
  const shell = useShell();
  const { platform, theme } = shell;
  const cloud = useCloud();
  const services = pluginServices(session);
  useEffect(() => services.setCloud(cloud), [services, cloud]);
  const workspaceId = page.workspaceId;
  useEffect(
    () => registerThirdPartyCommands(shell, services, workspaceId),
    [shell, services, workspaceId],
  );
  const pluginsOrigin = pluginsOriginOf(platform);
  return useMemo(
    () =>
      pluginsHost({
        databases,
        pickDatabase: async () => (canAsk() ? requestDatabasePick() : null),
        i18n,
        thirdParty: { source: services.sourceFor(workspaceId), pluginsOrigin, theme },
      }),
    [databases, i18n, services, workspaceId, pluginsOrigin, theme],
  );
}

/** Third-party blocks on a page shared by link: each says plugins are not shown there. */
export const SHARED_THIRD_PARTY: ThirdPartyHost = Object.freeze({
  source: SHARED_SOURCE,
  pluginsOrigin: null,
});

/** A frame drawn once `@cgw/plugins/view` has loaded; `update` and `destroy` work before then. */
function lazyFrame(
  element: HTMLElement,
  options: PluginMountOptions,
  deps: { registry: PluginRegistry; data: PluginData; i18n: I18n },
): MountedFrame<PluginMountOptions> {
  return lazily(element, options, deps.i18n, () =>
    import('@cgw/plugins/view').then(
      ({ mountPlugin }) =>
        (target: HTMLElement, latest: PluginMountOptions) =>
          mountPlugin(target, latest, deps),
    ),
  );
}

/** A third-party block, once `@cgw/plugins/frame-view` has loaded. */
function lazyThirdParty(
  element: HTMLElement,
  options: PluginMountOptions,
  deps: ThirdPartyDeps,
): MountedFrame<PluginMountOptions> {
  return lazily(element, options, deps.i18n, () =>
    import('@cgw/plugins/frame-view').then(
      ({ mountThirdParty }) =>
        (target: HTMLElement, latest: PluginMountOptions) =>
          mountThirdParty(target, latest, deps),
    ),
  );
}

function lazily(
  element: HTMLElement,
  options: PluginMountOptions,
  i18n: I18n,
  load: () => Promise<
    (element: HTMLElement, options: PluginMountOptions) => MountedFrame<PluginMountOptions>
  >,
): MountedFrame<PluginMountOptions> {
  let latest = options;
  let gone = false;
  let frame: MountedFrame<PluginMountOptions> | null = null;
  void load().then(
    (mount) => {
      if (gone) return;
      frame = mount(element, latest);
    },
    (error: unknown) => {
      console.error('The plugin blocks could not be loaded:', error);
      if (!gone) element.textContent = i18n.t('editor.pluginUnavailable');
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
