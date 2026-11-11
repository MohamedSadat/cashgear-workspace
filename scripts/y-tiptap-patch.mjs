// Writes the Q18 patch into a copy of @tiptap/y-tiptap made by `pnpm patch` (DECISIONS.md,
// 2026-11-11: Phase 1). Two changes to the reconcile that writes ProseMirror back to Yjs:
//   1. A node with an id never stands in for a node with another id, and children with equal
//      ids anchor the diff, so a move or merge no longer rewrites (and loses a peer's typing in)
//      the blocks between its ends.
//   2. An attribute this schema does not know is kept, not removed, when the node is written
//      back, so an older client keeps what a newer one added (S2).
// Every change must match exactly once, or nothing is written: a new upstream release that
// moved the code fails loudly instead of shipping half a patch.
//   node scripts/y-tiptap-patch.mjs <the directory pnpm patch printed>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node scripts/y-tiptap-patch.mjs <patch directory>');

const changes = (Y) => [
  {
    name: 'ids decide whether two nodes are the same',
    from: 'const matchNodeName = (yElement, pNode) => !(pNode instanceof Array) && yElement.nodeName === pNode.type.name;',
    to: [
      '// cgw (Q18): a node with an id never stands in for a node with another id.',
      'const sameBlockId = (yElement, pNode) => {',
      '\tconst yId = yElement.getAttribute("id");',
      '\tconst pId = pNode.attrs.id;',
      '\treturn yId == null || pId == null || yId === pId;',
      '};',
      'const matchNodeName = (yElement, pNode) => !(pNode instanceof Array) && yElement.nodeName === pNode.type.name && sameBlockId(yElement, pNode);',
    ].join('\n'),
  },
  {
    name: 'children with equal ids anchor the diff',
    from: [
      '\tconst candidates = [];',
      '\tyChildren.forEach((yChild, yIndex) => {',
      '\t\tconst mapped = meta.mapping.get(yChild);',
      '\t\tconst pIndex = mapped === void 0 ? void 0 : pChildIndices.get(mapped);',
      '\t\tif (pIndex !== void 0 && mappedIdentity(mapped, pChildren[pIndex])) candidates.push({',
    ].join('\n'),
    to: [
      '\t// cgw (Q18): children with equal ids anchor the diff too.',
      '\tconst pIdIndices = /* @__PURE__ */ new Map();',
      '\tpChildren.forEach((pChild, index) => {',
      '\t\tconst id = pChild instanceof Array ? null : pChild.attrs.id;',
      '\t\tif (id != null && !pIdIndices.has(id)) pIdIndices.set(id, index);',
      '\t});',
      '\tconst candidates = [];',
      '\tyChildren.forEach((yChild, yIndex) => {',
      '\t\tconst mapped = meta.mapping.get(yChild);',
      '\t\tlet pIndex = mapped === void 0 ? void 0 : pChildIndices.get(mapped);',
      '\t\tif (pIndex !== void 0 && !mappedIdentity(mapped, pChildren[pIndex])) pIndex = void 0;',
      `\t\tif (pIndex === void 0 && yChild instanceof ${Y}.XmlElement) {`,
      '\t\t\tconst id = yChild.getAttribute("id");',
      '\t\t\tif (id != null) pIndex = pIdIndices.get(id);',
      '\t\t}',
      '\t\tif (pIndex !== void 0) candidates.push({',
    ].join('\n'),
  },
  {
    name: 'one anchor is enough',
    from: '\tif (anchors.length < 2 || !anchors.some((anchor) => anchor.yIndex !== anchor.pIndex) || anchors.some((anchor) => {',
    to: '\tif (anchors.length < 1 || !anchors.some((anchor) => anchor.yIndex !== anchor.pIndex) || anchors.some((anchor) => {',
  },
  {
    name: 'an anchored child that did not change is left alone',
    from: '\t\tupdateMatchingYChild(y, anchor.yChild, pChild, meta, updateFragment);',
    to: '\t\tif (!mappedIdentity(meta.mapping.get(anchor.yChild), pChild)) updateMatchingYChild(y, anchor.yChild, pChild, meta, updateFragment);',
  },
  {
    name: 'attributes this schema does not know are kept',
    from: '\t\tfor (const key in yDomAttrs) if (pAttrs[key] === void 0) yDomFragment.removeAttribute(key);',
    to: '\t\tfor (const key in yDomAttrs) if (pAttrs[key] === void 0 && key in pNode.type.attrs) yDomFragment.removeAttribute(key); // cgw (Q18): unknown attributes are kept',
  },
];

for (const [file, Y] of [
  ['dist/index.js', 'Y'],
  ['dist/index.cjs', 'yjs'],
]) {
  const path = join(dir, file);
  let source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  for (const change of changes(Y)) {
    const count = source.split(change.from).length - 1;
    if (count !== 1) throw new Error(`${file}: "${change.name}" matched ${count} times, not once`);
    source = source.replace(change.from, change.to);
  }
  writeFileSync(path, source);
  console.log(`${file}: ${changes(Y).length} changes`);
}
