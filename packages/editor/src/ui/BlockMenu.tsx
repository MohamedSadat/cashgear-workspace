// The block menu, from the handle or Ctrl+/: turn into, colour, duplicate, delete, move up and
// down, copy a link to the block. Part of the Track U3 stand-in. Arrow keys move through it;
// Escape returns to the editor.
import { COLOUR_TOKENS } from '@cgw/doc';
import { NodeSelection } from '@tiptap/pm/state';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BLOCK_ACTIONS } from '../actions';
import {
  blockInfoAt,
  deleteBlock,
  duplicateBlock,
  firstBody,
  moveSibling,
  type BlockInfo,
} from '../blocks';
import type { BlockEditor } from '../editor';
import type { EditorHost } from '../host';

interface Opened {
  pos: number;
  rect: { left: number; right: number; top: number; bottom: number };
}

export function BlockMenu({
  editor: blockEditor,
  host,
}: {
  editor: BlockEditor;
  host: EditorHost;
}) {
  const editor = blockEditor.editor;
  const [opened, setOpened] = useState<Opened | null>(null);
  const [panel, setPanel] = useState<null | 'turnInto' | 'colour'>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: -9999, left: -9999 });
  const s = host.strings;

  useEffect(() => {
    blockEditor.ui.openBlockMenu = (pos, rect) => {
      setPanel(null);
      setOpened({
        pos,
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      });
    };
    return () => {
      blockEditor.ui.openBlockMenu = null;
    };
  }, [blockEditor]);

  useLayoutEffect(() => {
    if (!opened || !menu.current) return;
    const el = menu.current;
    const rtl = getComputedStyle(el).direction === 'rtl';
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const top = Math.max(8, Math.min(opened.rect.bottom + 4, window.innerHeight - height - 8));
    const left = Math.max(
      8,
      Math.min(rtl ? opened.rect.right - width : opened.rect.left, window.innerWidth - width - 8),
    );
    setPlace({ top, left });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [opened, panel]);

  if (!opened || !s) return null;
  const block = blockInfoAt(editor.state.doc, opened.pos);
  if (!block) return null;
  const body = firstBody(block);
  const close = (refocus = true) => {
    setOpened(null);
    if (refocus) editor.commands.focus();
  };
  const act = (make: (b: BlockInfo) => ReturnType<typeof deleteBlock> | null) => {
    const current = blockInfoAt(editor.state.doc, opened.pos);
    if (!current) return close();
    const tr = make(current);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
    close();
  };
  const selectBlockText = () => {
    if (body?.node.isTextblock)
      editor.commands.setTextSelection({
        from: body.pos + 1,
        to: body.pos + 1 + body.node.content.size,
      });
    else if (body)
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, body.pos)),
      );
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  };
  const item = (label: string, onSelect: () => void, hint?: string, expanded?: boolean) => (
    <button
      type="button"
      role="menuitem"
      className="cgw-block-menu-item"
      aria-expanded={expanded}
      onClick={onSelect}
    >
      <span>{label}</span>
      {hint && <span className="cgw-command-shortcut">{hint}</span>}
    </button>
  );
  return (
    <>
      <div className="cgw-menu-backdrop" onMouseDown={() => close()} />
      <div
        ref={menu}
        className="cgw-block-menu"
        role="menu"
        aria-label={s.blockMenu}
        style={{ top: place.top, left: place.left }}
        onKeyDown={onKeyDown}
      >
        {body?.node.isTextblock &&
          item(
            s.turnInto,
            () => setPanel(panel === 'turnInto' ? null : 'turnInto'),
            '▸',
            panel === 'turnInto',
          )}
        {panel === 'turnInto' && (
          <div className="cgw-block-submenu" role="group" aria-label={s.turnInto}>
            {BLOCK_ACTIONS.filter((a) => a.turnInto).map((action) => (
              <div key={action.name}>
                {item(host.blockName?.(action.name) ?? action.name, () => {
                  selectBlockText();
                  void action.apply(editor, host);
                  close(false);
                })}
              </div>
            ))}
          </div>
        )}
        {body?.node.type.name === 'textBody' &&
          item(
            s.colour,
            () => setPanel(panel === 'colour' ? null : 'colour'),
            '▸',
            panel === 'colour',
          )}
        {panel === 'colour' && body && (
          <div className="cgw-block-submenu" role="group" aria-label={s.colour}>
            {item(s.defaultColour, () =>
              act(() =>
                editor.state.tr.setNodeMarkup(body.pos, undefined, {
                  ...body.node.attrs,
                  colour: null,
                }),
              ),
            )}
            {COLOUR_TOKENS.map((token) => (
              <div key={token}>
                {item(s[`colour_${token}`] ?? token, () =>
                  act(() =>
                    editor.state.tr.setNodeMarkup(body.pos, undefined, {
                      ...body.node.attrs,
                      colour: token,
                    }),
                  ),
                )}
              </div>
            ))}
          </div>
        )}
        {item(
          s.duplicate,
          () => act((b) => duplicateBlock(editor.state, b)),
          host.shortcut?.('Mod+KeyD'),
        )}
        {item(
          s.moveUp,
          () => act((b) => moveSibling(editor.state, b, -1)),
          host.shortcut?.('Alt+Shift+ArrowUp'),
        )}
        {item(
          s.moveDown,
          () => act((b) => moveSibling(editor.state, b, 1)),
          host.shortcut?.('Alt+Shift+ArrowDown'),
        )}
        {block.id &&
          host.copyBlockLink &&
          item(s.copyBlockLink, () => {
            host.copyBlockLink?.(block.id!);
            close();
          })}
        {item(
          s.deleteBlock,
          () => act((b) => deleteBlock(editor.state, b)),
          host.shortcut?.('Delete'),
        )}
      </div>
    </>
  );
}
