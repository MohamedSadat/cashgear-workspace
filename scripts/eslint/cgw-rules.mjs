// Workspace's own lint rules.
//
// no-untranslated-text: interface text comes from the i18next catalogues (D24), never a literal.
// It reports JSX text with a letter in it, and string literals with a letter given to the props
// that people read or hear (labels, titles, placeholders, alt text). Brand names and test ids are
// not in those props, so they pass.
const READ_PROPS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-placeholder',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
  'legend',
  'headerText',
  'bodyText',
  'footerText',
  'closeButtonAriaLabel',
  'clearAriaLabel',
  'menuAriaLabel',
  'toggleAriaLabel',
]);

const hasLetter = (text) => /\p{L}/u.test(text);

const noUntranslatedText = {
  meta: {
    type: 'problem',
    docs: { description: 'Interface text must come from the translation catalogues' },
    schema: [],
    messages: {
      text: 'Untranslated interface text "{{text}}": use t() and add it to both catalogues.',
    },
  },
  create(context) {
    const report = (node, text) =>
      context.report({ node, messageId: 'text', data: { text: text.trim().slice(0, 40) } });
    return {
      JSXText(node) {
        if (hasLetter(node.value)) report(node, node.value);
      },
      JSXAttribute(node) {
        const name = typeof node.name.name === 'string' ? node.name.name : '';
        if (!READ_PROPS.has(name) || !node.value) return;
        const value =
          node.value.type === 'Literal'
            ? node.value
            : node.value.type === 'JSXExpressionContainer' &&
                node.value.expression.type === 'Literal'
              ? node.value.expression
              : null;
        if (value && typeof value.value === 'string' && hasLetter(value.value))
          report(value, value.value);
        if (
          node.value.type === 'JSXExpressionContainer' &&
          node.value.expression.type === 'TemplateLiteral'
        ) {
          const raw = node.value.expression.quasis.map((q) => q.value.cooked).join('');
          if (hasLetter(raw)) report(node.value, raw);
        }
      },
    };
  },
};

export default { rules: { 'no-untranslated-text': noUntranslatedText } };
