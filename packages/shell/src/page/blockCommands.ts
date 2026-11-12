// The editor's block actions as commands in the shell's registry: the slash menu, the palette and
// the block menu all list them from here, in the interface language, found by words in both.
import { BLOCK_ACTIONS, type SlashItem } from '@cgw/editor';
import type { TFunction } from 'i18next';
import type { ShellServices } from '../context';
import { ar } from '../i18n/ar';
import { en } from '../i18n/en';

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
  );
}

/** What the slash menu shows for a query: the block commands, best matches first. */
export function slashItems(services: ShellServices, t: TFunction, query: string): SlashItem[] {
  const context = { services, toggleSidebar: () => {} };
  return services.commands.list(context, query, ['block']).map((command) => {
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
