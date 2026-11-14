// The ERP view block (schema version 4, `erpView`): a frame the host draws the ERP view into
// (`host.erp.mount`, the shell's `@cgw/erp` view, from the reader's own ERP session, in memory
// only), by the lazy frame's rules (frame.ts). The frame is mounted again only when the block's
// link, block id or editability changes; its connector, filter, fields, sort and page size go to
// the frame's `update`. A block with no link yet is mounted too: choosing the link and connector
// is the view's own (its pickers). Without a host to draw it, it says so. The block holds only
// what the person chose, never ERP data.
import type { NodeViewRenderer } from '@tiptap/core';
import type { EditorHost, ErpBlockAttrs, ErpMountOptions, OnHostChange } from '../host';
import { frameBlockView, type FrameBlockSpec } from './frame';

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const size = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const spec: FrameBlockSpec<ErpMountOptions> = {
  body: 'erpView',
  classes: {
    root: 'cgw-erpView',
    frame: 'cgw-embed-frame',
    placeholder: 'cgw-embed-placeholder',
    text: 'cgw-embed-placeholder-text',
    action: 'cgw-embed-choose',
  },
  what: 'ERP view',
  label: (strings) => strings?.erpView ?? '',
  failed: (strings) => strings?.erpUnavailable ?? '',
  draw({ node, host, strings, blockId, editable, setAttrs }) {
    const linkId = text(node.attrs.linkId);
    const erp = host.erp;
    if (!erp?.mount)
      return {
        kind: 'placeholder',
        text: (linkId ? strings?.erpUnavailable : strings?.erpNotChosen) ?? '',
      };
    const attrs: ErpBlockAttrs = {
      linkId,
      connectorId: text(node.attrs.connectorId),
      filter: text(node.attrs.filter),
      fields: text(node.attrs.fields),
      sort: text(node.attrs.sort),
      pageSize: size(node.attrs.pageSize),
    };
    return {
      kind: 'frame',
      key: JSON.stringify([linkId, blockId, editable]),
      options: { ...attrs, blockId, editable, setAttrs: (next) => setAttrs(next) },
      mount: (element, options) => erp.mount!(element, options),
    };
  },
};

export function erpViewView(
  host: () => EditorHost,
  onHostChange: OnHostChange = () => () => {},
): NodeViewRenderer {
  return frameBlockView(spec, host, onHostChange);
}
