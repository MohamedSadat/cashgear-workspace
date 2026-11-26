// Phase 19's budget page (bench/phase19.mjs): 2,000 blocks of the common kinds, a fifth of them in
// Arabic, as the editor's slice, and first a database block of the given database.
export /** 2,000 blocks of every common kind, English and Arabic, as the editor's slice; and a database block. */
function bigContent(databaseId) {
  let n = 0;
  const block = (body, children = []) => ({
    type: 'block',
    attrs: { id: `big${++n}` },
    content: [body, ...children],
  });
  const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
  const body = (kind, content, attrs = {}) => ({
    type: 'textBody',
    attrs: { kind, ...attrs },
    content,
  });
  const out = [
    {
      type: 'block',
      attrs: { id: 'big-db' },
      content: [{ type: 'databaseView', attrs: { databaseId, viewId: null } }],
    },
  ];
  for (let i = 0; out.length < 2000; i++) {
    const arabic = i % 5 === 4;
    const line = arabic
      ? `السطر ${i}: نص عربي يكتب من اليمين إلى اليسار في صفحة كبيرة للقياس.`
      : `Line ${i}: a paragraph of an ordinary length, with `;
    switch (i % 10) {
      case 0:
        out.push(
          block(
            body('heading', [text(arabic ? `عنوان ${i}` : `Heading ${i}`)], { level: (i % 3) + 1 }),
          ),
        );
        break;
      case 1:
        out.push(block(body('bulletItem', [text(line)])));
        break;
      case 2:
        out.push(block(body('numberedItem', [text(line)])));
        break;
      case 3:
        out.push(block(body('checkItem', [text(line)], { checked: i % 4 === 0 })));
        break;
      case 6:
        out.push(block(body('quote', [text(line)])));
        break;
      case 7:
        out.push(
          block({
            type: 'codeBlock',
            attrs: { language: null },
            content: [text(`const value${i} = ${i};\nreturn value${i};`)],
          }),
        );
        break;
      case 8:
        out.push(
          block({
            type: 'table',
            attrs: { headerRow: true },
            content: Array.from({ length: 4 }, (_, r) => ({
              type: 'tableRow',
              content: [0, 1, 2].map((c) => ({ type: 'tableCell', content: [text(`R${r}C${c}`)] })),
            })),
          }),
        );
        break;
      default:
        out.push(
          block(
            body(
              'paragraph',
              arabic
                ? [text(line)]
                : [
                    text(line),
                    text('bold', [{ type: 'bold' }]),
                    text(' and '),
                    text('a link', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
                    text('.'),
                  ],
            ),
          ),
        );
    }
  }
  return out;
}
