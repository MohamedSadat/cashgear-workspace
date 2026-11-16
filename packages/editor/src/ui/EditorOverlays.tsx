import type { BlockEditor } from '../editor';
import type { EditorHost } from '../host';
import { BlockHandleParts } from './BlockHandle';
import { BlockMenu } from './BlockMenu';
import { BubbleToolbar } from './BubbleToolbar';
import { DatePicker } from './DatePicker';
import { MentionMenu } from './MentionMenu';
import { SlashMenu } from './SlashMenu';
import { TableMenu } from './TableMenu';
import { TouchToolbar } from './TouchToolbar';

/** Everything drawn over the editor: the slash menu, the bubble toolbar, the block handle's button
 * and drop line, the block menu, the date picker and, on a narrow or touch screen, the touch
 * toolbar. */
export function EditorOverlays({ editor, host }: { editor: BlockEditor; host: EditorHost }) {
  return (
    <>
      <SlashMenu editor={editor} host={host} />
      <MentionMenu editor={editor} host={host} />
      <BubbleToolbar editor={editor} host={host} />
      <BlockHandleParts editor={editor} host={host} />
      <BlockMenu editor={editor} host={host} />
      <TableMenu editor={editor} host={host} />
      <DatePicker editor={editor} host={host} />
      <TouchToolbar editor={editor} host={host} />
    </>
  );
}
