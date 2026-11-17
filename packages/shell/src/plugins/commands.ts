// The slash menu's third-party plugins (Phase 10): the open workspace's plugins that are on, by
// their manifests' names in the interface language, found by both names, their type and their
// keywords; inserting writes `{type, version, props: null}`. Registered with the page's editor and
// again whenever the list changes; a command another page already registered is left as it is.
import { insertPluginBlock } from '@cgw/editor';
import type { Id } from '@cgw/workspace';
import type { ShellServices } from '../context';
import type { PluginServices } from './services';

/** As the first-party blocks' commands (page/blockCommands.ts): `block.plugin:vendor.notes`. */
export const PLUGIN_COMMAND_PREFIX = 'block.plugin:';

export function registerThirdPartyCommands(
  shell: ShellServices,
  plugins: PluginServices,
  workspaceId: Id,
): () => void {
  let registered = '';
  let off: (() => void) | null = null;
  const sync = () => {
    const list = plugins.enabled(workspaceId);
    const key = JSON.stringify(list.map((p) => [p.type, p.version, p.name, p.keywords]));
    if (key === registered) return;
    registered = key;
    off?.();
    off = null;
    const commands = list
      .filter((p) => !shell.commands.get(`${PLUGIN_COMMAND_PREFIX}${p.type}`))
      .map((plugin) => ({
        id: `${PLUGIN_COMMAND_PREFIX}${plugin.type}`,
        group: 'block' as const,
        // In the interface language, which the shell keeps on <html> (`applyLanguage`).
        label: () =>
          (document.documentElement.lang.startsWith('ar') ? plugin.name.ar : plugin.name.en) ||
          plugin.name.en ||
          plugin.type,
        keywords: () => [plugin.name.en, plugin.name.ar, plugin.type, ...plugin.keywords],
        when: () => {
          const editor = shell.editor.current;
          return !!editor?.editor.isEditable && !!editor.host().plugins?.has(plugin.type);
        },
        run: () => {
          const editor = shell.editor.current;
          if (editor)
            insertPluginBlock(editor.editor, { type: plugin.type, version: plugin.version });
        },
      }));
    if (commands.length) off = shell.commands.register(...commands);
  };
  sync();
  plugins.ensure(workspaceId);
  const unsubscribe = plugins.subscribe(sync);
  return () => {
    unsubscribe();
    off?.();
    off = null;
  };
}
