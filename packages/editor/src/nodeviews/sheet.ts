// The workbook block (schema version 4, `sheetEmbed`): a frame the host draws the workbook into
// (`host.workbooks.mount`: its name, its picture, the live embed, the view picker), by the lazy
// frame's rules (frame.ts). The frame is mounted again only when the block's workbook, block id or
// editability changes; a change of its view or height goes to the frame's `update`. Without a
// workbook it offers to choose one or make one; without a host to draw it, it says so. Removing
// the block only destroys the frame: the workbook is a record of its own and stays.
import type { NodeViewRenderer } from '@tiptap/core';
import type {
  EditorHost,
  OnHostChange,
  SheetBlockAttrs,
  SheetMountOptions,
  WorkbookRef,
} from '../host';
import { frameBlockView, type FrameBlockSpec, type PlaceholderAction } from './frame';

/** A picked or new workbook's attributes for the block: its view, when the host gave one. */
export function workbookAttrs(ref: WorkbookRef) {
  return {
    workbookId: ref.workbookId,
    sheet: ref.sheet ?? null,
    range: ref.range ?? null,
    chartId: ref.chartId ?? null,
    height: ref.height ?? null,
  };
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const height = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const spec: FrameBlockSpec<SheetMountOptions> = {
  body: 'sheetEmbed',
  classes: {
    root: 'cgw-sheetEmbed',
    frame: 'cgw-embed-frame',
    placeholder: 'cgw-embed-placeholder',
    text: 'cgw-embed-placeholder-text',
    action: 'cgw-embed-choose',
  },
  what: 'workbook',
  label: (strings) => strings?.sheetEmbed ?? '',
  failed: (strings) => strings?.sheetUnavailable ?? '',
  draw({ node, host, strings, blockId, editable, setAttrs }) {
    const workbookId = text(node.attrs.workbookId);
    const workbooks = host.workbooks;
    const mount = workbooks?.mount;
    if (!workbookId || !mount) {
      const actions: PlaceholderAction[] = [];
      const offer = (
        label: string | undefined,
        ask: (() => Promise<WorkbookRef | null>) | undefined,
      ) => {
        if (!ask || !editable) return;
        actions.push({
          label: label ?? '',
          run: () =>
            void ask().then((ref) => {
              if (ref) setAttrs(workbookAttrs(ref));
            }),
        });
      };
      if (!workbookId) {
        offer(strings?.sheetChoose, workbooks?.pick);
        offer(strings?.sheetCreate, workbooks?.create);
      }
      return {
        kind: 'placeholder',
        text: (workbookId ? strings?.sheetUnavailable : strings?.sheetNotChosen) ?? '',
        actions,
      };
    }
    const attrs: SheetBlockAttrs = {
      sheet: text(node.attrs.sheet),
      range: text(node.attrs.range),
      chartId: text(node.attrs.chartId),
      height: height(node.attrs.height),
    };
    return {
      kind: 'frame',
      key: JSON.stringify([workbookId, blockId, editable]),
      options: {
        workbookId,
        ...attrs,
        blockId,
        editable,
        setAttrs: (next) => setAttrs(next),
      },
      mount: (element, options) => workbooks!.mount!(element, options),
    };
  },
};

export function sheetEmbedView(
  host: () => EditorHost,
  onHostChange: OnHostChange = () => () => {},
): NodeViewRenderer {
  return frameBlockView(spec, host, onHostChange);
}
