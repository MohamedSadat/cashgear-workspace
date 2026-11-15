// The plugin block (schema version 6, `pluginBlock`; INTEGRATIONS.md, Plugin blocks): a frame the
// host draws the block's definition into (`host.plugins.mount`, the shell's `@cgw/plugins`), by
// the lazy frame's rules (frame.ts). The frame is mounted again only when the block's type, block
// id or editability changes; its props and version go to the frame's `update`. A type the host
// has no definition for, or no host to draw it, draws a placeholder that names the type, and the
// node is never changed: a build without the plugin keeps the block exactly as it was.
import type { Editor, NodeViewRenderer } from '@tiptap/core';
import { insertBody } from '../actions';
import {
  EDITOR_STRING_DEFAULTS,
  type EditorHost,
  type EditorStrings,
  type OnHostChange,
  type PluginMountOptions,
} from '../host';
import { frameBlockView, type FrameBlockSpec } from './frame';

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const version = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

type PluginString = 'pluginBlock' | 'pluginUnknown' | 'pluginUnavailable';
const say = (strings: EditorStrings | undefined, key: PluginString) =>
  (strings?.[key] as string | undefined) || EDITOR_STRING_DEFAULTS[key];

/** "Needs a newer version" with the block's type in it (or without one, for a block with none). */
export function unknownPluginText(strings: EditorStrings | undefined, type: string | null) {
  const message = say(strings, 'pluginUnknown');
  return type
    ? message.replace('{{type}}', type)
    : message.replace(/\s*[(（]\{\{type\}\}[)）]/, '').replace('{{type}}', '');
}

const spec: FrameBlockSpec<PluginMountOptions> = {
  body: 'pluginBlock',
  classes: {
    root: 'cgw-pluginBlock',
    frame: 'cgw-embed-frame',
    placeholder: 'cgw-embed-placeholder',
    text: 'cgw-embed-placeholder-text',
    action: 'cgw-embed-choose',
  },
  what: 'plugin block',
  label: (strings) => say(strings, 'pluginBlock'),
  failed: (strings) => say(strings, 'pluginUnavailable'),
  draw({ node, host, strings, blockId, editable, setAttrs }) {
    const type = text(node.attrs.type);
    const plugins = host.plugins;
    if (!type || !plugins?.mount || !plugins.has(type))
      return { kind: 'placeholder', text: unknownPluginText(strings, type) };
    return {
      kind: 'frame',
      key: JSON.stringify([type, blockId, editable]),
      options: {
        type,
        version: version(node.attrs.version),
        props: text(node.attrs.props),
        blockId,
        editable,
        setProps: (props, written) => {
          // Only text that parses as a JSON object is ever written, with a whole version.
          if (!editable || !isObjectText(props) || version(written) === null) return;
          setAttrs({ props, version: written });
        },
      },
      mount: (element, options) => plugins.mount!(element, options),
    };
  },
};

function isObjectText(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Puts a plugin block in the document as a block of its own, the caret after it (the slash menu's
 * chart and kanban): its type, the definition's version and its first props (null: the
 * definition's own set-up, drawn in its frame, asks for the rest).
 */
export function insertPluginBlock(
  editor: Editor,
  attrs: { type: string; version: number; props?: string | null },
): void {
  if (!editor.isEditable || !editor.schema.nodes.pluginBlock) return;
  const props = attrs.props && isObjectText(attrs.props) ? attrs.props : null;
  insertBody(
    editor,
    editor.schema.nodes.pluginBlock.create({ type: attrs.type, version: attrs.version, props }),
    'after',
  );
}

export function pluginBlockView(
  host: () => EditorHost,
  onHostChange: OnHostChange = () => () => {},
): NodeViewRenderer {
  return frameBlockView(spec, host, onHostChange);
}
