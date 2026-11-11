import type { BlockEditor } from '../editor';
import type { EditorHost } from '../host';
import { BlockMenu } from './BlockMenu';
import { BubbleToolbar } from './BubbleToolbar';
import { MentionMenu } from './MentionMenu';
import { SlashMenu } from './SlashMenu';
import { TableMenu } from './TableMenu';

/** Everything drawn over the editor: the slash menu, the bubble toolbar and the block menu. */
export function EditorOverlays({ editor, host }: { editor: BlockEditor; host: EditorHost }) {
  return (
    <>
      <SlashMenu editor={editor} host={host} />
      <MentionMenu editor={editor} host={host} />
      <BubbleToolbar editor={editor} host={host} />
      <BlockMenu editor={editor} host={host} />
      <TableMenu editor={editor} host={host} />
    </>
  );
}
