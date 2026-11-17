// The editor's block actions as commands in the shell's registry: the slash menu, the palette and
// the block menu all list them from here, in the interface language, found by words in both. From
// Phase 7 also the plugin blocks (`@cgw/plugins`): chart and kanban, inserted with their
// definition's version and drawn by `EditorHost.plugins`.
import { BLOCK_ACTIONS, insertPluginBlock, type SlashItem } from '@cgw/editor';
import { FIRST_PARTY } from '@cgw/plugins';
import type { TFunction } from 'i18next';
import type { ShellServices } from '../context';
import { ar } from '../i18n/ar';
import { en } from '../i18n/en';

/** A plugin block's command id: `block.plugin:cashgear.chart`. */
const PLUGIN_PREFIX = 'block.plugin:';

export function registerBlockCommands(services: ShellServices, t: TFunction): () => void {
  return services.commands.register(
    ...BLOCK_ACTIONS.map((action) => ({
      id: `block.${action.name}`,
      group: 'block' as const,
      label: () => t(`blocks.${action.name}`),
      keywords: () => [
        en.blockKeywords[action.name],
        ar.blockKeywords[action.name],
        en.blocks[action.name],
        ar.blocks[action.name],
      ],
      // Offered where the editor can do it: "Database" needs a page that may hold one, "Linked
      // view" a host that can choose one (`BlockAction.available`).
      when: () => {
        const editor = services.editor.current;
        return !!editor?.editor.isEditable && (action.available?.(editor.host()) ?? true);
      },
      run: () => {
        const editor = services.editor.current;
        if (editor) return action.apply(editor.editor, editor.host());
      },
    })),
    // The plugin blocks, in the registry's order, where the page's host can draw them.
    ...FIRST_PARTY.list().map((definition) => ({
      id: `${PLUGIN_PREFIX}${definition.type}`,
      group: 'block' as const,
      // In the interface language, which the shell keeps on <html> (`applyLanguage`).
      label: () =>
        document.documentElement.lang.startsWith('ar')
          ? definition.slash.label.ar
          : definition.slash.label.en,
      keywords: () => [
        definition.slash.label.en,
        definition.slash.label.ar,
        ...definition.slash.keywords,
      ],
      when: () => {
        const editor = services.editor.current;
        return !!editor?.editor.isEditable && !!editor.host().plugins?.has(definition.type);
      },
      run: () => {
        const editor = services.editor.current;
        if (editor)
          insertPluginBlock(editor.editor, { type: definition.type, version: definition.version });
      },
    })),
  );
}

/** What the slash menu shows for a query: the block commands, best matches first. */
export function slashItems(services: ShellServices, t: TFunction, query: string): SlashItem[] {
  const context = { services, toggleSidebar: () => {} };
  return services.commands.list(context, query, ['block']).map((command) => {
    if (command.id.startsWith(PLUGIN_PREFIX)) {
      const definition = FIRST_PARTY.get(command.id.slice(PLUGIN_PREFIX.length));
      return {
        id: command.id,
        label: command.label(),
        // Phase 10: a third-party plugin (plugins/commands.ts) has no definition here.
        glyph: definition?.slash.icon ?? 'embed',
        group: t('commands.group.insert'),
      };
    }
    const name = command.id.slice('block.'.length);
    const action = BLOCK_ACTIONS.find((a) => a.name === name);
    return {
      id: command.id,
      label: command.label(),
      glyph: action?.glyph ?? '',
      group: t(action && action.turnInto ? 'commands.group.basic' : 'commands.group.insert'),
    };
  });
}
