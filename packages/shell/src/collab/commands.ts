// The comments' command: in the palette, the page menu and on a shortcut.
import type { TFunction } from 'i18next';
import type { CommandRegistry } from '../commands';
import type { CommandContext } from '../context';
import { ar } from '../i18n/ar';
import { en } from '../i18n/en';

/**
 * Shows or hides the comments: by `event.code`, so it is the same key on an Arabic layout. The
 * editor's "Comment" on the selection is Ctrl+Alt+M; with Shift it shows the comments.
 */
export const COMMENTS_SHORTCUT = 'Mod+Alt+Shift+KeyM';

/** "Show or hide comments", while a page whose comments can be shown is open. */
export function registerCommentsCommand(
  commands: CommandRegistry<CommandContext>,
  t: TFunction,
  toggle: () => void,
): () => void {
  return commands.register({
    id: 'page.comments',
    group: 'page',
    label: () => t('comments.toggle'),
    // Found by words in either language, whichever the interface is in.
    keywords: () => [en.keywords.comments, ar.keywords.comments],
    shortcut: COMMENTS_SHORTCUT,
    run: toggle,
  });
}
