// The database view block (schema version 3): a frame the host draws the database into
// (`host.databases.mount`, the shell's `@cgw/database`), by the lazy frame's rules (frame.ts, D26):
// mounted when the block comes near the viewport and unmounted when it goes far away, and mounted
// again only when the block's database, view, block id or editability changes. Without a host to
// draw it, or without a database, the block draws a placeholder. Removing the block only unmounts
// the frame; the database is a page of its own and stays (contracts, section 5).
import type { NodeViewRenderer } from '@tiptap/core';
import type { DatabaseMountOptions, DatabaseRef, EditorHost, OnHostChange } from '../host';
import { frameBlockView, type FrameBlockSpec } from './frame';

export { FAR_MARGIN, NEAR_MARGIN } from './frame';

const spec: FrameBlockSpec<DatabaseMountOptions> = {
  body: 'databaseView',
  classes: {
    root: 'cgw-databaseView',
    frame: 'cgw-database-frame',
    placeholder: 'cgw-database-placeholder',
    text: 'cgw-database-placeholder-text',
    action: 'cgw-database-choose',
  },
  what: 'database view',
  label: (strings) => strings?.databaseView ?? '',
  failed: (strings) => strings?.databaseUnavailable ?? '',
  draw({ node, host, strings, blockId, editable, setAttrs }) {
    const databaseId = node.attrs.databaseId as string | null;
    const databases = host.databases;
    if (!databaseId || !databases?.mount) {
      const pick = databases?.pick;
      return {
        kind: 'placeholder',
        text: (databaseId ? strings?.databaseUnavailable : strings?.databaseNotChosen) ?? '',
        actions:
          !databaseId && pick && editable
            ? [
                {
                  label: strings?.databaseChoose ?? '',
                  run: () =>
                    void pick().then((picked: DatabaseRef | null) => {
                      if (picked)
                        setAttrs({ databaseId: picked.databaseId, viewId: picked.viewId ?? null });
                    }),
                },
              ]
            : [],
      };
    }
    const viewId = (node.attrs.viewId as string | null) ?? null;
    return {
      kind: 'frame',
      // Another view of the database is drawn by a new frame (the host keeps its root, mount.tsx).
      key: JSON.stringify([databaseId, viewId, blockId, editable]),
      options: {
        databaseId,
        viewId,
        blockId,
        editable,
        setViewId: (next) => setAttrs({ viewId: next }),
      },
      mount: (element, options) => {
        const unmount = databases.mount!(element, options);
        return { update: () => {}, destroy: unmount };
      },
    };
  },
};

export function databaseViewView(
  host: () => EditorHost,
  onHostChange: OnHostChange = () => () => {},
): NodeViewRenderer {
  return frameBlockView(spec, host, onHostChange);
}
