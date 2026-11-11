// Markdown shortcuts (ARCHITECTURE.md, "Markdown shortcuts"): typed at the start of a paragraph,
// `#`, `##`, `###`, `-`, `1.`, `[]`, `>`, ``` and `---` turn the block into that kind; the
// paragraph keeps its id, its text after the marker and its children. `**bold**`, `*italic*`,
// `` `code` `` and `~~strike~~` mark the text between them.
import { Extension, InputRule, markInputRule, type Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { newBlockId, type TextKind } from '@cgw/doc';
import { blockAt } from './blocks';

function kindRule(
  find: RegExp,
  kind: TextKind,
  attrs: (match: RegExpMatchArray) => Record<string, unknown> = () => ({}),
) {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const $from = state.doc.resolve(range.from);
      const body = $from.parent;
      // Only from a plain paragraph, at its very start.
      if (body.type.name !== 'textBody' || body.attrs.kind !== 'paragraph') return null;
      if ($from.parentOffset !== 0) return null;
      state.tr.delete(range.from, range.to).setNodeMarkup($from.before(), undefined, {
        ...body.attrs,
        kind,
        level: kind === 'heading' ? 1 : null,
        checked: kind === 'checkItem' ? false : null,
        ...attrs(match),
      });
    },
  });
}

const codeRule = new InputRule({
  find: /^```([\w+-]{0,32})\s$/,
  handler: ({ state, range, match }) => {
    const $from = state.doc.resolve(range.from);
    const body = $from.parent;
    if (
      body.type.name !== 'textBody' ||
      body.attrs.kind !== 'paragraph' ||
      $from.parentOffset !== 0
    )
      return null;
    const rest = body.textContent.slice(match[0].length);
    const { codeBlock } = state.schema.nodes;
    const tr = state.tr;
    tr.replaceWith(
      $from.before(),
      $from.after(),
      codeBlock.create({ language: match[1] || null }, rest ? state.schema.text(rest) : null),
    );
    tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1));
  },
});

const dividerRule = new InputRule({
  find: /^---$/,
  handler: ({ state, range }) => {
    const $from = state.doc.resolve(range.from);
    const body = $from.parent;
    if (
      body.type.name !== 'textBody' ||
      body.attrs.kind !== 'paragraph' ||
      !/^-{2,3}$/.test(body.textContent)
    )
      return null;
    const block = blockAt($from);
    if (!block) return null;
    const { schema } = state;
    const tr = state.tr;
    // The paragraph becomes the divider (keeping its id); the caret goes to a new paragraph below.
    tr.replaceWith($from.before(), $from.after(), schema.nodes.divider.create());
    const after = tr.mapping.map(block.pos + block.node.nodeSize);
    tr.insert(
      after,
      schema.nodes.block.create({ id: newBlockId() }, schema.nodes.textBody.create()),
    );
    tr.setSelection(TextSelection.create(tr.doc, after + 2));
  },
});

export function markdownRules(editor: Editor): InputRule[] {
  const marks = editor.schema.marks;
  return [
    kindRule(/^(#{1,3})\s$/, 'heading', (m) => ({ level: m[1].length })),
    kindRule(/^[-*+]\s$/, 'bulletItem'),
    kindRule(/^1[.)]\s$/, 'numberedItem'),
    kindRule(/^\[([ xX]?)\]\s$/, 'checkItem', (m) => ({ checked: m[1].toLowerCase() === 'x' })),
    kindRule(/^>\s$/, 'quote'),
    kindRule(/^!>\s$/, 'callout', () => ({ icon: '💡', tone: 'info' })),
    codeRule,
    dividerRule,
    markInputRule({
      find: /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/,
      type: marks.bold,
    }),
    markInputRule({ find: /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/, type: marks.italic }),
    markInputRule({ find: /(?:^|\s)(`(?!\s+`)((?:[^`]+))`(?!\s+`))$/, type: marks.code }),
    markInputRule({ find: /(?:^|\s)(~~(?!\s+~~)((?:[^~]+))~~(?!\s+~~))$/, type: marks.strike }),
  ];
}

export const MarkdownShortcuts = Extension.create({
  name: 'cgwMarkdownShortcuts',
  addInputRules() {
    return markdownRules(this.editor);
  },
});
